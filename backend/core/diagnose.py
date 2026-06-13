"""Self-check diagnostics — answers "why doesn't it work on my machine?"

One pass over everything a working install needs: Python, compute device,
ffmpeg, HF token, disk, data-dir permissions, RAM, TTS engines, and (when
requested) network reachability of the HuggingFace hub. Surfaced two ways:

  - ``GET /system/diagnose`` (Settings > About -> "Run self-check")
  - ``python main.py --diagnose`` for headless installs / issue triage

Every ``detail``/``hint`` string is passed through ``core.scrub`` before it
leaves this module, so the report is safe to paste straight into a GitHub
issue — that's its whole purpose.

Check shape:

    {"id": str, "label": str, "status": "ok"|"warn"|"fail",
     "detail": str, "hint": Optional[str]}

``fail`` = the app cannot do its job (no disk, unwritable data dir).
``warn`` = degraded but usable (CPU-only, no HF token, hub unreachable).
"""
from __future__ import annotations

import os
import platform
import shutil
import sys

from core.config import DATA_DIR
from core.scrub import scrub_text
from core.version import APP_VERSION

OK = "ok"
WARN = "warn"
FAIL = "fail"

# Below this much free disk the model cache can't even hold one engine.
_DISK_FAIL_GB = 2
_DISK_WARN_GB = 10
_RAM_WARN_GB = 8

_HUB_URL = "https://huggingface.co"
_HUB_TIMEOUT_S = 5


def _check(check_id: str, label: str, status: str, detail: str, hint: str | None = None) -> dict:
    return {
        "id": check_id,
        "label": label,
        "status": status,
        "detail": scrub_text(detail),
        "hint": scrub_text(hint) if hint else None,
    }


def _check_python() -> dict:
    return _check(
        "python", "Python runtime", OK,
        f"{sys.version.split()[0]} on {platform.platform()}",
    )


def _check_device() -> dict:
    try:
        from services.model_manager import get_best_device
        device = get_best_device()
    except Exception as e:
        return _check(
            "device", "Compute device", FAIL,
            f"device detection failed: {e}",
            "Reinstall may be needed - torch could not initialize.",
        )
    gpu_name = ""
    try:
        import torch
        if torch.cuda.is_available():
            gpu_name = torch.cuda.get_device_name(0)
    except Exception:
        pass
    if device == "cpu":
        return _check(
            "device", "Compute device", WARN,
            "cpu (no GPU acceleration detected)",
            "Generation will be slow. If this machine has a GPU, check CUDA/ROCm drivers (Linux/Windows) or that you're on Apple Silicon (macOS).",
        )
    detail = f"{device} ({gpu_name})" if gpu_name else device
    return _check("device", "Compute device", OK, detail)


def _check_ffmpeg() -> dict:
    try:
        from services.ffmpeg_utils import find_ffmpeg
        path = find_ffmpeg()
    except Exception:
        path = None
    if path:
        return _check("ffmpeg", "ffmpeg", OK, str(path))
    return _check(
        "ffmpeg", "ffmpeg", FAIL,
        "not found on PATH or FFMPEG_PATH",
        "Dubbing and audio conversion need ffmpeg: brew install ffmpeg (macOS), apt install ffmpeg (Linux), or set the path in Settings > General.",
    )


def _check_hf_token() -> dict:
    # Presence only — the resolver never hands us the raw token and we
    # wouldn't print it anyway.
    try:
        from services import token_resolver
        present = token_resolver.resolve() is not None
    except Exception:
        present = False
    if present:
        return _check("hf_token", "HuggingFace token", OK, "configured")
    return _check(
        "hf_token", "HuggingFace token", WARN,
        "not set",
        "Downloads may be rate-limited and speaker diarization won't work. Set one in Settings > Credentials.",
    )


def _check_disk() -> dict:
    try:
        usage = shutil.disk_usage(DATA_DIR)
    except Exception as e:
        return _check("disk", "Disk space", WARN, f"could not stat {DATA_DIR}: {e}")
    free_gb = usage.free / (1024 ** 3)
    detail = f"{free_gb:.1f} GB free at {DATA_DIR}"
    if free_gb < _DISK_FAIL_GB:
        return _check(
            "disk", "Disk space", FAIL, detail,
            "Model downloads need several GB. Free up space or move OMNIVOICE_DATA_DIR to a larger volume.",
        )
    if free_gb < _DISK_WARN_GB:
        return _check(
            "disk", "Disk space", WARN, detail,
            "Engine model downloads can be 1-4 GB each; you may run out mid-download.",
        )
    return _check("disk", "Disk space", OK, detail)


