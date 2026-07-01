"""Single source of truth for the app version at runtime.

Read from the installed package metadata (driven by ``pyproject.toml``) so the
FastAPI/API version and exported-bundle metadata never drift to a stale literal
— the prior "0.4.0" / "0.2.7" bug, and the v0.3.6 desktop build that reported
"0.3.5" because the *frozen* backend couldn't read its own metadata.

Resolution order:
  1. installed package metadata — correct in any ``uv sync``'d env and, thanks
     to ``copy_metadata('omnivoice')`` in ``backend.spec``, in the frozen build;
  2. ``pyproject.toml`` walked up from this file — correct for a raw source
     checkout that was never installed;
  3. ``_FALLBACK_VERSION`` — a last resort, kept in lockstep with the four
     version files by ``tests/test_app_version.py`` so it can never silently
     drift again.
"""
from __future__ import annotations

import re
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

# Last-resort literal. Guarded by
# tests/test_app_version.py::test_all_version_files_in_lockstep and bumped by
# release.yml's version-bump job, so it stays equal to
# pyproject/tauri.conf/Cargo/package.json.
_FALLBACK_VERSION = "0.3.8"


def _fallback_version() -> str:
    """Version for contexts where package metadata is unavailable."""
    for parent in Path(__file__).resolve().parents:
        pyproject = parent / "pyproject.toml"
        if pyproject.is_file():
            match = re.search(r'(?m)^version\s*=\s*"([^"]+)"', pyproject.read_text())
            if match:
                return match.group(1)
    return _FALLBACK_VERSION


try:
    APP_VERSION = version("omnivoice")
except PackageNotFoundError:  # frozen build w/o metadata, or non-installed checkout
    APP_VERSION = _fallback_version()
