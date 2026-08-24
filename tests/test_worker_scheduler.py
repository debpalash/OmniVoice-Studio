"""Scheduler: admission, the selection pipeline, dispatch, and the sweeper.

The pipeline under test is filter → strategy → tiebreak. The property that
matters most: a user-selected strategy can reorder *preferences* but can never
reach past the hard filter to pick a worker that is offline, incapable, full,
or paused.
"""
from __future__ import annotations

import asyncio

import pytest

from worker import deadlines as deadline_policy
from worker.capacity import ModelSlot
from worker.errors import ErrorClass, WorkerError
from worker.identity import issue_session
from worker.lifecycle import PriorityClass, TaskState
from worker.pool import WorkerPool
from worker.registry import RemoteWorker
from worker.scheduler import (
    NoEligibleWorker,
    QueueFull,
    Scheduler,
    SchedulerStopped,
    Strategy,
)

ENGINE, MODEL, OP = "indextts", "IndexTTS-2", "tts"
MODEL_KEY = f"{ENGINE}:{MODEL}"


def _record(
    worker_id: str,
    *,
    priority: int = 50,
    consent: bool = True,
    operations: list[str] | None = None,
) -> RemoteWorker:
    return RemoteWorker(
        id=worker_id,
        name=worker_id,
        key_id=f"key-{worker_id}",
        public_key=b"\x00" * 32,
        priority=priority,
        capabilities=[
            {
                "engine": ENGINE,
                "model_id": MODEL,
                "operations": operations or [OP],
                "supported": True,
                "installed": True,
                "downloaded": True,
            }
        ],
        consent_granted_at=1.0 if consent else None,
        created_at=1.0,
    )


def _pool(*workers, slots: int = 2, now: float = 1000.0) -> WorkerPool:
    pool = WorkerPool()
    for record in workers:
        pool.connect(
            record,
            session=issue_session(worker_id=record.id, key_id=record.key_id, epoch=1, now=now),
            epoch=1,
            max_concurrent_tasks=slots,
            backend="cuda",
            now=now,
        )
    return pool


def _scheduler(pool: WorkerPool, **kw) -> Scheduler:
    return Scheduler(pool, persist=False, **kw)


def _submit(sched: Scheduler, **kw):
    defaults = dict(operation=OP, engine=ENGINE, model_id=MODEL, now=1000.0)
    defaults.update(kw)
    return sched.submit(**defaults)


# ── Admission ──────────────────────────────────────────────────────────────


def test_submit_queues_a_task():
    sched = _scheduler(_pool(_record("w1")))
    task = _submit(sched)
    assert task.state is TaskState.QUEUED
    assert sched.queue_depth == 1


def test_failed_durable_admission_never_publishes_a_ghost_task(monkeypatch):
    from worker import scheduler as scheduler_module

    sched = Scheduler(_pool(_record("w1")), persist=True)
    monkeypatch.setattr(
        scheduler_module.task_store,
        "create",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("disk full")),
    )

    with pytest.raises(OSError, match="disk full"):
        _submit(sched)

    assert sched.queue_depth == 0
    assert sched._tasks == {}
    assert sched.next_assignment(now=1000.0) is None


def test_idempotency_key_deduplicates_client_retries():
    """A client HTTP retry must not produce a second render of the same text."""
    sched = _scheduler(_pool(_record("w1")))
    first = _submit(sched, idempotency_key="abc")
    second = _submit(sched, idempotency_key="abc")
    assert first.task_id == second.task_id
    assert sched.queue_depth == 1


def test_queue_is_bounded_and_refuses_at_the_door():
    """Accepting into an unbounded queue means the user waits, then gets a
    timeout that looks like their hardware failed."""
    sched = _scheduler(_pool(_record("w1")), max_queue_depth=2)
    _submit(sched)
    _submit(sched)
    with pytest.raises(QueueFull, match="full"):
        _submit(sched)


def test_queue_full_error_is_actionable():
    sched = _scheduler(_pool(_record("w1")), max_queue_depth=1)
    _submit(sched)
    with pytest.raises(QueueFull) as exc:
        _submit(sched)
    assert "add another worker" in str(exc.value).lower()


def test_pin_is_a_hard_filter_in_both_selection_lists():
    sched = _scheduler(_pool(_record("chosen"), _record("other")))
    task = _submit(sched, pinned_worker_id="chosen")
    assert [w.worker_id for w in sched.eligible_workers(task, now=1000.0)] == ["chosen"]
    sched.pool.disconnect("chosen")
    with pytest.raises(NoEligibleWorker, match="selected worker") as exc:
        sched.select_worker(task, now=1001.0)
    assert exc.value.retryable is False


def test_pinned_capacity_races_do_not_spend_attempts_or_exclude_the_worker():
    sched = _scheduler(_pool(_record("chosen")))
    task = _submit(sched, pinned_worker_id="chosen", max_attempts=2)
    for stamp in (1001.0, 1002.0, 1003.0):
        assignment = sched.next_assignment(now=stamp)
        sched.on_failed(
            task.task_id, assignment.attempt.attempt_id,
            WorkerError(error_class=ErrorClass.CAPACITY, code="WORKER_AT_CAPACITY", message="busy"),
            epoch=1, now=stamp + 0.1,
        )
    assert task.state is TaskState.QUEUED
    assert task.attempts_remaining == 2
    assert task.excluded_workers == set()


def test_a_connected_pin_that_cannot_run_this_is_not_reported_as_offline():
    """"Offline" and "here but cannot run this" are different facts.

    Found on real hardware, not in this suite: asking a live worker for an
    engine it does not have answered "is offline or cannot be reached. Wake
    the selected worker" — while that worker reported ready, one free slot and
    3.6 ms latency. The user is sent to wake a machine that is already awake,
    and the actual cause (the model is not there) is never mentioned.

    The whole suite was green when that shipped, because nothing asked a
    connected worker for something it could not do.
    """
    sched = _scheduler(_pool(_record("chosen", operations=["tts"])))
    task = _submit(sched, pinned_worker_id="chosen", operation="dubbing")

    with pytest.raises(NoEligibleWorker) as exc:
        sched.select_worker(task, now=1001.0)

    message = str(exc.value)
    assert "offline" not in message.lower(), "the worker is connected"
    assert "connected but" in message
    # Names the engine rather than the operation: "cannot run indextts" points
    # at the thing the user can install, where "cannot run dubbing" does not.
    assert task.engine in message
    assert exc.value.retryable is False


