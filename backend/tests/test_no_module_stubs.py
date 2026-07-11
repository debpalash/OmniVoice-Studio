"""Regression guard for the collection-time sys.modules stub class.

Seven modules in this directory used to install bare ``types.ModuleType``
stubs for ``core.config`` (and test_capture_ws.py for ``services.*``) at
module level. pytest imports every test module during *collection*, so the
stubs leaked process-wide before a single test ran: in any mixed invocation
(``pytest tests/... backend/tests/...``) later lazy imports resolved the
stub — tests/test_router_smoke.py's ``from main import app`` died with
``ImportError: cannot import name 'find_ffmpeg' from 'services.ffmpeg_utils'
(unknown location)`` and tests/test_longform_e2e.py's
``monkeypatch.setattr("core.config.OUTPUTS_DIR", ...)`` died with
``AttributeError: module 'core' has no attribute 'config'``.

This test runs after collection has imported every sibling module, so any
reintroduced module-level stub trips it even in a backend/tests-only run.
A stub is recognizable because a bare ModuleType has neither ``__file__``
(real module) nor ``__path__`` (namespace package).

If you need a fake module in a test, use ``monkeypatch.setitem(sys.modules,
name, fake)`` inside the test — pytest restores it. For hermetic data dirs,
rely on conftest.py's ``OMNIVOICE_DATA_DIR`` redirect instead of stubbing
``core.config``.
"""
import sys

# Backend packages whose identity later tests depend on. Top-level third-party
# modules are out of scope (some legitimately lack __file__, e.g. frozen ones).
_GUARDED_PREFIXES = ("core.", "api.", "services.", "schemas.", "utils.")


def test_no_collection_time_sys_modules_stubs():
    offenders = []
    for name, mod in list(sys.modules.items()):
        if mod is None or not name.startswith(_GUARDED_PREFIXES):
            continue
        if getattr(mod, "__file__", None) is None and not hasattr(mod, "__path__"):
            offenders.append(name)
    assert not offenders, (
        "Stub module(s) found in sys.modules: "
        f"{offenders}. Some test module installed a bare ModuleType at import "
        "time; that leaks process-wide from pytest collection and breaks "
        "every later import of the real module in mixed runs. Use "
        "monkeypatch.setitem(sys.modules, ...) inside the test instead."
    )
