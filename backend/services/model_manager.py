import os
import time
import asyncio
import logging
import threading
from concurrent.futures import ThreadPoolExecutor, Executor

# ── Lazy imports ─────────────────────────────────────────────────────
# torch and OmniVoice are heavy (~2-3s import on Apple Silicon).
# Deferring them until first use cuts cold start from ~4s to ~1.5s,
# so health/status endpoints respond immediately on boot.

_torch = None
_OmniVoice = None


def _lazy_torch():
    global _torch
    if _torch is None:
        import torch as _t
        _torch = _t
    return _torch


def _lazy_omnivoice():
    global _OmniVoice
    if _OmniVoice is None:
        try:
            from omnivoice.models.omnivoice import OmniVoice as _OV
        except ModuleNotFoundError:
            # The venv's editable install is missing/broken (#564). main.py wires
            # the source fallback at startup, but resolve it here too so the
            # model-load path self-heals and logs the paths it searched.
            from core.omnivoice_path import ensure_omnivoice_importable
            _backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            ensure_omnivoice_importable(_backend_dir, logger)
            from omnivoice.models.omnivoice import OmniVoice as _OV
        _OmniVoice = _OV
    return _OmniVoice


from core.config import IDLE_TIMEOUT_SECONDS, CPU_POOL_WORKERS

logger = logging.getLogger("omnivoice.model")

# Per-TTS-job VRAM headroom estimate. OmniVoice's forward + autoregressive
# decode peaks around 1.6 GB, but the interactive clone path co-loads WhisperX
# large-v3 ASR (~3 GB) to transcribe the reference, so a *concurrent* clone job
# is realistically ~5 GB. The old 2.5 GB budget over-committed: an 8 GB card
# (~7 GB free) got 2 workers, and two concurrent clone jobs blew past VRAM into
# a sticky CUDA "illegal memory access" that aborts the whole backend process —
# the wave of "Can't reach the local backend" crash reports on 8 GB GPUs
# (#567/#570/#571/#580/#582/#583/#584). Budgeting 5 GB serializes to 1 worker on
# ≤10 GB cards (no contention → no crash) while 16/24 GB cards still parallelize.
# Power users override with OMNIVOICE_GPU_WORKERS.
_GPU_VRAM_PER_JOB_GB = 5.0
_GPU_WORKER_CAP = 4

_gpu_pool_singleton: "_ResilientGpuPool | None" = None
_cpu_pool = ThreadPoolExecutor(max_workers=CPU_POOL_WORKERS)


