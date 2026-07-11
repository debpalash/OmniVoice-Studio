"""
Engines router — Phase 3 wiring.

Exposes the three adapter registries (TTS, ASR, LLM) so the Settings UI can
render an engine picker + availability reasons.

    GET  /engines                       → { tts, asr, llm }
    GET  /engines/{family}              → list of backends
    POST /engines/select                → persist a backend choice in prefs.json
    GET  /engines/{engine_id}/health    → spawn-or-ping for SubprocessBackend
                                          subclasses; ``is_available()`` for
                                          in-process backends (Plan 02-04)

Environment variables (`OMNIVOICE_TTS_BACKEND`, `OMNIVOICE_ASR_BACKEND`,
`OMNIVOICE_LLM_BACKEND`) still win over the UI choice so power-users can pin
a backend without Settings silently undoing it.
"""
import os
import re
import threading
from time import perf_counter

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api.dependencies import require_loopback
from core import prefs
from services import tts_backend, asr_backend, llm_backend, translation_engines
from services.audio_dsp import list_effect_presets
from api.schemas import EffectPresetsResponse

router = APIRouter()

_FAMILIES = {
    "tts": (tts_backend, "tts_backend"),
    "asr": (asr_backend, "asr_backend"),
    "llm": (llm_backend, "llm_backend"),
}


@router.get("/engines")
def list_all_engines():
    return {
        "tts": {
            "active": tts_backend.active_backend_id(),
            "backends": tts_backend.list_backends(),
        },
        "asr": {
            "active": asr_backend.active_backend_id(),
            "backends": asr_backend.list_backends(),
        },
        "llm": {
            "active": llm_backend.active_backend_id(),
            "backends": llm_backend.list_backends(),
        },
    }


@router.get("/engines/tts")
def list_tts_backends():
    return {"active": tts_backend.active_backend_id(), "backends": tts_backend.list_backends()}


@router.get("/engines/asr")
def list_asr_backends():
    return {"active": asr_backend.active_backend_id(), "backends": asr_backend.list_backends()}


@router.get("/engines/llm")
def list_llm_backends():
    return {"active": llm_backend.active_backend_id(), "backends": llm_backend.list_backends()}


@router.get("/engines/effects/presets", response_model=EffectPresetsResponse)
def list_effects_presets():
    """Return available DSP effect presets for the dub pipeline.

    Each preset is a named chain of audio effects (EQ, compressor, reverb, etc.)
    that can be applied to generated TTS audio on a per-segment basis.
    """
    return {"presets": list_effect_presets()}


@router.get("/engines/translation")
def list_translation_engines():
    """Translation engines with per-engine pip-package availability.

    Separate from the tts/asr/llm "family" endpoints because these are
    pip-installable on demand rather than select-from-what's-available.
    The UI uses this to show a one-click Install chip when the user picks
    an engine whose Python dependency isn't importable yet.
    """
    return {
        "engines": translation_engines.list_engines(),
        "sandboxed": translation_engines.is_frozen(),
    }


@router.post("/engines/translation/{engine_id}/install")
async def install_translation_engine(engine_id: str):
    entry = translation_engines.get_engine(engine_id)
    if not entry:
        raise HTTPException(status_code=404, detail=f"Unknown translation engine: {engine_id!r}")
    if translation_engines.is_frozen():
        raise HTTPException(
            status_code=400,
            detail=(
                "Engine install is disabled in the packaged build — the "
                "bundled Python environment is read-only and signed. Run the "
                "source/dev install (`uv sync`) if you need to add an engine."
            ),
        )
    pkg = entry.get("pip_package")
    if not pkg:
        return {"status": "already_installed", "engine": engine_id, "reason": "no pip package required"}
    if translation_engines.is_installed(engine_id):
        return {"status": "already_installed", "engine": engine_id}
    rc, out = await translation_engines.run_pip(["install", pkg])
    if rc != 0:
        raise HTTPException(status_code=500, detail=f"pip install {pkg} failed ({rc}): {out[-1000:]}")
    # Probe again so the response reflects post-install reality; site-packages
    # is visible immediately but importlib may have cached a failure.
    import importlib
    importlib.invalidate_caches()
    ok = translation_engines.is_installed(engine_id)
    return {
        "status": "installed" if ok else "installed_but_probe_failed",
        "engine": engine_id,
        "package": pkg,
        "log_tail": out[-800:],
        "restart_required": not ok,
    }