def _check_data_dir() -> dict:
    probe = os.path.join(DATA_DIR, ".diagnose_write_probe")
    try:
        with open(probe, "w") as f:
            f.write("ok")
        os.remove(probe)
        return _check("data_dir", "Data directory", OK, f"writable: {DATA_DIR}")
    except Exception as e:
        return _check(
            "data_dir", "Data directory", FAIL,
            f"not writable: {DATA_DIR} ({e})",
            "Voices, projects, and logs all live here. Fix permissions or point OMNIVOICE_DATA_DIR somewhere writable.",
        )


def _check_ram() -> dict:
    try:
        import psutil
        total_gb = psutil.virtual_memory().total / (1024 ** 3)
    except Exception as e:
        return _check("ram", "System memory", WARN, f"could not read: {e}")
    detail = f"{total_gb:.1f} GB total"
    if total_gb < _RAM_WARN_GB:
        return _check(
            "ram", "System memory", WARN, detail,
            "Large engines may swap or OOM below 8 GB. Prefer lighter engines and close other apps while generating.",
        )
    return _check("ram", "System memory", OK, detail)


def _check_engines() -> dict:
    try:
        from services.tts_backend import list_backends, active_backend_id
        backends = list_backends()
        active = active_backend_id()
    except Exception as e:
        return _check("engines", "TTS engines", WARN, f"could not enumerate: {e}")
    available = [b["id"] for b in backends if b.get("available")]
    detail = f"active: {active}; available: {', '.join(available) or 'none'}"
    active_row = next((b for b in backends if b.get("id") == active), None)
    if active_row is not None and not active_row.get("available"):
        reason = active_row.get("reason") or "unavailable"
        return _check(
            "engines", "TTS engines", FAIL,
            f"{detail} - active engine '{active}' is unavailable: {reason}",
            active_row.get("install_hint") or "Pick a different engine in Settings > Engines.",
        )
    if not available:
        return _check(
            "engines", "TTS engines", FAIL, detail,
            "No usable TTS engine. Install one from Settings > Engines.",
        )
    return _check("engines", "TTS engines", OK, detail)


def _check_gpu_routing() -> dict:
    """Routing verdict for the active TTS engine on THIS host (#21).

    Surfaces a CPU fallback / unavailable-GPU *before* a slow or failed synth —
    the no-silent-fallback contract. `cpu_only` on a no-GPU machine is the
    expected normal state and stays OK (never noise-warns)."""
    try:
        from services.tts_backend import gpu_routing_verdict
        v = gpu_routing_verdict()
    except Exception as e:
        return _check("gpu_routing", "GPU routing", WARN, f"could not resolve: {e}")

    status = v.get("routing_status")
    engine = v.get("engine") or "active engine"
    dev = v.get("effective_device") or "?"
    reason = v.get("routing_reason")
    host = v.get("host_family", "cpu")

    if status == "accelerated":
        if reason:  # driver/arch caveat — accelerated but at risk
            return _check("gpu_routing", "GPU routing", WARN,
                          f"{engine} -> {dev}: {reason}",
                          "The GPU is selected but may fail at kernel launch — "
                          "update drivers / reinstall torch for this GPU arch.")
        return _check("gpu_routing", "GPU routing", OK, f"{engine} -> {dev} (accelerated)")
    if status == "cpu_fallback":
        return _check("gpu_routing", "GPU routing", WARN,
                      f"{engine} runs on CPU: {reason or 'no GPU path for this host'}",
                      "Pick an engine that supports this host's GPU for a big speedup, "
                      "or continue on CPU (slower).")
    if status == "cpu_only":
        return _check("gpu_routing", "GPU routing", OK,
                      f"{engine} -> cpu (no accelerator on this host)")
    if status == "unavailable":
        return _check("gpu_routing", "GPU routing", FAIL,
                      f"{engine} can't run on this host: {reason or f'needs a GPU; host is {host}'}",
                      "Select an engine with a CPU path in Settings -> Engines.")
    # status == "none" / unknown — no active engine resolved.
    return _check("gpu_routing", "GPU routing", WARN,
                  "No active TTS engine resolved for routing.",
                  "Pick an engine in Settings -> Engines.")


_DEEP_TIMEOUT_S = 180