def test_supports_does_not_hide_a_missing_download_from_gateway_preflight():
    """Scheduling filters installation, while the gateway owns downloads."""
    worker = _pool(_record("chosen", operations=["tts"])).get("chosen")
    worker.record.capabilities[0]["downloaded"] = False

    assert worker.supports(ENGINE, MODEL, OP) is True


def test_unreachable_pin_fails_by_name_instead_of_leaking_or_waiting_forever():
    sched = _scheduler(_pool(_record("other")))
    task = _submit(sched, pinned_worker_id="chosen")

    assert sched.next_assignment(now=1001.0) is None
    assert task.state is TaskState.FAILED
    assert task.error.code == "PINNED_WORKER_UNREACHABLE"
    assert "chosen" in task.error.message


# ── Ordering ───────────────────────────────────────────────────────────────


def test_interactive_outranks_batch():
    sched = _scheduler(_pool(_record("w1")))
    batch = _submit(sched, priority=PriorityClass.BATCH)
    interactive = _submit(sched, priority=PriorityClass.INTERACTIVE)
    assert sched.next_assignment(now=1000.0).task.task_id == interactive.task_id
    assert batch.state is TaskState.QUEUED


def test_same_class_is_fifo():
    sched = _scheduler(_pool(_record("w1")))
    first = _submit(sched, now=1000.0)
    _submit(sched, now=1001.0)
    assert sched.next_assignment(now=1002.0).task.task_id == first.task_id


def test_queue_position_is_reported():
    """Preserves the local queue's "2 jobs ahead of you" affordance."""
    sched = _scheduler(_pool(_record("w1")))
    a = _submit(sched, now=1000.0)
    b = _submit(sched, now=1001.0)
    assert sched.position(a.task_id) == 0
    assert sched.position(b.task_id) == 1


# ── Hard filter ────────────────────────────────────────────────────────────


def test_disabled_worker_is_never_selected():
    record = _record("w1")
    record.enabled = False
    sched = _scheduler(_pool(record))
    with pytest.raises(NoEligibleWorker):
        sched.select_worker(_submit(sched), now=1000.0)


def test_worker_without_consent_is_never_selected():
    """Audio must not leave the machine for a worker the user never approved."""
    sched = _scheduler(_pool(_record("w1", consent=False)))
    with pytest.raises(NoEligibleWorker):
        sched.select_worker(_submit(sched), now=1000.0)


def test_incapable_worker_is_never_selected():
    sched = _scheduler(_pool(_record("w1")))
    task = _submit(sched, engine="cosyvoice", model_id="CosyVoice2")
    with pytest.raises(NoEligibleWorker) as exc:
        sched.select_worker(task, now=1000.0)
    assert exc.value.retryable is False


def test_excluded_worker_is_never_reselected():
    sched = _scheduler(_pool(_record("w1")))
    task = _submit(sched)
    task.excluded_workers.add("w1")
    with pytest.raises(NoEligibleWorker):
        sched.select_worker(task, now=1000.0)


def test_open_breaker_removes_a_worker():
    pool = _pool(_record("w1"))
    sched = _scheduler(pool)
    for _ in range(3):
        pool.breakers.record_failure(
            "w1", MODEL_KEY, WorkerError(error_class=ErrorClass.TRANSIENT, code="X", message="x"), now=1000.0
        )
    with pytest.raises(NoEligibleWorker) as exc:
        sched.select_worker(_submit(sched), now=1000.0)
    assert exc.value.retryable is True


def test_stale_worker_is_removed():
    """Half-open TCP looks exactly like a healthy idle connection."""
    sched = _scheduler(_pool(_record("w1"), now=1000.0))
    with pytest.raises(NoEligibleWorker):
        sched.select_worker(_submit(sched), now=1000.0 + 500)


def test_draining_worker_takes_no_new_work():
    pool = _pool(_record("w1"))
    pool.get("w1").draining = True
    sched = _scheduler(pool)
    with pytest.raises(NoEligibleWorker):
        sched.select_worker(_submit(sched), now=1000.0)


def test_full_worker_is_removed_but_stays_retryable():
    pool = _pool(_record("w1"), slots=1)
    sched = _scheduler(pool)
    _submit(sched)
    sched.next_assignment(now=1000.0)
    with pytest.raises(NoEligibleWorker) as exc:
        sched.select_worker(_submit(sched), now=1000.0)
    assert exc.value.retryable is True


def test_busy_and_incapable_are_different_errors():
    """Telling a user to wait for something that will never happen is the
    error-message failure this project treats as a bug."""
    pool = _pool(_record("w1"), slots=1)
    sched = _scheduler(pool)
    _submit(sched)
    sched.next_assignment(now=1000.0)

    with pytest.raises(NoEligibleWorker) as busy:
        sched.select_worker(_submit(sched), now=1000.0)
    with pytest.raises(NoEligibleWorker) as incapable:
        sched.select_worker(_submit(sched, engine="nope"), now=1000.0)

    assert busy.value.retryable is True
    assert incapable.value.retryable is False
    assert "busy" in str(busy.value).lower()
    assert "install" in str(incapable.value).lower()


# ── Strategy and tiebreak ──────────────────────────────────────────────────


def test_priority_strategy_prefers_the_primary():
    pool = _pool(_record("low", priority=10), _record("high", priority=90))
    sched = _scheduler(pool, strategy=Strategy.PRIORITY)
    assert sched.select_worker(_submit(sched), now=1000.0).worker_id == "high"


def test_least_busy_is_the_default():
    pool = _pool(_record("w1"), _record("w2"))
    sched = _scheduler(pool)
    pool.get("w1").capacity.reserve(ENGINE, MODEL)
    assert sched.select_worker(_submit(sched), now=1000.0).worker_id == "w2"


def test_strategy_cannot_override_the_hard_filter():
    """The §14-vs-§19 conflict: a user's 'always use my primary' must not be
    able to select a paused or offline worker."""
    pool = _pool(_record("primary", priority=100), _record("backup", priority=10))
    sched = _scheduler(pool, strategy=Strategy.PRIORITY)
    for _ in range(3):
        pool.breakers.record_failure(
            "primary",
            MODEL_KEY,
            WorkerError(error_class=ErrorClass.TRANSIENT, code="X", message="x"),
            now=1000.0,
        )
    assert sched.select_worker(_submit(sched), now=1000.0).worker_id == "backup"