@router.delete("/engines/translation/{engine_id}")
async def uninstall_translation_engine(engine_id: str):
    entry = translation_engines.get_engine(engine_id)
    if not entry:
        raise HTTPException(status_code=404, detail=f"Unknown translation engine: {engine_id!r}")
    if entry.get("builtin"):
        raise HTTPException(
            status_code=400,
            detail=(
                f"{entry['display_name']} is built-in and cannot be uninstalled. "
                "It shares its Python dependency with core features."
            ),
        )
    if translation_engines.is_frozen():
        raise HTTPException(status_code=400, detail="Engine uninstall is disabled in packaged builds.")
    pkg = entry.get("pip_package")
    if not pkg:
        return {"status": "no_op", "engine": engine_id}
    rc, out = await translation_engines.run_pip(["uninstall", "-y", pkg])
    if rc != 0:
        raise HTTPException(status_code=500, detail=f"pip uninstall {pkg} failed ({rc}): {out[-1000:]}")
    return {"status": "uninstalled", "engine": engine_id, "package": pkg, "log_tail": out[-800:]}


# ── One-click sidecar-engine install (IndexTTS-2 & friends) ────────────────
#
# Sidecar engines (dedicated venv + source checkout + weights, isolated from
# the parent's transformers>=5.3) used to require four manual terminal steps.
# These routes drive services.sidecar_install: POST starts a resumable
# background job, GET polls its step-by-step status (the Settings → Engines
# Install button polls this), DELETE removes an app-managed install.
#
# Path namespace: /engines/sidecar/{engine_id}/… — NOT /engines/{engine_id}/…
# — because a dynamic segment there would shadow pre-existing literal routes
# (this router registers before sonitranslate's, so a dynamic
# POST /engines/{engine_id}/install would swallow
# POST /engines/sonitranslate/install). Mirrors the
# /engines/translation/{engine_id}/install namespace pattern.
#
# Loopback-gated: installing spawns subprocesses (git/uv) and writes to the
# data directory — only the local desktop frontend may trigger it. The job
# runs fine in packaged builds: the venv lives under the user data dir, not
# inside the signed app bundle, and uv resolves via OMNIVOICE_BUNDLED_UV/PATH.


@router.post(
    "/engines/sidecar/{engine_id}/install",
    dependencies=[Depends(require_loopback)],
)
def install_sidecar_engine(engine_id: str):
    """Start (or report) the one-click install for a sidecar engine.

    Returns ``{status: "started"|"already_running"|"already_installed"}``.
    404 for engines that have no sidecar installer — the response names the
    translation-engine route so a mis-aimed client can self-correct.
    """
    from services import sidecar_install
    try:
        return sidecar_install.start_install(engine_id)
    except KeyError:
        raise HTTPException(
            status_code=404,
            detail=(
                f"No one-click installer for engine {engine_id!r}. Sidecar "
                f"installers exist for: {sorted(sidecar_install.SPECS)}. "
                "(Translation engines install via POST "
                "/engines/translation/{id}/install.)"
            ),
        )


@router.get(
    "/engines/sidecar/{engine_id}/install/status",
    dependencies=[Depends(require_loopback)],
)
def sidecar_install_status(engine_id: str):
    """Step-by-step status of the sidecar install job (poll while running).

    Shape: ``{engine_id, installed, managed, install_dir, job}`` where job is
    null before the first run, else ``{state, steps[], log[], error,
    remediation, weights_progress, started_at, finished_at}``.
    """
    from services import sidecar_install
    try:
        return sidecar_install.get_status(engine_id)
    except KeyError:
        raise HTTPException(
            status_code=404,
            detail=f"No one-click installer for engine {engine_id!r}.",
        )


@router.delete(
    "/engines/sidecar/{engine_id}/install",
    dependencies=[Depends(require_loopback)],
)
def uninstall_sidecar_engine(engine_id: str):
    """Remove an app-managed sidecar install (checkout + venv + weights) and
    clear the persisted path. Refuses user-managed installs (a clone the user
    made themselves) and installs with a job still running."""
    from services import sidecar_install
    try:
        res = sidecar_install.uninstall(engine_id)
    except KeyError:
        raise HTTPException(
            status_code=404,
            detail=f"No one-click installer for engine {engine_id!r}.",
        )
    if res["status"] == "install_in_progress":
        raise HTTPException(status_code=409, detail="Install is still running — wait for it to finish.")
    if res["status"] == "not_managed":
        raise HTTPException(status_code=400, detail=res["detail"])
    return res


