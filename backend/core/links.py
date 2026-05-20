"""Project repo URL resolver — single source of truth for deeplinks.

Owned by Plan 01-02 (checker B-6 resolution). Read by:
  - backend/core/error_docs_map.py — error → docs URL mapping
  - (future) backend/services/bug_report.py — prefilled GitHub Issues URL

Resolution order (highest → lowest):
  1. `frontend/src-tauri/tauri.conf.json` `plugins.updater.endpoints[0]`
     — this points at the desktop app fork (e.g. github.com/debpalash/
     OmniVoice-Studio), which is where docs deeplinks should resolve.
  2. `pyproject.toml [project.urls].Repository` — fallback to the upstream
     model repo URL when the Tauri config is unreadable.

The resolved URL is cached at import time so callers can use the module
constants directly without re-reading files.
"""
from __future__ import annotations

import json
import logging
import re
import sys
from pathlib import Path
from typing import Optional

logger = logging.getLogger("omnivoice.core.links")

# Walk up from this file to find the repo root (the dir containing
# `pyproject.toml`). This lets the module work whether the backend is
# imported under `--app-dir backend` or installed as a wheel.
_THIS = Path(__file__).resolve()


def _find_repo_root() -> Path:
    for ancestor in (_THIS.parent, *_THIS.parents):
        if (ancestor / "pyproject.toml").exists():
            return ancestor
    # Fallback — two levels up from backend/core/links.py
    return _THIS.parent.parent.parent


_REPO_ROOT = _find_repo_root()
_TAURI_CONF = _REPO_ROOT / "frontend" / "src-tauri" / "tauri.conf.json"
_PYPROJECT = _REPO_ROOT / "pyproject.toml"

_GITHUB_REPO_RE = re.compile(r"https?://github\.com/([^/]+)/([^/]+?)(?:/|\.git|$)")


def _from_tauri() -> Optional[str]:
    """Parse the updater endpoint and pull `github.com/<owner>/<repo>` out."""
    try:
        text = _TAURI_CONF.read_text(encoding="utf-8")
        conf = json.loads(text)
    except Exception:
        logger.debug("links: tauri.conf.json unreadable", exc_info=True)
        return None
    try:
        endpoints = (
            conf.get("plugins", {})
            .get("updater", {})
            .get("endpoints", [])
        )
        for url in endpoints:
            m = _GITHUB_REPO_RE.search(url)
            if m:
                owner, repo = m.group(1), m.group(2)
                return f"https://github.com/{owner}/{repo}"
    except Exception:
        logger.debug("links: tauri.conf.json updater shape unexpected", exc_info=True)
    return None


def _from_pyproject() -> Optional[str]:
    """Read `[project.urls].Repository` from pyproject.toml via tomllib."""
    try:
        # tomllib is stdlib on 3.11+
        if sys.version_info >= (3, 11):
            import tomllib
        else:  # pragma: no cover — repo pins 3.11+
            import tomli as tomllib  # type: ignore[no-redef]
        with _PYPROJECT.open("rb") as f:
            data = tomllib.load(f)
        repo = data.get("project", {}).get("urls", {}).get("Repository")
        if isinstance(repo, str) and repo.startswith("https://github.com/"):
            # Strip trailing `.git` / slash if present.
            return repo.rstrip("/").removesuffix(".git")
    except Exception:
        logger.debug("links: pyproject.toml read failed", exc_info=True)
    return None


def _resolve() -> str:
    """Pick the Tauri config URL first, then fall back to pyproject."""
    return (
        _from_tauri()
        or _from_pyproject()
        or "https://github.com/debpalash/OmniVoice-Studio"
    )


PROJECT_REPO_URL: str = _resolve()
PROJECT_REPO_BLOB_MAIN: str = f"{PROJECT_REPO_URL}/blob/main"
