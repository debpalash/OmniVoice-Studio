import os
import sys
import time
import asyncio
import logging
import threading
from concurrent.futures import ThreadPoolExecutor, Executor

from utils.containment import contain_system_exit

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


# ── GPU-job timeout guard (#730 class; residual #850/#802/#755 …) ─────
# A blocking GPU job that wedges on a Windows+CUDA hang keeps occupying its
# worker forever — run_in_executor can't cancel the thread. With a 1–2 worker
# pool that starves *every* other request, so the next user action surfaces as
# the misleading "Can't reach the local backend" even though the process is
# alive. ASR/dub/model-load already bound+reset on hang (run_transcribe_guarded,
# _reset_pool_on_wedge, _load_model_with_timeout); the TTS **generate** paths
# (generation.py, tts_stream.py) were the last unguarded dispatch — and the
# residual on-main reports all fail on generate:start (audio). This is the same
# guard generalised so every GPU dispatch shares one recovery path.
GPU_JOB_TIMEOUT_S = float(os.environ.get("OMNIVOICE_GENERATE_TIMEOUT_S", "300.0"))


class GpuJobTimeoutError(TimeoutError):
    """A GPU-pool job exceeded its wall-clock bound and was abandoned.

    The backend is alive — the job was too heavy for the available compute
    (most often a VRAM-starved GPU). Pool capacity is restored automatically by
    resetting the pool; the message carries the durable fix.
    """


async def run_on_gpu_pool_guarded(fn, *, what: str = "GPU job",
                                  timeout: float = GPU_JOB_TIMEOUT_S,
                                  executor=None):
    """Run blocking ``fn`` on the GPU pool with a hard wall-clock bound.

    On timeout, ``reset()`` the pool (abandon the wedged worker so the next
    submit gets a fresh one) and raise :class:`GpuJobTimeoutError`. ``fn`` must
    be a zero-arg callable — wrap args with ``functools.partial`` at the call
    site. Deliberately mirrors ``asr_backend.run_transcribe_guarded`` so every
    GPU dispatch shares one bound+recover path (#730 class). Executors without
    ``reset`` (a plain ThreadPoolExecutor in tests) still get the bound + error.
    """
    loop = asyncio.get_running_loop()
    ex = executor if executor is not None else _get_gpu_pool()
    fut = loop.run_in_executor(ex, contain_system_exit(fn, what))
    try:
        return await asyncio.wait_for(fut, timeout=timeout)
    except asyncio.TimeoutError:
        _reset = getattr(ex, "reset", None)
        if callable(_reset):
            try:
                _reset()
                logger.warning(
                    "%s exceeded %.0fs — abandoned the GPU-pool worker to "
                    "restore capacity (#730).", what, timeout,
                )
            except Exception:
                logger.exception("GPU pool reset after %s timeout failed", what)
        raise GpuJobTimeoutError(_timeout_guidance(what, timeout))


