"""A job that never ran was not "too heavy for the available compute" (#1416).

When a GPU-pool job overruns its budget the user gets one message, and until
now it made the same claim whatever had happened: the job "ran for more than
300s of actual compute time" and "was too heavy for the available compute",
followed by advice about shorter text, lighter engines and VRAM.

That is a specific, testable claim, and it is false whenever the worker spent
its budget parked on a lock. #1416 (MPS, 16 GB) and #1419 (CPU, Windows) both
arrived as "my machine is too slow" reports from people whose jobs never
started — a cold model load waiting on a lock owned by a different event loop
(#1417) — and #1329's "advances one sentence then stops with no error" is the
same wedge seen from the dub loop. All three were sent to look at hardware.

The stack of every pool worker is already captured at the moment of the
timeout (#1338). These pin that it is now *read* as well as logged, and that
the reading is conservative in the direction that matters.
"""
from __future__ import annotations

import pytest


@pytest.fixture
def mm():
    """Resolved at run time, not import time: a module-level import of an app
    module keeps mutable state in sys.modules across test boundaries."""
    import services.model_manager as _mm

    return _mm


# Shapes taken from real captures: a thread blocked in a lock/event/future.
WEDGED_STACKS = [
    # asyncio.Lock.acquire on a foreign loop — the #1417 deadlock.
    '  File "/usr/lib/python3.11/asyncio/locks.py", line 114, in acquire\n'
    "    await fut\n",
    # threading.Event.wait / Condition.wait.
    '  File "/usr/lib/python3.11/threading.py", line 327, in wait\n'
    "    waiter.acquire()\n",
    # concurrent.futures — a pool job waiting on the pool it occupies.
    '  File "/usr/lib/python3.11/concurrent/futures/_base.py", line 451, in result\n'
    "    self._condition.wait(timeout)\n",
    # A plain threading.Lock.
    '  File "/usr/lib/python3.11/threading.py", line 604, in acquire\n'
    "    self._block.acquire()\n",
]

# A worker that really is grinding: deepest frame inside the model.
COMPUTING_STACK = (
    '  File "/app/backend/services/model_manager.py", line 1801, in _load\n'
    "    return VoiceStudio.from_pretrained(checkpoint)\n"
    '  File "/app/omnivoice/models/omnivoice.py", line 812, in generate\n'
    "    audio = self.llm.forward(tokens)\n"
    '  File "/app/.venv/lib/python3.11/site-packages/torch/nn/modules/module.py", '
    'line 1553, in _call_impl\n'
    "    return forward_call(*args, **kwargs)\n"
)


@pytest.mark.parametrize("stack", WEDGED_STACKS)
def test_a_parked_worker_is_recognised(mm, stack):
    assert mm._stack_shows_a_wedge(stack)


def test_a_computing_worker_is_not(mm):
    """The false positive that matters: telling someone with a genuinely slow
    machine that they found a bug would send them to the issue tracker instead
    of to the shorter-text/lighter-engine advice that would actually help."""
    assert not mm._stack_shows_a_wedge(COMPUTING_STACK)


@pytest.mark.parametrize("stack", ["", None])
def test_no_stack_means_no_claim(mm, stack):
    """Unreadable stacks keep the old wording. Claiming a hang we cannot see is
    the same mistake pointing the other way."""
    assert not mm._stack_shows_a_wedge(stack)


def test_a_lock_the_worker_already_left_does_not_count(mm):
    """Only the deepest frames decide. A compute job's callers routinely
    include a lock acquisition it has since returned from — reading the whole
    stack would flag almost every job."""
    stack = (
        '  File "/usr/lib/python3.11/threading.py", line 604, in acquire\n'
        "    self._block.acquire()\n"
    ) + COMPUTING_STACK * 6
    assert not mm._stack_shows_a_wedge(stack)


# ── the message ────────────────────────────────────────────────────────────

def test_a_wedge_does_not_blame_the_machine(mm):
    msg = mm._timeout_guidance("TTS generate", 300.0, wedged=True)
    assert "too heavy for the available compute" not in msg
    assert "not a limit of your machine" in msg
    # None of the hardware remedies: they cannot speed up a job that never ran.
    for useless in ("shorter text", "lighter engine", "VRAM", "Flush caches"):
        assert useless not in msg or "won't help" in msg
    # It must give the one thing that does help.
    assert "restart the backend" in msg.lower()
    assert "github.com/debpalash/VoiceStudio/issues" in msg


def test_a_genuinely_slow_job_keeps_its_advice(mm):
    """No regression for the case the message was written for."""
    msg = mm._timeout_guidance("TTS generate", 300.0, wedged=False)
    assert "too heavy for the available compute" in msg
    assert "shorter text" in msg or "lighter engine" in msg


def test_the_default_is_the_old_wording(mm):
    """Every existing caller that hasn't been taught about wedges keeps its
    behaviour — the new branch is opt-in from the one site that has evidence."""
    assert mm._timeout_guidance("TTS generate", 300.0) == mm._timeout_guidance(
        "TTS generate", 300.0, wedged=False
    )


def test_an_app_function_named_wait_is_not_a_wedge(mm):
    """`in wait` / `in result` say nothing on their own — plenty of application
    code has functions by those names, and flagging them would tell a user with
    a genuinely slow machine that they had found a bug (CodeRabbit)."""
    stack = (
        '  File "/app/backend/services/dub_pipeline.py", line 88, in wait\n'
        "    self.poll_until_done()\n"
    )
    assert not mm._stack_shows_a_wedge(stack)


def test_a_third_party_result_function_is_not_a_wedge(mm):
    stack = (
        '  File "/app/.venv/lib/python3.11/site-packages/somelib/api.py", '
        'line 12, in result\n'
        "    return self._compute()\n"
    )
    assert not mm._stack_shows_a_wedge(stack)


def test_a_stdlib_frame_that_is_not_a_blocking_call_is_not_a_wedge(mm):
    stack = (
        '  File "/usr/lib/python3.11/threading.py", line 1002, in _bootstrap\n'
        "    self._bootstrap_inner()\n"
    )
    assert not mm._stack_shows_a_wedge(stack)


def test_windows_stdlib_paths_are_recognised(mm):
    """The reporters are on Windows and macOS; a POSIX-only path match would
    quietly never fire for half of them."""
    stack = (
        '  File "C:\\Python311\\Lib\\threading.py", line 327, in wait\n'
        "    waiter.acquire()\n"
    )
    assert mm._stack_shows_a_wedge(stack)


def test_unparseable_text_is_not_a_claim(mm):
    assert not mm._stack_shows_a_wedge("something that is not a stack at all")