def test_warm_model_wins_the_tiebreak():
    """A resident model is seconds away; a cold one can be minutes."""
    pool = _pool(_record("cold"), _record("warm"))
    pool.get("warm").capacity.resident_models = {MODEL_KEY}
    sched = _scheduler(pool)
    assert sched.select_worker(_submit(sched), now=1000.0).worker_id == "warm"


def test_load_beats_warmth_when_a_warm_worker_is_saturated():
    pool = _pool(_record("warm"), _record("cold"), slots=1)
    pool.get("warm").capacity.resident_models = {MODEL_KEY}
    sched = _scheduler(pool)
    _submit(sched)
    first = sched.next_assignment(now=1000.0)
    assert first.worker.worker_id == "warm"
    assert sched.select_worker(_submit(sched), now=1000.0).worker_id == "cold"


def test_per_model_slot_limit_is_respected():
    pool = _pool(_record("w1"), slots=8)
    pool.get("w1").capacity.slots[MODEL_KEY] = ModelSlot(
        engine=ENGINE, model_id=MODEL, derived_concurrency=1
    )
    sched = _scheduler(pool)
    _submit(sched)
    sched.next_assignment(now=1000.0)
    with pytest.raises(NoEligibleWorker):
        sched.select_worker(_submit(sched), now=1000.0)


# ── Dispatch ───────────────────────────────────────────────────────────────


def test_assignment_reserves_capacity_and_sets_deadlines():
    pool = _pool(_record("w1"))
    sched = _scheduler(pool)
    _submit(sched)
    assignment = sched.next_assignment(now=1000.0)

    assert assignment.task.state is TaskState.ASSIGNED
    assert pool.get("w1").capacity.active_tasks == 1
    assert assignment.attempt.attempt_id in pool.get("w1").in_flight
    assert assignment.deadlines.accept_seconds > 0


def test_assignment_deadline_uses_selected_workers_device(monkeypatch):
    record = _record("w1")
    record.capabilities[0]["backend"] = "cuda"
    pool = _pool(record)
    worker = pool.get("w1")
    worker.capacity.backend = "cuda"
    seen = []
    real = deadline_policy.for_task

    def recording_for_task(*args, **kwargs):
        seen.append(kwargs.get("execution_device"))
        return real(*args, **kwargs)

    monkeypatch.setattr(deadline_policy, "for_task", recording_for_task)
    sched = _scheduler(pool)
    _submit(sched)
    assignment = sched.next_assignment(now=1000.0)

    sched._budget_for(assignment.task)
    assert seen == ["cuda", "cuda"]


def test_cpu_fallback_capability_overrides_machine_cuda(monkeypatch):
    record = _record("w1")
    record.capabilities[0].update({"backend": "cuda", "cpu_fallback": True})
    pool = _pool(record)
    worker = pool.get("w1")

    assert worker.capacity.backend == "cuda"
    assert worker.execution_device(ENGINE, MODEL, OP) == "cpu"


def test_missing_or_unknown_capability_backend_is_conservative_cpu():
    record = _record("w1")
    pool = _pool(record)
    worker = pool.get("w1")
    assert worker.execution_device(ENGINE, MODEL, OP) == "cpu"

    record.capabilities[0]["backend"] = "mystery-accelerator"
    assert worker.execution_device(ENGINE, MODEL, OP) == "cpu"
    assert worker.execution_device("missing", MODEL, OP) == "cpu"


def test_no_capable_worker_fails_the_task_rather_than_ageing_it_out():
    sched = _scheduler(_pool(_record("w1")))
    task = _submit(sched, engine="nope")
    assert sched.next_assignment(now=1000.0) is None
    assert task.state is TaskState.FAILED
    assert task.error.code == "NO_CAPABLE_WORKER"


def test_all_busy_leaves_the_task_queued():
    pool = _pool(_record("w1"), slots=1)
    sched = _scheduler(pool)
    _submit(sched)
    queued = _submit(sched)
    sched.next_assignment(now=1000.0)
    assert sched.next_assignment(now=1000.0) is None
    assert queued.state is TaskState.QUEUED


def test_happy_path_completes_and_releases_capacity():
    pool = _pool(_record("w1"))
    sched = _scheduler(pool)
    _submit(sched)
    a = sched.next_assignment(now=1000.0)

    sched.on_accepted(a.task.task_id, a.attempt.attempt_id, epoch=1, now=1001.0)
    sched.on_started(a.task.task_id, a.attempt.attempt_id, epoch=1, now=1002.0)
    committed, task = sched.on_result(
        a.task.task_id, a.attempt.attempt_id, result_ref="out.wav", epoch=1, now=1003.0
    )

    assert committed is True
    assert task.state is TaskState.COMPLETED
    assert pool.get("w1").capacity.active_tasks == 0


def test_duplicate_result_is_acked_but_not_applied():
    pool = _pool(_record("w1"))
    sched = _scheduler(pool)
    _submit(sched)
    a = sched.next_assignment(now=1000.0)
    sched.on_accepted(a.task.task_id, a.attempt.attempt_id, epoch=1, now=1001.0)
    sched.on_started(a.task.task_id, a.attempt.attempt_id, epoch=1, now=1002.0)
    sched.on_result(a.task.task_id, a.attempt.attempt_id, result_ref="first", epoch=1, now=1003.0)

    committed, task = sched.on_result(
        a.task.task_id, a.attempt.attempt_id, result_ref="second", epoch=1, now=1004.0
    )
    assert committed is False
    assert task.result_ref == "first"


def test_stale_epoch_messages_are_dropped():
    sched = _scheduler(_pool(_record("w1")))
    _submit(sched)
    a = sched.next_assignment(now=1000.0)
    assert sched.on_accepted(a.task.task_id, a.attempt.attempt_id, epoch=99, now=1001.0) is None
    assert a.task.state is TaskState.ASSIGNED


# ── Failures and retry ─────────────────────────────────────────────────────