def _timeout_guidance(what: str, timeout: float) -> str:
    """Device-aware timeout message (#896): a CPU-only host must never be told
    to "set the engine to CPU" or blamed on VRAM — on CPU the job is simply
    compute-bound. GPU hosts keep the VRAM-contention guidance."""
    family = "cuda"  # conservative default: GPU wording if the probe fails
    try:
        from core.device_caps import detect_host_caps
        family = detect_host_caps().family
    except Exception:  # noqa: BLE001 — guidance must never mask the timeout
        pass
    common = (
        f"{what} exceeded {timeout:.0f}s and was abandoned — the backend is "
        "running, but the job was too heavy for the available compute. "
        "Capacity was restored automatically; "
    )
    if family == "cpu":
        return common + (
            "this machine renders on CPU, where long generations are "
            "compute-bound. For a durable fix try shorter text or a lighter "
            "engine (OmniVoice GGUF and Supertonic-3 are CPU-tuned). If you "
            "expect very long single generations, raise "
            "OMNIVOICE_GENERATE_TIMEOUT_S."
        )
    return common + (
        "most often the GPU is VRAM-starved (a resident model and this job "
        "contend for memory). For a durable fix, Flush caches / Unload the "
        "resident model (top toolbar or Settings → Models) before retrying, "
        "try shorter text, a lighter engine, or set the engine to CPU in "
        "Settings → Models. (Raise OMNIVOICE_GENERATE_TIMEOUT_S for very "
        "long single generations.)"
    )


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
            # #756: the GPU's compute capability isn't in this torch build's arch
            # list, so CUDA kernels can't launch ("no kernel image is available
            # for execution") — every generate would 500. Too-old (Pascal sm_61)
            # and too-new (Blackwell sm_120 on pre-cu128 wheels) both land here.
            # Fall back to CPU so the app WORKS (slowly) instead of dead-ending;
            # OMNIVOICE_FORCE_CUDA=1 overrides for users who installed a matching
            # torch and know the arch_list probe is wrong for their setup.
            if not _env_flag("OMNIVOICE_FORCE_CUDA"):
                logger.warning(
                    "Falling back to CPU: this GPU is unsupported by the installed "
                    "PyTorch build (set OMNIVOICE_FORCE_CUDA=1 to force CUDA anyway)."
                )
                return "cpu"
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


def _is_incomplete_cache_error(exc: BaseException) -> bool:
    """True when `exc` is the truncated-HF-cache class (#352 / #581).

    transformers raises an OSError whose message contains "does not appear to
    have a file named …" when the on-disk snapshot has config/tokenizer files
    but no weight shard — the signature of an interrupted download. We match on
    that phrase (stable across transformers 4.x/5.x) rather than the error type,
    since the same OSError type covers unrelated I/O failures."""
    return "does not appear to have a file named" in str(exc)


def _hf_offline() -> bool:
    """Respect HF's offline switches so repair never makes a network call the
    user opted out of. `snapshot_download` would itself raise offline, but
    checking up front lets us skip straight to the actionable message."""
    return _env_flag("HF_HUB_OFFLINE") or _env_flag("TRANSFORMERS_OFFLINE")


# ── Broken-snapshot-link self-heal ───────────────────────────────────
# A sibling of the incomplete-cache class above: the blobs are FULLY
# downloaded, but the snapshots/<rev>/ entries pointing at them are dangling
# symlinks (0 KB) or zero-byte stand-ins — blob-naming mismatches between
# download modes, interrupted renames, or antivirus interference all produce
# this state (reported on Windows, where the NTFS links show as 0 KB, but the
# heal is generic). os.path.isfile() on a dangling link is False, so
# transformers raises the same "does not appear to have a file named …"
# signature even though the bytes are on disk. The resume repair below can't
# fix it (snapshot_download may trust/short-circuit on the existing broken
# entry), so rung 0 of the recovery ladder deletes exactly the broken entries
# and restores them — see services.hf_cache_repair.

# Repos this process already attempted the link self-heal for — the retry
# after a repair may only happen ONCE per repo per process, so a cache that
# stays broken can't loop repair↔retry.
_LINK_REPAIR_ATTEMPTED: set[str] = set()


def _selfheal_broken_snapshot_links(checkpoint: str) -> bool:
    """Rung 0 of cache recovery: delete-and-restore broken snapshot entries.

    Returns True only when broken entries were found, removed AND restored —
    i.e. retrying the load is worth it. At most one attempt per repo per
    process. Never raises; when it returns False the legacy resume/force
    ladder still runs."""
    if checkpoint in _LINK_REPAIR_ATTEMPTED:
        return False
    _LINK_REPAIR_ATTEMPTED.add(checkpoint)
    if os.path.isdir(checkpoint):
        return False  # a local-directory checkpoint doesn't use the hub cache
    try:
        from services.hf_cache_repair import repair_repo_cache
        summary = repair_repo_cache(checkpoint)
    except Exception as repair_err:  # repair must never break the ladder
        logger.warning("Snapshot-link self-heal for %s errored: %s",
                       checkpoint, repair_err)
        return False
    if summary.get("removed") and summary.get("ok"):
        logger.warning(
            "Model cache for %s had %d broken file link(s) — repaired "
            "automatically (%s), retrying the load.",
            checkpoint, summary["removed"],
            summary.get("outcome") or "healed",
        )
        return True
    if summary.get("found"):
        logger.warning(
            "Model cache for %s has %d broken file link(s) that could not be "
            "auto-repaired (%s).",
            checkpoint, summary["found"], summary.get("error") or "unknown",
        )
    return False


