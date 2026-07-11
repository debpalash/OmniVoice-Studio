"""Shared setup for backend/tests — import path + hermetic data dir.

Historically every module in this directory stubbed
``sys.modules["core.config"]`` with a bare 3-4 attribute ``ModuleType``
pointing at its own ``mkdtemp``. That stub leaked **process-wide at
collection time**: pytest imports test modules while collecting, so in any
mixed invocation (``pytest tests/... backend/tests/...``) every *later* lazy
import of ``core.config`` resolved the stub instead of the real module —
``tests/test_router_smoke.py``'s ``from main import app`` died with
ImportError (missing config attrs), and
``monkeypatch.setattr("core.config.X", ...)`` died with AttributeError
(``core`` never gets a ``config`` attribute when the name is satisfied
straight from ``sys.modules``). That was the root cause of the
order-pollution combos around test_longform_e2e (8 AttributeErrors) and
test_router_smoke (24 fixture ImportErrors).

The real ``core.config`` derives every path from ``OMNIVOICE_DATA_DIR`` at
import time, so pointing that env var at a throwaway dir *before* any test
module imports it gives the same hermeticity (issue #878: never touch the
developer's real app state) with zero ``sys.modules`` surgery. This mirrors
``tests/conftest.py``; in a mixed run whichever conftest loads first wins
(``setdefault`` semantics) and both point at a throwaway tmpdir.

Do NOT reintroduce module-level ``sys.modules`` stubs in this directory —
import the real module and rely on this conftest instead.
"""
import os
import sys
import tempfile

# Backend runs with `--app-dir backend`, so tests must do the same.
_BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

if not os.environ.get("OMNIVOICE_DATA_DIR"):
    os.environ["OMNIVOICE_DATA_DIR"] = tempfile.mkdtemp(prefix="omnivoice-test-data-")
if not os.environ.get("OMNIVOICE_ENV_FILE"):
    os.environ["OMNIVOICE_ENV_FILE"] = os.path.join(
        os.environ["OMNIVOICE_DATA_DIR"], "user-env"
    )