def test_failure_requeues_and_excludes_the_worker():
    pool = _pool(_record("w1"), _record("w2"))
    sched = _scheduler(pool)
    _submit(sched)
    a = sched.next_assignment(now=1000.0)

    sched.on_failed(
        a.task.task_id,
        a.attempt.attempt_id,
        WorkerError(error_class=ErrorClass.TRANSIENT, code="ENGINE_CRASHED", message="boom"),
        epoch=1,
        now=1001.0,
    )

    assert a.task.state is TaskState.QUEUED
    second = sched.next_assignment(now=1002.0)
    assert second.worker.worker_id != a.worker.worker_id


def test_capacity_rejection_does_not_exclude_or_charge():
    pool = _pool(_record("w1"))
    sched = _scheduler(pool)
    _submit(sched)
    a = sched.next_assignment(now=1000.0)

    sched.on_failed(
        a.task.task_id,
        a.attempt.attempt_id,
        WorkerError(error_class=ErrorClass.CAPACITY, code="WORKER_AT_CAPACITY", message="full"),
        epoch=1,
        now=1001.0,
    )

    assert a.task.excluded_workers == set()
    assert pool.breakers.allows("w1", MODEL_KEY, now=1001.0) is True


def test_timeout_parks_a_zombie_slot():
    """The GPU thread survives the timeout, so its capacity does not return."""
    pool = _pool(_record("w1"), slots=2)
    sched = _scheduler(pool)
    _submit(sched)
    a = sched.next_assignment(now=1000.0)

    sched.on_failed(
        a.task.task_id,
        a.attempt.attempt_id,
        WorkerError(error_class=ErrorClass.TIMEOUT, code="EXECUTION_TIMEOUT", message="slow"),
        epoch=1,
        now=1001.0,
    )

    assert pool.get("w1").capacity.zombie_tasks == 1
    assert pool.get("w1").capacity.available_slots == 1


# ── Disconnect and reconciliation ──────────────────────────────────────────


def test_disconnect_starts_a_grace_window_without_failing():
    pool = _pool(_record("w1"))
    sched = _scheduler(pool)
    _submit(sched)
    a = sched.next_assignment(now=1000.0)
    sched.on_accepted(a.task.task_id, a.attempt.attempt_id, epoch=1, now=1001.0)
    sched.on_started(a.task.task_id, a.attempt.attempt_id, epoch=1, now=1002.0)

    affected = sched.on_disconnected("w1", now=1003.0)

    assert len(affected) == 1
    assert a.task.state is TaskState.RUNNING
    assert a.attempt.grace_expires_at is not None


def test_restore_stamps_a_deadline_on_legacy_queued_rows(monkeypatch):
    from worker import task_store

    task = _submit(_scheduler(_pool(_record("w1"))))
    task.deadline_at = None
    saves = []
    monkeypatch.setattr(task_store, "load_unfinished", lambda: [task])
    monkeypatch.setattr(task_store, "save", lambda saved, **kw: saves.append(saved.deadline_at))
    sched = Scheduler(_pool(_record("w1")))
    sched.restore(now=10_000.0)
    assert task.deadline_at > 10_000.0
    assert saves == [task.deadline_at]


def test_grace_expiry_requeues_and_frees_the_slot():
    pool = _pool(_record("w1"), _record("w2"))
    sched = _scheduler(pool)
    _submit(sched)
    a = sched.next_assignment(now=1000.0)
    sched.on_accepted(a.task.task_id, a.attempt.attempt_id, epoch=1, now=1001.0)
    sched.on_started(a.task.task_id, a.attempt.attempt_id, epoch=1, now=1002.0)
    sched.on_disconnected("w1", now=1003.0)

    sched.sweep(now=1003.0 + 600)

    assert a.task.state is TaskState.QUEUED
    assert "w1" in a.task.excluded_workers


def test_result_arriving_inside_the_grace_window_still_commits():
    """No duplicate execution ever happened — this is the whole point."""
    pool = _pool(_record("w1"))
    sched = _scheduler(pool)
    _submit(sched)
    a = sched.next_assignment(now=1000.0)
    sched.on_accepted(a.task.task_id, a.attempt.attempt_id, epoch=1, now=1001.0)
    sched.on_started(a.task.task_id, a.attempt.attempt_id, epoch=1, now=1002.0)
    sched.on_disconnected("w1", now=1003.0)

    committed, task = sched.on_result(
        a.task.task_id, a.attempt.attempt_id, result_ref="out.wav", epoch=1, now=1010.0
    )

    assert committed is True
    assert task.attempt_count == 1


def test_reconnect_flags_zombies_for_cancellation():
    pool = _pool(_record("w1"))
    sched = _scheduler(pool)
    _submit(sched)
    a = sched.next_assignment(now=1000.0)
    sched.on_accepted(a.task.task_id, a.attempt.attempt_id, epoch=1, now=1001.0)
    sched.on_started(a.task.task_id, a.attempt.attempt_id, epoch=1, now=1002.0)
    sched.on_disconnected("w1", now=1003.0)
    sched.sweep(now=1003.0 + 600)

    zombies = sched.on_reconnected("w1", in_flight={a.attempt.attempt_id}, now=2000.0)
    assert a.attempt.attempt_id in zombies


def test_reconnect_cancels_an_attempt_unknown_to_the_control_plane():
    pool = _pool(_record("w1"))
    sched = _scheduler(pool)
    _submit(sched)

    zombies = sched.on_reconnected("w1", in_flight={"unknown-attempt"}, now=2000.0)

    assert zombies == ["unknown-attempt"]


def test_reconnect_does_not_mistake_another_live_task_for_a_zombie():
    pool = _pool(_record("w1"), slots=2)
    sched = _scheduler(pool)
    tasks = [_submit(sched), _submit(sched)]
    attempts = [
        task.assign(worker_id="w1", session_epoch=1, now=1000.0)
        for task in tasks
    ]
    for task, attempt in zip(tasks, attempts):
        task.accept(attempt.attempt_id, now=1001.0)
        task.start(attempt.attempt_id, now=1002.0)
    sched.on_disconnected("w1", now=1003.0)
    claimed = {attempt.attempt_id for attempt in attempts}

    assert sched.on_reconnected("w1", in_flight=claimed, now=1010.0) == []
    assert all(task.state is TaskState.RUNNING for task in tasks)


