"""Worker capacity — derived, never declared.

The original goal doc let a user configure "Whisper: concurrency = 4, large TTS
model: concurrency = 1". This repo's own history says that is unsafe:

  * compiled inference is pinned to a single thread because torch.compile's
    cudagraph state is thread-local (#315) — a second concurrent job on a
    compiled model produces *silently corrupted audio*, with no exception to
    catch and nothing for a reliability score to detect;
  * two concurrent clone jobs on an 8 GB card produced a sticky CUDA
    illegal-memory-access that aborted the whole process (#567), which is why
    ``gpu_queue`` is a deliberately serial single lane;
  * Apple's unified memory means "GPU memory" is shared with everything else
    the user is running, so a number that was safe at configuration time is not
    safe at execution time.

So capacity is computed from what the machine has *right now*, clamped by
device family, and the worker's own accept/reject is authoritative — the
scheduler's view is only ever advisory.

One more rule the repo learned the hard way: a timed-out GPU job cannot be
killed. The thread keeps the device until it finishes on its own
(``_ResilientGpuPool.reset()`` reclaims nothing). So a timeout must NOT return
the slot; the slot stays occupied by a zombie until the worker confirms the
thread exited. Returning it early is how a worker gets overcommitted into an
OOM.

But a park with no way out is just as wrong as no park at all: a worker whose
only slot is parked never gets another assignment, so it never produces the
confirmation that would release it, and it heartbeats "idle, 1 free" forever
while the scheduler considers it full. Two bounded exits, neither of which
trusts the worker's own accounting (which counts asyncio tasks, not GPU
threads, and so reports a parked slot as free the moment the task object is
gone):

  * a **TTL** sized from the budget the stuck job was given — past that, its
    thread is either finished or wedged beyond anything we can wait out;
  * **reconciliation** against the worker's reported ceiling — if the worker
    is running as many tasks as it says it can hold, the park is protecting
    nothing, because the overcommit it exists to prevent has already happened.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Optional

from worker.clock import resolve

logger = logging.getLogger("omnivoice.worker")

# Per-job VRAM budget. Mirrors the figure model_manager uses when sizing its
# GPU worker pool; deliberately conservative because exceeding it does not
# degrade gracefully, it aborts the process.
_VRAM_PER_JOB_BYTES = 5 * 1024**3

# Device families where concurrency above 1 is never derived:
#   mps/mlx — unified memory, shared with the user's other apps
#   cpu     — oversubscription just thrashes
_ALWAYS_SERIAL = frozenset({"mps", "mlx", "cpu", ""})

# Absolute protocol ceiling regardless of how much memory a peer reports.
# Beyond this the bottleneck stops being VRAM and starts being scheduler
# overhead and host-side I/O contention.  It is public because every wire
# boundary must clamp to the same number; a UINT32_MAX heartbeat must not grow
# a scheduler queue that local derivation would never create.
MAX_CONCURRENT_TASKS = 4


def clamp_concurrency(value: int, *, allow_zero: bool = False) -> int:
    """Bound an advertised concurrency value to the server's safe range."""
    minimum = 0 if allow_zero else 1
    return max(minimum, min(MAX_CONCURRENT_TASKS, int(value)))

# Bounds on how long a parked slot is held. The caller passes the timed-out
# job's own execution budget — the longest its thread can still legitimately be
# running — and these clamp a nonsensical one: never so short that the park
# stops meaning anything, never so long that a single timeout costs the user a
# worker for the rest of the session.
_MIN_ZOMBIE_TTL_SECONDS = 60.0
_MAX_ZOMBIE_TTL_SECONDS = 3600.0
_DEFAULT_ZOMBIE_TTL_SECONDS = 600.0


def _bounded_ttl(seconds: Optional[float]) -> float:
    if not seconds or seconds <= 0:
        return _DEFAULT_ZOMBIE_TTL_SECONDS
    return min(_MAX_ZOMBIE_TTL_SECONDS, max(_MIN_ZOMBIE_TTL_SECONDS, float(seconds)))


