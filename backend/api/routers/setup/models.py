"""Model catalog, platform detection, and cache introspection.

Extracted from the monolithic ``setup.py`` to keep concerns separate:
- ``KNOWN_MODELS`` loaded from ``config/models.yaml``
- ``GET /models`` endpoint (with 10 s response cache)
- ``GET /setup/recommendations`` device-aware preset endpoint
- ``ModelCatalog`` dependency for use with ``Depends()``
"""
from __future__ import annotations

import logging
import os
import platform as _platform
import sys
import time
from pathlib import Path

from fastapi import APIRouter

logger = logging.getLogger("omnivoice.setup.models")
router = APIRouter()

# ── Model Catalog (loaded from YAML) ──────────────────────────────────────

_YAML_PATH = Path(__file__).resolve().parents[3] / "config" / "models.yaml"


def _load_models_from_yaml() -> list[dict]:
    """Load model catalog from config/models.yaml.

    Falls back to an empty list if the file is missing or unreadable.
    The YAML file is read once at import time — restart to pick up edits.
    """
    try:
        import yaml  # PyYAML is already a transitive dep of huggingface_hub
        with open(_YAML_PATH, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        models = data.get("models", [])
        logger.info("Loaded %d models from %s", len(models), _YAML_PATH)
        return models
    except FileNotFoundError:
        logger.warning("models.yaml not found at %s — using empty catalog", _YAML_PATH)
        return []
    except Exception as e:
        logger.error("Failed to load models.yaml: %s — using empty catalog", e)
        return []


KNOWN_MODELS = _load_models_from_yaml()

# Back-compat tuple view for code that expects (repo_id, label) pairs.
REQUIRED_MODELS = [(m["repo_id"], m["label"]) for m in KNOWN_MODELS if m.get("required")]


# ── Dependency Injection ───────────────────────────────────────────────────
# Use `catalog: ModelCatalog = Depends(get_model_catalog)` in endpoint params
# for testable, mockable access to the model registry.

class ModelCatalog:
    """Injectable service wrapping the model catalog + cache scanner."""

    def __init__(self, models: list[dict] | None = None):
        self.models = models if models is not None else KNOWN_MODELS
        self._by_id = {m["repo_id"]: m for m in self.models}
        self._required = [(m["repo_id"], m["label"]) for m in self.models if m.get("required")]

    def get(self, repo_id: str) -> dict | None:
        return self._by_id.get(repo_id)

    @property
    def required(self) -> list[tuple[str, str]]:
        return self._required

    @property
    def all(self) -> list[dict]:
        return self.models

    def supported_on_host(self, model: dict) -> bool:
        return _model_supported(model)


# Singleton — shared across all requests.
_catalog = ModelCatalog()


def get_model_catalog() -> ModelCatalog:
    """FastAPI dependency — inject with ``Depends(get_model_catalog)``."""
    return _catalog


# ── Platform Detection ─────────────────────────────────────────────────────

def _current_platform_tags() -> list[str]:
    """Return platform tags that the current host supports."""
    tags = [sys.platform]
    arch = _platform.machine()
    tags.append(f"{sys.platform}-{arch}")
    try:
        import torch
        if torch.cuda.is_available():
            tags.append("cuda")
    except Exception:
        pass
    return tags


def _model_supported(model: dict) -> bool:
    """Check if a model is supported on the current platform."""
    plats = model.get("platforms")
    if not plats:
        return True
    return bool(set(plats) & set(_current_platform_tags()))


# ── HF Cache Helpers ───────────────────────────────────────────────────────

def hf_cache_dir() -> str:
    return (
        os.environ.get("HF_HUB_CACHE")
        or os.environ.get("HUGGINGFACE_HUB_CACHE")
        or os.environ.get("HF_HOME")
        or os.path.expanduser("~/.cache/huggingface")
    )


# ── Disk-space guard (shared, single-sourced) ──────────────────────────────
# MIN_FREE_GB is the headroom we insist on keeping free on the model-cache
# volume — the wizard's absolute pre-install floor AND the extra buffer the
# per-install check demands on top of the download itself, so an "Install all"
# can't fill the disk to the brim (setup/download.py). Lives here — the lowest
# module in the setup import graph — so the wizard, the /models header, and the
# install endpoint can't drift apart (mirrors the weight-floor single-sourcing).
_GIB = 1024 ** 3
MIN_FREE_GB = 10


def disk_free_bytes(path: "str | None" = None) -> int:
    """Free bytes on the volume backing *path* (defaults to the HF cache).

    Walks up to the nearest existing ancestor so a not-yet-created cache dir
    still probes the correct mount point. ``shutil.disk_usage`` is cross-platform
    (macOS/Windows/Linux) so this behaves identically everywhere. Never raises.
    """
    import shutil
    try:
        p = Path(path or hf_cache_dir()).resolve()
        while not p.exists():
            parent = p.parent
            if parent == p:  # reached the volume root
                break
            p = parent
        return int(shutil.disk_usage(str(p)).free)
    except Exception:
        return 0


def disk_space_error(to_download_bytes: "int | None", *, cache_dir: "str | None" = None) -> "str | None":
    """Actionable message when *to_download_bytes* (+ MIN_FREE_GB headroom) won't
    fit on the cache volume; ``None`` when it fits, the size is unknown, or the
    volume can't be probed (never block on missing information).

    Names the three numbers a user needs to act — needs X, headroom Y, have Z —
    so "Install all" can't silently overrun the disk (issue: no pre-install disk
    check). Platform-agnostic; applied identically on macOS/Windows/Linux.
    """
    if not to_download_bytes or to_download_bytes <= 0:
        return None  # unknown plan (older/gated repo, mirror without dry-run) → don't block
    cache = cache_dir or hf_cache_dir()
    free = disk_free_bytes(cache)
    if free <= 0:
        return None  # couldn't probe the volume → don't block on missing info
    required = int(to_download_bytes) + MIN_FREE_GB * _GIB
    if free >= required:
        return None

    def _gb(n: int) -> str:
        return f"{n / _GIB:.1f} GB"

    return (
        f"Not enough disk space to install: this download needs {_gb(int(to_download_bytes))} "
        f"plus {MIN_FREE_GB} GB free headroom ({_gb(required)} total), but only {_gb(free)} "
        f"is free at {cache}. Free up space (or move the model cache to a bigger volume) and retry."
    )


def _repo_dir_name(repo_id: str) -> str:
    """HF cache dir name for a repo: 'k2-fsa/OmniVoice' → 'models--k2-fsa--OmniVoice'."""
    return "models--" + repo_id.replace("/", "--")


def _hub_cache_roots() -> list[str]:
    """Candidate roots that directly contain ``models--*`` dirs.

    HF stores repos under ``$HF_HUB_CACHE`` (== ``$HF_HOME/hub`` by default). When
    only ``HF_HOME`` (or the ``~/.cache/huggingface`` default) is known, the repos
    live under the ``hub`` subdir — so we probe both ``<dir>`` (the
    ``HF_HUB_CACHE``-is-set case, e.g. OmniVoice's Windows short cache) and
    ``<dir>/hub`` (the ``HF_HOME``-only case). Without this the WinError-448
    fallback would look one level too high and miss the cache (CodeRabbit #137).
    """
    base = hf_cache_dir()
    roots = [base]
    hub = os.path.join(base, "hub")
    if hub not in roots:
        roots.append(hub)
    return roots


# ── Weight-presence (truncated-cache) detection ─────────────────────────────
# A cache that downloaded config/tokenizer files but not the weight shard still
# occupies bytes on disk, so a size-only "installed" check (#352/#581/#606) reads
# it as installed and the first-run wizard hides the re-download button, stranding
# the user (#622). These helpers tell a *complete* snapshot from a truncated one by
# checking for a plausible weight file — the same class `download.py` guards at
# install time and `model_manager.py` repairs at load time. Shared here (the lowest
# module in the setup import graph; `download.py` imports from this module) so the
# floors live in exactly one place and can't drift between the three call sites.

_MIN_WEIGHT_BYTES = 5 * 1024 * 1024  # tensor formats: a real shard is ≥ a few MB

# Per-extension floors. ONNX graphs are legitimately small (a complete model can be
# well under 5 MB), so they get a lower floor that still rejects a bytes-only partial.
_WEIGHT_FLOORS = {
    ".safetensors": _MIN_WEIGHT_BYTES,
    ".bin": _MIN_WEIGHT_BYTES,
    ".ckpt": _MIN_WEIGHT_BYTES,
    ".pt": _MIN_WEIGHT_BYTES,
    ".pth": _MIN_WEIGHT_BYTES,
    ".gguf": _MIN_WEIGHT_BYTES,
    ".onnx": 64 * 1024,
}


def snapshot_has_weights(snapshot_path: str) -> bool:
    """True when a finished snapshot dir holds a plausible weight file.

    A snapshot is complete if it contains a recognized weight file meeting its
    per-extension floor OR any file ≥ the global 5 MB floor (the lenient catch for
    non-standard weight names). Returns True when the path can't be inspected — an
    un-walkable dir must never be reported as truncated, only a confirmed weight-less
    one. `getsize` follows symlinks, so HF's snapshot→blob links resolve correctly;
    a broken link (missing blob) raises OSError and is skipped, i.e. counts as absent.
    """
    try:
        for root, _dirs, files in os.walk(snapshot_path, followlinks=True):
            for f in files:
                try:
                    size = os.path.getsize(os.path.join(root, f))
                except OSError:
                    continue
                ext = os.path.splitext(f)[1].lower()
                floor = _WEIGHT_FLOORS.get(ext)
                if floor is not None and size >= floor:
                    return True
                if size >= _MIN_WEIGHT_BYTES:
                    return True
    except OSError:
        return True  # can't inspect — don't mislabel as truncated
    return False


def _snapshot_dirs(repo_id: str) -> list[str]:
    """Existing snapshot revision dirs for a repo across the candidate cache roots."""
    name = _repo_dir_name(repo_id)
    dirs: list[str] = []
    for root in _hub_cache_roots():
        snaps = os.path.join(root, name, "snapshots")
        try:
            for rev in os.listdir(snaps):
                rev_dir = os.path.join(snaps, rev)
                if os.path.isdir(rev_dir):
                    dirs.append(rev_dir)
        except OSError:
            continue
    return dirs


def cache_is_complete(model: dict) -> bool:
    """True when this model's on-disk cache is usable (not a truncated download).

    Config-only repos (``config_only: true`` in models.yaml — e.g. pyannote's
    diarisation pipeline, whose real weights live in referenced sub-repos) carry no
    weight file of their own, so the weight check would false-positive them as
    incomplete (#622 caveat). They're exempt: cache presence alone means complete.
    A weight-bearing repo is complete only if at least one of its snapshots has
    weights; if no snapshot dir is found on disk we can't prove truncation, so we
    don't downgrade (the size-based caller already decided it's cached).
    """
    if model.get("config_only"):
        return True
    dirs = _snapshot_dirs(model["repo_id"])
    if not dirs:
        return True
    return any(snapshot_has_weights(d) for d in dirs)


def _is_cached_on_disk(repo_id: str) -> bool:
    """Direct-filesystem fallback for is_cached when scan_cache_dir is unavailable.

    On Windows scan_cache_dir() can raise WinError 448 ('untrusted mount point');
    we then walk the canonical HF layout <root>/models--<org>--<name>/snapshots/
    <rev>/ and treat the repo as cached if any revision directory has files. This
    stops a present model from being mistaken for missing and re-downloaded
    (#117/#118).
    """
    name = _repo_dir_name(repo_id)
    for root in _hub_cache_roots():
        snaps = os.path.join(root, name, "snapshots")
        try:
            if not os.path.isdir(snaps):
                continue
            for rev in os.listdir(snaps):
                rev_dir = os.path.join(snaps, rev)
                if os.path.isdir(rev_dir):
                    # `with` so the dir handle is closed even when any() short-
                    # circuits — avoids handle leaks on repeated polls (Greptile).
                    with os.scandir(rev_dir) as it:
                        if any(it):
                            return True
        except OSError:
            continue
    return False


def _scan_cache_on_disk() -> dict[str, dict]:
    """Direct-filesystem equivalent of scan_cache_dir(), for the WinError-448
    fallback path. Returns {repo_id: {size_on_disk, last_accessed, nb_files}}."""
    out: dict[str, dict] = {}
    for root in _hub_cache_roots():
        try:
            names = os.listdir(root)
        except OSError:
            continue
        for name in names:
            if not name.startswith("models--"):
                continue
            repo_id = name[len("models--"):].replace("--", "/")
            if repo_id in out:
                continue  # first root wins (HF_HUB_CACHE before the /hub probe)
            repo_root = os.path.join(root, name)
            if not os.path.isdir(os.path.join(repo_root, "snapshots")):
                continue
            size = 0
            nb = 0
            for dirpath, _dirs, files in os.walk(repo_root):
                for f in files:
                    try:
                        size += os.path.getsize(os.path.join(dirpath, f))
                        nb += 1
                    except OSError:
                        # Skip files we can't stat (broken symlink, permission) —
                        # the count is best-effort for the UI's "installed" badge.
                        continue
            if nb > 0:
                out[repo_id] = {"size_on_disk": size, "last_accessed": None, "nb_files": nb}
    return out


def is_cached(repo_id: str) -> bool:
    """Best-effort check: does HF have this repo in its cache on disk?"""
    try:
        from huggingface_hub import scan_cache_dir
        info = scan_cache_dir()
        for entry in info.repos:
            if entry.repo_id == repo_id and entry.size_on_disk > 0:
                return True
        return False
    except Exception as e:
        # scan_cache_dir can raise on Windows (WinError 448 'untrusted mount
        # point'); fall back to a direct disk check so a cached model isn't
        # mistaken for missing and re-downloaded in a loop (#117/#118). Logged
        # at WARNING with the exception type (MM2-09) so this fallback isn't
        # invisible when triaging a Windows cache report — it previously logged
        # at DEBUG and never showed at the default level.
        logger.warning("is_cached: scan_cache_dir failed (%s: %s); using on-disk fallback for %s",
                       type(e).__name__, e, repo_id)
        return _is_cached_on_disk(repo_id)


# ── Response Cache ─────────────────────────────────────────────────────────
# Simple TTL dict cache to avoid re-scanning the HF cache directory on every
# frontend poll.  Entries expire after ``_CACHE_TTL`` seconds.

_CACHE_TTL = 10.0  # seconds
_cache: dict[str, tuple[float, object]] = {}


def _cached(key: str, ttl: float = _CACHE_TTL):
    """Return cached value if still valid, else None."""
    entry = _cache.get(key)
    if entry and (time.monotonic() - entry[0]) < ttl:
        return entry[1]
    return None


def _set_cache(key: str, value: object) -> None:
    _cache[key] = (time.monotonic(), value)


def invalidate_cache() -> None:
    """Called after install/delete to bust the models cache."""
    _cache.clear()


# ── Endpoints ──────────────────────────────────────────────────────────────

@router.get("/models")
def list_models():
    """Catalogue every known model + its on-disk install state.

    Uses a 10 s response cache to avoid repeated ``scan_cache_dir()`` disk
    walks when the frontend polls.
    """
    cached_response = _cached("models")
    if cached_response is not None:
        return cached_response

    cached_by_repo: dict[str, dict] = {}
    try:
        from huggingface_hub import scan_cache_dir
        info = scan_cache_dir()
        for entry in info.repos:
            cached_by_repo[entry.repo_id] = {
                "size_on_disk": entry.size_on_disk,
                "last_accessed": entry.last_accessed,
                "nb_files": entry.nb_files,
            }
    except Exception as e:
        # WinError-448 fallback (#117/#118): use a direct disk scan so installed
        # models still show as installed instead of offering a re-download.
        logger.warning("scan_cache_dir failed (%s); using disk fallback", e)
        cached_by_repo = _scan_cache_on_disk()

    out = []
    for m in KNOWN_MODELS:
        cached = cached_by_repo.get(m["repo_id"])
        on_disk = cached is not None and cached["size_on_disk"] > 0
        # A size-positive cache can still be a truncated download (config landed,
        # weight shard didn't). Treat that as not-installed + incomplete so the
        # wizard re-offers the download instead of stranding the user (#622).
        incomplete = on_disk and not cache_is_complete(m)
        out.append({
            **m,
            "installed": on_disk and not incomplete,
            "incomplete": incomplete,
            "size_on_disk_bytes": cached["size_on_disk"] if cached else 0,
            "nb_files": cached["nb_files"] if cached else 0,
            "supported": _model_supported(m),
        })
    response = {
        "models": out,
        "total_installed_bytes": sum(m["size_on_disk_bytes"] for m in out),
        "hf_cache_dir": hf_cache_dir(),
        # Free space on the cache volume, so the Model Store header can warn
        # BEFORE an "Install all" overruns the disk (pairs with the per-install
        # disk_space_error guard in setup/download.py).
        "disk_free_gb": round(disk_free_bytes() / _GIB, 1),
        "platform_tags": _current_platform_tags(),
    }
    _set_cache("models", response)
    return response


@router.get("/setup/recommendations")
def recommendations():
    """Return a curated model preset for the caller's device + architecture."""
    is_mac_arm = sys.platform == "darwin" and _platform.machine() == "arm64"
    is_mac_intel = sys.platform == "darwin" and _platform.machine() == "x86_64"
    is_linux = sys.platform.startswith("linux")
    is_windows = sys.platform == "win32"

    has_cuda = False
    try:
        import torch
        has_cuda = bool(torch.cuda.is_available())
    except Exception:
        pass

    # Device label — used as the card title.
    if is_mac_arm:
        device_label = f"Apple Silicon ({_platform.machine()})"
    elif is_mac_intel:
        device_label = "macOS Intel (x86_64)"
    elif is_windows:
        device_label = "Windows x64" + (" + CUDA" if has_cuda else "")
    elif is_linux:
        device_label = "Linux x64" + (" + CUDA" if has_cuda else "")
    else:
        device_label = f"{sys.platform} / {_platform.machine()}"

    # Pick the preset for this device.
    if is_mac_arm:
        recommended_ids = [
            "k2-fsa/OmniVoice",
            "Systran/faster-whisper-large-v3",
            "mlx-community/whisper-large-v3-mlx",
            "mlx-community/whisper-large-v3-turbo",
            "mlx-community/Kokoro-82M-bf16",
            "KittenML/kitten-tts-mini-0.8",
        ]
        rationale = (
            "Apple Silicon gets the full stack: OmniVoice for multilingual clone + "
            "WhisperX (faster-whisper weights) for cross-platform ASR + MLX-Whisper "
            "for the Apple-optimised speedup + Whisper Turbo (5× faster) for live "
            "dictation + Kokoro (mlx-audio) for fast local English + KittenTTS as "
            "a CPU-realtime backup."
        )
    else:
        recommended_ids = [
            "k2-fsa/OmniVoice",
            "Systran/faster-whisper-large-v3",
            "KittenML/kitten-tts-mini-0.8",
        ]
        if has_cuda:
            recommended_ids.append("openai/whisper-large-v3")
            rationale = (
                "Cross-platform stack + pytorch-whisper as a CUDA-accelerated "
                "ASR fallback. MLX / mlx-audio are Apple-Silicon-only and don't "
                "apply here."
            )
        else:
            rationale = (
                "Cross-platform stack: OmniVoice (multilingual clone) + WhisperX "
                "(faster-whisper ASR) + KittenTTS (English turbo, CPU-realtime). "
                "Clean install, every model runs on CPU."
            )

    known_by_id = {m["repo_id"]: m for m in KNOWN_MODELS}
    cached_ids: set[str] = set()
    try:
        from huggingface_hub import scan_cache_dir
        info = scan_cache_dir()
        cached_ids = {
            entry.repo_id for entry in info.repos if entry.size_on_disk > 0
        }
    except Exception as e:
        # WinError-448 fallback (#117/#118): recommend based on the disk scan.
        logger.debug("scan_cache_dir failed (%s); using disk fallback", e)
        cached_ids = set(_scan_cache_on_disk().keys())

    entries = []
    for rid in recommended_ids:
        meta = known_by_id.get(rid, {})
        # Mirror /models: a truncated cache (weights missing) is not installed, so
        # the wizard counts it toward the remaining download instead of "all set".
        installed = rid in cached_ids and cache_is_complete(meta or {"repo_id": rid})
        entries.append({
            "repo_id": rid,
            "label": meta.get("label", rid),
            "role": meta.get("role", ""),
            "size_gb": meta.get("size_gb", 0),
            "required": bool(meta.get("required", False)),
            "note": meta.get("note"),
            "installed": installed,
        })

    to_download_gb = sum(e["size_gb"] for e in entries if not e["installed"])
    all_installed = all(e["installed"] for e in entries)

    return {
        "device": {
            "os": sys.platform,
            "arch": _platform.machine(),
            "is_mac_arm": is_mac_arm,
            "is_mac_intel": is_mac_intel,
            "is_linux": is_linux,
            "is_windows": is_windows,
            "has_cuda": has_cuda,
            "label": device_label,
        },
        "rationale": rationale,
        "models": entries,
        "download_gb_remaining": round(to_download_gb, 2),
        "total_gb": round(sum(e["size_gb"] for e in entries), 2),
        "all_installed": all_installed,
    }