def _manual_cache_delete_hint(checkpoint: str) -> str:
    """Names the exact on-disk folder to delete when every auto-repair rung
    failed — "delete the model" is only actionable if the user can find it.
    Empty for local-directory checkpoints (they don't live in the hub cache)."""
    try:
        if os.path.isdir(checkpoint):
            return ""
        from services.hf_cache_repair import repo_cache_dir
        return (
            f" If the problem persists, quit OmniVoice, delete "
            f"{repo_cache_dir(checkpoint)} and restart — the model "
            "re-downloads automatically."
        )
    except Exception:
        return ""


# Why the LAST _repair_model_cache run failed ("" when it succeeded / hasn't
# run). #886: the "could not be auto-repaired" message used to drop the cause
# entirely, so a mirror outage, offline mode, or a full disk all read the same.
_last_repair_error: str = ""


def _repair_failure_detail() -> str:
    """One sanitized clause naming why auto-repair failed, or "" (#886).

    Feeds user-facing messages (the generate 500 detail / model status), so it
    goes through core.failure.sanitize — and because the cause text is now part
    of the surfaced error, the shared HF-mirror hint (#874) fires on it when
    the repair failed against an unreachable configured mirror."""
    if not _last_repair_error:
        return ""
    try:
        from core.failure import sanitize
        cause = sanitize(_last_repair_error)
    except Exception:
        cause = _last_repair_error
    return f" Auto-repair failed with: {cause}."


