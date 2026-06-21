"""Regression: the backend must resolve its own `omnivoice` package from source
when the venv's editable install is missing (#564).

`No module named 'omnivoice'` is a venv that starts uvicorn but never laid (or
lost) the editable record. The bootstrap now gates on it, and this source
fallback is the runtime safety net. These tests cover the pure path-resolution
logic without disturbing the real (installed) omnivoice.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from core.omnivoice_path import (  # noqa: E402
    find_omnivoice_source_root,
    ensure_omnivoice_importable,
    _candidate_roots,
)


def _make_source_root(tmp_path):
    root = tmp_path / "project"
    (root / "omnivoice").mkdir(parents=True)
    (root / "omnivoice" / "__init__.py").write_text("")
    return root


def test_find_source_root_picks_dir_with_package(tmp_path):
    root = _make_source_root(tmp_path)
    other = tmp_path / "empty"
    other.mkdir()
    assert find_omnivoice_source_root([str(other), str(root)]) == str(root)


def test_find_source_root_none_when_absent(tmp_path):
    assert find_omnivoice_source_root([str(tmp_path), None, str(tmp_path / "nope")]) is None


def test_candidate_roots_prefers_env_then_backend_parent(tmp_path, monkeypatch):
    monkeypatch.setenv("OMNIVOICE_PROJECT_ROOT", "/explicit/root")
    backend_dir = str(tmp_path / "project" / "backend")
    roots = _candidate_roots(backend_dir)
    assert roots[0] == "/explicit/root"
    assert roots[1] == os.path.join(str(tmp_path), "project")  # parent of backend/


def test_candidate_roots_without_env(tmp_path, monkeypatch):
    monkeypatch.delenv("OMNIVOICE_PROJECT_ROOT", raising=False)
    backend_dir = str(tmp_path / "project" / "backend")
    assert _candidate_roots(backend_dir) == [os.path.join(str(tmp_path), "project")]


# NB: patch + call through the LIVE module object (`op`), never the names bound
# at this file's import time. Other suites `importlib.reload(core.*)`, which can
# leave the top-level-imported `ensure_omnivoice_importable` closed over a stale
# module whose `_already_importable` a string-form monkeypatch wouldn't touch —
# the #603 CI flake. Resolving both from sys.modules keeps them consistent.
def _live():
    import importlib
    return importlib.import_module("core.omnivoice_path")


def test_ensure_noop_when_already_importable():
    op = _live()
    # omnivoice IS installed in the test venv → find_spec resolves → no fallback.
    before = list(sys.path)
    assert op.ensure_omnivoice_importable("/anywhere") is None
    assert sys.path == before


def test_ensure_appends_source_root_when_not_importable(tmp_path, monkeypatch):
    op = _live()
    root = _make_source_root(tmp_path)
    backend_dir = str(root / "backend")
    # Simulate the missing editable install (patch on the live module object).
    monkeypatch.setattr(op, "_already_importable", lambda: False)
    monkeypatch.delenv("OMNIVOICE_PROJECT_ROOT", raising=False)
    monkeypatch.setattr(sys, "path", list(sys.path))  # isolate mutation

    added = op.ensure_omnivoice_importable(backend_dir)
    assert added == str(root)
    assert str(root) in sys.path
    # Appended (not inserted) so a real install keeps precedence.
    assert sys.path[-1] == str(root)


def test_ensure_returns_none_when_no_source_found(tmp_path, monkeypatch):
    op = _live()
    monkeypatch.setattr(op, "_already_importable", lambda: False)
    monkeypatch.delenv("OMNIVOICE_PROJECT_ROOT", raising=False)
    backend_dir = str(tmp_path / "no-sibling" / "backend")
    assert op.ensure_omnivoice_importable(backend_dir) is None
