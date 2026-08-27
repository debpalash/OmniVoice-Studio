"""Live worker state.

Everything here is in-memory and rebuilt from reconnection, by design: sessions,
capacity snapshots, latency, breaker state. A desktop control plane restarts
constantly, and none of this is worth persisting when the worker itself will
tell us the truth the moment it reconnects.

What the pool owns is the *current* picture — who is connected, on which epoch,
with what free capacity and which models warm. What it deliberately does not
own is anything durable (``registry``) or any scheduling policy
(``scheduler``).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Iterator, Optional

from worker.breaker import BreakerRegistry
from worker.capacity import WorkerCapacity, clamp_concurrency, derive_concurrency
from worker.clock import resolve
from worker.identity import Session
from worker.registry import RemoteWorker

logger = logging.getLogger("omnivoice.worker")

# A worker that has not been heard from in this long is treated as gone even if
# the socket has not reported it. Half-open TCP through an expired CGNAT
# mapping looks identical to a healthy idle connection until you ask.
_HEARTBEAT_MISS_SECONDS = 90.0

# How many round-trip samples the median is taken over. Five at a five-second
# ping is a ~25-second view: current enough to notice a link degrading, long
# enough that one slow answer cannot move it.
_LATENCY_WINDOW = 5
_KNOWN_EXECUTION_DEVICES = frozenset(
    {"cpu", "cuda", "mps", "mlx", "directml", "rocm", "xpu"}
)


@dataclass
class ConnectedWorker:
    """One live worker session."""

    record: RemoteWorker
    session: Session
    epoch: int
    capacity: WorkerCapacity
    connected_at: float
    last_heartbeat_at: float
    latency_ms: float = 0.0
    # Recent round-trip samples. A median over these rather than a running
    # average, because the first sample after connect is routinely an outlier
    # — the worker is still importing torch and loading models, so its event
    # loop answers the ping late. One 139 ms startup spike would otherwise
    # dominate an average for a minute and read as a broken link.
    latency_samples: list[float] = field(default_factory=list)
    # The address this worker connected FROM, as the control plane saw it.
    address: str = ""
    draining: bool = False
    # Registration handoff temporarily stops new assignments without
    # conflating that transport state with a user-requested drain/shutdown.
    registration_pending: bool = False
    # Attempt ids this worker claims to be running. Rebuilt on every reconnect
    # from its own report, never inferred.
    in_flight: set[str] = field(default_factory=set)

    @property
    def worker_id(self) -> str:
        return self.record.id

    @property
    def name(self) -> str:
        return self.record.name

    def stale(self, *, now: Optional[float] = None) -> bool:
        return resolve(now) - self.last_heartbeat_at > _HEARTBEAT_MISS_SECONDS

    @property
    def status(self) -> str:
        """What the UI colours on: ready, busy, or gone.

        Draining counts as busy rather than offline — it is still finishing
        work, and calling it offline would imply the results are lost.
        """
        if self.stale():
            return "offline"
        if (
            self.draining
            or self.registration_pending
            or self.capacity.available_slots <= 0
        ):
            return "busy"
        return "ready"

    def supports(self, engine: str, model_id: str, operation: str) -> bool:
        """Can this worker run this work at all?

        ``supported`` alone is not enough — an engine whose weights are not on
        disk cannot start without a download, and one that is not installed
        cannot start at all. Both are capability mismatches, not failures.
        """
        for cap in self.record.capabilities:
            if cap.get("engine") != engine:
                continue
            if model_id and cap.get("model_id") not in (model_id, "", None):
                continue
            if operation and operation not in (cap.get("operations") or [operation]):
                continue
            return bool(cap.get("supported")) and bool(cap.get("installed", True))
        return False

    def execution_device(self, engine: str, model_id: str, operation: str) -> str:
        """Device used by the exact capability selected for this task."""
        for cap in self.record.capabilities:
            if cap.get("engine") != engine:
                continue
            if model_id and cap.get("model_id") not in (model_id, "", None):
                continue
            if operation and operation not in (cap.get("operations") or [operation]):
                continue
            if cap.get("cpu_fallback"):
                return "cpu"
            backend = str(cap.get("backend") or "").lower()
            return backend if backend in _KNOWN_EXECUTION_DEVICES else "cpu"
        return "cpu"

    def is_warm(self, engine: str, model_id: str) -> bool:
        return self.capacity.is_resident(engine, model_id)

    def to_dict(self, *, now: Optional[float] = None) -> dict:
        return {
            **self.record.to_dict(),
            "connected": True,
            "draining": self.draining,
            "latency_ms": round(self.latency_ms, 1),
            "address": self.address,
            "status": self.status,
            "active_tasks": self.capacity.active_tasks,
            "available_slots": self.capacity.available_slots,
            "resident_models": sorted(self.capacity.resident_models),
            "stale": self.stale(now=now),
        }


class WorkerPool:
    """The set of workers currently connected, plus their breakers."""

    def __init__(self) -> None:
        self._connected: dict[str, ConnectedWorker] = {}
        self.breakers = BreakerRegistry()

    # ── Membership ────────────────────────────────────────────────────────

    def connect(
        self,
        record: RemoteWorker,
        *,
        session: Session,
        epoch: int,
        max_concurrent_tasks: int = 1,
        backend: str = "",
        in_flight: Optional[set[str]] = None,
        address: str = "",
        now: Optional[float] = None,
    ) -> ConnectedWorker:
        """Register a live session, replacing any previous one.

        Newest epoch wins, unconditionally. Two sessions for one worker is the
        race that delivers two accepts for a single assignment, so the old one
        is dropped rather than merged.
        """
        stamp = resolve(now)
        previous = self._connected.get(record.id)
        if previous is not None and previous.epoch > epoch:
            raise ValueError(
                f"refusing to install session epoch {epoch} over newer epoch {previous.epoch}"
            )
        worker = ConnectedWorker(
            record=record,
            session=session,
            epoch=epoch,
            capacity=WorkerCapacity(
                worker_id=record.id,
                max_concurrent_tasks=clamp_concurrency(max_concurrent_tasks),
                backend=backend,
            ),
            connected_at=stamp,
            last_heartbeat_at=stamp,
            address=address,
            in_flight=set(in_flight or set()),
        )
        self._connected[record.id] = worker
        self.breakers.note_worker(record.id)
        if previous is not None:
            logger.info("Worker %s reconnected (epoch %d → %d)", record.name, previous.epoch, epoch)
        return worker

    def record_latency(self, worker_id: str, latency_ms: float) -> None:
        """Record a measured round trip and republish the median.

        Median, not mean: a consumer link jitters, and a worker busy loading a
        model answers late. Both produce outliers that an average carries for
        a long time and a median ignores outright.

        Nothing is published until a second sample arrives, so the startup
        outlier is never shown — the UI treats 0 as "not measured yet" and
        simply omits the figure.
        """
        live = self._connected.get(worker_id)
        if live is None:
            return
        samples = live.latency_samples
        samples.append(latency_ms)
        del samples[:-_LATENCY_WINDOW]
        if len(samples) < 2:
            return
        ordered = sorted(samples)
        middle = len(ordered) // 2
        live.latency_ms = (
            ordered[middle]
            if len(ordered) % 2
            else (ordered[middle - 1] + ordered[middle]) / 2
        )

    def refresh_record(self, record: RemoteWorker) -> None:
        """Adopt an updated database row for a live worker.

        The pool caches the RemoteWorker it was handed at connect time. Every
        registry write — rename, priority, enable — makes that copy wrong until
        the worker reconnects, so writers refresh it here rather than leaving
        two disagreeing answers in memory.
        """
        live = self._connected.get(record.id)
        if live is not None:
            live.record = record

    def disconnect(self, worker_id: str) -> Optional[ConnectedWorker]:
        return self._connected.pop(worker_id, None)

    def restore_connection(self, worker: ConnectedWorker) -> None:
        """Restore an exact live snapshot after replacement activation fails."""
        self._connected[worker.worker_id] = worker

    def get(self, worker_id: str) -> Optional[ConnectedWorker]:
        return self._connected.get(worker_id)

    def __iter__(self) -> Iterator[ConnectedWorker]:
        return iter(list(self._connected.values()))

    def __len__(self) -> int:
        return len(self._connected)

    @property
    def connected_ids(self) -> set[str]:
        return set(self._connected)

    # ── Session validity ──────────────────────────────────────────────────

    def valid_epoch(self, worker_id: str, epoch: int) -> bool:
        """Fence: is this message from the session we currently believe in?"""
        worker = self._connected.get(worker_id)
        return worker is not None and worker.epoch == epoch

    # ── Heartbeats ────────────────────────────────────────────────────────

    def heartbeat(
        self,
        worker_id: str,
        *,
        active_tasks: int,
        available_slots: int,
        resident_models: Optional[set[str]] = None,
        free_memory_bytes: Optional[int] = None,
        latency_ms: Optional[float] = None,
        now: Optional[float] = None,
    ) -> Optional[ConnectedWorker]:
        worker = self._connected.get(worker_id)
        if worker is None:
            return None
        worker.last_heartbeat_at = resolve(now)
        if latency_ms is not None:
            worker.latency_ms = latency_ms
        worker.capacity.apply_snapshot(
            active_tasks=active_tasks,
            available_slots=available_slots,
            resident_models=resident_models,
            free_memory_bytes=free_memory_bytes,
        )
        return worker

    def apply_capabilities(self, worker_id: str, capabilities: list[dict]) -> None:
        """Refresh what a worker can run, and re-derive its per-model slots."""
        worker = self._connected.get(worker_id)
        if worker is None:
            return
        worker.record.capabilities = capabilities
        for cap in capabilities:
            key = WorkerCapacity.slot_key(cap.get("engine", ""), cap.get("model_id", ""))
            slot = worker.capacity.slots.get(key)
            declared = int(cap.get("derived_concurrency") or 0)
            if declared <= 0:
                declared = derive_concurrency(
                    backend=cap.get("backend", worker.capacity.backend),
                    free_memory_bytes=int(cap.get("free_memory_bytes") or 0),
                    min_model_bytes=int(cap.get("min_memory_bytes") or 0),
                )
            if slot is None:
                from worker.capacity import ModelSlot  # noqa: PLC0415 — avoids a cycle

                worker.capacity.slots[key] = ModelSlot(
                    engine=cap.get("engine", ""),
                    model_id=cap.get("model_id", ""),
                    derived_concurrency=clamp_concurrency(
                        declared, allow_zero=True
                    ),
                )
            else:
                slot.derived_concurrency = clamp_concurrency(
                    declared, allow_zero=True
                )

    def stale_workers(self, *, now: Optional[float] = None) -> list[ConnectedWorker]:
        return [w for w in self if w.stale(now=now)]

    def snapshot(self, *, now: Optional[float] = None) -> list[dict]:
        return [w.to_dict(now=now) for w in self]


__all__ = ["ConnectedWorker", "WorkerPool"]