@pytest.mark.asyncio
async def test_reconnect_failure_resolves_an_existing_waiter():
    sched = _scheduler(_pool(_record("w1")))
    task = _submit(sched, max_attempts=1)
    assignment = sched.next_assignment(now=1000.0)
    assert assignment is not None
    waiter = asyncio.create_task(sched.wait(task.task_id, timeout=1))
    await asyncio.sleep(0)

    sched.on_reconnected("w1", in_flight=set(), now=1010.0)

    assert await waiter is task
    assert task.state is TaskState.FAILED


def test_reconnect_notifies_listeners_when_missing_work_is_requeued():
    sched = _scheduler(_pool(_record("w1")))
    task = _submit(sched, max_attempts=2)
    assignment = sched.next_assignment(now=1000.0)
    events = []
    sched.on_change(lambda event, changed: events.append((event, changed.task_id)))

    sched.on_reconnected("w1", in_flight=set(), now=1010.0)

    assert assignment.attempt.state.terminal
    assert task.state is TaskState.QUEUED
    assert events == [("requeued", task.task_id)]


# ── Sweeper ────────────────────────────────────────────────────────────────


def test_unaccepted_assignment_times_out():
    pool = _pool(_record("w1"), _record("w2"))
    sched = _scheduler(pool)
    _submit(sched)
    a = sched.next_assignment(now=1000.0)

    sched.sweep(now=1000.0 + a.deadlines.accept_seconds + 1)

    assert a.task.state is TaskState.QUEUED
    assert a.attempt.error.code == "ACCEPT_TIMEOUT"


def test_a_reporting_task_is_never_swept():
    """Silence is the failure signal, not slowness."""
    pool = _pool(_record("w1", operations=["dub"]))
    sched = _scheduler(pool)
    _submit(sched, operation="dub")
    a = sched.next_assignment(now=1000.0)
    sched.on_accepted(a.task.task_id, a.attempt.attempt_id, epoch=1, now=1001.0)
    sched.on_started(a.task.task_id, a.attempt.attempt_id, epoch=1, now=1002.0)

    clock = 1002.0
    for _ in range(60):
        clock += 60.0
        sched.on_progress(a.task.task_id, a.attempt.attempt_id, progress=0.5, epoch=1, now=clock)
        sched.sweep(now=clock)

    assert a.task.state is TaskState.RUNNING


def test_stale_heartbeat_disconnects_a_worker():
    pool = _pool(_record("w1"))
    sched = _scheduler(pool)
    _submit(sched)
    a = sched.next_assignment(now=1000.0)
    sched.on_accepted(a.task.task_id, a.attempt.attempt_id, epoch=1, now=1001.0)
    sched.on_started(a.task.task_id, a.attempt.attempt_id, epoch=1, now=1002.0)

    sched.sweep(now=1002.0 + 200)

    assert pool.get("w1") is None
    assert a.attempt.grace_expires_at is not None


def test_queued_task_past_its_deadline_fails_with_a_clear_reason():
    sched = _scheduler(_pool(_record("w1"), slots=1))
    _submit(sched)
    sched.next_assignment(now=1000.0)
    waiting = _submit(sched, deadline_seconds=30)

    sched.sweep(now=1100.0)

    assert waiting.state is TaskState.TIMEOUT
    assert waiting.error.code == "TASK_DEADLINE_EXCEEDED"


# ── Cancellation ───────────────────────────────────────────────────────────


def test_cancel_parks_capacity_until_worker_acknowledges():
    pool = _pool(_record("w1"))
    sched = _scheduler(pool)
    task = _submit(sched)
    assignment = sched.next_assignment(now=1000.0)

    assert sched.cancel(task.task_id, now=1001.0) is True
    assert task.state is TaskState.CANCELLED
    assert pool.get("w1").capacity.active_tasks == 1
    assert assignment.attempt.attempt_id in pool.get("w1").in_flight

    sched.on_cancel_ack(
        task.task_id, assignment.attempt.attempt_id, epoch=1, now=1002.0
    )
    assert pool.get("w1").capacity.active_tasks == 0
    assert assignment.attempt.attempt_id not in pool.get("w1").in_flight


def test_cancelled_task_cannot_resurrect_to_completed():
    sched = _scheduler(_pool(_record("w1")))
    task = _submit(sched)
    assignment = sched.next_assignment(now=1000.0)
    sched.cancel(task.task_id, now=1001.0)

    committed, _ = sched.on_result(
        task.task_id,
        assignment.attempt.attempt_id,
        result_ref="late.wav",
        epoch=1,
        now=1002.0,
    )

    assert committed is False
    assert task.state is TaskState.CANCELLED
    assert task.result_ref is None


def test_cancelling_a_finished_task_is_a_no_op():
    pool = _pool(_record("w1"))
    sched = _scheduler(pool)
    _submit(sched)
    a = sched.next_assignment(now=1000.0)
    sched.on_accepted(a.task.task_id, a.attempt.attempt_id, epoch=1, now=1001.0)
    sched.on_started(a.task.task_id, a.attempt.attempt_id, epoch=1, now=1002.0)
    sched.on_result(a.task.task_id, a.attempt.attempt_id, result_ref="r", epoch=1, now=1003.0)

    assert sched.cancel(a.task.task_id, now=1004.0) is False


# ── Events ─────────────────────────────────────────────────────────────────


def test_transitions_are_broadcast():
    pool = _pool(_record("w1"))
    sched = _scheduler(pool)
    seen: list[str] = []
    sched.on_change(lambda event, _task: seen.append(event))

    _submit(sched)
    a = sched.next_assignment(now=1000.0)
    sched.on_accepted(a.task.task_id, a.attempt.attempt_id, epoch=1, now=1001.0)
    sched.on_started(a.task.task_id, a.attempt.attempt_id, epoch=1, now=1002.0)
    sched.on_result(a.task.task_id, a.attempt.attempt_id, result_ref="r", epoch=1, now=1003.0)

    assert seen == ["queued", "assigned", "accepted", "started", "completed"]


def test_a_broken_listener_cannot_break_scheduling():
    sched = _scheduler(_pool(_record("w1")))
    sched.on_change(lambda *_: 1 / 0)
    _submit(sched)
    assert sched.next_assignment(now=1000.0) is not None