def _repair_model_cache(checkpoint: str, *, force: bool = False) -> bool:
    """Re-fetch a checkpoint's missing files in place and report success.

    An interrupted download leaves the cache missing only some files;
    `snapshot_download` resumes/fills exactly those (already-present, correctly
    sized blobs are skipped by hash, so a near-complete cache repairs in
    seconds and a complete one would no-op). Returns False — leaving the caller
    to surface the actionable delete-and-reinstall message — when repair is
    impossible (offline) or the re-fetch itself fails (no network, gated repo,
    full disk). Never raises; repair is best-effort.

    ``force=True`` passes ``force_download`` so the re-fetch replaces files that
    are *present but corrupt* — a truncated/garbled blob that still has the right
    size won't be re-fetched by the default resume (#739). It re-downloads the
    whole snapshot, so it's the last resort the load path only reaches after a
    plain resume-repair didn't fix the cache."""
    global _last_repair_error
    _last_repair_error = ""
    if _hf_offline():
        logger.warning(
            "Model cache for %s is incomplete but HF offline mode is set — "
            "cannot auto-repair.", checkpoint,
        )
        _last_repair_error = (
            "Hugging Face offline mode is enabled (HF_HUB_OFFLINE/TRANSFORMERS_OFFLINE)"
        )
        return False
    try:
        from huggingface_hub import snapshot_download
    except Exception as imp_err:  # pragma: no cover - huggingface_hub is a hard dep
        logger.warning("Cannot import snapshot_download to repair cache: %s", imp_err)
        _last_repair_error = f"{type(imp_err).__name__}: {imp_err}"
        return False
    dl_kwargs: dict = {"repo_id": checkpoint}
    # Explicit endpoint (HF_ENDPOINT / pref) wins; otherwise the automatic
    # endpoint selection's cached pick applies (services.endpoint_race).
    try:
        from services import endpoint_race
        endpoint = endpoint_race.effective_endpoint()
    except Exception:  # endpoint resolution must never break the repair
        endpoint = os.environ.get("HF_ENDPOINT")
    if endpoint:
        dl_kwargs["endpoint"] = endpoint
    if force:
        # Replace present-but-corrupt blobs that resume would trust by size.
        dl_kwargs["force_download"] = True
    if os.name == "nt":
        # Match the install path (download.py): avoid symlinks on Windows.
        dl_kwargs["local_dir_use_symlinks"] = False

    def _attempt() -> None:
        """One snapshot_download, tolerating an hf_hub that rejects the optional
        symlink knob. Lets real failures (network, gated repo, disk) propagate."""
        try:
            snapshot_download(**dl_kwargs)
        except TypeError:
            # Older/newer huggingface_hub may not accept local_dir_use_symlinks
            # on a cache-only call — retry without the optional knob.
            dl_kwargs.pop("local_dir_use_symlinks", None)
            snapshot_download(**dl_kwargs)

    # Bounded retries (#739): an incomplete cache *is* an interrupted download, so
    # a single transient blip mid-repair shouldn't drop the user back to a manual
    # delete-and-reinstall. snapshot_download resumes between attempts (present,
    # correctly-sized blobs are skipped by hash), so each retry continues where
    # the last left off — cheap and idempotent. Counts/backoff are env-tunable
    # for restricted networks and kept fast (backoff=0) in tests.
    try:
        retries = max(1, int(os.environ.get("OMNIVOICE_MODEL_REPAIR_RETRIES", "3")))
    except ValueError:
        retries = 3
    try:
        backoff = max(0.0, float(os.environ.get("OMNIVOICE_MODEL_REPAIR_BACKOFF_S", "2")))
    except ValueError:
        backoff = 2.0

    logger.info(
        "Auto-repairing incomplete model cache for %s (up to %d attempt(s)) …",
        checkpoint, retries,
    )
    for attempt in range(1, retries + 1):
        try:
            _attempt()
            logger.info("Auto-repair of %s completed; retrying model load.", checkpoint)
            return True
        except Exception as e:
            logger.warning(
                "Auto-repair of %s attempt %d/%d failed: %s",
                checkpoint, attempt, retries, e,
            )
            _last_repair_error = f"{type(e).__name__}: {e}"
            if attempt < retries:
                # Endpoint failover (auto mode only, once per repo per
                # process — same guard pattern as the snapshot-link rung): a
                # network-classified repair failure re-races the endpoints so
                # the next attempt retries on the winner instead of burning
                # every retry on a dead host. Explicit user endpoints are
                # never switched.
                try:
                    from services import endpoint_race
                    if endpoint_race.reselect_after_failure(checkpoint, str(e)):
                        new_ep = endpoint_race.effective_endpoint()
                        if new_ep:
                            dl_kwargs["endpoint"] = new_ep
                        else:
                            dl_kwargs.pop("endpoint", None)
                        logger.info(
                            "Auto-repair of %s: endpoint failover — retrying on %s",
                            checkpoint, new_ep or "https://huggingface.co",
                        )
                except Exception:  # failover must never break the ladder
                    pass
                if backoff:
                    time.sleep(backoff * attempt)
    return False


_DEFAULT_OMNIVOICE_CHECKPOINT = "k2-fsa/OmniVoice"


