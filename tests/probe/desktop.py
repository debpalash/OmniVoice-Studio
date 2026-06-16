"""L3 desktop layer — Tauri config loading + (guarded) live bundle launch.

Desktop E2E is intentionally thin here: Tauri has no official macOS WebDriver, so
per the architecture decision we test the backend over HTTP (L5) and the UI in a
browser (L2), and reserve L3 for the packaging/shell contract — verified via the
config (see judges/desktop.py) plus a best-effort live launch of a built bundle
when one exists and a display is available.
"""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SRC_TAURI = _REPO_ROOT / "frontend" / "src-tauri"


def src_tauri_dir() -> Path:
    return _SRC_TAURI


def _deep_merge(base: dict, override: dict) -> dict:
    """Tauri-style merge: dicts merge recursively, everything else (incl. lists)
    is replaced by the platform override."""
    out = copy.deepcopy(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def load_tauri_config(platform: str | None = None) -> dict:
    """Load the base tauri.conf.json, optionally deep-merged with a platform
    override ('linux' | 'macos' | 'windows') the way `tauri build` resolves it."""
    base = json.loads((_SRC_TAURI / "tauri.conf.json").read_text(encoding="utf-8"))
    if platform:
        override_path = _SRC_TAURI / f"tauri.{platform}.conf.json"
        if override_path.exists():
            base = _deep_merge(base, json.loads(override_path.read_text(encoding="utf-8")))
    return _resolve_version(base)


def _resolve_version(config: dict) -> dict:
    """Resolve a package.json `version` reference the way Tauri does.

    package.json is the single source of truth, so tauri.conf.json carries
    ``"version": "../package.json"`` (a path Tauri reads at build time) rather
    than a literal. Resolve it here to the effective bundle version so the
    config-integrity checks see — and assert parity against — the real value."""
    v = config.get("version")
    if isinstance(v, str) and v.endswith("package.json"):
        pkg = json.loads((_SRC_TAURI / v).resolve().read_text(encoding="utf-8"))
        config = {**config, "version": pkg.get("version", v)}
    return config


def pyproject_version() -> str:
    """The project version, for parity checks against tauri.conf.json."""
    import re

    text = (_REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    m = re.search(r'(?m)^\s*version\s*=\s*"([^"]+)"', text)
    return m.group(1) if m else ""


def desktop_context(platform: str | None = None) -> dict:
    """The L3 run context the config-integrity spec reads via ``$.``."""
    return {"config": load_tauri_config(platform), "pyproject_version": pyproject_version()}


# ── guarded live launch ─────────────────────────────────────────────────────────

_BUNDLE_GLOBS = ("*.AppImage", "*.deb", "*.dmg", "*.app", "*.msi", "*.exe")


def find_bundle() -> str | None:
    """Locate a built desktop bundle/binary, if any (none in a fresh checkout)."""
    bundle_dir = _SRC_TAURI / "target" / "release" / "bundle"
    if not bundle_dir.exists():
        return None
    for pat in _BUNDLE_GLOBS:
        hits = sorted(bundle_dir.glob(f"**/{pat}"))
        if hits:
            return str(hits[0])
    return None


def can_launch() -> tuple[bool, str]:
    """Whether a live desktop launch is possible here. Returns (ok, reason)."""
    bundle = find_bundle()
    if bundle is None:
        return False, "no built bundle (run the Tauri build first)"
    if os.name == "posix" and not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        return False, "no display (headless) — desktop window can't render"
    return True, bundle