# ── Awaiting a result ──────────────────────────────────────────────────────


def _run_to_completion(sched: Scheduler, a, *, result_ref: str = "out.wav") -> None:
    sched.on_accepted(a.task.task_id, a.attempt.attempt_id, epoch=1, now=1001.0)
    sched.on_started(a.task.task_id, a.attempt.attempt_id, epoch=1, now=1002.0)
    sched.on_result(
        a.task.task_id, a.attempt.attempt_id, result_ref=result_ref, epoch=1, now=1003.0
    )


@pytest.mark.asyncio
async def test_wait_returns_the_completed_task():
    sched = _scheduler(_pool(_record("w1")))
    task = _submit(sched)
    a = sched.next_assignment(now=1000.0)

    waiter = asyncio.ensure_future(sched.wait(task.task_id, timeout=5))
    await asyncio.sleep(0)
    _run_to_completion(sched, a)

    finished = await waiter
    assert finished.state is TaskState.COMPLETED
    assert finished.result_ref == "out.wav"


@pytest.mark.asyncio
async def test_wait_returns_a_task_that_finished_before_anyone_asked():
    """`submit` hands back an existing task on an idempotency-key hit and
    `restore` adopts finished ones from disk, so the terminal check has to come
    before registering — nothing will emit a second ending."""
    sched = _scheduler(_pool(_record("w1")))
    task = _submit(sched)
    _run_to_completion(sched, sched.next_assignment(now=1000.0))

    assert (await sched.wait(task.task_id, timeout=0.05)).state is TaskState.COMPLETED


@pytest.mark.asyncio
async def test_waiting_does_not_leak_a_listener_per_call():
    """`on_change` has no unregister, so building the await on it would leak a
    listener for the life of the process on every awaited job."""
    sched = _scheduler(_pool(_record("w1")))
    before = len(sched._listeners)
    for _ in range(5):
        task = _submit(sched)
        _run_to_completion(sched, sched.next_assignment(now=1000.0))
        await sched.wait(task.task_id, timeout=0.05)

    assert len(sched._listeners) == before
    assert sched._waiters == {}


@pytest.mark.asyncio
async def test_a_failed_task_wakes_its_waiter():
    sched = _scheduler(_pool(_record("w1")))
    task = _submit(sched, max_attempts=1)
    a = sched.next_assignment(now=1000.0)

    waiter = asyncio.ensure_future(sched.wait(task.task_id, timeout=5))
    await asyncio.sleep(0)
    sched.on_failed(
        a.task.task_id,
        a.attempt.attempt_id,
        WorkerError(error_class=ErrorClass.TERMINAL, code="BAD_INPUT", message="no"),
        epoch=1,
        now=1001.0,
    )

    assert (await waiter).state is TaskState.FAILED


@pytest.mark.asyncio
async def test_a_cancelled_task_wakes_its_waiter():
    sched = _scheduler(_pool(_record("w1")))
    task = _submit(sched)
    sched.next_assignment(now=1000.0)

    waiter = asyncio.ensure_future(sched.wait(task.task_id, timeout=5))
    await asyncio.sleep(0)
    sched.cancel(task.task_id, now=1001.0)

    assert (await waiter).state is TaskState.CANCELLED


def test_cancel_ack_releases_a_parked_slot_exactly_once():
    pool = _pool(_record("w1"), slots=1)
    sched = _scheduler(pool)
    task = _submit(sched)
    assignment = sched.next_assignment(now=1000.0)
    sched.cancel(task.task_id, now=1001.0)
    sched.on_cancel_ack(task.task_id, assignment.attempt.attempt_id, epoch=1, now=1002.0)
    sched.on_cancel_ack(task.task_id, assignment.attempt.attempt_id, epoch=1, now=1003.0)
    assert pool.get("w1").capacity.available_slots == 1


@pytest.mark.asyncio
async def test_control_plane_sends_task_cancel_to_the_attempt_owner():
    from worker.service import ControlPlane

    pool = _pool(_record("w1"), slots=1)
    sched = _scheduler(pool)
    task = _submit(sched)
    assignment = sched.next_assignment(now=1000.0)
    sent = []

    class Servicer:
        async def cancel(self, *args):
            sent.append(args)
            return True

    plane = ControlPlane()
    plane.scheduler = sched
    plane.servicer = Servicer()
    assert await plane.cancel(task.task_id, reason="caller left")
    assert sent == [(
        "w1", task.task_id, assignment.attempt.attempt_id,
        assignment.attempt.session_epoch,
    )]


@pytest.mark.asyncio
async def test_a_task_with_no_capable_worker_wakes_its_waiter():
    """The dead-end path fails the task inside `next_assignment` rather than
    through any worker callback — a funnel that missed it would hang the
    caller until its own timeout for a verdict already reached."""
    sched = _scheduler(_pool(_record("w1")))
    task = _submit(sched, engine="nope")

    waiter = asyncio.ensure_future(sched.wait(task.task_id, timeout=5))
    await asyncio.sleep(0)
    sched.next_assignment(now=1000.0)

    assert (await waiter).state is TaskState.FAILED


@pytest.mark.asyncio
async def test_a_late_failure_after_a_result_does_not_explode():
    """`on_failed` used to run its whole body even when the attempt was
    already settled, emitting "failed" for a completed task — and a second
    resolution of one waiter raises InvalidStateError inside the read loop,
    killing a healthy worker session over a message that changed nothing."""
    pool = _pool(_record("w1"))
    sched = _scheduler(pool)
    task = _submit(sched)
    a = sched.next_assignment(now=1000.0)
    _run_to_completion(sched, a)
    await sched.wait(task.task_id, timeout=0.05)

    seen: list[str] = []
    sched.on_change(lambda event, _t: seen.append(event))
    sched.on_failed(
        a.task.task_id,
        a.attempt.attempt_id,
        WorkerError(error_class=ErrorClass.TIMEOUT, code="EXECUTION_TIMEOUT", message="slow"),
        epoch=1,
        now=1004.0,
    )

    assert task.state is TaskState.COMPLETED
    assert seen == []
    assert pool.breakers.allows("w1", MODEL_KEY, now=1004.0) is True


