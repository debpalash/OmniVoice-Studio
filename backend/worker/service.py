"""Lifecycle for the remote-worker feature, on both sides.

One module owns starting and stopping everything, because the feature has to be
genuinely absent when it is switched off. The local-first guarantee is not
"we do not use the network much" — it is that a user who never enables this
has no listening socket, no certificate, no background loop, and an app that
behaves exactly as it did before.

So nothing here runs unless ``remote_workers_enabled()`` is true, and the gRPC
imports happen inside the start path rather than at module import.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Optional
from urllib.parse import urlsplit

from worker.clock import resolve

logger = logging.getLogger("omnivoice.worker")

# How often the scheduler enforces leases, grace windows, and deadlines.
_SWEEP_INTERVAL_SECONDS = 5.0
# How often the dispatcher looks for queued work it can place.
_DISPATCH_INTERVAL_SECONDS = 1.0
# Finished rows and their artifacts remain inspectable for a week, then leave
# in bounded batches. The loop keeps a long-lived control plane from growing
# forever while the startup pass covers apps that are rarely left open.
_ARTIFACT_GC_INTERVAL_SECONDS = 60 * 60.0
_ARTIFACT_GC_BATCH_SIZE = 250

DEFAULT_PORT = 7443


class EndpointCertificateError(ValueError):
    """An advertised endpoint is not usable with the live TLS certificate."""


def _endpoint_host(endpoint: str) -> str:
    """Extract the hostname from the gRPC ``host:port`` enrollment target."""
    target = (endpoint or "").strip()
    try:
        parsed = urlsplit(f"//{target}")
        host = parsed.hostname
        port = parsed.port
    except ValueError as exc:
        raise EndpointCertificateError(
            f"Worker endpoint must be host:port; got {endpoint!r}."
        ) from exc
    if (
        not host
        or port is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        raise EndpointCertificateError(
            f"Worker endpoint must be host:port; got {endpoint!r}."
        )
    return host


def _format_endpoint(host: str, port: int) -> str:
    clean_host = (host or "").strip().strip("[]")
    if ":" in clean_host:
        clean_host = f"[{clean_host}]"
    return f"{clean_host}:{port}"


def remote_workers_enabled() -> bool:
    """Opt-in gate. Off unless the user turned it on.

    Checked in the environment first so a headless/server deployment can enable
    it without a UI, then in settings for the desktop case.
    """
    env = (os.environ.get("OMNIVOICE_REMOTE_WORKERS") or "").strip().lower()
    if env in ("1", "true", "yes", "on"):
        return True
    if env in ("0", "false", "no", "off"):
        return False
    try:
        from services import settings_store  # noqa: PLC0415

        stored = (settings_store.get_text("remote_workers_enabled", "") or "").strip().lower()
        return stored in ("1", "true", "yes", "on")
    except Exception:
        return False


def set_remote_workers_enabled(enabled: bool) -> None:
    from services import settings_store  # noqa: PLC0415

    settings_store.set_text("remote_workers_enabled", "true" if enabled else "false")


def control_port() -> int:
    try:
        return int(os.environ.get("OMNIVOICE_WORKER_PORT") or DEFAULT_PORT)
    except ValueError:
        return DEFAULT_PORT


def _data_dir() -> str:
    try:
        from core.config import DATA_DIR  # noqa: PLC0415

        return str(DATA_DIR)
    except Exception:
        return os.path.expanduser("~/.omnivoice")


def paths() -> dict[str, str]:
    """Where the feature keeps its state, all under the user's data dir."""
    root = os.path.join(_data_dir(), "workers")
    return {
        "root": root,
        "certificate": os.path.join(root, "control-plane.crt"),
        "private_key": os.path.join(root, "control-plane.key"),
        "worker_key": os.path.join(root, "worker.key"),
        "artifacts": os.path.join(root, "artifacts"),
    }


