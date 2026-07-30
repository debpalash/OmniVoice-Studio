"""The autouse shutdown-state reset must actually reset, and fail loudly.

``conftest._clean_model_manager_shutdown_state`` is the fix for #1269: a test
that runs the app lifespan leaves ``model_manager._shutting_down`` set and the
GPU pool torn down, and the next test then finds every ``run_in_executor``
raising "cannot schedule new futures after shutdown" — swallowed by the preload
path as a benign shutdown, so the symptom is a load that silently never starts.

A fixture with nothing asserting it is a fixture nobody notices breaking. The
pair below is deliberately order-dependent (pytest runs tests in definition
order within a file): the first test dirties exactly the state the lifespan
dirties, the second asserts it arrived clean. Delete the fixture and the second
test fails; that is the fail-before/pass-after this file exists to provide.
"""

import os

import services.model_manager as mm

_CONFTEST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "conftest.py")


def test_dirty_the_shutdown_state():
    """Stand in for any lifespan-running test: leave the module globals in the
    exact state graceful shutdown leaves them."""
    mm.begin_shutdown()
    mm._reset_gpu_pool()
    assert mm.is_shutting_down()


def test_next_test_starts_clean():
    """Runs immediately after the test above and must not inherit its state."""
    assert not mm.is_shutting_down(), (
        "the shutdown flag leaked from the previous test — the autouse fixture "
        "in backend/tests/conftest.py is not resetting it, and every executor "
        "submit in this test will now raise 'cannot schedule new futures after "
        "shutdown' and be misread as a benign cancellation (#1269)"
    )


def test_reset_failures_are_not_swallowed():
    """A reset wrapped in ``except: pass`` hands the next test stale state while
    reporting success — the fixture would look like it worked and #1269 would
    come back with the evidence removed. Mechanical, so it stays true."""
    with open(_CONFTEST, encoding="utf-8") as fh:
        src = fh.read()
    marker = "def _clean_model_manager_shutdown_state("
    assert marker in src, f"fixture renamed or removed from {_CONFTEST}"
    body = src.split(marker, 1)[1].split("\n@", 1)[0]
    # Comments and the docstring explain *why* there is no try/except; only the
    # code is evidence of whether there is one.
    code = "\n".join(
        line for line in body.split('"""')[-1].splitlines()
        if not line.lstrip().startswith("#")
    )
    assert "except" not in code, (
        "the shutdown-state reset catches exceptions; a failed reset must fail "
        "the test that caused it, not leak into the next one:\n" + code
    )