@pytest.mark.asyncio
async def test_wait_times_out_without_disturbing_the_task():
    """A caller giving up says nothing to the worker, which is still rendering."""
    sched = _scheduler(_pool(_record("w1")))
    task = _submit(sched)
    sched.next_assignment(now=1000.0)

    with pytest.raises(TimeoutError):
        await sched.wait(task.task_id, timeout=0.01)

    assert task.state is TaskState.ASSIGNED
    assert sched._waiters == {}


@pytest.mark.asyncio
async def test_one_waiter_timing_out_does_not_cancel_the_others():
    sched = _scheduler(_pool(_record("w1")))
    task = _submit(sched)
    a = sched.next_assignment(now=1000.0)

    patient = asyncio.ensure_future(sched.wait(task.task_id, timeout=5))
    await asyncio.sleep(0)
    with pytest.raises(TimeoutError):
        await sched.wait(task.task_id, timeout=0.01)

    _run_to_completion(sched, a)
    assert (await patient).state is TaskState.COMPLETED


@pytest.mark.asyncio
async def test_shutdown_fails_outstanding_waiters_by_name():
    """Not a bare cancellation: the work may still be running on the worker,
    and the caller has to be able to say so."""
    sched = _scheduler(_pool(_record("w1")))
    task = _submit(sched)
    sched.next_assignment(now=1000.0)

    waiter = asyncio.ensure_future(sched.wait(task.task_id, timeout=5))
    await asyncio.sleep(0)
    assert sched.abort_waiters() == 1

    with pytest.raises(SchedulerStopped):
        await waiter


@pytest.mark.asyncio
async def test_waiting_on_an_unknown_task_is_an_error_not_a_hang():
    sched = _scheduler(_pool(_record("w1")))
    with pytest.raises(KeyError):
        await sched.wait("nosuch", timeout=0.01)


# ── Keepalives and the lease ceiling ───────────────────────────────────────


def _running(sched: Scheduler, *, now: float = 1000.0):
    a = sched.next_assignment(now=now)
    sched.on_accepted(a.task.task_id, a.attempt.attempt_id, epoch=1, now=now + 1)
    sched.on_started(a.task.task_id, a.attempt.attempt_id, epoch=1, now=now + 2)
    return a


def test_a_keepalive_does_not_overwrite_real_progress():
    """The keepalive is the worker's timer, not its work. Letting it write
    would walk the user's progress bar backwards to zero every 40 seconds."""
    sched = _scheduler(_pool(_record("w1")))
    _submit(sched)
    a = _running(sched)
    sched.on_progress(
        a.task.task_id, a.attempt.attempt_id, progress=0.6, stage="generating", epoch=1, now=1010.0
    )

    sched.on_progress(
        a.task.task_id, a.attempt.attempt_id, progress=0.0, keepalive=True, epoch=1, now=1050.0
    )

    assert a.attempt.progress == pytest.approx(0.6)
    assert a.attempt.stage == "generating"
    assert a.attempt.lease_expires_at > 1050.0


def test_a_keepalive_cannot_outlive_the_execution_budget():
    """The keepalive would otherwise remove the only enforced bound in the
    system: nothing reads `execution_seconds`, `Deadlines.total_seconds` has no
    callers, and a RUNNING attempt past its deadline is never swept."""
    sched = _scheduler(_pool(_record("w1")))
    _submit(sched)
    a = _running(sched)
    budget = a.deadlines.execution_seconds

    clock = 1002.0
    for _ in range(200):
        clock += 40.0
        sched.on_progress(
            a.task.task_id, a.attempt.attempt_id, progress=0.0, keepalive=True, epoch=1, now=clock
        )
        sched.sweep(now=clock)
        if a.task.state.terminal or a.task.state is TaskState.QUEUED:
            break

    assert clock <= 1002.0 + budget + 60, "the keepalive kept a wedged task alive past its budget"
    assert a.attempt.error.code == "EXECUTION_TIMEOUT"


def test_keepalive_distinguishes_slow_execution_from_a_wedge():
    """A slow executor crosses 120s; a timer-only wedge still hits its phase cap."""
    sched = _scheduler(_pool(_record("w1")))
    _submit(sched)
    a = _running(sched)
    original_lease = a.attempt.lease_expires_at

    # Timer frames prove the worker is alive, so crossing the original lease
    # is not itself a failure.
    clock = original_lease - 1.0
    sched.on_progress(
        a.task.task_id,
        a.attempt.attempt_id,
        progress=0.0,
        keepalive=True,
        epoch=1,
        now=clock,
    )
    sched.sweep(now=original_lease + 1.0)
    assert a.task.state is TaskState.RUNNING

    # But keepalive=True carries no evidence of forward progress. Repeating it
    # can renew only up to the execution phase budget.
    while a.task.state is TaskState.RUNNING:
        clock += 40.0
        sched.on_progress(
            a.task.task_id,
            a.attempt.attempt_id,
            progress=0.0,
            keepalive=True,
            epoch=1,
            now=clock,
        )
        sched.sweep(now=clock)

    assert a.attempt.error.code == "EXECUTION_TIMEOUT"


def test_real_progress_renews_without_a_ceiling():
    """Slow is not wedged: a task that keeps producing output keeps its lease
    however long it takes (a 40-minute dub is not a hung task)."""
    pool = _pool(_record("w1", operations=["dub"]))
    sched = _scheduler(pool)
    _submit(sched, operation="dub")
    a = _running(sched)

    clock = 1002.0
    for step in range(200):
        clock += 60.0
        sched.on_progress(
            a.task.task_id,
            a.attempt.attempt_id,
            progress=step / 200,
            epoch=1,
            now=clock,
        )
        sched.sweep(now=clock)

    assert a.task.state is TaskState.RUNNING


def test_a_keepalive_is_bounded_by_the_model_load_budget_while_loading():
    sched = _scheduler(_pool(_record("w1")))
    _submit(sched)
    a = sched.next_assignment(now=1000.0)
    sched.on_accepted(a.task.task_id, a.attempt.attempt_id, epoch=1, now=1001.0)
    sched.on_model_loading(a.task.task_id, a.attempt.attempt_id, epoch=1, now=1002.0)
    ceiling = 1002.0 + a.deadlines.model_load_seconds

    sched.on_progress(
        a.task.task_id,
        a.attempt.attempt_id,
        progress=0.0,
        keepalive=True,
        epoch=1,
        now=ceiling - 10,
    )

    assert a.attempt.lease_expires_at == pytest.approx(ceiling)


