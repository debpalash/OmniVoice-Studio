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


class SelectEngineRequest(BaseModel):
    family: str   # "tts" | "asr" | "llm"
    backend_id: str


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
