"""Resolving an engine's venv is work, and work must report progress (#1414).

`SubprocessBackend._spawn()` calls `venv_python()`, and on a cold first run
that is not cheap: the probe spawns each candidate interpreter to import the
engine (tens of seconds on a slow disk), and if none is installed it can run
the whole `uv venv` + `uv pip install` bootstrap — which is bounded at 900 s
*by design*, because installing torch takes minutes.

All of that happens on a GPU-pool worker, inside a generate request whose
execution budget defaults to 300 s. Nothing along the way reported progress,
so the budget expired part-way through and the job was abandoned — and, until
#1424, blamed on the machine's compute. The first generation that triggers a
bootstrap could therefore never succeed, no matter how good the hardware.

The sidecar's own cold model load already heartbeats for exactly this reason
(#1367). Resolution is the step immediately before it that never did.
"""
from __future__ import annotations

import threading
from contextlib import contextmanager
from pathlib import Path

import pytest


@pytest.fixture
def sb():
    """Resolved at run time, not import time."""
    import services.subprocess_backend as _sb

    return _sb


@pytest.fixture
def mm():
    import services.model_manager as _mm

    return _mm


def test_a_slow_resolution_extends_the_deadline(sb, mm, monkeypatch):
    """The whole point: a resolution that outlives one heartbeat interval
    leaves proof of life on the execution clock."""
    monkeypatch.setattr(sb, "_RESOLVE_HEARTBEAT_S", 0)
    monkeypatch.setattr(mm, "running_on_gpu_pool", lambda: True)
    ident = threading.get_ident()
    mm._MODEL_LOAD_ACTIVITY.pop(ident, None)

    wrote = threading.Event()

    class _SignallingMap(dict):
        def __setitem__(self, key, value):
            super().__setitem__(key, value)
            wrote.set()

    monkeypatch.setattr(mm, "_MODEL_LOAD_ACTIVITY", _SignallingMap())
    with sb._heartbeat_while_resolving("indextts2"):
        assert wrote.wait(2), "the heartbeat thread never reported progress"

    assert ident in mm._MODEL_LOAD_ACTIVITY, (
        "a slow venv resolution reported no progress — the generate budget "
        "expires part-way through the install it is waiting for"
    )
    mm._MODEL_LOAD_ACTIVITY.pop(ident, None)


def test_it_credits_the_resolving_thread_not_the_beater(sb, mm, monkeypatch):
    """The heartbeat runs on a helper thread so it can tick while resolution
    blocks — but the job the clock is watching is the caller's. Crediting the
    helper's ident would extend nothing and would poison an ident a pool
    worker may later reuse.

    Asserted against the beater's OWN ident rather than a before/after diff of
    the activity map: other tests in the suite have live pool workers, so the
    diff is not this test's to own.
    """
    monkeypatch.setattr(sb, "_RESOLVE_HEARTBEAT_S", 0)
    monkeypatch.setattr(mm, "running_on_gpu_pool", lambda: True)
    ident = threading.get_ident()
    mm._MODEL_LOAD_ACTIVITY.pop(ident, None)
    beater_idents: set[int] = set()
    wrote = threading.Event()

    class _SignallingMap(dict):
        def __setitem__(self, key, value):
            super().__setitem__(key, value)
            wrote.set()

    monkeypatch.setattr(mm, "_MODEL_LOAD_ACTIVITY", _SignallingMap())

    real_thread = threading.Thread

    class _Recording(real_thread):
        def run(self):
            beater_idents.add(threading.get_ident())
            super().run()

    monkeypatch.setattr(sb.threading, "Thread", _Recording)

    with sb._heartbeat_while_resolving("indextts2"):
        assert wrote.wait(2), "the heartbeat thread never reported progress"

    assert ident in mm._MODEL_LOAD_ACTIVITY, "the caller's job was never credited"
    assert beater_idents, "no heartbeat thread ran"
    assert not (beater_idents & set(mm._MODEL_LOAD_ACTIVITY)), (
        "the heartbeat thread credited its own ident — that extends nothing "
        "and poisons an ident a pool worker may later reuse"
    )
    mm._MODEL_LOAD_ACTIVITY.pop(ident, None)


def test_an_off_pool_caller_never_heartbeats(sb, mm, monkeypatch):
    """#1379's lesson: an off-pool thread's ident is not tracked by the clock,
    and a pool worker that later reuses it would inherit unearned extension."""
    monkeypatch.setattr(mm, "running_on_gpu_pool", lambda: False)
    ident = threading.get_ident()
    mm._MODEL_LOAD_ACTIVITY.pop(ident, None)

    class _UnexpectedThread:
        def __init__(self, *args, **kwargs):
            raise AssertionError("an off-pool call started a heartbeat helper")

    monkeypatch.setattr(sb.threading, "Thread", _UnexpectedThread)
    with sb._heartbeat_while_resolving("indextts2"):
        pass

    assert ident not in mm._MODEL_LOAD_ACTIVITY