def derive_concurrency(
    *,
    backend: str,
    free_memory_bytes: int,
    min_model_bytes: int = 0,
    compiled: bool = False,
) -> int:
    """How many jobs of this model may run at once on this worker.

    Returns 0 when the model cannot run here at all — a capability mismatch,
    which the scheduler must treat as "send it elsewhere", never as a worker
    fault.
    """
    family = (backend or "").strip().lower()
    if min_model_bytes and free_memory_bytes < min_model_bytes:
        return 0
    if compiled:
        # Thread-affinity pinning (#315). One job, always.
        return 1
    if family in _ALWAYS_SERIAL:
        return 1 if (not min_model_bytes or free_memory_bytes >= min_model_bytes) else 0
    budget = max(min_model_bytes, _VRAM_PER_JOB_BYTES)
    if budget <= 0:
        return 1
    return clamp_concurrency(int(free_memory_bytes // budget))


@dataclass
class ModelSlot:
    """Capacity bookkeeping for one (worker, model) pair."""

    engine: str
    model_id: str
    derived_concurrency: int = 1
    active: int = 0
    # Slots held by jobs that timed out but whose GPU thread has not exited.
    # Not available, not counted as active work, not returnable until the
    # worker says the thread is gone or the park times out. Stored as the
    # absolute reclaim time of each park rather than a bare count: a count has
    # no way to answer "has this one waited long enough", and a count kept
    # beside a list of deadlines is two records of one fact that drift.
    zombie_expiries: list[float] = field(default_factory=list)

    @property
    def zombie(self) -> int:
        return len(self.zombie_expiries)

    @property
    def available(self) -> int:
        return max(0, self.derived_concurrency - self.active - self.zombie)


@dataclass
class WorkerCapacity:
    """Live capacity snapshot for one worker.

    Absolute values only — never deltas. Per-stream FIFO does not survive a
    reconnect, so a delta that arrives out of order corrupts the count
    permanently.
    """

    worker_id: str
    max_concurrent_tasks: int = 1
    active_tasks: int = 0
    free_memory_bytes: int = 0
    backend: str = ""
    resident_models: set[str] = field(default_factory=set)
    slots: dict[str, ModelSlot] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.max_concurrent_tasks = clamp_concurrency(self.max_concurrent_tasks)

    @staticmethod
    def slot_key(engine: str, model_id: str) -> str:
        return f"{engine}:{model_id}"

    @property
    def zombie_tasks(self) -> int:
        """Derived from the slots, never counted separately: a worker-wide
        counter maintained alongside per-slot ones is how a double release used
        to invent a zombie that no slot owned and nothing could ever reap."""
        return sum(slot.zombie for slot in self.slots.values())

    @property
    def available_slots(self) -> int:
        """Worker-wide availability. The binding constraint is whichever of
        the worker-wide and per-model caps is smaller — they are not
        independent, because every model draws on the same VRAM."""
        return max(0, self.max_concurrent_tasks - self.active_tasks - self.zombie_tasks)

    def slot_for(self, engine: str, model_id: str) -> Optional[ModelSlot]:
        exact = self.slots.get(self.slot_key(engine, model_id))
        if exact is not None or not model_id:
            return exact
        # Protocol-v1 workers may advertise only an engine (model_id="").
        # That row is an engine-wide wildcard, not a second pool of capacity.
        return self.slots.get(self.slot_key(engine, ""))

    def can_accept(self, engine: str, model_id: str) -> bool:
        if self.available_slots <= 0:
            return False
        slot = self.slot_for(engine, model_id)
        if slot is None:
            # Unknown model on a worker with room: the worker decides. Its
            # reject is authoritative and penalty-free.
            return True
        return slot.available > 0

    def is_resident(self, engine: str, model_id: str) -> bool:
        """Warm models are the dominant latency term — 8s versus minutes."""
        return self.slot_key(engine, model_id) in self.resident_models or model_id in self.resident_models

    def reserve(self, engine: str, model_id: str) -> None:
        self.active_tasks += 1
        slot = self.slot_for(engine, model_id)
        if slot is None:
            slot = self.slots.setdefault(
                self.slot_key(engine, model_id), ModelSlot(engine=engine, model_id=model_id)
            )
        slot.active += 1

    def reserve_unknown(self) -> None:
        """Consume worker-wide capacity for claimed work we cannot classify.

        Reconciliation will tell the peer to cancel a terminal or unknown
        attempt, but until that cancellation lands it is still using the GPU.
        """
        self.active_tasks += 1

    def release_unknown(self) -> bool:
        """Release one exact reconciled claim with no model-slot identity."""
        if self.active_tasks <= 0:
            return False
        self.active_tasks -= 1
        return True

    def release(
        self,
        engine: str,
        model_id: str,
        *,
        zombie: bool = False,
        zombie_ttl_seconds: Optional[float] = None,
        now: Optional[float] = None,
    ) -> bool:
        """Return a slot. ``zombie=True`` parks it instead: the task is over
        but the GPU thread is not, so the capacity is still gone.

        Returns whether a slot was actually returned. A release for a slot that
        holds nothing is a bug in the caller (a double release), and answering
        it with a decrement would invent worker-wide capacity out of nothing —
        so it is refused and reported rather than absorbed.
        """
        slot = self.slot_for(engine, model_id)
        if slot is None or slot.active <= 0:
            return False
        slot.active -= 1
        if self.active_tasks > 0:
            self.active_tasks -= 1
        if zombie:
            slot.zombie_expiries.append(resolve(now) + _bounded_ttl(zombie_ttl_seconds))
        return True

    def reap_zombie(self, engine: str, model_id: str) -> None:
        """The worker confirmed the stuck thread exited. Capacity returns."""
        slot = self.slot_for(engine, model_id)
        if slot is not None and slot.zombie_expiries:
            # Oldest first: parks are indistinguishable, so releasing the one
            # that has waited longest is the only ordering that cannot starve.
            slot.zombie_expiries.pop(0)

    def expire_zombies(self, *, now: Optional[float] = None) -> int:
        """Reclaim parks whose TTL ran out. Returns how many came back.

        The backstop that keeps a timeout from costing a worker permanently:
        the confirmation ``reap_zombie`` waits for is a message the current
        protocol has no way to send, so without this the only exit is a
        reconnect.
        """
        stamp = resolve(now)
        reaped = 0
        for slot in self.slots.values():
            keep = [t for t in slot.zombie_expiries if t > stamp]
            reaped += len(slot.zombie_expiries) - len(keep)
            slot.zombie_expiries = keep
        if reaped:
            logger.info(
                "Reclaimed %d parked slot(s) on worker %s — the stuck thread's own "
                "budget has run out",
                reaped,
                self.worker_id,
            )
        return reaped

    def apply_snapshot(
        self,
        *,
        active_tasks: int,
        available_slots: int,
        resident_models: Optional[set[str]] = None,
        free_memory_bytes: Optional[int] = None,
        now: Optional[float] = None,
    ) -> None:
        """Adopt a heartbeat snapshot. The worker is the source of truth for
        what it is actually running."""
        self.active_tasks = clamp_concurrency(active_tasks, allow_zero=True)
        bounded_available = clamp_concurrency(available_slots, allow_zero=True)
        bounded_available = min(
            bounded_available, MAX_CONCURRENT_TASKS - self.active_tasks
        )
        reported_ceiling = self.active_tasks + bounded_available
        if reported_ceiling > 0:
            # Adopted, not merely grown. The worker computes this as its own
            # ``max_concurrent_tasks``, so a ceiling we refuse to lower is one
            # we keep dispatching against after the worker has told us it can
            # no longer honour it — the overcommit this module exists to avoid.
            self.max_concurrent_tasks = reported_ceiling
        if resident_models is not None:
            self.resident_models = set(resident_models)
        if free_memory_bytes is not None:
            self.free_memory_bytes = free_memory_bytes
        # Parks are released on a timer, and by the worker restarting — never
        # by the worker's own load report.
        #
        # Reconciling them against ``active_tasks`` looks reasonable and is
        # exactly backwards: a park exists because a timed-out GPU thread
        # cannot be killed and the worker therefore cannot account for it. At
        # ``max_concurrent_tasks == 1`` the only task such a worker can report
        # IS the wedged one, so "busy" would drop the park and the next idle
        # heartbeat would hand the slot out with the thread still running —
        # the overcommit-into-OOM this module exists to prevent (#730/#1190).
        # The two safe signals are already covered: ``expire_zombies`` above
        # bounds the park by TTL, and a reconnect builds a fresh capacity
        # record (pool.py), because a restarted process has no live threads.
        self.expire_zombies(now=now)

    def to_dict(self) -> dict:
        return {
            "worker_id": self.worker_id,
            "max_concurrent_tasks": self.max_concurrent_tasks,
            "active_tasks": self.active_tasks,
            "zombie_tasks": self.zombie_tasks,
            "available_slots": self.available_slots,
            "resident_models": sorted(self.resident_models),
        }


__all__ = [
    "MAX_CONCURRENT_TASKS",
    "ModelSlot",
    "WorkerCapacity",
    "clamp_concurrency",
    "derive_concurrency",
]