# ── Engine health-check (Plan 02-04 / ENGINE-06) ───────────────────────────
#
# The Compat Matrix UI's "Test engine" button calls into this endpoint so
# that users can verify a SubprocessBackend engine is alive without
# kicking off a full synthesize. For an in-process backend the check is a
# cheap ``is_available()`` round-trip; for a SubprocessBackend subclass
# the call spawns the sidecar (if not already up) and round-trips a ping
# frame. Result includes wall-clock latency so the UI can render
# "1234 ms — pong" inline next to the button.
#
# Loopback-gated (T-02-13): only the local desktop frontend may trigger
# a sidecar spawn through this endpoint.

# Engine instances cached for the lifetime of the FastAPI process so that
# repeated health checks don't spawn a new SubprocessBackend (each spawn
# allocates a sidecar venv probe + atexit hook). The cache is keyed by
# class to survive registry-sandbox tests that rebind ids transiently.
_ENGINE_INSTANCES: dict[type, object] = {}


def _get_engine_instance(cls):
    """Return a cached singleton instance of ``cls``.

    SubprocessBackend's ``__init__`` registers an atexit shutdown hook,
    so re-instantiating per request would leak handler entries (and on
    real engines, additional sidecar processes the first time the lock
    is acquired). One instance per process is the right move.
    """
    inst = _ENGINE_INSTANCES.get(cls)
    if inst is None:
        inst = cls()
        _ENGINE_INSTANCES[cls] = inst
    return inst


def _resolve_engine_class(engine_id: str):
    """Look up ``engine_id`` across the tts/asr/llm registries.

    Returns the class or ``None`` if no family knows the id. Order is
    tts → asr → llm so the most-common case (TTS engine matrix) wins
    early. No collision risk today — all current ids are family-unique.
    """
    for registry in (
        tts_backend._REGISTRY,
        asr_backend._REGISTRY,
        llm_backend._REGISTRY,
    ):
        if engine_id in registry:
            return registry[engine_id]
    return None


@router.get(
    "/engines/{engine_id}/health",
    dependencies=[Depends(require_loopback)],
)
def engine_health(engine_id: str):
    """Spawn-and-ping a SubprocessBackend; ``is_available()`` for the rest.

    Returns:
        { id, ok, message, latency_ms }

    Never raises through to a 500: if the backend's check throws, the
    exception is captured into the response body as ``ok=False`` /
    ``message="ExcType: ..."`` so the UI can render a per-row failure
    without crashing the panel. Unknown engine ids return 404.
    """
    cls = _resolve_engine_class(engine_id)
    if cls is None:
        raise HTTPException(
            status_code=404,
            detail=f"unknown engine id: {engine_id!r}",
        )

    t0 = perf_counter()
    if hasattr(cls, "health_check"):
        # SubprocessBackend path — spawn sidecar (if not running) and ping.
        # ``health_check`` already swallows its own exceptions per Plan
        # 02-01's contract; we still wrap in a defensive try so a custom
        # subclass that violates the contract can't 500 the endpoint.
        try:
            instance = _get_engine_instance(cls)
            ok, msg = instance.health_check()
        except Exception as exc:
            ok, msg = False, f"{type(exc).__name__}: {exc}"
    else:
        # In-process backend — `is_available()` is the classmethod-level
        # liveness check. Cheap and side-effect-free for every shipping
        # backend (it imports the engine package, no model load).
        try:
            ok, msg = cls.is_available()
        except Exception as exc:
            ok, msg = False, f"{type(exc).__name__}: {exc}"

    # Mask any HF token the engine accidentally leaked into the message
    # so the response body matches the same redaction guarantee as
    # ``list_backends()``.
    from services.tts_backend import _mask_hf_tokens

    latency_ms = (perf_counter() - t0) * 1000.0
    return {
        "id": engine_id,
        "ok": bool(ok),
        "message": _mask_hf_tokens(msg) if isinstance(msg, str) else str(msg),
        "latency_ms": latency_ms,
    }


# ── Real-synthesis self-test (in-process TTS engines) ──────────────────────
#
# ``/health`` above is a liveness/import probe — for an in-process backend it
# only calls ``is_available()`` and the UI labels the result "deps OK". This
# route goes one step further: for an AVAILABLE, IN-PROCESS TTS engine it runs
# a *tiny real synthesis* from a fixed short phrase and reports duration +
# sample-rate + sample count, proving the engine actually emits audio rather
# than merely importing. The Compat Matrix's "Self-test" button calls it.
#
# Guardrails (kept identical across macOS/Windows/Linux per the default-feature
# rule — the phrase, timeout and gating don't branch on OS):
#   * TTS family + available + in-process only. Subprocess engines keep their
#     spawn-and-ping ``health_check`` (a real synth there is a sidecar
#     cold-start — out of scope for a click-to-test affordance).
#   * Bounded wall-clock timeout (``OMNIVOICE_SELFTEST_TIMEOUT_S``, default 90s):
#     a runaway synth returns ``ok=False`` / ``timed_out=True`` instead of
#     hanging the Settings panel. The orphaned worker is best-effort daemon.
#   * A process-wide lock serialises self-tests so a click-storm can't stack
#     concurrent model loads.
#   * Only ever on user click (POST) — never on Settings load. Loopback-gated.

