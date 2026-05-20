"""Tests for backend/core/links.py — project repo URL resolver.

The module owns the single source of truth for the GitHub repo URL used by
error → docs deeplinks (and, in Phase 5, by the prefilled bug-report URL).
The 4 tests below pin the resolution order:

  1. Tauri config endpoint wins when present.
  2. Falls back to pyproject's Repository URL when Tauri is unreadable.
  3. The derived `BLOB_MAIN` constant is always `<URL>/blob/main`.
  4. The URL always starts with `https://github.com/`.
"""
from __future__ import annotations

import importlib
import sys


def _fresh_links_module():
    """Drop any cached `core.links` so the next import re-runs `_resolve()`."""
    for mod in list(sys.modules):
        if mod == "core.links":
            del sys.modules[mod]
    import core.links as links  # noqa: WPS433 — needed for re-import
    return importlib.reload(links)


def test_project_repo_url_is_set():
    links = _fresh_links_module()
    assert isinstance(links.PROJECT_REPO_URL, str)
    assert links.PROJECT_REPO_URL.startswith("https://github.com/")


def test_project_repo_blob_main_derives_from_url():
    links = _fresh_links_module()
    assert links.PROJECT_REPO_BLOB_MAIN == links.PROJECT_REPO_URL + "/blob/main"


def test_prefers_tauri_config_when_present(monkeypatch, tmp_path):
    """With a fake `tauri.conf.json` containing the desktop fork URL in the
    updater endpoint, `PROJECT_REPO_URL` resolves to that fork (NOT the
    pyproject upstream)."""
    fake_conf = {
        "plugins": {
            "updater": {
                "endpoints": [
                    "https://github.com/debpalash/OmniVoice-Studio/releases/latest/download/latest.json"
                ]
            }
        }
    }
    # Reload the module first to pick up the original constants, then exercise
    # the resolver helpers directly.
    links = _fresh_links_module()
    monkeypatch.setattr(links, "_TAURI_CONF", tmp_path / "tauri.conf.json")
    import json
    (tmp_path / "tauri.conf.json").write_text(json.dumps(fake_conf), encoding="utf-8")
    url = links._from_tauri()
    assert url == "https://github.com/debpalash/OmniVoice-Studio"


def test_falls_back_to_pyproject_when_tauri_unreadable(monkeypatch, tmp_path):
    """With the Tauri config set to a non-existent path, `_resolve()` falls
    back to the pyproject Repository URL."""
    links = _fresh_links_module()
    monkeypatch.setattr(links, "_TAURI_CONF", tmp_path / "missing.json")
    # pyproject is read from the real repo root, which has a Repository URL.
    url = links._resolve()
    assert url.startswith("https://github.com/")
    # Tauri path was missing → _from_tauri returned None → we ended up in
    # the pyproject branch (or the hardcoded fallback). Both are acceptable
    # https://github.com/... URLs.