def _workers_for_free_vram(free_gb: float) -> int:
    """GPU worker count for a given free-VRAM figure: free // per-job budget,
    floored at 1 and capped at _GPU_WORKER_CAP. Pure so the sizing policy is
    unit-tested without a GPU (the #567 crash hinged on this returning >1 on
    8 GB cards)."""
    return max(1, min(_GPU_WORKER_CAP, int(free_gb // _GPU_VRAM_PER_JOB_GB)))


def _pick_gpu_workers() -> int:
    """Pick a sensible GPU worker count from the runtime environment.

    Resolution order:
      1. OMNIVOICE_GPU_WORKERS env var (explicit user override, clamped 1..16).
      2. CUDA / ROCm: free VRAM // per-job budget, capped at 4.
      3. MPS / CPU / unknown: 1.

    Designed to fail safe — any exception → 1 worker, never propagated.
    """
    override = os.environ.get("OMNIVOICE_GPU_WORKERS")
    if override:
        try:
            n = int(override)
            return max(1, min(16, n))
        except ValueError:
            logger.warning("OMNIVOICE_GPU_WORKERS=%r is not an integer; ignoring", override)
    try:
        torch = _lazy_torch()
        if hasattr(torch, "cuda") and torch.cuda.is_available():
            free_bytes, _total = torch.cuda.mem_get_info()
            free_gb = free_bytes / (1024 ** 3)
            workers = _workers_for_free_vram(free_gb)
            logger.info(
                "GPU pool sized to %d worker(s) — %.1f GB free / %.1f GB per job (cap %d)",
                workers, free_gb, _GPU_VRAM_PER_JOB_GB, _GPU_WORKER_CAP,
            )
            return workers
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            logger.info("GPU pool: MPS detected, using 1 worker (shared system memory)")
            return 1
    except Exception as e:
        logger.warning("GPU worker probe failed (%s); defaulting to 1", e)
    return 1


def _build_gpu_pool() -> ThreadPoolExecutor:
    workers = _pick_gpu_workers()
    return ThreadPoolExecutor(max_workers=workers, thread_name_prefix="gpu-pool")


class _ResilientGpuPool(Executor):
    """A stable, self-healing wrapper around the GPU `ThreadPoolExecutor`.

    The crash this fixes (#589 #599): `_reset_gpu_pool()` shuts the pool down on
    a model-load timeout, but consumers that captured the executor *object* at
    import time (`from services.model_manager import _gpu_pool` at module level —
    generation, dub_generate, dub_core, dub_translate, openai_compat) kept
    submitting to the dead pool and got `RuntimeError: cannot schedule new
    futures after shutdown` on the next generate/dub/translate.

    Making `_gpu_pool` a single long-lived wrapper whose *inner* pool is swapped
    means those references never go stale: every `submit()` resolves the live
    pool, and a submit that races a shutdown rebuilds once and retries. Building
    the inner pool stays lazy so we still size workers after torch's device
    probe (the reason for the original `__getattr__` indirection).
    """

    def __init__(self):
        self._pool: "ThreadPoolExecutor | None" = None
        self._lock = threading.Lock()

    def _live_pool(self) -> ThreadPoolExecutor:
        pool = self._pool
        if pool is None:
            with self._lock:
                if self._pool is None:
                    self._pool = _build_gpu_pool()
                pool = self._pool
        return pool

    def submit(self, fn, /, *args, **kwargs):
        try:
            return self._live_pool().submit(fn, *args, **kwargs)
        except RuntimeError as e:
            # "cannot schedule new futures after shutdown": the inner pool was
            # reset (or torn down) under us. Rebuild once and retry so a stale
            # caller self-heals instead of 500-ing. (Interpreter-shutdown races
            # re-raise on the retry — we don't loop.)
            if "shutdown" not in str(e).lower():
                raise
            with self._lock:
                self._pool = _build_gpu_pool()
                pool = self._pool
            return pool.submit(fn, *args, **kwargs)

    def reset(self) -> None:
        """Abandon the current worker pool; the next submit builds a fresh one.

        Python can't kill a thread wedged in a timed-out load, but dropping the
        poisoned pool means a retry gets a clean worker instead of queueing
        behind the wedged one. The wrapper identity is preserved, so references
        held by importers stay valid.
        """
        with self._lock:
            pool, self._pool = self._pool, None
        if pool is not None:
            try:
                pool.shutdown(wait=False, cancel_futures=True)
            except Exception:
                pass

    def shutdown(self, wait=True, *, cancel_futures=False):
        with self._lock:
            pool, self._pool = self._pool, None
        if pool is not None:
            pool.shutdown(wait=wait, cancel_futures=cancel_futures)


def _get_gpu_pool() -> "_ResilientGpuPool":
    """Internal accessor for the GPU pool singleton. Same object as the
    module-level `_gpu_pool` attribute, but resolvable from inside this module
    (Python's module `__getattr__` only fires for lookups from *outside*).
    """
    global _gpu_pool_singleton
    if _gpu_pool_singleton is None:
        _gpu_pool_singleton = _ResilientGpuPool()
    return _gpu_pool_singleton


def __getattr__(name: str):
    """Lazy module attribute — initialises `_gpu_pool` on first access so we
    can probe the device after torch finishes its lazy import. Without this
    we'd be forced to commit to max_workers=1 at module import time, before
    knowing whether CUDA is even available.
    """
    if name == "_gpu_pool":
        return _get_gpu_pool()
    raise AttributeError(f"module 'services.model_manager' has no attribute {name!r}")

model = None  # type: ignore
_model_lock = asyncio.Lock()
_last_used = time.time()
# Idle timeout is resolved per-tick in _resolve_idle_timeout() (MM2-05) from
# prefs/env/core.config — no module-level duplicate of IDLE_TIMEOUT_SECONDS.

# ── Loading sub-stage tracker ────────────────────────────────────────
# Updated by _load_model_sync() so get_model_status() can report
# granular progress to the frontend pill.
_loading_detail: dict = {
    "sub_stage": None,   # importing | loading_weights | loading_asr | compiling | ready | error
    "detail": "",        # human-readable description
    "error": None,       # error message string if failed
    "progress": None,    # 0-100 percentage (None = indeterminate)
}

# ── ROCm GFX version overrides ───────────────────────────────────────
# AMD GPUs on ROCm report through torch.cuda but may need
# HSA_OVERRIDE_GFX_VERSION for unsupported GFX IDs.
_ROCM_GFX_OVERRIDES = {
    # RDNA 3 (RX 7000 series) — override to gfx1100
    "gfx1101": "11.0.0", "gfx1102": "11.0.0", "gfx1103": "11.0.0",
    # RDNA 2 (RX 6000 series) — override to gfx1030
    "gfx1031": "10.3.0", "gfx1032": "10.3.0", "gfx1034": "10.3.0",
    # Vega (RX Vega / Radeon VII) — override to gfx900
    "gfx902": "9.0.0", "gfx906": "9.0.6",
}


def _configure_rocm_if_needed(torch):
    """Auto-set HSA_OVERRIDE_GFX_VERSION for AMD GPUs on ROCm.

    ROCm-enabled PyTorch reports `torch.cuda.is_available() == True` but
    some consumer AMD GPUs have GFX IDs not in the official support matrix.
    Setting HSA_OVERRIDE_GFX_VERSION lets them run with the closest
    supported architecture.
    """
    if os.environ.get("HSA_OVERRIDE_GFX_VERSION"):
        return  # User already set it manually
    try:
        device_name = torch.cuda.get_device_name(0).lower()
        # Only AMD GPUs need this — skip NVIDIA
        if not any(kw in device_name for kw in ("amd", "radeon", "instinct")):
            return
        # Try to read the GFX version from the device properties
        props = torch.cuda.get_device_properties(0)
        gcn_arch = getattr(props, "gcnArchName", "") or ""
        gfx_id = gcn_arch.split(":")[0].strip().lower()
        if gfx_id in _ROCM_GFX_OVERRIDES:
            override = _ROCM_GFX_OVERRIDES[gfx_id]
            os.environ["HSA_OVERRIDE_GFX_VERSION"] = override
            logger.info("ROCm: auto-set HSA_OVERRIDE_GFX_VERSION=%s for %s (%s)",
                        override, device_name, gfx_id)
    except Exception as e:
        logger.debug("ROCm GFX auto-config skipped: %s", e)


def check_device_compatibility():
    """Check if PyTorch supports the current GPU's compute capability.

    Returns (compatible, warning_message). Compatible is True if OK or
    no discrete GPU is present.
    """
    torch = _lazy_torch()
    if not torch.cuda.is_available():
        return True, None
    try:
        major, minor = torch.cuda.get_device_capability(0)
        device_name = torch.cuda.get_device_name(0)
        sm_tag = f"sm_{major}{minor}"
        arch_list = getattr(torch.cuda, "_get_arch_list", lambda: [])()
        if arch_list:
            compute_tag = f"compute_{major}{minor}"
            if sm_tag not in arch_list and compute_tag not in arch_list:
                return False, (
                    f"{device_name} (compute capability {major}.{minor} / {sm_tag}) "
                    f"is not supported by this PyTorch build. "
                    f"Supported architectures: {', '.join(arch_list)}. "
                    f"Try: pip install torch --index-url https://download.pytorch.org/whl/nightly/cu128"
                )
    except Exception:
        pass
    return True, None


def get_best_device():
    """Detect the best available compute device.

    Priority: CUDA/ROCm > Intel XPU > DirectML > MPS > CPU

    The *family* decision delegates to ``core.device_caps.detect_host_caps()``
    (the single source of truth) so the probe and this loader can never
    disagree. This function keeps the side-effects the probe deliberately
    avoids: the ROCm ``HSA_OVERRIDE_GFX_VERSION`` env override and the
    DirectML device-string return (DirectML is not a torch device family, so
    the probe reports it as ``cpu`` — we still resolve the real device string
    here for Windows DirectML users). The string contract is unchanged:
    ``"cuda"`` / ``"xpu"`` / a DirectML device string / ``"mps"`` / ``"cpu"``.
    """
    from core.device_caps import detect_host_caps

    torch = _lazy_torch()
    family = detect_host_caps().family

    # ── NVIDIA CUDA or AMD ROCm (both present through torch.cuda) ─────
    if family in ("cuda", "rocm"):
        _configure_rocm_if_needed(torch)
        compatible, warning = check_device_compatibility()
        if not compatible:
            logger.warning(warning)
        return "cuda"

    # ── Intel Arc / discrete GPU via IPEX ────────────────────────────
    if family == "xpu":
        try:
            logger.info("Using Intel XPU device: %s", torch.xpu.get_device_name(0))
        except Exception:
            logger.info("Using Intel XPU device")
        return "xpu"

    # ── Apple Silicon MPS ────────────────────────────────────────────
    # Checked BEFORE DirectML to mirror the probe's family-priority order
    # (cuda > rocm > xpu > mps; DirectML is not a torch family) so the loader
    # and detect_host_caps() never disagree on a host that somehow exposes both.
    if family == "mps":
        return "mps"

    # ── DirectML — universal Windows GPU (probe reports this as "cpu") ─
    # Reached only when no torch family was detected (family == "cpu"), which is
    # exactly the DirectML case — the probe classifies DirectML hosts as cpu.
    try:
        import torch_directml
        if torch_directml.device_count() > 0:
            logger.info("Using DirectML device (GPU %d)", 0)
            return str(torch_directml.device(0))
    except ImportError:
        pass

    return "cpu"

_COMPILE_ERR_MODULE_PREFIXES = ("torch._dynamo", "torch._inductor", "torch.fx", "triton")
_COMPILE_ERR_TB_MARKERS = ("/_dynamo/", "/_inductor/", "/triton/", "torch/fx/")
_COMPILE_ERR_MSG_MARKERS = (
    "dynamo", "inductor", "triton", "cudagraph",
    "symbolically trace", "torch.compile", "fx graph",
)


def _is_compile_runtime_failure(exc: BaseException) -> bool:
    """True when an exception originates in the torch.compile stack (Dynamo /
    Inductor / Triton / FX / CUDA-graph trees) rather than in the model itself.

    #278: on GPU architectures Triton doesn't support yet (e.g. Blackwell
    sm_120), the compiled model dies mid-generation with errors like
    "Detected that you are using FX to symbolically trace a dynamo-optimized
    function" or an AssertionError out of torch/_inductor/cudagraph_trees.py.
    Walks the exception chain and checks (a) the exception type's module,
    (b) the message, (c) the traceback file paths — the cudagraph case is a
    bare AssertionError, so the traceback check is load-bearing.
    """
    import traceback as _tb

    seen: set[int] = set()
    cur: BaseException | None = exc
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        mod = type(cur).__module__ or ""
        if mod.startswith(_COMPILE_ERR_MODULE_PREFIXES):
            return True
        msg = str(cur).lower()
        if any(marker in msg for marker in _COMPILE_ERR_MSG_MARKERS):
            return True
        try:
            for frame in _tb.extract_tb(cur.__traceback__):
                filename = (frame.filename or "").replace("\\", "/")
                if any(marker in filename for marker in _COMPILE_ERR_TB_MARKERS):
                    return True
        except Exception as traceback_scan_error:
            logging.debug(
                "Skipping traceback marker scan while classifying compile runtime failure: %s",
                traceback_scan_error,
            )
        # Follow the chain, honoring `raise ... from None` (the eager-retry
        # path suppresses the original compile error so a genuine eager
        # failure isn't misclassified as a compile failure).
        if cur.__cause__ is not None:
            cur = cur.__cause__
        elif not cur.__suppress_context__:
            cur = cur.__context__
        else:
            cur = None
    return False


def _install_compile_fallback(_model) -> None:
    """Wrap ``model.generate`` so a torch.compile failure at inference time
    falls back to the eager (uncompiled) model instead of failing the
    generation (#278).

    All TTS paths (generate, archetype previews, dub, stream, batch) funnel
    through ``model.generate``, so this is the single choke point. On a
    compile-stack failure we: log a clear warning, restore the eager module
    (``OptimizedModule._orig_mod``), disable compile for the rest of the
    session via ``engine_env.mark_compile_runtime_failure``, reset dynamo
    state, and retry the call once eagerly. Non-compile errors (real OOM,
    validation, …) propagate unchanged — fully backward compatible for users
    whose torch.compile works.
    """
    orig_generate = _model.generate

    def _generate_with_compile_fallback(*args, **kwargs):
        try:
            return orig_generate(*args, **kwargs)
        except Exception as exc:
            compiled = getattr(_model, "llm", None)
            eager = getattr(compiled, "_orig_mod", None)
            if eager is None or not _is_compile_runtime_failure(exc):
                raise
            logger.warning(
                "torch.compile runtime failure during generation (%s: %s) — "
                "falling back to the eager model and disabling torch.compile "
                "for this session. Generation is being retried without it.",
                type(exc).__name__, exc,
            )
            from services import engine_env
            engine_env.mark_compile_runtime_failure(f"{type(exc).__name__}: {exc}")
            _model.llm = eager
            try:
                torch = _lazy_torch()
                torch._dynamo.reset()
            except Exception as reset_exc:
                logger.debug(
                    "Non-fatal: failed to reset torch._dynamo state after compile failure (%s: %s). "
                    "Continuing with eager fallback.",
                    type(reset_exc).__name__,
                    reset_exc,
                )
            try:
                return orig_generate(*args, **kwargs)
            except Exception as eager_exc:
                # `from None` so a genuine eager failure (e.g. a real OOM)
                # isn't chained to — and misclassified as — the compile error.
                raise eager_exc from None

    _model.generate = _generate_with_compile_fallback


# ── #315: thread affinity for cudagraph-compiled models ─────────────────────
# `torch.compile(mode="reduce-overhead")` captures CUDA graphs, and captured
# graph state is **thread-local** (torch/_inductor/cudagraph_trees keys its
# tree manager off the capturing thread). The `_gpu_pool` runs up to
# `_GPU_WORKER_CAP` threads, so render #1 captures the graph on worker A and a
# later render dispatched to worker B replays against mismatched cudagraph
# state — silently corrupting the audio (static / slowed playback, no
# exception, so the #278 eager fallback never fires). Fix: every call into a
# cudagraph-compiled model executes on ONE dedicated thread; uncompiled
# models (CPU / MPS / Windows-no-Triton / compile-disabled) keep the full pool.

_TORCH_COMPILE_MODE = "reduce-overhead"
# Compile modes that enable CUDA graphs under the hood — these need the
# single-thread affinity below. "default" / "max-autotune-no-cudagraphs"
# would not.
_CUDAGRAPH_COMPILE_MODES = frozenset({"reduce-overhead", "max-autotune"})

_compiled_inference_executor: "ThreadPoolExecutor | None" = None
_compiled_inference_thread_ident: "int | None" = None


def _get_compiled_inference_executor() -> ThreadPoolExecutor:
    """The single-thread executor that owns ALL inference on a compiled model.

    Created lazily the first time a model is compiled with a cudagraph mode;
    reused across model reloads (idle unload → reload keeps the same thread,
    which is fine — a fresh compile simply captures its graphs there too).
    The worker is spun up eagerly so its thread ident is known for the
    re-entrancy guard in `_install_compile_thread_affinity`.
    """
    global _compiled_inference_executor, _compiled_inference_thread_ident
    if _compiled_inference_executor is None:
        _compiled_inference_executor = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="compiled-infer",
        )
        _compiled_inference_thread_ident = _compiled_inference_executor.submit(
            threading.get_ident
        ).result()
    return _compiled_inference_executor


def _install_compile_thread_affinity(_model) -> None:
    """Pin every ``model.generate`` call to the dedicated compile thread (#315).

    Wraps ``model.generate`` (the single choke point all TTS paths funnel
    through — generate, archetype previews, dub, stream, batch) so the call
    body always runs on `_get_compiled_inference_executor()`'s one thread.
    That makes the thread that *captures* the CUDA graph on the first render
    and the thread that *replays* it on every later render the same thread,
    deterministically, regardless of which `_gpu_pool` worker dispatched it.

    Installed AFTER `_install_compile_fallback`, so the call-time order is:
    caller thread → hop to the dedicated thread → eager-fallback wrapper →
    real generate (the #278 classification/retry also runs on the dedicated
    thread, with native tracebacks). The hop is a no-op when already on the
    dedicated thread — a 1-worker executor submitting to itself would
    deadlock, so the re-entrancy guard is load-bearing.
    """
    executor = _get_compiled_inference_executor()
    inner_generate = _model.generate

    def _generate_on_compile_thread(*args, **kwargs):
        if threading.get_ident() == _compiled_inference_thread_ident:
            return inner_generate(*args, **kwargs)
        return executor.submit(inner_generate, *args, **kwargs).result()

    _model.generate = _generate_on_compile_thread


def _set_loading(sub_stage: str, detail: str = "", error: str | None = None, progress: float | None = None):
    """Update the loading detail dict atomically."""
    _loading_detail["sub_stage"] = sub_stage
    _loading_detail["detail"] = detail
    _loading_detail["error"] = error
    _loading_detail["progress"] = progress


def _env_flag(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def should_preload_tts_asr() -> bool:
    """Whether OmniVoice.from_pretrained should attach PyTorch Whisper.

    The default is intentionally false. On Apple Silicon, eager TTS + ASR
    loading can overcommit unified memory and leave desktop startup stuck
    at the model-loading stage. ASR backends still load on demand.
    """
    return _env_flag("OMNIVOICE_PRELOAD_TTS_ASR")


def _load_model_sync():
    global model
    from utils.hf_progress import register_listener, unregister_listener

    # Register a listener that updates _loading_detail with real-time
    # download/weight-loading percentages from hf_hub_download tqdm bars.
    def _on_hf_progress(ev):
        pct = ev.get("pct", 0.0)
        filename = ev.get("filename", "")
        phase = ev.get("phase", "")
        if pct > 0:
            pct_int = min(round(pct * 100), 99)  # cap at 99 until fully done
            detail = _loading_detail.get("detail", "")
            # Append percentage to the existing detail label
            base = detail.split(" —")[0].split(" (")[0]  # strip old suffix
            _loading_detail["progress"] = pct_int
            _loading_detail["detail"] = f"{base} — {pct_int}%"

    lid = register_listener(_on_hf_progress)
    try:
        _set_loading("importing", "Importing PyTorch & OmniVoice runtime…")
        logger.info("Importing PyTorch & OmniVoice runtime…")
        torch = _lazy_torch()
        OmniVoice = _lazy_omnivoice()
        device = get_best_device()

        checkpoint = os.environ.get("OMNIVOICE_MODEL", "k2-fsa/OmniVoice")
        _set_loading("loading_weights", f"Loading TTS weights on {device}…")
        logger.info("Loading OmniVoice model on device: %s", device)
        preload_asr = should_preload_tts_asr()
        if preload_asr:
            logger.info("Preloading PyTorch Whisper with TTS model.")
        else:
            logger.info("Skipping PyTorch Whisper preload; ASR will load on demand.")
        try:
            _model = OmniVoice.from_pretrained(
                checkpoint, device_map=device, dtype=torch.float16, load_asr=preload_asr,
            )
        except OSError as e:
            # #352: a truncated HF cache surfaces here as "does not appear to
            # have a file named pytorch_model.bin or model.safetensors".
            # Translate to an actionable message instead of the raw
            # transformers error.
            if "does not appear to have a file named" in str(e):
                raise RuntimeError(
                    f"The TTS model cache for {checkpoint} is incomplete "
                    "(weights missing — usually an interrupted download). "
                    "Open Settings → Models, delete the OmniVoice TTS model, "
                    "and install it again."
                ) from e
            raise

        try:
            # plan-02 (#65): gate on Triton availability (+ user setting), not
            # just device==cuda. Triton has no Windows wheel, so the old
            # cuda-only check OOM'd on Windows+CUDA; should_torch_compile()
            # falls back to eager there.
            from services.engine_env import should_torch_compile

            if should_torch_compile(device):
                _set_loading("compiling", "Compiling model (torch.compile)…")
                try:
                    _model.llm = torch.compile(_model.llm, mode=_TORCH_COMPILE_MODE)
                except Exception as compile_exc:
                    # #278: compile is an optimization, never a point of
                    # failure — keep the eager model and remember the failure
                    # so later loads this session skip compile up front.
                    from services.engine_env import mark_compile_runtime_failure
                    mark_compile_runtime_failure(f"{type(compile_exc).__name__}: {compile_exc}")
                    logger.warning(
                        "torch.compile failed (%s) — continuing with the eager model.",
                        compile_exc,
                    )
                else:
                    # Compilation is lazy: Dynamo/Inductor/Triton can still
                    # blow up on the first *forward* (e.g. unsupported new GPU
                    # archs, #278). Wrap generate so that falls back to eager
                    # instead of failing the generation.
                    _install_compile_fallback(_model)
                    if _TORCH_COMPILE_MODE in _CUDAGRAPH_COMPILE_MODES:
                        # #315: reduce-overhead uses CUDA graphs, whose
                        # captured state is thread-local. Pin all inference to
                        # one dedicated thread so a later render dispatched to
                        # a different _gpu_pool worker can't replay a graph it
                        # didn't capture (static / slowed audio from the 2nd
                        # render onward).
                        _install_compile_thread_affinity(_model)
                        logger.info(
                            "torch.compile mode %r uses CUDA graphs — compiled-model "
                            "inference pinned to a single dedicated thread (#315).",
                            _TORCH_COMPILE_MODE,
                        )
                    logger.info("torch.compile applied.")
        except Exception as e:
            logger.info("torch.compile skipped: %s", e)

        _set_loading("ready", "Model ready", progress=100)
        logger.info("OmniVoice model loaded successfully.")
        return _model
    except Exception as exc:
        err_msg = str(exc)
        _set_loading("error", "Model loading failed", error=err_msg)
        logger.error("Model loading failed: %s", err_msg)
        raise
    finally:
        unregister_listener(lid)

def _model_load_timeout() -> float:
    """Overall ceiling (seconds) for a single model load/download attempt.

    Backstop for any hang the HF per-read socket timeouts don't catch
    (a wedged torch.compile, a deadlock, etc.). Generous by default so a
    legitimate cold multi-GB download on a slow link still completes;
    overridable via OMNIVOICE_MODEL_LOAD_TIMEOUT for very slow networks.
    """
    try:
        return max(30.0, float(os.environ.get("OMNIVOICE_MODEL_LOAD_TIMEOUT", "1200")))
    except (ValueError, TypeError):
        return 1200.0


def _reset_gpu_pool() -> None:
    """Recover from a wedged/timed-out load by abandoning the GPU worker pool.

    The resilient wrapper is kept (its identity is shared by every importer);
    only its inner `ThreadPoolExecutor` is dropped, so the next submit builds a
    fresh worker. This is what stops stale references from raising "cannot
    schedule new futures after shutdown" after a reset (#589 #599).
    """
    if _gpu_pool_singleton is not None:
        _gpu_pool_singleton.reset()


async def _load_model_with_timeout():
    """Run the blocking model load on the GPU pool, bounded by a deadline.

    Raises RuntimeError on timeout (and resets the poisoned pool) so callers
    surface an actionable error instead of hanging indefinitely.
    """
    loop = asyncio.get_running_loop()
    timeout = _model_load_timeout()
    try:
        return await asyncio.wait_for(
            loop.run_in_executor(_get_gpu_pool(), _load_model_sync),
            timeout=timeout,
        )
    except asyncio.TimeoutError as exc:
        _set_loading("error", "Model load timed out", error="timeout")
        _reset_gpu_pool()
        logger.error("Model load exceeded %ss; resetting GPU pool.", timeout)
        raise RuntimeError(
            f"Model loading timed out after {int(timeout)}s — usually a network "
            "stall downloading the model (proxy, firewall, or antivirus). Check "
            "your connection or set a Hugging Face mirror in Settings, then retry."
        ) from exc


async def get_model():
    global model, _last_used
    _last_used = time.time()
    if model is not None:
        return model

    async with _model_lock:
        if model is None:
            model = await _load_model_with_timeout()
    return model


async def preload_model():
    """Background model warm-up — call from lifespan startup.

    Loads the TTS model on the GPU pool thread so the first /generate
    call is near-instant instead of waiting 4-6s for weight loading.
    Non-blocking: if models aren't installed yet, silently exits.
    """
    global model, _last_used
    if model is not None:
        return  # already loaded
    try:
        # Check if the required model checkpoint exists before attempting
        # a heavy load that would fail and pollute startup logs.
        checkpoint = os.environ.get("OMNIVOICE_MODEL", "k2-fsa/OmniVoice")
        try:
            from huggingface_hub import model_info
            model_info(checkpoint, timeout=5)
        except Exception:
            # Model not downloaded yet — skip preload
            logger.info("Preload skipped: %s not available locally.", checkpoint)
            return

        logger.info("Preloading TTS model in background…")
        _last_used = time.time()
        async with _model_lock:
            if model is None:
                model = await _load_model_with_timeout()
        logger.info("Preload complete — model ready.")
    except Exception as e:
        logger.warning("Model preload failed (non-fatal): %s", e)

def get_model_status():
    is_loaded = model is not None
    # asyncio.Lock exposes .locked() on all supported Python versions; wrap in try for safety.
    try:
        is_loading = (not is_loaded) and _model_lock.locked()
    except Exception:
        is_loading = False

    status = "loading" if is_loading else ("ready" if is_loaded else "idle")
    result = {
        "loaded": is_loaded,
        "loading": is_loading,
        "status": status,
    }
    # Attach sub-stage detail when loading or after an error
    sub = _loading_detail.get("sub_stage")
    if sub:
        result["sub_stage"] = sub
        result["detail"] = _loading_detail.get("detail", "")
        progress = _loading_detail.get("progress")
        if progress is not None:
            result["progress"] = progress
        err = _loading_detail.get("error")
        if err:
            result["error"] = err
    return result

def _resolve_idle_timeout() -> float:
    """In-process model idle timeout in seconds (MM2-05): prefs store → env →
    core.config default, env winning. Resolved per-tick so a settings change
    takes effect without a restart."""
    try:
        from core import prefs
        return float(prefs.resolve(
            "idle_timeout_seconds",
            env="OMNIVOICE_IDLE_TIMEOUT_S",
            default=IDLE_TIMEOUT_SECONDS,
        ))
    except (TypeError, ValueError, ImportError):
        return float(IDLE_TIMEOUT_SECONDS)


async def idle_worker():
    global model
    torch = _lazy_torch()
    while True:
        await asyncio.sleep(30)
        async with _model_lock:
            if model is not None and time.time() - _last_used > _resolve_idle_timeout():
                logger.info("Idle timeout reached. Unloading OmniVoice model to free VRAM.")
                model = None
                free_vram()

def free_vram():
    """Release cached GPU memory on any accelerator (CUDA, MPS, XPU)."""
    torch = _lazy_torch()
    import gc
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        torch.mps.empty_cache()
    elif hasattr(torch, "xpu") and torch.xpu.is_available():
        torch.xpu.empty_cache()


def _has_dedicated_vram():
    """Check if the current device has limited dedicated VRAM that needs offloading."""
    torch = _lazy_torch()
    if torch.cuda.is_available():
        return True
    if hasattr(torch, "xpu") and torch.xpu.is_available():
        return True
    return False


def offload_tts_for_asr():
    """Move TTS model to CPU to free VRAM for ASR (WhisperX large-v3).

    On a 7-8 GB laptop GPU the TTS model (~2.4 GB) and WhisperX large-v3
    (~3 GB) plus the VAD model can't coexist. Offloading the TTS model to
    CPU before transcription prevents CUDA OOM, then restore_tts_after_asr()
    moves it back.

    Works on CUDA (NVIDIA + ROCm) and Intel XPU.
    """
    global model
    torch = _lazy_torch()
    if model is None:
        return
    if not _has_dedicated_vram():
        return  # MPS / CPU / DirectML don't benefit from manual offloading
    try:
        # Check if there's enough free VRAM to skip offloading
        if torch.cuda.is_available():
            free_mem = torch.cuda.mem_get_info()[0]
            if free_mem > 8 * 1024 ** 3:  # > 8 GB free → skip offload
                return
    except Exception:
        pass
    try:
        logger.info("Offloading TTS model to CPU to free VRAM for ASR...")
        model.to("cpu")
        free_vram()
        logger.info("TTS model offloaded. VRAM freed for ASR.")
    except Exception as e:
        logger.warning("TTS offload failed: %s", e)


def restore_tts_after_asr():
    """Move TTS model back to the GPU after ASR completes."""
    global model
    torch = _lazy_torch()
    if model is None:
        return
    if not _has_dedicated_vram():
        return
    try:
        device = get_best_device()
        if device in ("cuda", "xpu"):
            logger.info("Restoring TTS model to %s...", device)
            model.to(device)
            free_vram()
    except Exception as e:
        logger.warning("TTS restore to %s failed: %s", get_best_device(), e)

_diar_pipeline = None

# Sentinel error classes used by callers (dub_core) to decide whether to
# emit a structured SSE warning with a docs deeplink. Kept as module-level
# constants so tests can pin them — they cross the SSE wire and the
# frontend's errorDocsMap classifies on the same strings.
DIARIZATION_ERR_NO_TOKEN = "NO_TOKEN"
DIARIZATION_ERR_LICENSE  = "PYANNOTE_LICENSE_REQUIRED"
DIARIZATION_ERR_LOAD     = "LOAD_FAILED"


def _classify_diarization_error(exc: BaseException) -> str:
    """Map a pyannote/HF-hub exception to one of the diarization error
    sentinels above.

    The 401/403 path is the canonical "user hasn't accepted the model
    license on huggingface.co" symptom — both `Pipeline.from_pretrained`
    and `huggingface_hub` raise distinct exception classes for it
    depending on the installed versions, so we sniff on both the class
    name and the stringified message rather than importing the
    `HfHubHTTPError` symbol directly (which is not stable across
    huggingface_hub majors).
    """
    name = type(exc).__name__.lower()
    msg = str(exc).lower()
    if (
        "401" in msg
        or "403" in msg
        or "unauthorized" in msg
        or "gated" in msg
        or "accept" in msg and ("license" in msg or "terms" in msg or "user conditions" in msg)
        or "hfhubhttperror" in name
        or "gatedrepoerror" in name
        or "repositorynotfounderror" in name and "gated" in msg
    ):
        return DIARIZATION_ERR_LICENSE
    return DIARIZATION_ERR_LOAD


def _ensure_pyannote_hf_token_compat():
    """pyannote-audio 3.x calls huggingface_hub.hf_hub_download / snapshot_download
    with the ``use_auth_token`` kwarg, which huggingface_hub 1.x removed (only
    ``token`` remains) — raising ``hf_hub_download() got an unexpected keyword
    argument 'use_auth_token'`` and breaking diarization (#167).

    Wrap those functions to translate the deprecated kwarg. We patch
    huggingface_hub itself BEFORE pyannote is imported, so pyannote's
    ``from huggingface_hub import hf_hub_download`` binds the wrapped fn; we
    also patch any already-imported pyannote submodule that bound it directly.
    Idempotent (guarded by an attribute marker).
    """
    import functools
    import sys as _sys
    import huggingface_hub as _hf

    def _wrap(orig):
        if orig is None or getattr(orig, "_ov_uat_shim", False):
            return orig

        @functools.wraps(orig)
        def _wrapped(*args, **kwargs):
            if "use_auth_token" in kwargs:
                kwargs.setdefault("token", kwargs.pop("use_auth_token"))
            return orig(*args, **kwargs)

        _wrapped._ov_uat_shim = True
        return _wrapped

    for _name in ("hf_hub_download", "snapshot_download"):
        if hasattr(_hf, _name):
            setattr(_hf, _name, _wrap(getattr(_hf, _name)))
    for _modname, _mod in list(_sys.modules.items()):
        if _modname.startswith("pyannote.") and _mod is not None:
            for _name in ("hf_hub_download", "snapshot_download"):
                if hasattr(_mod, _name):
                    setattr(_mod, _name, _wrap(getattr(_mod, _name)))


def get_diarization_pipeline(return_error: bool = False):
    """Load (or return the cached) pyannote speaker-diarization-3.1 pipeline.

    Default return: the pipeline instance, or `None` if anything went
    wrong (no token, license not accepted, model load crashed). Existing
    callers (dub_core legacy `_transcribe`) rely on the `None` sentinel.

    When `return_error=True`, returns a 2-tuple
    `(pipeline | None, error_sentinel | None)` where `error_sentinel` is
    one of the `DIARIZATION_ERR_*` constants. This shape is what the
    streaming `_diarize` path uses to emit a structured SSE warning with
    a docs deeplink — issue #78.
    """
    global _diar_pipeline
    if _diar_pipeline is not None:
        return (_diar_pipeline, None) if return_error else _diar_pipeline

    # Phase 1 AUTH-01: 3-source resolver (App → Env → HF-CLI). Per
    # Pitfall #1 in 01-RESEARCH.md — exactly one place in the backend
    # reads HF tokens, and that place is `token_resolver.resolve()`.
    from services import token_resolver
    resolved = token_resolver.resolve()
    if not resolved:
        return (None, DIARIZATION_ERR_NO_TOKEN) if return_error else None
    hf_token = resolved.token
    try:
        torch = _lazy_torch()
        _ensure_pyannote_hf_token_compat()  # #167: use_auth_token -> token
        # PyTorch 2.6 flipped torch.load's default to weights_only=True, whose
        # secure unpickler rejects the pyannote checkpoint's metadata globals
        # (torch_version.TorchVersion, omegaconf nodes, …) — surfacing as
        # "Weights only load failed / Unsupported global" and breaking
        # diarization on torch>=2.6 even after the license is accepted (#270).
        # Reuse the exact allowlist the WhisperX VAD load registers so the
        # secure load path succeeds; it is idempotent and per-process.
        try:
            from services.asr_backend import WhisperXBackend
            WhisperXBackend._allow_vad_pickle_globals()
        except Exception as _glob_e:
            logger.debug("pyannote safe-globals allowlist skipped: %s", _glob_e)
        from pyannote.audio import Pipeline
        logger.info("Loading Pyannote Diarization Pipeline...")
        _diar_pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", use_auth_token=hf_token)
        device = get_best_device()
        # Pyannote supports CUDA and CPU; route XPU/DirectML to CPU
        if device in ("cuda",):
            _diar_pipeline.to(torch.device(device))
        logger.info("Pyannote Diarization Pipeline loaded on %s.", device)
        return (_diar_pipeline, None) if return_error else _diar_pipeline
    except Exception as e:
        err_class = _classify_diarization_error(e)
        logger.error(
            "Failed to load Pyannote pipeline (class=%s): %s", err_class, e,
        )
        return (None, err_class) if return_error else None