# Deliberately short + ASCII so the synth stays CPU-cheap and the phrase never
# trips the no-hardcoded-CJK guard.
_SELFTEST_PHRASE = "OmniVoice engine self test."
_SELFTEST_LOCK = threading.Lock()


def _selftest_timeout_s() -> float:
    try:
        return max(1.0, float(os.environ.get("OMNIVOICE_SELFTEST_TIMEOUT_S", "90")))
    except (TypeError, ValueError):
        return 90.0


def _sample_count(audio) -> int:
    """Total sample count of an engine's ``generate()`` return, tolerant of
    torch.Tensor / numpy.ndarray / list shapes. 0 when it can't be measured."""
    try:
        shape = getattr(audio, "shape", None)
        if shape is not None and len(shape) > 0:
            return int(shape[-1])
        return int(len(audio))
    except Exception:
        return 0


def _run_synth_bounded(backend, timeout_s: float) -> dict | None:
    """Run one tiny synthesis in a daemon thread, bounded by ``timeout_s``.

    Returns ``{"audio": .., "duration_ms": ..}`` on success, ``{"error": exc}``
    on a synth exception, or ``None`` when the timeout elapsed (worker left
    running best-effort — Python threads can't be force-killed)."""
    box: dict = {}

    def _worker():
        t0 = perf_counter()
        try:
            audio = backend.generate(_SELFTEST_PHRASE, language="en", num_step=8)
            box["audio"] = audio
        except Exception as exc:  # noqa: BLE001 — surfaced to the caller as ok=False
            box["error"] = exc
        finally:
            box["duration_ms"] = (perf_counter() - t0) * 1000.0

    th = threading.Thread(target=_worker, name="engine-selftest", daemon=True)
    th.start()
    th.join(timeout_s)
    if th.is_alive():
        return None
    return box


class SelfTestResponse(BaseModel):
    id: str
    ok: bool
    message: str
    duration_ms: float
    sample_rate: int | None = None
    num_samples: int | None = None
    audio_seconds: float | None = None
    timed_out: bool = False


@router.post(
    "/engines/{engine_id}/selftest",
    response_model=SelfTestResponse,
    dependencies=[Depends(require_loopback)],
)
def engine_selftest(engine_id: str):
    """Run a bounded, real synthesis on an available in-process TTS engine.

    404 for an unknown TTS id; 400 when the engine is subprocess-isolated or
    not currently available (a real synth on either is meaningless). Never
    raises through to a 500 on a synth failure — the exception is captured into
    ``ok=False`` / ``message`` so the panel renders a per-row failure."""
    if engine_id not in tts_backend._REGISTRY:
        raise HTTPException(
            status_code=404,
            detail=f"unknown TTS engine id: {engine_id!r}",
        )
    cls = tts_backend._REGISTRY[engine_id]
    if getattr(cls, "_is_subprocess_isolated", False):
        raise HTTPException(
            status_code=400,
            detail=(
                f"{engine_id} is subprocess-isolated — self-test runs real "
                "synthesis for in-process engines only. Use Test engine "
                "(spawn-and-ping) for subprocess engines."
            ),
        )
    try:
        ok, msg = cls.is_available()
    except Exception as exc:  # noqa: BLE001
        ok, msg = False, f"{type(exc).__name__}: {exc}"
    if not ok:
        raise HTTPException(
            status_code=400,
            detail=(
                f"{engine_id} is not available: {tts_backend._mask_hf_tokens(msg)}. "
                "Install/enable the engine, then self-test."
            ),
        )

    timeout_s = _selftest_timeout_s()
    # Serialise so a click-storm can't stack concurrent model loads.
    with _SELFTEST_LOCK:
        backend = _get_engine_instance(cls)
        res = _run_synth_bounded(backend, timeout_s)

    if res is None:
        return SelfTestResponse(
            id=engine_id,
            ok=False,
            message=f"timed out after {timeout_s:.0f}s (model still loading?)",
            duration_ms=timeout_s * 1000.0,
            timed_out=True,
        )
    if "error" in res:
        exc = res["error"]
        return SelfTestResponse(
            id=engine_id,
            ok=False,
            message=tts_backend._mask_hf_tokens(f"{type(exc).__name__}: {exc}"),
            duration_ms=res.get("duration_ms", 0.0),
        )

    n = _sample_count(res.get("audio"))
    try:
        sr = int(getattr(backend, "sample_rate", 0) or 0) or None
    except Exception:
        sr = None
    secs = round(n / sr, 3) if (sr and n) else None
    return SelfTestResponse(
        id=engine_id,
        ok=n > 0,
        message="synthesized" if n > 0 else "engine returned no audio",
        duration_ms=res["duration_ms"],
        sample_rate=sr,
        num_samples=n or None,
        audio_seconds=secs,
    )


