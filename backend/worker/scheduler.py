"""Central scheduler.

Two structural decisions the council settled, both of which shape everything
else in this module:

**One central queue.** The original design gave every worker its own queue with
its own depth and maximum size. That produces head-of-line blocking — a task
committed to a busy worker waits while another sits idle — and then demands
work-stealing to undo. Here the queue is central and workers hold only in-flight
slots, so a task is bound to a worker at the last possible moment.

**Filter, then strategy, then tiebreak.** The original had seven user-selectable
strategies *and* a ten-factor ranked scheduler, with no rule for how they
compose — so "always use my primary" and "never use an unhealthy worker" could
each claim to be authoritative. The pipeline here is unambiguous:

    1. hard filter   — enabled, connected, consented, capable, has capacity,
                       breaker closed, not excluded, not draining.
                       A user strategy can NEVER override these.
    2. strategy      — priority-ordered or least-busy, over the survivors.
    3. tiebreak      — warm model first, then lower load, then higher priority.

Model residency is in the tiebreak rather than the strategy because it is a
latency term, not a preference: a warm model is seconds away and a cold one can
be minutes.
"""
from __future__ import annotations

import asyncio
import copy
import enum
import logging
import uuid
from dataclasses import dataclass, fields
from functools import partial
from typing import Callable, Optional

from worker import deadlines as deadline_policy
from worker import registry, task_store
from worker.async_utils import (
    to_thread_and_defer_cancellation,
    to_thread_and_drain_on_cancel,
)
from worker.breaker import Attribution
from worker.capacity import WorkerCapacity
from worker.clock import resolve
from worker.errors import ErrorClass, WorkerError
from worker.lifecycle import Attempt, PriorityClass, Task, TaskState, reconcile
from worker.pool import ConnectedWorker, WorkerPool

logger = logging.getLogger("omnivoice.worker")

# Bounded queue. Past this, submission is refused at the door with an
# actionable error rather than accepted and quietly timed out later.
_MAX_QUEUE_DEPTH = 200

# How often a progress report is written through to disk. Every frame would be
# a database write per second of a forty-minute dub; never writing leaves the
# persisted lease frozen at the one on_started stamped, so a restart mid-render
# reloads an attempt that expires on the next sweep. Ten seconds against a
# 120-second lease keeps the recovered value inside its own window.
_PROGRESS_PERSIST_SECONDS = 10.0

# What a restored attempt's lease is re-armed to. The clock we recover with is
# meaningless — it was ticking while we were not listening — and the worker
# cannot renew it before it reconnects, which its own backoff allows up to 60s
# for (`transport/client.py:_MAX_BACKOFF_SECONDS`). Anything shorter fails
# every healthy in-flight task on restart; anything much longer delays the
# honest verdict for work whose worker is genuinely gone.
_RESTART_REARM_SECONDS = 90.0


class Strategy(str, enum.Enum):
    """Two strategies, not seven.

    ``PRIORITY`` expresses primary/backup: the user's preferred machine simply
    has a higher priority number. ``LEAST_BUSY`` is the default and is what
    most setups actually want. Random and round-robin collapse into each other
    once the eligibility filter has run, and lowest-latency is actively
    misleading — heartbeat round-trip is milliseconds while inference is
    seconds, so it ranks on noise.
    """

    LEAST_BUSY = "least_busy"
    PRIORITY = "priority"


class QueueFull(RuntimeError):
    """Submission refused because the queue is at its bound."""


class NoEligibleWorker(RuntimeError):
    """No connected worker can run this task."""

    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.retryable = retryable


class SchedulerStopped(RuntimeError):
    """The control plane shut down while a caller was awaiting a task.

    Named, not a bare cancellation: the work may well still be running on the
    worker, so the caller has to be able to say that rather than report a
    failure that never happened.
    """


def _adopt_task_state(target: Task, source: Task) -> None:
    """Commit a reconciled copy while preserving public task/attempt identities."""
    current_attempts = {attempt.attempt_id: attempt for attempt in target.attempts}
    adopted_attempts = []
    for source_attempt in source.attempts:
        target_attempt = current_attempts.get(source_attempt.attempt_id)
        if target_attempt is None:
            target_attempt = copy.deepcopy(source_attempt)
        else:
            for item in fields(Attempt):
                setattr(
                    target_attempt,
                    item.name,
                    copy.deepcopy(getattr(source_attempt, item.name)),
                )
        adopted_attempts.append(target_attempt)

    for item in fields(Task):
        if item.name != "attempts":
            setattr(target, item.name, copy.deepcopy(getattr(source, item.name)))
    target.attempts[:] = adopted_attempts


@dataclass(frozen=True)
class Assignment:
    """One task bound to one worker, ready to send."""

    task: Task
    attempt: Attempt
    worker: ConnectedWorker
    deadlines: deadline_policy.Deadlines


@dataclass(frozen=True)
class _ReconciliationGeneration:
    """Immutable task copies persisted before their live generation is adopted."""

    worker_id: str
    stamp: float
    originals: tuple[Task, ...]
    snapshots: tuple[Task, ...]
    candidates: tuple[Task, ...]
    zombies: tuple[str, ...] = ()