class ControlPlane:
    """Owns the scheduler, the worker pool, and the gRPC server."""

    def __init__(self) -> None:
        self.pool = None
        self.scheduler = None
        self.servicer = None
        self.credentials = None
        self._server = None
        self._tasks: list[asyncio.Task] = []
        self._started = False
        self._lifecycle_lock = asyncio.Lock()
        self.startup_error: Optional[str] = None
        # The port we actually bound, which is not necessarily the configured
        # one — an enrollment token carries this, so advertising the config
        # value instead hands workers an endpoint nothing is listening on.
        self._port: Optional[int] = None

    @property
    def running(self) -> bool:
        return self._started

    @property
    def fingerprint(self) -> str:
        return self.credentials.fingerprint if self.credentials else ""

    async def start(self, *, port: Optional[int] = None) -> None:
        async with self._lifecycle_lock:
            await self._start(port=port)

    async def _start(self, *, port: Optional[int] = None) -> None:
        if self._started:
            return
        # Imported here, not at module scope: a user who never enables remote
        # workers should not pay grpc's import cost at every backend start.
        from worker import tls  # noqa: PLC0415
        from worker.pool import WorkerPool  # noqa: PLC0415
        from worker.scheduler import Scheduler  # noqa: PLC0415
        from worker.transport.server import WorkerServicer, serve  # noqa: PLC0415

        self._port = port or control_port()
        try:
            locations = paths()
            os.makedirs(locations["root"], exist_ok=True)
            wanted_hostnames = tls.default_hostnames()
            advertised_host = _endpoint_host(self.default_endpoint())
            if advertised_host not in wanted_hostnames:
                wanted_hostnames.append(advertised_host)
            self.credentials = tls.load_or_create(
                locations["certificate"],
                locations["private_key"],
                hostnames=wanted_hostnames,
            )
            self.pool = WorkerPool()
            self.scheduler = Scheduler(self.pool)
            try:
                await self._artifact_gc_once(
                    locations["artifacts"], retry_upload_parts=False
                )
            except Exception:
                # Retention is best-effort. A locked file or temporarily busy
                # database must not make remote compute unavailable.
                logger.exception("Remote worker startup artifact sweep failed")
            # Recover anything that was in flight when the app last quit. The
            # workers holding those tasks may still be rendering.
            self.scheduler.restore()

            self.servicer = WorkerServicer(
                self.scheduler,
                self.pool,
                artifact_dir=locations["artifacts"],
                cert_fingerprint=self.credentials.fingerprint,
            )
            self._server = await serve(
                self.servicer,
                port=self._port,
                certificate_pem=self.credentials.certificate_pem,
                private_key_pem=self.credentials.private_key_pem,
            )
        except Exception:
            self._port = None
            raise
        self._tasks = [
            asyncio.create_task(self._sweep_loop(), name="worker-sweep"),
            asyncio.create_task(self._dispatch_loop(), name="worker-dispatch"),
            asyncio.create_task(
                self._artifact_gc_loop(locations["artifacts"]),
                name="worker-artifact-gc",
            ),
        ]
        self._started = True
        self.startup_error = None
        logger.info("Remote worker control plane started on port %d", self._port)

    async def stop(self) -> None:
        async with self._lifecycle_lock:
            await self._stop()

    async def _stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks = []
        if self.scheduler is not None:
            # Anyone awaiting a task is waiting on a future only this scheduler
            # will ever complete, and the sweeper that would have timed it out
            # has just been cancelled — so a shutdown would otherwise hang the
            # request, and with it the app's own quit.
            self.scheduler.abort_waiters()
        if self._server is not None:
            # A short grace so in-flight acknowledgements land; anything longer
            # would delay app shutdown for work that survives anyway.
            await self._server.stop(grace=2.0)
            self._server = None
        self._port = None
        self._started = False
        self.startup_error = None

    async def cancel(self, task_id: str, *, reason: str = "cancelled") -> bool:
        """Cancel locally, notify the owner, and hold its slot until ACK."""
        if self.scheduler is None:
            return False
        task = self.scheduler.get(task_id) if hasattr(self.scheduler, "get") else None
        attempt = task.active_attempt if task is not None else None
        if not self.scheduler.cancel(task_id, reason=reason):
            return False
        if attempt is not None and self.servicer is not None:
            await self.servicer.cancel(
                attempt.worker_id,
                task_id,
                attempt.attempt_id,
                attempt.session_epoch,
            )
        return True

    async def _sweep_loop(self) -> None:
        while True:
            await asyncio.sleep(_SWEEP_INTERVAL_SECONDS)
            try:
                self.scheduler.sweep()
            except Exception:
                logger.exception("Worker sweep failed")

    async def _artifact_gc_once(
        self, artifact_root: str, *, retry_upload_parts: bool = True
    ) -> int:
        """Purge one bounded retention batch without blocking the event loop."""
        from worker import task_store  # noqa: PLC0415

        removed = await asyncio.to_thread(
            task_store.purge_finished,
            root=artifact_root,
            limit=_ARTIFACT_GC_BATCH_SIZE,
        )
        if retry_upload_parts and self.servicer is not None:
            self.servicer.sweep_orphaned_upload_parts()
        return removed

    async def _artifact_gc_loop(self, artifact_root: str) -> None:
        while True:
            await asyncio.sleep(_ARTIFACT_GC_INTERVAL_SECONDS)
            try:
                await self._artifact_gc_once(artifact_root)
            except Exception:
                logger.exception("Remote worker artifact sweep failed")

    async def _dispatch_loop(self) -> None:
        """Place queued work on eligible workers.

        A failed hand-off is not a task failure: the stream may have dropped
        between selection and send, so the attempt is returned to the queue for
        the next pass rather than charged to anyone.
        """
        while True:
            await asyncio.sleep(_DISPATCH_INTERVAL_SECONDS)
            try:
                while True:
                    assignment = self.scheduler.next_assignment()
                    if assignment is None:
                        break
                    if not await self.servicer.dispatch(assignment):
                        from worker.errors import ErrorClass, WorkerError  # noqa: PLC0415

                        self.scheduler.on_failed(
                            assignment.task.task_id,
                            assignment.attempt.attempt_id,
                            WorkerError(
                                error_class=ErrorClass.CAPACITY,
                                code="WORKER_UNREACHABLE",
                                message="The worker's connection dropped before the task was sent.",
                            ),
                            epoch=assignment.attempt.session_epoch,
                        )
            except Exception:
                logger.exception("Worker dispatch failed")

    # ── Enrollment ────────────────────────────────────────────────────────

    def create_enrollment(self, *, endpoint: str = "", label: str = "", ttl_seconds: int = 900):
        """Mint a join token carrying this control plane's fingerprint."""
        from worker import tls  # noqa: PLC0415
        from worker import registry  # noqa: PLC0415

        advertised_endpoint = endpoint.strip() or self.default_endpoint()
        advertised_host = _endpoint_host(advertised_endpoint)
        if self.credentials is not None and not tls.covers(
            self.credentials, advertised_host
        ):
            raise EndpointCertificateError(
                f"The running certificate does not cover {advertised_host!r}. "
                "Set OMNIVOICE_WORKER_ENDPOINT_HOST to that hostname and restart "
                "VoiceStudio before creating this enrollment."
            )
        return registry.create_enrollment(
            endpoint=advertised_endpoint,
            cert_fingerprint=self.fingerprint,
            label=label,
            ttl_seconds=ttl_seconds,
        )

    def default_endpoint(self) -> str:
        """A best guess at how a worker should reach us.

        An IP address, not the hostname. gRPC resolves through c-ares, which
        does not speak mDNS — so the ``host.local`` that macOS reports (and
        that Python's own resolver happily resolves) produces a token no worker
        can connect with. The LAN address works on the same network and is at
        least a correct starting point elsewhere.

        Still only a guess: a laptop behind NAT has no address that is right
        from everywhere, which is why the docs lead with a tailnet and why this
        is overridable.
        """
        from worker import tls  # noqa: PLC0415

        host = (
            os.environ.get("OMNIVOICE_WORKER_ENDPOINT_HOST")
            or tls.primary_ip()
            or "127.0.0.1"
        )
        return _format_endpoint(host, self._port or control_port())

    def snapshot(self, *, now: Optional[float] = None) -> dict:
        """Everything the workers UI needs in one call."""
        stamp = resolve(now)
        if not self.running:
            return {
                "enabled": remote_workers_enabled(),
                "running": False,
                "startup_error": self.startup_error,
                "workers": [],
                "queue_depth": 0,
            }
        from worker import registry  # noqa: PLC0415

        # Config comes from the DATABASE, liveness from the pool — never the
        # other way round. The pool holds the RemoteWorker it was handed when
        # the worker connected, so reading a name or a priority from there
        # serves whatever was true at connect time: rename a connected worker
        # and the UI would show the old name until it reconnected.
        connected = {w.worker_id: w for w in self.pool}
        workers = []
        for record in registry.list_workers():
            entry = record.to_dict()
            live = connected.get(record.id)
            if live is None:
                entry["connected"] = False
            else:
                entry.update(
                    {
                        "connected": True,
                        "draining": live.draining,
                        "latency_ms": round(live.latency_ms, 1),
                        "address": live.address,
                        "status": live.status,
                        "active_tasks": live.capacity.active_tasks,
                        "available_slots": live.capacity.available_slots,
                        "resident_models": sorted(live.capacity.resident_models),
                        "stale": live.stale(now=stamp),
                    }
                )
            entry["breakers"] = [
                b.to_dict(now=stamp) for b in self.pool.breakers.open_breakers(record.id, now=stamp)
            ]
            workers.append(entry)
        return {
            "enabled": True,
            "running": True,
            "endpoint": self.default_endpoint(),
            "fingerprint": self.fingerprint,
            "queue_depth": self.scheduler.queue_depth,
            "workers": workers,
        }


