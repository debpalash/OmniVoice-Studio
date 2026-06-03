"""Single source of truth for the app version at runtime.

Read from the installed package metadata (driven by ``pyproject.toml``) so the
FastAPI/API version and exported-bundle metadata never drift to a stale literal
again (the prior "0.4.0" / "0.2.7" bug). Falls back to a literal only when
running from a raw source checkout that was never ``uv sync``'d.
"""
from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version

try:
    APP_VERSION = version("omnivoice")
except PackageNotFoundError:  # non-installed source checkout
    APP_VERSION = "0.3.5"