def resolve_omnivoice_checkpoint() -> str:
    """Resolve the OmniVoice TTS checkpoint from ``OMNIVOICE_MODEL``, self-healing
    a misconfigured value.

    A valid checkpoint is either a HuggingFace repo id (``org/repo`` — contains a
    ``/``) or an existing local directory. A bare token like ``"omnivoice"`` — a
    TTS *engine id* that leaked into ``OMNIVOICE_MODEL`` (e.g. a stale pref/env) —
    is neither, and would crash model load with *"omnivoice is not a local folder
    and is not a valid model identifier listed on huggingface.co/models"* (#693).
    Fall back to the default rather than 500 on every launch.
    """
    checkpoint = os.environ.get("OMNIVOICE_MODEL", _DEFAULT_OMNIVOICE_CHECKPOINT).strip()
    if not checkpoint:
        return _DEFAULT_OMNIVOICE_CHECKPOINT
    # Honor a HF repo id (org/repo) or an EXPLICIT local path (absolute, or with
    # a path separator). A bare token like "omnivoice" must NOT be treated as a
    # local dir even if a cwd-relative folder happens to share its name — that
    # is exactly the engine-id leak (#693), so self-heal to the default.
    if "/" in checkpoint or "\\" in checkpoint or os.path.isabs(checkpoint):
        return checkpoint
    logger.warning(
        "OMNIVOICE_MODEL=%r is not a HuggingFace repo id (org/repo) or a local "
        "path — falling back to %s (#693).",
        checkpoint, _DEFAULT_OMNIVOICE_CHECKPOINT,
    )
    return _DEFAULT_OMNIVOICE_CHECKPOINT


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

        checkpoint = resolve_omnivoice_checkpoint()
        _set_loading("loading_weights", f"Loading TTS weights on {device}…")
        logger.info("Loading OmniVoice model on device: %s", device)
        preload_asr = should_preload_tts_asr()
        if preload_asr:
            logger.info("Preloading PyTorch Whisper with TTS model.")
        else:
            logger.info("Skipping PyTorch Whisper preload; ASR will load on demand.")
        def _load():
            return OmniVoice.from_pretrained(
                checkpoint, device_map=device, dtype=torch.float16, load_asr=preload_asr,
            )

        try:
            _model = _load()
        except OSError as e:
            # #352 / #581: a truncated HF cache surfaces here as "does not
            # appear to have a file named pytorch_model.bin or
            # model.safetensors". Instead of dead-ending the user with a
            # manual delete-and-reinstall instruction, try to self-repair: an
            # interrupted download leaves the cache missing only some files,
            # and snapshot_download() resumes/fills exactly those (a complete
            # cache never reaches this branch, so the fast path is untouched).
            if not _is_incomplete_cache_error(e):
                raise
            # Rung 0: broken snapshot links — the blobs are on disk but the
            # snapshot entries don't resolve (dangling symlinks / zero-byte
            # stand-ins). Delete exactly the broken entries, restore, and
            # retry the load ONCE (guarded per repo per process). A cache
            # without broken links falls straight through to the resume
            # ladder below.
            _model = None
            if _selfheal_broken_snapshot_links(checkpoint):
                _set_loading(
                    "loading_weights",
                    "Model cache had broken file links — repaired "
                    "automatically, retrying…",
                )
                try:
                    _model = _load()
                except OSError as e_link:
                    if not _is_incomplete_cache_error(e_link):
                        raise
                    logger.warning(
                        "Load still failing after snapshot-link repair of %s — "
                        "falling back to resume repair.", checkpoint,
                    )
                    e = e_link
                    _model = None
            if _model is None:
                _set_loading("loading_weights", "Repairing incomplete model cache…")
                if not _repair_model_cache(checkpoint):
                    raise RuntimeError(
                        f"The TTS model cache for {checkpoint} is incomplete "
                        "(weights missing — usually an interrupted download)."
                        f"{_repair_failure_detail()} "
                        "Open Settings → Models, delete the OmniVoice TTS model, "
                        f"and install it again.{_manual_cache_delete_hint(checkpoint)}"
                    ) from e
                _set_loading("loading_weights", f"Loading TTS weights on {device}…")
                try:
                    _model = _load()
                except OSError as e2:
                    # Resume-repair ran but the cache is still unusable. The usual
                    # cause beyond "repo genuinely lacks weights" is a blob that's
                    # present with the right size but corrupt — snapshot_download's
                    # resume trusts it and never re-fetches it (#739). Force a full
                    # re-download (replaces corrupt blobs) and retry once more before
                    # falling back to the manual delete-and-reinstall message.
                    if _is_incomplete_cache_error(e2):
                        _set_loading("loading_weights", "Re-downloading model files…")
                        if _repair_model_cache(checkpoint, force=True):
                            try:
                                _model = _load()
                            except OSError as e3:
                                raise RuntimeError(
                                    f"The TTS model cache for {checkpoint} is incomplete "
                                    "and could not be auto-repaired. Open Settings → "
                                    "Models, delete the OmniVoice TTS model, and install "
                                    f"it again.{_manual_cache_delete_hint(checkpoint)}"
                                ) from e3
                        else:
                            raise RuntimeError(
                                f"The TTS model cache for {checkpoint} is incomplete and "
                                f"could not be auto-repaired.{_repair_failure_detail()} "
                                "Open Settings → Models, delete the OmniVoice TTS model, "
                                f"and install it again.{_manual_cache_delete_hint(checkpoint)}"
                            ) from e2
                    else:
                        raise RuntimeError(
                            f"The TTS model cache for {checkpoint} is incomplete and "
                            "could not be auto-repaired. Open Settings → Models, delete "
                            "the OmniVoice TTS model, and install it again."
                            f"{_manual_cache_delete_hint(checkpoint)}"
                        ) from e2

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
        # Surface an ACTIONABLE, sanitized error in /model/status (it's shown in
        # the first-run System Check). build_failure classifies the cause and
        # attaches a fix hint — e.g. a corrupted transformers install
        # ([Errno 2] … modeling_*.py) now says "reinstall transformers" instead
        # of an unhelpful raw path + "try restarting" — and strips the home dir.
        try:
            from core.failure import build_failure
            _f = build_failure(exc, stage="model-load", include_diagnostic=False)
            err_msg = _f["reason"] + (f" — {_f['hint']}" if _f.get("hint") else "")
        except Exception:  # never let failure-formatting mask the real error
            err_msg = str(exc)
        _set_loading("error", "Model loading failed", error=err_msg)
        # #1000 class: transformers' lazy-import machinery wraps ANY disruption
        # to an inner import (including one interrupted by process teardown)
        # in a generic "Could not import module X. Are this object's
        # requirements defined correctly?" — logging only str(exc) discarded
        # the real cause in __cause__/__context__ and made a shutdown race
        # look like a broken install. exc_info surfaces the full chain.
        logger.error("Model loading failed: %s", str(exc), exc_info=exc)
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

    This is the shared load boundary for BOTH get_model() and the startup
    preload_model() — the memory reclaim must live here, or a memory-tight
    machine gets protected on demand loads but OS-killed during the startup
    preload (review finding on the original placement in get_model()).
    """
    _make_room_before_tts_load()
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


def _make_room_before_tts_load() -> None:
    """Evict-then-load: free what we already own before a tight TTS load.

    The audit's top gap: on a 16 GB unified-memory box a plain TTS load could
    still be OS-killed — the dub path frees memory before *ASR* loads
    (offload_tts_for_asr, #1119), but nothing freed memory before a *TTS*
    load, and a warm dictation model (~2 GB) is routinely the difference.

    Deliberately NOT admission control: refusing a load on an estimate would
    brick machines that would actually cope (the #1111 decision — advisory
    only). This only releases things the app already reclaims on idle anyway
    (the capture-ASR model, engine instances, allocator caches), just *now*
    instead of after the idle timeout — and only when free memory is actually
    tight, so a roomy machine pays nothing.
    """
    try:
        from services.memory_budget import available_memory
        free_gb = (available_memory() or {}).get("ram_available_gb")
        if free_gb is None or free_gb >= _UNIFIED_OFFLOAD_HEADROOM_GB:
            return
        logger.info(
            "Memory tight before TTS load (%.1f GB free) — releasing idle "
            "models first.", free_gb,
        )
        try:
            from services.asr_backend import release_idle_capture_backend
            release_idle_capture_backend(0.0)  # 0s idle = release if unleased
        except Exception:  # noqa: BLE001 — best-effort, never block the load
            logger.debug("capture-ASR pre-load release failed", exc_info=True)
        release_tts_side_caches()
        free_vram()
    except Exception:  # noqa: BLE001 — making room must never break loading
        logger.debug("pre-load memory reclaim skipped", exc_info=True)


def _checkpoint_in_local_cache(checkpoint: str) -> bool:
    """True when ``checkpoint`` is loadable with NO network: an existing local
    directory, or a COMPLETE HF cache snapshot. ``snapshot_download(...,
    local_files_only=True)`` never constructs an HTTP session, so a broken
    proxy env (#959: ``ALL_PROXY``/``HTTPS_PROXY=socks5://`` without socksio)
    can't false-negative this probe. Never raises."""
    if os.path.isdir(checkpoint):
        return True
    try:
        from huggingface_hub import snapshot_download
        snapshot_download(checkpoint, local_files_only=True)
        return True
    except Exception:
        return False


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
        # a heavy load that would fail and pollute startup logs. Use the same
        # resolver as the load path (#693) so a leaked engine id in
        # OMNIVOICE_MODEL can't make this model_info() probe fail and silently
        # disable warm-up (then the first /generate eats the full load).
        checkpoint = resolve_omnivoice_checkpoint()
        try:
            from huggingface_hub import model_info
            model_info(checkpoint, timeout=5)
        except Exception as probe_err:
            # The probe failing does NOT mean the model isn't installed — it
            # means the Hub API wasn't reachable from this process. The #959
            # class: under ALL_PROXY/HTTPS_PROXY=socks5:// without socksio,
            # hf_hub's get_session() raises ImportError AT CLIENT CONSTRUCTION;
            # same story for offline mode, DNS, or firewall failures. Fall back
            # to a cache-only probe (no HTTP session involved) and warm up
            # anyway when the model is locally present, instead of silently
            # skipping and letting the first /generate eat the full load.
            if not _checkpoint_in_local_cache(checkpoint):
                logger.info(
                    "Preload skipped: %s not available locally (network probe "
                    "failed: %s: %s).",
                    checkpoint, type(probe_err).__name__, probe_err,
                )
                return
            logger.warning(
                "Network probe for %s failed (%s: %s) — model found in the "
                "local cache; warming up from cache.",
                checkpoint, type(probe_err).__name__, probe_err,
            )

        logger.info("Preloading TTS model in background…")
        _last_used = time.time()
        async with _model_lock:
            if model is None:
                model = await _load_model_with_timeout()
        logger.info("Preload complete — model ready.")
    except Exception as e:
        # See the matching exc_info note on the _load_model_sync handler above
        # (#1000 class) — the full chain, not just str(e), is what actually
        # distinguishes a real dependency problem from a shutdown-interrupted
        # import.
        logger.warning("Model preload failed (non-fatal): %s", e, exc_info=e)

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
        idle_timeout = _resolve_idle_timeout()
        async with _model_lock:
            if model is not None and time.time() - _last_used > idle_timeout:
                logger.info("Idle timeout reached. Unloading OmniVoice model to free VRAM.")
                model = None
                release_tts_side_caches()
                free_vram()
        # The capture/dictation ASR was never idle-released — so once a user
        # dictated, its model stayed resident for the life of the process while
        # the TTS model dutifully freed its 3.8 GB. On a 16 GB Mac that left the
        # backend sitting at ~6.2 GB idle, which is what tipped it into the
        # memory pressure that gets it killed mid-generate (#1076/#1092/#1093/
        # #1101). Give it the same bargain the TTS model already makes. Held
        # off while a live dictation stream has a lease, so nothing is unloaded
        # mid-sentence.
        try:
            from services.asr_backend import release_idle_capture_backend

            if release_idle_capture_backend(idle_timeout):
                free_vram()
        except Exception:  # noqa: BLE001 — the reaper must never kill idle_worker
            logger.warning("idle capture-ASR release failed", exc_info=True)

def release_tts_side_caches():
    """Drop caches keyed to the TTS model, for when the model itself is released.

    The voice-clone prompt cache (services.tts_backend) holds encoded reference
    tensors belonging to *this* model instance. If the model is unloaded but the
    prompts survive, an "unload" no longer means unload (#1119) — they sit in the
    very memory the unload was reclaiming (``_offload_unified_memory`` drops the
    model precisely to hand that RAM to the ASR model).

    Previously only ``OmniVoiceBackend.unload()`` cleared them, which sufficed
    while the cache was adapter-only. The native ``/generate`` path now populates
    it too, and that path unloads through *here*, never through the adapter.

    Reached through ``sys.modules`` rather than an import, deliberately:
    ``tts_backend`` already imports this module, so importing it back would close
    a real cycle — and doing it at *import* time (e.g. a registration hook) drags
    ``core.config`` in earlier than it is today, which perturbs DATA_DIR binding.
    A plain lookup has neither problem, and is exactly right besides: if the module
    was never imported, it has no cache to clear.

    Best-effort by construction — cache hygiene must never be able to break an
    unload, because a failed unload is how the backend gets OOM-killed.
    """
    mod = sys.modules.get("services.tts_backend")
    if mod is None:
        return
    try:
        mod.clear_clone_prompt_cache()
    except Exception:  # noqa: BLE001
        logger.debug("clone-prompt cache clear failed during unload", exc_info=True)


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



# Free RAM below which the TTS model is released before ASR loads on a
# unified-memory machine. WhisperX large-v3 needs ~3 GB plus VAD and overhead,
# so a box with less than this much headroom cannot hold both — and on a Mac the
# loser is the whole backend process (the OS kills it). Tunable for bigger boxes.
_UNIFIED_OFFLOAD_HEADROOM_GB = float(
    os.environ.get("OMNIVOICE_UNIFIED_OFFLOAD_HEADROOM_GB", "6.0")
)


def _offload_unified_memory() -> bool:
    """Release the TTS model on a unified-memory host when RAM is tight.

    Returns True when the model was actually released. Never raises — a failure
    to make room must not abort the transcription that asked for it."""
    global model
    try:
        from services.memory_budget import available_memory

        free_gb = available_memory().get("ram_available_gb")
        if free_gb is not None and free_gb > _UNIFIED_OFFLOAD_HEADROOM_GB:
            return False  # plenty of room — keep the model warm, pay no reload
        logger.info(
            "Unified memory tight (%s GB free) — releasing the TTS model so ASR has room "
            "(it reloads on the next generation).",
            "unknown" if free_gb is None else f"{free_gb:.1f}",
        )
        model = None
        release_tts_side_caches()
        free_vram()
        return True
    except Exception as e:  # noqa: BLE001
        logger.warning("unified-memory TTS offload failed (continuing): %s", e)
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
        # UNIFIED MEMORY (Apple Silicon / CPU). Moving the model "to CPU" frees
        # nothing here — it is the same physical RAM — which is why this used to
        # bail out entirely. But the conclusion was wrong: the fix on unified
        # memory isn't to MOVE the model, it's to RELEASE it.
        #
        # Holding the ~3.8 GB TTS model resident while WhisperX large-v3 (~3 GB)
        # loads on top of it is what gets the backend OOM-killed mid-dub on a
        # 16 GB Mac (#1119) — the transcribe stream just dies. Unload it and the
        # room is real. get_model() lazily reloads on the next TTS use, so the
        # only cost is that reload, and only when memory was actually tight.
        _offload_unified_memory()
        return
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
        # Nothing to restore on unified memory: offload UNLOADED the model, and
        # get_model() reloads it lazily on the next TTS call. Reloading it here
        # would just re-occupy the RAM we freed, right when the dub still has
        # translation and synthesis ahead of it.
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