def _check_deep_synthesis() -> dict:
    """Actually load the active engine and synthesize a short utterance.

    Catches "installed but broken" — the most common issue category — which
    the presence checks above can't see. Opt-in only (?deep=true / --deep):
    it may cold-load the model (minutes + a multi-GB download on a fresh
    install), so it must never run on a casual Settings-page self-check.
    """
    try:
        from services.model_manager import get_model_status
        if get_model_status().get("status") == "loading":
            return _check(
                "deep_synth", "Deep synthesis", WARN,
                "skipped - a model load is already in progress",
                "Re-run once the current load finishes.",
            )
    except Exception:
        pass

    import concurrent.futures
    import time as _time

    def _synth():
        import services.model_manager as mm
        from services.tts_backend import get_active_tts_backend, active_backend_id
        backend = get_active_tts_backend(model=mm.model)
        wav = backend.generate("Diagnostics check, one two three.", num_step=4)
        return active_backend_id(), int(wav.shape[-1]) / max(1, backend.sample_rate)

    t0 = _time.perf_counter()
    ex = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    try:
        engine_id, audio_s = ex.submit(_synth).result(timeout=_DEEP_TIMEOUT_S)
    except concurrent.futures.TimeoutError:
        return _check(
            "deep_synth", "Deep synthesis", FAIL,
            f"timed out after {_DEEP_TIMEOUT_S}s - engine load or synthesis hung",
            "If this is a first run, the model may still be downloading - retry later. Otherwise check the backend log for where it stalled.",
        )
    except Exception as e:
        return _check(
            "deep_synth", "Deep synthesis", FAIL,
            f"active engine failed: {type(e).__name__}: {e}",
            "The engine is installed but not producing audio. The error above is the lead; Settings > Logs has the full trace.",
        )
    finally:
        # Never block the report on a hung worker; the thread is left to
        # finish (or hang) on its own — the timeout verdict already shipped.
        ex.shutdown(wait=False)
    elapsed = _time.perf_counter() - t0
    if audio_s <= 0:
        return _check(
            "deep_synth", "Deep synthesis", FAIL,
            f"engine '{engine_id}' returned empty audio in {elapsed:.1f}s",
            "Synthesis ran but produced no samples - engine output is broken.",
        )
    return _check(
        "deep_synth", "Deep synthesis", OK,
        f"engine '{engine_id}' produced {audio_s:.1f}s of audio in {elapsed:.1f}s",
    )


def _check_network() -> dict:
    # Any HTTP response — even a 4xx — proves the hub is reachable; that's
    # all model downloads need to get started. urllib honors HTTP(S)_PROXY.
    import urllib.request
    import urllib.error
    if not _HUB_URL.startswith("https://"):  # constant today; guard the sink anyway
        raise ValueError(f"hub URL must be https, got {_HUB_URL!r}")
    req = urllib.request.Request(_HUB_URL, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=_HUB_TIMEOUT_S):
            pass
        return _check("network", "HuggingFace hub", OK, f"{_HUB_URL} reachable")
    except urllib.error.HTTPError:
        return _check("network", "HuggingFace hub", OK, f"{_HUB_URL} reachable")
    except Exception as e:
        return _check(
            "network", "HuggingFace hub", WARN,
            f"{_HUB_URL} unreachable: {e}",
            "Model downloads will fail until this resolves. Behind a restricted network, set a proxy in Settings > General or configure a mirror via HF_ENDPOINT.",
        )


def run_diagnostics(include_network: bool = True, deep: bool = False) -> dict:
    """Run every check and return the structured report.

    ``include_network=False`` skips the hub probe — used by tests and by
    callers that need the report to come back instantly offline.
    ``deep=True`` additionally loads the active engine and synthesizes a
    short utterance (may take minutes on a cold install — opt-in only).
    """
    checks = [
        _check_python(),
        _check_device(),
        _check_ffmpeg(),
        _check_hf_token(),
        _check_disk(),
        _check_data_dir(),
        _check_ram(),
        _check_engines(),
        _check_gpu_routing(),
    ]
    if include_network:
        checks.append(_check_network())
    if deep:
        checks.append(_check_deep_synthesis())

    counts = {OK: 0, WARN: 0, FAIL: 0}
    for c in checks:
        counts[c["status"]] += 1
    return {
        "app_version": APP_VERSION,
        "platform": scrub_text(platform.platform()),
        "checks": checks,
        "summary": {
            "ok": counts[FAIL] == 0,
            "passed": counts[OK],
            "warnings": counts[WARN],
            "failures": counts[FAIL],
        },
    }


def format_text(report: dict) -> str:
    """Human-readable rendering for `--diagnose` / pasting into an issue.

    ASCII-only on purpose — Windows consoles with legacy code pages must
    not choke on the output.
    """
    tag = {OK: "[ OK ]", WARN: "[WARN]", FAIL: "[FAIL]"}
    lines = [
        f"OmniVoice Studio self-check - v{report['app_version']} on {report['platform']}",
        "",
    ]
    for c in report["checks"]:
        lines.append(f"{tag[c['status']]} {c['label']}: {c['detail']}")
        if c.get("hint"):
            lines.append(f"       hint: {c['hint']}")
    s = report["summary"]
    lines.append("")
    lines.append(
        f"{s['passed']} ok, {s['warnings']} warning(s), {s['failures']} failure(s) - "
        + ("looks healthy" if s["ok"] else "needs attention")
    )
    return "\n".join(lines)