class SelectEngineRequest(BaseModel):
    family: str   # "tts" | "asr" | "llm"
    backend_id: str
    # Only meaningful for family="tts", backend_id="mlx-audio" (#981) — picks
    # which of mlx-audio's curated models is actually loaded. A curated key
    # ("kokoro") or a raw HF repo id ("mlx-community/Kokoro-82M-bf16") — the
    # same tolerance MLXAudioBackend.__init__ already has. Ignored otherwise.
    model_id: str | None = None


class SelectEngineResponse(BaseModel):
    family: str
    active: str
    env_override: bool
    # Routing verdict for the selected engine on THIS host (#21). Always present
    # so the UI can show a confirm/warning toast on a cpu_fallback pick without
    # branching on key presence; defaults match a legacy/degraded row.
    routing_status: str = "cpu_only"
    effective_device: str = "cpu"
    routing_reason: str | None = None


@router.post("/engines/select", response_model=SelectEngineResponse)
def select_engine(req: SelectEngineRequest):
    """Persist a family's engine pick to prefs.json. Refuses unknown backends,
    backends whose deps aren't installed, AND backends that cannot run on THIS
    host's hardware (routing_status == "unavailable") — so the UI can't silently
    brick a pipeline by picking an engine that needs a GPU this machine lacks.
    A `cpu_fallback` pick is allowed (it runs, just slower) — only a hard
    `unavailable` is blocked. LLM is never routing-gated (its status is "n/a")."""
    family = _FAMILIES.get(req.family)
    if not family:
        raise HTTPException(400, f"Unknown family: {req.family}. Expected one of tts/asr/llm.")
    module, pref_key = family
    available = {b["id"]: b for b in module.list_backends()}
    if req.backend_id not in available:
        raise HTTPException(400, f"Unknown {req.family} backend: {req.backend_id!r}")
    entry = available[req.backend_id]
    if not entry["available"]:
        reason = entry.get("reason") or "unavailable"
        raise HTTPException(400, f"Backend {req.backend_id} not ready: {reason}")
    # Host-routing gate (no silent CPU fallback). `.get` is defensive so an
    # older/legacy payload without routing keys still selects cleanly.
    if entry.get("routing_status") == "unavailable":
        why = entry.get("routing_reason") or "requires a GPU this host doesn't have"
        raise HTTPException(
            400,
            f"Backend {req.backend_id} can't run on this machine: {why}. "
            f"Pick an engine with a CPU path, or one that supports this host's GPU.",
        )
    # #981: mlx-audio multiplexes 7+ curated models behind one backend id —
    # persist the model pick alongside the backend id so the UI can actually
    # select which curated model gets loaded (previously it always defaulted
    # to Kokoro no matter what the user downloaded in Settings → Models).
    if req.family == "tts" and req.backend_id == "mlx-audio" and req.model_id is not None:
        known_keys = tts_backend.MLXAudioBackend.CURATED_MODELS
        # Accept a curated key OR a raw HF repo id ("owner/name") — the same
        # tolerance MLXAudioBackend.__init__ already has for power users.
        # Anything else (typo'd key, malformed id) is rejected outright
        # rather than silently persisted as a "custom repo" that then fails
        # to resolve at load time.
        if req.model_id not in known_keys and not re.fullmatch(r"[\w.-]+/[\w.-]+", req.model_id):
            raise HTTPException(
                400,
                f"Unknown mlx-audio model: {req.model_id!r}. Expected one of "
                f"{sorted(known_keys)} or a HF repo id like 'owner/name'.",
            )
        prefs.set_("mlx_audio_model_id", req.model_id)
    prefs.set_(pref_key, req.backend_id)
    return {
        "family": req.family,
        "active": module.active_backend_id(),
        "env_override": bool(__import__("os").environ.get(f"OMNIVOICE_{req.family.upper()}_BACKEND")),
        # Echo the routing verdict so the UI can warn on a cpu_fallback pick.
        "routing_status": entry.get("routing_status", "cpu_only"),
        "effective_device": entry.get("effective_device", "cpu"),
        "routing_reason": entry.get("routing_reason"),
    }