# Process-wide control plane. One per backend, created lazily.
control_plane = ControlPlane()


async def start_if_enabled() -> None:
    """Called from the app lifespan. A no-op unless the user opted in."""
    await _start_inbound_node_if_enabled()

    if not remote_workers_enabled():
        logger.debug("Remote workers are disabled; not starting the control plane.")
        return
    try:
        await control_plane.start()
    except Exception as exc:
        # A failure here must never take the app down with it: the user's
        # local workflow does not depend on this feature existing.
        control_plane.startup_error = str(exc)
        logger.exception("Remote worker control plane failed to start")
        return

    # Redial saved nodes only once the control plane is up: the connector hands
    # frames to its servicer, which does not exist until then.
    try:
        from worker.inbound import service as inbound  # noqa: PLC0415

        await inbound.outbound.start_all(control_plane.servicer)
    except Exception:
        logger.exception("Could not reconnect saved GPU machines")


async def _start_inbound_node_if_enabled() -> None:
    """Accepting connections is independent of running a control plane.

    A machine can lend its GPU without driving any jobs of its own, and the
    import is deferred so one that does neither pays nothing for either.
    """
    try:
        from worker.inbound import service as inbound  # noqa: PLC0415

        if not inbound.enabled():
            return
        await inbound.node.start()
    except Exception:
        logger.exception("Inbound node listener failed to start")


async def stop() -> None:
    try:
        from worker.inbound import service as inbound  # noqa: PLC0415

        await inbound.outbound.stop()
        await inbound.node.stop()
    except Exception:
        logger.exception("Inbound node failed to stop cleanly")
    try:
        await control_plane.stop()
    except Exception:
        logger.exception("Remote worker control plane failed to stop cleanly")


__all__ = [
    "ControlPlane",
    "DEFAULT_PORT",
    "EndpointCertificateError",
    "control_plane",
    "control_port",
    "paths",
    "remote_workers_enabled",
    "start_if_enabled",
    "stop",
]