def test_the_beater_stops_when_resolution_finishes(sb, mm, monkeypatch):
    """A thread per spawn that never exits would accumulate one per generate."""
    monkeypatch.setattr(sb, "_RESOLVE_HEARTBEAT_S", 0)
    monkeypatch.setattr(mm, "running_on_gpu_pool", lambda: True)
    exited = threading.Event()
    real_thread = threading.Thread

    class _Recording(real_thread):
        def run(self):
            try:
                super().run()
            finally:
                exited.set()

    monkeypatch.setattr(sb.threading, "Thread", _Recording)

    with sb._heartbeat_while_resolving("indextts2"):
        pass

    assert exited.wait(2), "heartbeat helper survived context exit"
    mm._MODEL_LOAD_ACTIVITY.pop(threading.get_ident(), None)


def test_a_broken_heartbeat_does_not_break_the_spawn(sb, monkeypatch):
    """Never raises: a generation must not fail because progress reporting
    could not import or could not write."""
    monkeypatch.setattr(sb, "_RESOLVE_HEARTBEAT_S", 0.01)

    import services.model_manager as mm

    monkeypatch.setattr(
        mm, "running_on_gpu_pool",
        lambda: (_ for _ in ()).throw(RuntimeError("clock is broken")),
    )
    with sb._heartbeat_while_resolving("indextts2"):
        pass  # the point is that this block is reached and exits cleanly


def test_spawn_wraps_the_resolution(sb, monkeypatch):
    """A guard against the wrapper being dropped in a later refactor: the
    heartbeat is worthless if `venv_python()` is called outside it."""
    active = False
    resolved_inside = threading.Event()

    @contextmanager
    def _recording_heartbeat(_engine_id):
        nonlocal active
        active = True
        try:
            yield
        finally:
            active = False

    class _StopAfterResolution(RuntimeError):
        pass

    class _Backend(sb.SubprocessBackend):
        id = "test"

        @property
        def sample_rate(self):
            return 24_000

        @property
        def supported_languages(self):
            return ["en"]

        @classmethod
        def is_available(cls):
            return True, "ready"

        @classmethod
        def venv_python(cls):
            assert active, "venv_python() ran outside the heartbeat context"
            resolved_inside.set()
            return Path("python")

        @classmethod
        def sidecar_script(cls):
            raise _StopAfterResolution

    monkeypatch.setattr(sb, "_heartbeat_while_resolving", _recording_heartbeat)
    backend = _Backend.__new__(_Backend)
    backend._proc = None
    with pytest.raises(_StopAfterResolution):
        backend._spawn()
    assert resolved_inside.is_set()


def test_no_heartbeat_write_escapes_the_context(sb, mm, monkeypatch):
    """The late-write race (CodeRabbit, #1426).

    `_beat()` can be past its `stop.wait()` and already committed to a write
    at the moment the context exits. Signalling the stop flag without joining
    lets that write land afterwards — and `_run_on_gpu_pool`'s `_job` pops
    this ident right after, precisely so a stale beat cannot vouch for a later
    job on the same (reused) worker ident. A write that arrives after the pop
    resurrects the entry, and the next job inherits a heartbeat it never sent:
    the wedge detector reads it as progress and keeps extending a stuck job.

    The interleaving is forced rather than waited for. A patched writer parks
    inside the write until the test releases it, so the exit path must be the
    thing that waits — if it only signals, the write lands after the context
    and the assertion catches it deterministically, on every run and every
    scheduler.
    """
    monkeypatch.setattr(sb, "_RESOLVE_HEARTBEAT_S", 0)
    monkeypatch.setattr(mm, "running_on_gpu_pool", lambda: True)
    ident = threading.get_ident()
    mm._MODEL_LOAD_ACTIVITY.pop(ident, None)

    in_write = threading.Event()
    release = threading.Event()
    write_finished = threading.Event()

    class _ParkingMap(dict):
        """Stalls the heartbeat mid-write so the exit path has to wait."""

        def __setitem__(self, key, value):
            in_write.set()
            assert release.wait(5), "test did not release the parked write"
            super().__setitem__(key, value)
            write_finished.set()

    context_exited = threading.Event()
    monkeypatch.setattr(mm, "_MODEL_LOAD_ACTIVITY", _ParkingMap())

    joined = threading.Event()
    real_thread = threading.Thread

    class _JoinRecordingThread(real_thread):
        def join(self, *args, **kwargs):
            joined.set()
            return super().join(*args, **kwargs)

    monkeypatch.setattr(sb.threading, "Thread", _JoinRecordingThread)

    def _run_context():
        with sb._heartbeat_while_resolving("indextts2"):
            assert in_write.wait(5), "heartbeat never attempted a write"
        context_exited.set()

    runner = real_thread(target=_run_context)
    runner.start()
    try:
        assert in_write.wait(5), "heartbeat never reached the parked write"
        assert joined.wait(2), "context exit did not wait for the heartbeat helper"
        assert not context_exited.is_set(), "context exited before the write finished"
    finally:
        release.set()
        runner.join(5)

    assert write_finished.is_set(), "parked heartbeat write did not finish"
    assert not runner.is_alive(), "resolve context did not exit after the write"
    assert context_exited.is_set()
    mm._MODEL_LOAD_ACTIVITY.pop(ident, None)