def test_a_keepalive_for_a_stale_epoch_is_dropped():
    sched = _scheduler(_pool(_record("w1")))
    _submit(sched)
    a = _running(sched)
    before = a.attempt.lease_expires_at

    assert (
        sched.on_progress(
            a.task.task_id, a.attempt.attempt_id, progress=0.0, keepalive=True, epoch=99, now=1050.0
        )
        is None
    )
    assert a.attempt.lease_expires_at == before


# ── Persistence of progress ────────────────────────────────────────────────


def test_progress_is_written_through_but_throttled(monkeypatch):
    """Without this the persisted lease is whichever one `on_started` stamped,
    so a restart mid-render restores an attempt that the first sweep kills.
    Writing every frame would be a database write per second of a long dub."""
    from worker import task_store

    saves: list[float] = []
    monkeypatch.setattr(task_store, "create", lambda task, **kw: task)
    monkeypatch.setattr(task_store, "save", lambda task, now=None: saves.append(now))
    monkeypatch.setattr(task_store, "commit_result", lambda task, **kw: None)
    monkeypatch.setattr(task_store, "get_by_idempotency_key", lambda key: None)

    sched = Scheduler(_pool(_record("w1")))
    _submit(sched)
    a = _running(sched)
    saves.clear()

    clock = 1002.0
    for _ in range(10):
        clock += 1.0
        sched.on_progress(a.task.task_id, a.attempt.attempt_id, progress=0.5, epoch=1, now=clock)

    assert saves, "the lease on disk would otherwise never move"
    assert len(saves) < 10, "a write per frame is a write per second of a 40-minute dub"


def test_restore_rearms_the_lease_of_a_recovered_attempt(monkeypatch):
    """The recovered lease was ticking while the app was closed and nobody was
    listening for renewals. Enforcing it fails every healthy in-flight task at
    once, before its worker's own backoff can even reconnect it."""
    from worker import task_store

    pool = _pool(_record("w1"))
    donor = _scheduler(pool)
    _submit(donor)
    a = _running(donor)
    monkeypatch.setattr(task_store, "load_unfinished", lambda: [a.task])
    monkeypatch.setattr(task_store, "save", lambda task, now=None: None)

    sched = Scheduler(pool)
    assert sched.restore(now=99_000.0) == 1
    pool.get("w1").last_heartbeat_at = 99_000.0  # its worker reconnected

    assert sched.sweep(now=99_001.0) == []
    assert a.task.state is TaskState.RUNNING


def test_restore_bounds_a_legacy_queued_task_with_no_deadline(monkeypatch):
    """Pre-deadline rows otherwise survive every sweep forever."""
    from worker import task_store

    task = _submit(_scheduler(_pool(_record("w1"))))
    task.deadline_at = None
    saves = []
    monkeypatch.setattr(task_store, "load_unfinished", lambda: [task])
    monkeypatch.setattr(task_store, "save", lambda saved, now=None: saves.append(saved.deadline_at))

    sched = Scheduler(_pool(_record("w1")))
    assert sched.restore(now=10_000.0) == 1
    assert task.deadline_at is not None and task.deadline_at > 10_000.0
    assert saves == [task.deadline_at]


# ── Zombie slots (B2) ──────────────────────────────────────────────────────


def test_a_parked_slot_does_not_strand_the_worker_forever():
    """B2: with `max_concurrent_tasks=1`, one lease expiry made the worker
    permanently unschedulable — `reap_zombie` had no caller and nothing else
    ever looked at `zombie_tasks` again."""
    pool = _pool(_record("w1"), slots=1)
    sched = _scheduler(pool)
    _submit(sched)
    a = _running(sched)

    sched.on_failed(
        a.task.task_id,
        a.attempt.attempt_id,
        WorkerError(error_class=ErrorClass.TIMEOUT, code="EXECUTION_TIMEOUT", message="slow"),
        epoch=1,
        now=1010.0,
    )
    assert pool.get("w1").capacity.available_slots == 0

    later = 1010.0 + 3600 + 1
    pool.get("w1").last_heartbeat_at = later  # it never stopped heartbeating
    sched.sweep(now=later)

    assert pool.get("w1").capacity.zombie_tasks == 0
    assert pool.get("w1").capacity.available_slots == 1


def test_a_lost_attempt_parks_its_slot_rather_than_returning_it():
    """A grace expiry is an unknown outcome, so the GPU thread may well still
    be running — the same un-killable thread the timeout path parks for
    (#730/#1190). Marked lost without dropping the session, because
    `on_disconnected` takes the whole capacity record with it."""
    pool = _pool(_record("w1"), _record("w2"))
    sched = _scheduler(pool)
    _submit(sched)
    a = _running(sched)
    a.task.mark_disconnected(a.attempt.attempt_id, grace_seconds=45, now=1010.0)

    pool.get("w1").last_heartbeat_at = 1060.0
    sched.sweep(now=1060.0)

    assert a.task.state is TaskState.QUEUED
    assert pool.get("w1").capacity.zombie_tasks == 1
    assert a.attempt.attempt_id not in pool.get("w1").in_flight


def test_a_result_racing_the_sweeper_cannot_double_release():
    """Two paths ending one attempt: `capacity.release` guards its per-model
    slot but decrements the worker-wide count regardless, so the second one
    invents a slot the machine does not have."""
    pool = _pool(_record("w1"), slots=2)
    pool.get("w1").capacity.slots[MODEL_KEY] = ModelSlot(
        engine=ENGINE, model_id=MODEL, derived_concurrency=2
    )
    sched = _scheduler(pool)
    _submit(sched)
    _submit(sched)
    first = _running(sched)
    second = _running(sched, now=1005.0)
    assert pool.get("w1").capacity.active_tasks == 2

    for stamp in (1010.0, 1011.0):
        sched.on_result(
            first.task.task_id, first.attempt.attempt_id, result_ref="out.wav", epoch=1, now=stamp
        )

    assert second.task.state is TaskState.RUNNING
    assert pool.get("w1").capacity.active_tasks == 1, "the second job is still on the GPU"
    assert pool.get("w1").capacity.available_slots == 1