class Scheduler:
    """Owns the queue, the selection pipeline, and the deadline sweeper."""

    def __init__(
        self,
        pool: WorkerPool,
        *,
        strategy: Strategy = Strategy.LEAST_BUSY,
        max_queue_depth: int = _MAX_QUEUE_DEPTH,
        persist: bool = True,
    ) -> None:
        self.pool = pool
        self.strategy = strategy
        self.max_queue_depth = max_queue_depth
        self._persist = persist
        # Central queue: task_id → Task, insertion-ordered.
        self._tasks: dict[str, Task] = {}
        self._listeners: list[Callable[[str, Task], None]] = []
        # Callers blocked in `wait`, task_id → one shared future. Deliberately not
        # built on `on_change`: that list has no unregister, so one listener
        # per await would leak for the life of the process. `shield` below
        # prevents one request timeout from cancelling the shared outcome.
        self._waiters: dict[str, asyncio.Future] = {}
        self._waiter_counts: dict[str, int] = {}
        # task_id → when its progress was last written through. Cleared with
        # the task, so it cannot outlive what it describes.
        self._progress_saved_at: dict[str, float] = {}
        # Async producers serialize admission while durable input staging is
        # off-loop. This keeps queue/idempotency decisions atomic without
        # holding the event loop hostage to a multi-gigabyte copy and hash.
        self._submission_lock = asyncio.Lock()

    # ── Persistence seam ──────────────────────────────────────────────────

    def _save(self, task: Task, *, now: Optional[float] = None) -> None:
        if self._persist:
            task_store.save(task, now=now)

    def on_change(self, callback: Callable[[str, Task], None]) -> None:
        """Subscribe to task transitions (the UI's event feed hangs off this)."""
        self._listeners.append(callback)

    def _emit(self, event: str, task: Task) -> None:
        for callback in self._listeners:
            try:
                callback(event, task)
            except Exception:
                logger.exception("Task listener failed for %s", event)
        if task.state.terminal:
            # The one funnel. Every terminal path already announces itself
            # here, so hanging the await on this makes it impossible to add a
            # new ending that forgets to wake the caller waiting on it.
            self._resolve(task)

    # ── Awaiting a result ─────────────────────────────────────────────────

    async def wait(self, task_id: str, timeout: Optional[float] = None) -> Task:
        """Block until ``task_id`` reaches a terminal state, and return it.

        Raises ``KeyError`` for a task this scheduler does not hold,
        ``TimeoutError`` when ``timeout`` elapses first (the task keeps
        running — the worker was never told anything), and ``SchedulerStopped``
        if the control plane shuts down first.
        """
        task = self._tasks.get(task_id)
        if task is None:
            raise KeyError(task_id)
        # Checked before registering, not after: `submit` returns an existing
        # task on an idempotency-key hit and `restore` adopts tasks from disk,
        # so the task may have finished before anyone thought to wait for it —
        # and nothing will ever emit a second terminal event for it.
        if task.state.terminal:
            return task

        future = self._waiters.get(task_id)
        if future is None:
            future = asyncio.get_running_loop().create_future()
            self._waiters[task_id] = future
        self._waiter_counts[task_id] = self._waiter_counts.get(task_id, 0) + 1
        try:
            return await asyncio.wait_for(asyncio.shield(future), timeout)
        finally:
            remaining = self._waiter_counts.get(task_id, 1) - 1
            if remaining > 0:
                self._waiter_counts[task_id] = remaining
            else:
                self._waiter_counts.pop(task_id, None)
                if not future.done() and self._waiters.get(task_id) is future:
                    self._waiters.pop(task_id, None)

    def _resolve(self, task: Task) -> None:
        """Hand a finished task to everyone awaiting it, at most once.

        Idempotent by construction. `on_failed` used to run its whole body even
        when the attempt was already terminal, so one task could announce
        "failed" after it had completed — and a second `set_result` on a
        settled future raises `InvalidStateError` inside the read loop, which
        is a torn-down worker session for a message that changed nothing.
        """
        self._progress_saved_at.pop(task.task_id, None)
        future = self._waiters.pop(task.task_id, None)
        self._waiter_counts.pop(task.task_id, None)
        if future is not None and not future.done():
            future.set_result(task)

    def abort_waiters(self, reason: str = "The control plane stopped.") -> int:
        """Fail every outstanding waiter. Called from ``ControlPlane.stop``.

        Without it, a shutdown leaves each awaiting request hanging on a future
        nothing will ever complete, and the app cannot finish quitting.
        """
        pending = self._waiters
        self._waiters = {}
        self._waiter_counts = {}
        count = 0
        for future in pending.values():
            if not future.done():
                future.set_exception(SchedulerStopped(reason))
                count += 1
        return count

    # ── Submission ────────────────────────────────────────────────────────

    def submit(
        self,
        *,
        operation: str,
        engine: str,
        model_id: str,
        params: Optional[dict] = None,
        priority: PriorityClass = PriorityClass.INTERACTIVE,
        idempotency_key: Optional[str] = None,
        max_attempts: int = 3,
        deadline_seconds: Optional[float] = None,
        pinned_worker_id: Optional[str] = None,
        now: Optional[float] = None,
    ) -> Task:
        """Admit a task, or refuse it at the door.

        Refusing at submission is deliberate: accepting work into an unbounded
        queue means the user waits, then gets a timeout that looks like their
        hardware failed. A queue-full error names the real problem while they
        can still act on it.
        """
        stamp = resolve(now)
        if idempotency_key:
            for existing in self._tasks.values():
                if existing.idempotency_key == idempotency_key:
                    return existing
            if self._persist:
                stored = task_store.get_by_idempotency_key(idempotency_key)
                if stored is not None:
                    self._tasks.setdefault(stored.task_id, stored)
                    return stored

        if self.queue_depth >= self.max_queue_depth:
            raise QueueFull(
                f"The remote task queue is full ({self.max_queue_depth} waiting). "
                "Wait for current work to finish, or add another worker."
            )

        task = Task(
            task_id=uuid.uuid4().hex[:16],
            operation=operation,
            engine=engine,
            model_id=model_id,
            params=params or {},
            priority=priority,
            idempotency_key=idempotency_key,
            max_attempts=max_attempts,
            created_at=stamp,
            pinned_worker_id=pinned_worker_id,
        )
        if deadline_seconds:
            task.deadline_at = stamp + deadline_seconds
        if self._persist:
            persisted = task_store.create(task, now=stamp)
            if persisted.task_id != task.task_id:
                self._tasks.setdefault(persisted.task_id, persisted)
                return persisted
            task = persisted
        # Publish to the dispatcher only after durable admission succeeds. A
        # failed DB/input-stage write must not send work the API rejected.
        self._tasks[task.task_id] = task
        self._emit("queued", task)
        return task

    async def submit_async(
        self,
        *,
        operation: str,
        engine: str,
        model_id: str,
        params: Optional[dict] = None,
        priority: PriorityClass = PriorityClass.INTERACTIVE,
        idempotency_key: Optional[str] = None,
        max_attempts: int = 3,
        deadline_seconds: Optional[float] = None,
        pinned_worker_id: Optional[str] = None,
        now: Optional[float] = None,
    ) -> Task:
        """Admit durably without hashing/copying task inputs on the app loop."""
        async with self._submission_lock:
            stamp = resolve(now)
            if idempotency_key:
                for existing in self._tasks.values():
                    if existing.idempotency_key == idempotency_key:
                        return existing
                if self._persist:
                    stored, cancelled = await to_thread_and_defer_cancellation(
                        task_store.get_by_idempotency_key, idempotency_key
                    )
                    if stored is not None:
                        self._tasks.setdefault(stored.task_id, stored)
                        if cancelled:
                            raise asyncio.CancelledError
                        return stored
                    if cancelled:
                        raise asyncio.CancelledError

            if self.queue_depth >= self.max_queue_depth:
                raise QueueFull(
                    f"The remote task queue is full ({self.max_queue_depth} waiting). "
                    "Wait for current work to finish, or add another worker."
                )

            task = Task(
                task_id=uuid.uuid4().hex[:16],
                operation=operation,
                engine=engine,
                model_id=model_id,
                params=params or {},
                priority=priority,
                idempotency_key=idempotency_key,
                max_attempts=max_attempts,
                created_at=stamp,
                pinned_worker_id=pinned_worker_id,
            )
            if deadline_seconds:
                task.deadline_at = stamp + deadline_seconds
            if self._persist:
                persisted, cancelled = await to_thread_and_defer_cancellation(
                    partial(task_store.create, task, now=stamp)
                )
                if persisted.task_id != task.task_id:
                    self._tasks.setdefault(persisted.task_id, persisted)
                    if cancelled:
                        raise asyncio.CancelledError
                    return persisted
                task = persisted
                if cancelled:
                    # The durable copy cannot be interrupted midway. Settle it
                    # before publication so cancellation can never dispatch a
                    # task whose caller did not finish submitting it.
                    task.cancel(reason="submission was cancelled", now=resolve())
                    await to_thread_and_drain_on_cancel(
                        partial(task_store.save, task, now=resolve())
                    )
                    self._tasks[task.task_id] = task
                    self._emit("cancelled", task)
                    raise asyncio.CancelledError

            # The dispatcher only learns the task after input bytes and its DB
            # row are durable. A failed stage cannot escape as runnable work.
            self._tasks[task.task_id] = task
            self._emit("queued", task)
            return task

    def adopt(self, task: Task) -> None:
        """Take ownership of a task loaded from disk after a restart."""
        self._tasks[task.task_id] = task

    def restore(self, *, now: Optional[float] = None) -> int:
        """Reload tasks that were live when the control plane stopped.

        They are NOT failed on the way in — unlike local jobs, the machine
        doing the work is still running. Reconciliation decides each one's fate
        when its worker reconnects.
        """
        if not self._persist:
            return 0
        stamp = resolve(now)
        restored = task_store.load_unfinished()
        for task in restored:
            if task.state is TaskState.QUEUED and task.deadline_at is None:
                # Rows created before deadlines became mandatory would never
                # be swept. Recovery gives them one bounded lifetime.
                task.deadline_at = stamp + deadline_policy.for_task(
                    task.operation,
                    text=task.params.get("text"),
                    input_seconds=float(task.params.get("input_seconds") or 0.0),
                ).total_seconds
                self._save(task, now=stamp)
            self._tasks.setdefault(task.task_id, task)
            attempt = task.active_attempt
            if attempt is not None:
                # A lease that expired while the app was closed says nothing
                # about the worker: nobody was listening for the renewals. Give
                # it a reconnect window instead, or the first sweep after
                # startup kills every healthy in-flight task at once.
                attempt.renew_lease(_RESTART_REARM_SECONDS, now=stamp)
        if restored:
            logger.info("Recovered %d in-flight remote task(s) after restart", len(restored))
        return len(restored)

    # ── Queue introspection ───────────────────────────────────────────────

    @property
    def queue_depth(self) -> int:
        return sum(1 for t in self._tasks.values() if t.state is TaskState.QUEUED)

    def get(self, task_id: str) -> Optional[Task]:
        return self._tasks.get(task_id)

    def tasks_for_worker(self, worker_id: str) -> list[Task]:
        """Live tasks this control plane believes ``worker_id`` is running.

        Sent back on reconnect as the authoritative list: anything the worker
        holds that is absent here is a zombie it must stop, and anything here
        the worker does not claim was lost while we were apart.
        """
        found = []
        for task in self._tasks.values():
            if task.state.terminal:
                continue
            attempt = task.active_attempt
            if attempt is not None and attempt.worker_id == worker_id:
                found.append(task)
        return found

    def position(self, task_id: str) -> int:
        """0-indexed place in line, or -1. Preserves the local queue's
        "2 jobs ahead of you" affordance for remote work."""
        target = self._tasks.get(task_id)
        if target is None or target.state is not TaskState.QUEUED:
            return -1
        return sum(1 for t in self._queued_order() if t.task_id != task_id and self._ranks_before(t, target))

    def _queued_order(self) -> list[Task]:
        """Interactive before batch, then FIFO inside each class."""
        return sorted(
            (t for t in self._tasks.values() if t.state is TaskState.QUEUED),
            key=lambda t: (int(t.priority), t.created_at),
        )

    @staticmethod
    def _ranks_before(a: Task, b: Task) -> bool:
        return (int(a.priority), a.created_at) < (int(b.priority), b.created_at)

    # ── Selection ─────────────────────────────────────────────────────────

    def eligible_workers(self, task: Task, *, now: Optional[float] = None) -> list[ConnectedWorker]:
        """The hard filter. No strategy may bypass any of these."""
        stamp = resolve(now)
        model_key = WorkerCapacity.slot_key(task.engine, task.model_id)
        eligible = []
        for worker in self.pool:
            if task.pinned_worker_id and worker.worker_id != task.pinned_worker_id:
                continue
            if (
                not worker.record.schedulable
                or worker.draining
                or worker.registration_pending
            ):
                continue
            if worker.stale(now=stamp):
                continue
            if worker.worker_id in task.excluded_workers:
                continue
            if not worker.supports(task.engine, task.model_id, task.operation):
                continue
            if not worker.capacity.can_accept(task.engine, task.model_id):
                continue
            if not self.pool.breakers.allows(worker.worker_id, model_key, now=stamp):
                continue
            eligible.append(worker)
        return eligible

    def _rank(self, task: Task, workers: list[ConnectedWorker]) -> list[ConnectedWorker]:
        """Strategy, then tiebreak. Warm-model affinity is the first tiebreak
        because it is worth more than any other factor here: a resident model
        is seconds away, a cold one minutes."""

        def tiebreak(worker: ConnectedWorker) -> tuple:
            return (
                0 if worker.is_warm(task.engine, task.model_id) else 1,
                worker.capacity.active_tasks,
                -worker.record.priority,
                worker.record.created_at,
            )

        if self.strategy is Strategy.PRIORITY:
            return sorted(workers, key=lambda w: (-w.record.priority, *tiebreak(w)))
        return sorted(workers, key=lambda w: (w.capacity.active_tasks, *tiebreak(w)))

    def select_worker(self, task: Task, *, now: Optional[float] = None) -> ConnectedWorker:
        """Pick the best eligible worker, or explain why there is none.

        The two "nothing available" cases are deliberately distinguished: all
        workers busy is a wait, no capable worker is a dead end, and telling a
        user to wait for something that will never happen is the error-message
        failure this project treats as a bug.
        """
        stamp = resolve(now)
        eligible = self.eligible_workers(task, now=stamp)
        if eligible:
            return self._rank(task, eligible)[0]

        capable = [
            w
            for w in self.pool
            if (not task.pinned_worker_id or w.worker_id == task.pinned_worker_id)
            and w.record.schedulable and w.supports(task.engine, task.model_id, task.operation)
        ]
        if not capable:
            if task.pinned_worker_id:
                # "Offline" and "here but cannot run this" are different facts,
                # and answering both with the first sends the user to go wake a
                # machine that is already awake — verified against a live
                # worker reporting ready, 1 free slot and 3.6 ms latency while
                # this raised "offline or cannot be reached".
                pinned = next(
                    (w for w in self.pool if w.worker_id == task.pinned_worker_id), None
                )
                if pinned is not None and pinned.record.schedulable:
                    raise NoEligibleWorker(
                        f"The selected worker {task.pinned_worker_id} is connected but "
                        f"cannot run {task.engine or task.operation}. Install or download "
                        "it there, or choose another GPU.",
                        retryable=False,
                    )
                raise NoEligibleWorker(
                    f"The selected worker {task.pinned_worker_id} is offline or cannot be reached.",
                    retryable=False,
                )
            raise NoEligibleWorker(
                f"No connected worker can run {task.engine or task.operation}. "
                "Check the worker is online and has that engine installed.",
                retryable=False,
            )
        raise NoEligibleWorker(
            "Every worker that can run this is busy or paused. The task stays queued.",
            retryable=True,
        )

    # ── Dispatch ──────────────────────────────────────────────────────────

    def next_assignment(self, *, now: Optional[float] = None) -> Optional[Assignment]:
        """Bind the highest-ranked waiting task to the best worker for it.

        Returns ``None`` when nothing can be dispatched — either the queue is
        empty or every waiting task is blocked on capacity. A task with no
        capable worker at all is failed here rather than left to age out.
        """
        # Selection and binding are one authority read. A revoke/disable route
        # holds the same lock until its durable row and live pool record agree,
        # so another thread cannot bind work in that publication window.
        with registry.authority_guard():
            return self._next_assignment(now=now)

    def _next_assignment(self, *, now: Optional[float] = None) -> Optional[Assignment]:
        stamp = resolve(now)
        for task in self._queued_order():
            try:
                worker = self.select_worker(task, now=stamp)
            except NoEligibleWorker as exc:
                if exc.retryable:
                    continue
                pinned = bool(task.pinned_worker_id)
                self._fail(
                    task,
                    WorkerError(
                        error_class=ErrorClass.CAPACITY if pinned else ErrorClass.CAPABILITY,
                        code="PINNED_WORKER_UNREACHABLE" if pinned else "NO_CAPABLE_WORKER",
                        message=str(exc),
                        hint=(
                            "Wake the selected worker, choose another GPU, or run locally."
                            if pinned else
                            "Install the engine on a worker, or run this task locally."
                        ),
                    ),
                    now=stamp,
                )
                continue
            return self._bind(task, worker, now=stamp)
        return None

    def _bind(self, task: Task, worker: ConnectedWorker, *, now: float) -> Assignment:
        attempt = task.assign(worker_id=worker.worker_id, session_epoch=worker.epoch, now=now)
        worker.capacity.reserve(task.engine, task.model_id)
        worker.in_flight.add(attempt.attempt_id)

        budget = deadline_policy.for_task(
            task.operation,
            text=task.params.get("text"),
            model_resident=worker.is_warm(task.engine, task.model_id),
            model_downloaded=True,
            input_seconds=float(task.params.get("input_seconds") or 0.0),
            execution_device=worker.execution_device(
                task.engine, task.model_id, task.operation
            ),
        )
        attempt.renew_lease(budget.accept_seconds, now=now)
        self._save(task, now=now)
        self._emit("assigned", task)
        return Assignment(task=task, attempt=attempt, worker=worker, deadlines=budget)

    # ── Worker callbacks ──────────────────────────────────────────────────

    def _fenced(self, task_id: str, attempt_id: str, epoch: Optional[int]) -> Optional[Task]:
        """Resolve a task for an inbound message, dropping stale sessions."""
        task = self._tasks.get(task_id)
        if task is None:
            return None
        attempt = task.get_attempt(attempt_id)
        if attempt is None:
            return None
        if epoch is not None and attempt.session_epoch != epoch:
            logger.debug("Dropping message for %s from stale epoch %s", task_id, epoch)
            return None
        return task

    def on_accepted(
        self, task_id: str, attempt_id: str, *, epoch: Optional[int] = None, now: Optional[float] = None
    ) -> Optional[Task]:
        task = self._fenced(task_id, attempt_id, epoch)
        if task is None:
            return None
        stamp = resolve(now)
        task.accept(attempt_id, session_epoch=epoch, now=stamp)
        budget = self._budget_for(task)
        task.get_attempt(attempt_id).renew_lease(budget.model_load_seconds, now=stamp)
        self._save(task, now=stamp)
        self._emit("accepted", task)
        return task

    def on_model_loading(
        self,
        task_id: str,
        attempt_id: str,
        *,
        progress: float = -1.0,
        detail: str = "",
        epoch: Optional[int] = None,
        now: Optional[float] = None,
    ) -> Optional[Task]:
        task = self._fenced(task_id, attempt_id, epoch)
        if task is None:
            return None
        stamp = resolve(now)
        attempt = task.get_attempt(attempt_id)
        if task.state is not TaskState.MODEL_LOADING:
            task.model_loading(attempt_id, session_epoch=epoch, now=stamp)
        attempt.stage = detail or "loading model"
        # A load that is still reporting is not stuck, however long it takes.
        attempt.renew_lease(self._budget_for(task).progress_lease_seconds, now=stamp)
        self._save(task, now=stamp)
        self._emit("model_loading", task)
        return task

    def on_started(
        self, task_id: str, attempt_id: str, *, epoch: Optional[int] = None, now: Optional[float] = None
    ) -> Optional[Task]:
        task = self._fenced(task_id, attempt_id, epoch)
        if task is None:
            return None
        stamp = resolve(now)
        task.start(attempt_id, session_epoch=epoch, now=stamp)
        task.get_attempt(attempt_id).renew_lease(
            self._budget_for(task).progress_lease_seconds, now=stamp
        )
        self._save(task, now=stamp)
        self._emit("started", task)
        return task

    def on_progress(
        self,
        task_id: str,
        attempt_id: str,
        *,
        progress: float,
        stage: str = "",
        keepalive: bool = False,
        epoch: Optional[int] = None,
        now: Optional[float] = None,
    ) -> Optional[Task]:
        """Renew an attempt's lease from a progress frame.

        The single entry point for the lease, ceiling included — the transport
        passes the flag off the wire and never computes an expiry of its own,
        so there is one place where "how long may this task stay alive" is
        decided.

        ``keepalive`` frames are the worker's timer, not its work: they say the
        process is still there while a single uninterruptible call runs. They
        renew the lease but leave ``progress``/``stage`` alone, because
        overwriting a real 60% with a timer's zero is a UI that goes backwards.
        """
        task = self._fenced(task_id, attempt_id, epoch)
        if task is None:
            return None
        stamp = resolve(now)
        attempt = task.get_attempt(attempt_id)
        budget = self._budget_for(task)
        if keepalive:
            attempt.renew_lease(
                budget.progress_lease_seconds,
                not_after=self._phase_ceiling(task, attempt, budget),
                now=stamp,
            )
            self._persist_progress(task, now=stamp)
            return task
        attempt.progress = max(0.0, min(1.0, progress))
        attempt.stage = stage or attempt.stage
        # Evidence of actual work: renewed without a ceiling, because a task
        # that keeps producing output is not wedged however long it takes.
        attempt.renew_lease(budget.progress_lease_seconds, now=stamp)
        self._persist_progress(task, now=stamp)
        self._emit("progress", task)
        return task

    @staticmethod
    def _phase_budget(task: Task, budget: deadline_policy.Deadlines) -> int:
        """How long the task's current phase is allowed to take in total."""
        if task.state is TaskState.MODEL_LOADING:
            return budget.model_load_seconds
        if task.state is TaskState.RESULT_UPLOADING:
            return budget.result_delivery_seconds
        return budget.execution_seconds

    def _phase_ceiling(
        self, task: Task, attempt: Attempt, budget: deadline_policy.Deadlines
    ) -> float:
        """The absolute time a keepalive may not renew past.

        Bounds the keepalive by the budget of the phase it is keeping alive.
        Without this the keepalive would delete the last enforced bound in the
        system: `Deadlines.total_seconds` has no callers, `execution_seconds`
        is put on the wire and read by nobody, and a RUNNING attempt past its
        task deadline is never swept — the progress lease is all there is.
        """
        return attempt.phase_anchor + self._phase_budget(task, budget)

    def _persist_progress(self, task: Task, *, now: float) -> None:
        """Write a progress report through to disk, at most every few seconds.

        The persisted lease used to be whichever one `on_started` stamped, so a
        restart mid-render restored an attempt whose lease had expired minutes
        ago and the first sweep failed it — the healthiest task in the system
        killed by the recovery meant to save it.
        """
        if not self._persist:
            return
        last = self._progress_saved_at.get(task.task_id)
        if last is not None and now - last < _PROGRESS_PERSIST_SECONDS:
            return
        self._progress_saved_at[task.task_id] = now
        self._save(task, now=now)

    def on_result(
        self,
        task_id: str,
        attempt_id: str,
        *,
        result_ref: Optional[str] = None,
        result: Optional[dict] = None,
        epoch: Optional[int] = None,
        now: Optional[float] = None,
    ) -> tuple[bool, Optional[Task]]:
        """Commit a result. Returns ``(committed, task)``.

        The caller must acknowledge the worker in BOTH cases — a duplicate
        still needs its ack, or the worker redelivers forever — but must only
        apply the result when ``committed`` is True.

        The commit is durable before this returns, which is what makes the
        subsequent RESULT_ACK safe to send.
        """
        stamp = resolve(now)
        task = self._tasks.get(task_id)
        if task is None:
            # Unknown task: either purged, or this control plane restarted and
            # never reloaded it. If disk says it completed, ack-and-discard.
            if self._persist and task_store.is_committed(task_id):
                return False, None
            return False, None
        attempt = task.get_attempt(attempt_id)
        if attempt is None:
            return False, task
        if epoch is not None and attempt.session_epoch != epoch:
            return False, task

        if self._persist:
            # Prepare and persist the terminal generation before publishing it
            # to the live graph.  A failed database write must leave the
            # redelivery path looking exactly as it did before this frame:
            # still in flight, still consuming capacity, and not yet credited
            # as a breaker success.
            candidate = copy.deepcopy(task)
            committed, _ = candidate.commit_result(
                attempt_id, result_ref=result_ref, session_epoch=epoch, now=stamp
            )
            if committed:
                task_store.commit_result(candidate, result_json=result, now=stamp)
            else:
                task_store.save(candidate, now=stamp)
            _adopt_task_state(task, candidate)
        else:
            committed, attempt = task.commit_result(
                attempt_id, result_ref=result_ref, session_epoch=epoch, now=stamp
            )
        self._release_slot(task, attempt, now=stamp)
        worker = self.pool.get(attempt.worker_id)
        if worker is not None and committed:
            self.pool.breakers.record_success(
                worker.worker_id,
                WorkerCapacity.slot_key(task.engine, task.model_id),
                now=stamp,
            )
        self._emit("completed" if committed else "duplicate", task)
        return committed, task

    def on_failed(
        self,
        task_id: str,
        attempt_id: str,
        error: WorkerError,
        *,
        epoch: Optional[int] = None,
        now: Optional[float] = None,
    ) -> Optional[Task]:
        task = self._fenced(task_id, attempt_id, epoch)
        if task is None:
            return None
        stamp = resolve(now)
        attempt = task.get_attempt(attempt_id)
        if attempt.state.terminal:
            # Already settled — a redelivered failure, or one the sweeper got
            # to first. `fail_attempt` ignores it, so running the rest of this
            # body would charge the breaker twice for one failure and announce
            # "failed" for a task that may have completed since.
            return task
        worker = self.pool.get(attempt.worker_id)
        model_key = WorkerCapacity.slot_key(task.engine, task.model_id)
        # Computed before the attempt is settled, while it is still the active
        # one the budget is derived from.
        budget = self._budget_for(task)

        task.fail_attempt(attempt_id, error, session_epoch=epoch, now=stamp)

        if worker is not None:
            # A timeout leaves a GPU thread that cannot be killed, so its slot
            # is parked rather than returned (#730/#1190) — for as long as that
            # thread's own budget could still be running it.
            self._release_slot(
                task,
                attempt,
                zombie=error.error_class is ErrorClass.TIMEOUT,
                zombie_ttl_seconds=budget.execution_seconds,
                now=stamp,
            )
            attribution, opened = self.pool.breakers.record_failure(
                worker.worker_id, model_key, error, now=stamp
            )
            if opened:
                logger.info(
                    "Circuit breaker opened for %s / %s after repeated failures",
                    worker.name,
                    model_key,
                )
            elif attribution is Attribution.INFRA:
                logger.info("Suppressing penalty for %s — fleet-wide failure detected", worker.name)

        self._save(task, now=stamp)
        self._emit("failed" if task.state.terminal else "requeued", task)
        return task

    def on_disconnected(self, worker_id: str, *, now: Optional[float] = None) -> list[Task]:
        """A worker's stream dropped. Start grace windows; fail nothing.

        This is where the duplicate-execution bug would live if a disconnect
        were treated as a failure: the worker may be seconds from delivering.
        """
        generation = self.prepare_disconnected(worker_id, now=now)
        try:
            # A disconnect is one generation, just like reconnect. If any
            # write fails, neither the database nor the live task graph may
            # contain a half-marked set of attempts.
            self.persist_reconciliation(generation)
            return self.apply_disconnected(generation)
        finally:
            # A failed persistence write must not leave a dead stream's pool
            # entry schedulable.
            self.pool.disconnect(worker_id)

    def prepare_disconnected(
        self,
        worker_id: str,
        *,
        now: Optional[float] = None,
        include_task_ids: Optional[set[str]] = None,
    ) -> _ReconciliationGeneration:
        """Build, but do not publish, one disconnected task generation."""
        stamp = resolve(now)
        included = include_task_ids or set()
        originals = tuple(
            task
            for task in self._tasks.values()
            if task.task_id in included
            or (
                task.active_attempt is not None
                and task.active_attempt.worker_id == worker_id
            )
        )
        snapshots = tuple(copy.deepcopy(task) for task in originals)
        candidates = tuple(copy.deepcopy(task) for task in snapshots)
        for task in candidates:
            attempt = task.active_attempt
            if attempt is None or attempt.worker_id != worker_id:
                continue
            grace = deadline_policy.default_grace_seconds(task.operation)
            task.mark_disconnected(
                attempt.attempt_id, grace_seconds=grace, now=stamp
            )
        return _ReconciliationGeneration(
            worker_id=worker_id,
            stamp=stamp,
            originals=originals,
            snapshots=snapshots,
            candidates=candidates,
        )

    def on_reconnected(
        self,
        worker_id: str,
        *,
        in_flight: set[str],
        now: Optional[float] = None,
        before_persist: Optional[Callable[[object], None]] = None,
    ) -> list[str]:
        """Reconcile against what the worker says it is running.

        Returns attempt ids the worker should cancel — work we have already
        written off, which it must stop burning a GPU on.
        """
        generation = self.prepare_reconnected(
            worker_id, in_flight=in_flight, now=now
        )
        self.persist_reconciliation(
            generation, before_persist=before_persist
        )
        return self.apply_reconnected(generation)

    def prepare_reconnected(
        self,
        worker_id: str,
        *,
        in_flight: set[str],
        now: Optional[float] = None,
        include_task_ids: Optional[set[str]] = None,
    ) -> _ReconciliationGeneration:
        """Build, but do not publish, one reconnect reconciliation."""
        stamp = resolve(now)
        known = {
            attempt.attempt_id: attempt
            for task in self._tasks.values()
            for attempt in task.attempts
            if attempt.worker_id == worker_id
        }
        zombies = [
            attempt_id
            for attempt_id in in_flight
            if attempt_id not in known or known[attempt_id].state.terminal
        ]
        included = include_task_ids or set()
        originals = tuple(
            task
            for task in self._tasks.values()
            if task.task_id in included
            or (
                not task.state.terminal
                and task.active_attempt is not None
                and task.active_attempt.worker_id == worker_id
            )
        )
        snapshots = tuple(copy.deepcopy(task) for task in originals)
        candidates = tuple(copy.deepcopy(task) for task in snapshots)
        for task in candidates:
            if task.state.terminal:
                continue
            reconcile(
                task,
                worker_id=worker_id,
                worker_in_flight=in_flight,
                # A resumed attempt has been silent for the whole outage; the
                # lease it carries was stamped before it. Give it a fresh one
                # or the next sweep fails the task we just recovered.
                resume_lease_seconds=self._budget_for(task).progress_lease_seconds,
                now=stamp,
            )
        return _ReconciliationGeneration(
            worker_id=worker_id,
            stamp=stamp,
            originals=originals,
            snapshots=snapshots,
            candidates=candidates,
            zombies=tuple(zombies),
        )

    def persist_reconciliation(
        self,
        generation: _ReconciliationGeneration,
        *,
        before_persist: Optional[Callable[[object], None]] = None,
    ) -> None:
        """Persist a prepared generation without touching the live task graph."""
        # Nothing in the live graph changes until the complete generation is
        # durable. A failed write therefore cannot queue duplicate execution
        # while the old worker is still finishing the original attempt.
        if self._persist or before_persist is not None:
            task_store.save_many(
                generation.candidates if self._persist else [],
                now=generation.stamp,
                before_save=before_persist,
            )

    def reconciliation_is_current(
        self, generation: _ReconciliationGeneration
    ) -> bool:
        """Did the live graph remain unchanged while persistence was off-loop?"""
        return all(
            self._tasks.get(original.task_id) is original
            and original == snapshot
            for original, snapshot in zip(
                generation.originals, generation.snapshots
            )
        )

    def apply_reconnected(
        self, generation: _ReconciliationGeneration
    ) -> list[str]:
        """Publish a durable reconnect generation on the scheduler's loop."""
        if not self.reconciliation_is_current(generation):
            raise RuntimeError("reconnect reconciliation generation changed")
        changed: list[Task] = []
        for original, candidate in zip(
            generation.originals, generation.candidates
        ):
            if original != candidate:
                changed.append(original)
            _adopt_task_state(original, candidate)
        for task in changed:
            self._emit(
                "failed"
                if task.state.terminal
                else "requeued"
                if task.state is TaskState.QUEUED
                else "resumed",
                task,
            )
        return list(generation.zombies)

    def apply_disconnected(
        self, generation: _ReconciliationGeneration
    ) -> list[Task]:
        """Publish a durable disconnect generation on the scheduler's loop."""
        if not self.reconciliation_is_current(generation):
            raise RuntimeError("disconnect reconciliation generation changed")
        changed: list[Task] = []
        for original, candidate in zip(
            generation.originals, generation.candidates
        ):
            if original != candidate:
                changed.append(original)
            _adopt_task_state(original, candidate)
        for task in changed:
            self._emit("worker_lost", task)
        return list(generation.originals)

    def cancel(self, task_id: str, *, reason: str = "cancelled", now: Optional[float] = None) -> bool:
        task = self._tasks.get(task_id)
        if task is None or task.state.terminal:
            return False
        stamp = resolve(now)
        attempt = task.active_attempt
        task.cancel(reason=reason, now=stamp)
        # A live GPU call is not known to have stopped yet. Its slot remains
        # parked in `in_flight` until the worker acknowledges TaskCancel.
        self._save(task, now=stamp)
        self._emit("cancelled", task)
        return True

    def on_cancel_ack(
        self, task_id: str, attempt_id: str, *, epoch: Optional[int] = None,
        now: Optional[float] = None,
    ) -> Optional[Task]:
        task = self._fenced(task_id, attempt_id, epoch)
        if task is None:
            return None
        attempt = task.get_attempt(attempt_id)
        self._release_slot(task, attempt, now=now)
        self._save(task, now=now)
        return task

    # ── Sweeper ───────────────────────────────────────────────────────────

    def sweep(self, *, now: Optional[float] = None) -> list[Task]:
        """Enforce leases, grace windows, and task deadlines.

        Called on a timer. Everything time-based happens here rather than being
        scattered across callbacks, so there is one place to reason about what
        expires and in what order.
        """
        stamp = resolve(now)
        changed: list[Task] = []

        for worker in self.pool.stale_workers(now=stamp):
            logger.info("Worker %s missed its heartbeats — treating as disconnected", worker.name)
            changed.extend(self.on_disconnected(worker.worker_id, now=stamp))

        for worker in self.pool:
            # The park's TTL is enforced here rather than only on a heartbeat:
            # the sweeper is the one loop with an injectable clock, and a
            # worker whose last slot is parked is exactly the worker whose
            # heartbeats we may have stopped believing.
            worker.capacity.expire_zombies(now=stamp)

        for task in list(self._tasks.values()):
            if task.state.terminal:
                continue
            attempt = task.active_attempt

            if attempt is not None and attempt.grace_expired(now=stamp):
                task.lose_attempt(attempt.attempt_id, now=stamp)
                # Parked, not returned: we never learned whether the worker's
                # GPU thread stopped, and it is the same un-killable thread the
                # timeout path parks for.
                self._release_slot(
                    task,
                    attempt,
                    zombie=True,
                    zombie_ttl_seconds=self._budget_for(task).execution_seconds,
                    now=stamp,
                )
                changed.append(task)
                self._save(task, now=stamp)
                self._emit("attempt_lost", task)
                continue

            if attempt is not None and attempt.disconnected_at is None and attempt.lease_expired(now=stamp):
                self._expire(task, attempt, now=stamp)
                changed.append(task)
                continue

            if task.deadline_exceeded(now=stamp) and task.state is TaskState.QUEUED:
                self._fail(
                    task,
                    WorkerError(
                        error_class=ErrorClass.TIMEOUT,
                        code="TASK_DEADLINE_EXCEEDED",
                        message="The task waited for an available worker past its deadline.",
                        hint="Add a worker, or run this task locally.",
                    ),
                    now=stamp,
                )
                changed.append(task)
        return changed

    def _expire(self, task: Task, attempt: Attempt, *, now: float) -> None:
        """A live attempt stopped reporting — or never stopped and never finished.

        Silence is the usual failure signal, but a keepalive-driven lease can
        also simply reach its phase ceiling, and the two are different stories
        for the user: one machine went quiet, the other is still working on
        something that has run past every budget we gave it. Naming them the
        same way sends the second one to a "check the worker is online" hint
        for a worker that is demonstrably online.
        """
        # ASSIGNED is excluded: it has no phase of its own to overrun, only an
        # accept window, and silence is the only thing that can end it.
        exhausted = task.state is not TaskState.ASSIGNED and now >= self._phase_ceiling(
            task, attempt, self._budget_for(task)
        )
        code = {
            TaskState.ASSIGNED: "ACCEPT_TIMEOUT",
            TaskState.MODEL_LOADING: "MODEL_LOAD_TIMEOUT",
            TaskState.RESULT_UPLOADING: "RESULT_DELIVERY_TIMEOUT",
        }.get(task.state, "EXECUTION_TIMEOUT" if exhausted else "PROGRESS_LEASE_EXPIRED")
        self.on_failed(
            task.task_id,
            attempt.attempt_id,
            WorkerError(
                error_class=ErrorClass.TIMEOUT,
                code=code,
                message=(
                    "The task ran past the time budgeted for this stage."
                    if exhausted
                    else "The worker stopped reporting progress."
                ),
                hint="It will be retried on another worker if one is available.",
            ),
            epoch=attempt.session_epoch,
            now=now,
        )

    def _release_slot(
        self,
        task: Task,
        attempt: Attempt,
        *,
        zombie: bool = False,
        zombie_ttl_seconds: Optional[float] = None,
        now: Optional[float] = None,
    ) -> bool:
        """Return one attempt's slot to its worker, at most once.

        ``in_flight`` is the record of whether this attempt still holds a slot,
        and every release goes through this guard: `capacity.release` protects
        its per-model counter but the worker-wide one is a plain decrement, so
        two paths ending the same attempt — a result racing the sweeper, a
        cancel racing a late failure — would hand back capacity that was never
        taken and overcommit the machine.
        """
        worker = self.pool.get(attempt.worker_id)
        if worker is None or attempt.attempt_id not in worker.in_flight:
            return False
        worker.in_flight.discard(attempt.attempt_id)
        return worker.capacity.release(
            task.engine,
            task.model_id,
            zombie=zombie,
            zombie_ttl_seconds=zombie_ttl_seconds,
            now=now,
        )

    def _fail(self, task: Task, error: WorkerError, *, now: float) -> None:
        task.error = error
        task.state = TaskState.FAILED if error.error_class is not ErrorClass.TIMEOUT else TaskState.TIMEOUT
        task.finished_at = now
        self._save(task, now=now)
        self._emit("failed", task)

    def _budget_for(self, task: Task) -> deadline_policy.Deadlines:
        attempt = task.active_attempt
        worker = self.pool.get(attempt.worker_id) if attempt else None
        return deadline_policy.for_task(
            task.operation,
            text=task.params.get("text"),
            model_resident=bool(worker and worker.is_warm(task.engine, task.model_id)),
            input_seconds=float(task.params.get("input_seconds") or 0.0),
            execution_device=(
                worker.execution_device(task.engine, task.model_id, task.operation)
                if worker else None
            ),
        )


__all__ = ["Assignment", "NoEligibleWorker", "QueueFull", "Scheduler", "Strategy"]
