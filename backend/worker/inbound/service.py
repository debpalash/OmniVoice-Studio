"""Lifecycle for inbound mode on both sides, and the settings that gate it.

Two independent switches, deliberately not one:

  * **Accept connections** turns this machine into a node other panels can
    dial. Off by default.
  * **Saved connections** are the nodes this panel dials out to. Adding one is
    what pasting a connection string does.

A machine can do both — a workstation with a GPU that also drives jobs on a
second box — which is why neither implies the other.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import os
from typing import Optional
from urllib.parse import urlsplit

from worker.async_utils import drain_task, to_thread_and_drain_on_cancel
from worker.inbound.artifacts import ArtifactStore, KeyedArtifactTransport
from worker.inbound.connection_log import ConnectionLog
from worker.inbound.connection_string import (
    Connection,
    InvalidConnectionString,
    format_connection,
    parse_connection,
)
from worker.inbound.connector import InboundConnectionRollbackError
from worker.inbound.keys import KeyStore
from worker.inbound.listener import DEFAULT_BIND, DEFAULT_PORT, NodeListener

logger = logging.getLogger(__name__)

_ENABLED_KEY = "inbound_node_enabled"
_BIND_KEY = "inbound_node_bind"
_PORT_KEY = "inbound_node_port"
_SAVED_KEY = "inbound_saved_nodes"


async def _finish_rollback(rollback, *, description: str) -> None:
    """Finish a lifecycle rollback even if its caller is cancelled again."""
    task = asyncio.create_task(rollback, name="inbound-connection-rollback")
    try:
        await asyncio.shield(task)
    except BaseException:
        await drain_task(task)
    if task.cancelled():
        raise InboundConnectionRollbackError(
            f"Could not {description}: rollback was cancelled."
        )
    return task.result()


def _normalise_listener_host(value: str) -> str:
    """Return the bare identity gRPC and X.509 expect for an IP literal."""
    candidate = (value or "").strip()
    inner = (
        candidate[1:-1]
        if len(candidate) >= 2
        and candidate.startswith("[")
        and candidate.endswith("]")
        else candidate
    )
    try:
        return str(ipaddress.ip_address(inner))
    except ValueError:
        return candidate


def normalise_bind_host(value: str) -> str:
    """Canonicalise a requested listener host before comparing or saving it."""
    return _normalise_listener_host(value)


def _setting(name: str, default: str = "") -> str:
    try:
        from services import settings_store  # noqa: PLC0415

        return (settings_store.get_text(name, default) or default).strip()
    except Exception:
        return default


def _set_setting(name: str, value: str) -> None:
    from services import settings_store  # noqa: PLC0415

    settings_store.set_text(name, value)


def enabled_override() -> Optional[bool]:
    """A headless environment override, or None when the UI owns the switch."""
    env = (os.environ.get("OMNIVOICE_INBOUND_NODE") or "").strip().lower()
    if env in ("1", "true", "yes", "on"):
        return True
    if env in ("0", "false", "no", "off"):
        return False
    return None


def enabled() -> bool:
    """Whether this machine accepts inbound connections. Off unless asked.

    Environment first so a headless node can be brought up without a UI, then
    settings for the desktop case — the same precedence remote workers uses.
    """
    override = enabled_override()
    if override is not None:
        return override
    return _setting(_ENABLED_KEY).lower() in ("1", "true", "yes", "on")


def set_enabled(value: bool) -> None:
    _set_setting(_ENABLED_KEY, "true" if value else "false")


def bind_host() -> str:
    """Where the listener binds.

    Localhost by default, which is nearly useless on its own — that is the
    point. Reaching this node from another machine should be a decision
    somebody made, not a side effect of turning the feature on.
    """
    return _normalise_listener_host(
        os.environ.get("OMNIVOICE_INBOUND_BIND")
        or _setting(_BIND_KEY)
        or DEFAULT_BIND
    )


def set_bind_host(value: str) -> None:
    _set_setting(_BIND_KEY, _normalise_listener_host(value) or DEFAULT_BIND)


def bind_port() -> int:
    raw = os.environ.get("OMNIVOICE_INBOUND_PORT") or _setting(_PORT_KEY)
    try:
        return int(raw) if raw else DEFAULT_PORT
    except ValueError:
        return DEFAULT_PORT


def set_bind_port(value: int) -> None:
    _set_setting(_PORT_KEY, str(int(value)))


# Addresses that are legal to BIND but meaningless to DIAL. A connection
# string built from one of these is broken for the person who receives it, and
# broken in the least diagnosable way: it looks like a perfectly good address.
_WILDCARD_BINDS = frozenset({"0.0.0.0", "::", "[::]", "*", ""})


def advertised_host() -> str:
    """The address to put in a connection string.

    Not the bind address. Binding to 0.0.0.0 means "every interface", which is
    exactly what you want for listening and exactly what you cannot hand to
    somebody else — verified on hardware, where the string came out as
    `ovnode://…@0.0.0.0:7444` and would have failed on the far end with a
    connection error that names nothing.
    """
    host = bind_host()
    if host not in _WILDCARD_BINDS:
        return host

    # Ask the routing table which source address would be used to reach the
    # outside world. No packets are sent — a connected UDP socket only fixes
    # the local endpoint — so this works with no network and no DNS.
    import socket  # noqa: PLC0415

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("192.0.2.1", 9))  # TEST-NET-1: reserved, never routed
        return sock.getsockname()[0]
    except OSError:
        return ""
    finally:
        sock.close()


def is_exposed(host: Optional[str] = None) -> bool:
    """True when the listener is reachable from other machines.

    The UI says so at the point the bind is widened because the private
    connection string then admits clients beyond this machine. Transport
    remains pinned TLS (docs/adr/inbound-node-mode.md).
    """
    return _normalise_listener_host(
        host if host is not None else bind_host()
    ).lower() not in (
        "127.0.0.1",
        "localhost",
        "::1",
    )


def paths() -> dict[str, str]:
    from worker.service import paths as worker_paths  # noqa: PLC0415

    root = worker_paths()["root"]
    return {
        "keys": os.path.join(root, "inbound-keys.json"),
        "staged": os.path.join(root, "inbound-staged"),
        "certificate": os.path.join(root, "inbound-node.crt"),
        "private_key": os.path.join(root, "inbound-node.key"),
    }


def _tls_credentials():
    from worker import tls  # noqa: PLC0415

    wanted = tls.default_hostnames()
    for host in (bind_host(), advertised_host()):
        if host not in _WILDCARD_BINDS and host not in wanted:
            wanted.append(host)
    locations = paths()
    return tls.load_or_create(
        locations["certificate"], locations["private_key"], hostnames=wanted
    )


class InboundNode:
    """This machine as a node other panels can dial."""

    def __init__(self) -> None:
        self._listener: Optional[NodeListener] = None
        self._credentials = None
        self._keys: Optional[KeyStore] = None
        self._log = ConnectionLog()
        self._idle_sweep: Optional[asyncio.Task] = None
        self._lifecycle_lock = asyncio.Lock()
        self.startup_error: Optional[str] = None

    @property
    def keys(self) -> KeyStore:
        if self._keys is None:
            self._keys = KeyStore(paths()["keys"])
        return self._keys

    @property
    def log(self) -> ConnectionLog:
        return self._log

    @property
    def running(self) -> bool:
        return self._listener is not None and self._listener.running

    @property
    def port(self) -> int:
        return self._listener.port if self._listener else 0

    def _prepare_client(self, key_id: str) -> dict:
        """Probe keys, host and accelerators away from the listener loop."""
        from worker import capabilities  # noqa: PLC0415
        from worker.agent import _paths as agent_paths  # noqa: PLC0415
        from worker.identity import load_or_create_worker_key  # noqa: PLC0415
        from worker.transport.client import describe_host  # noqa: PLC0415

        locations = agent_paths()
        os.makedirs(locations["root"], exist_ok=True)
        keypair = load_or_create_worker_key(locations["worker_key"])
        discovered = capabilities.discover(include_unavailable=True)
        host = describe_host()
        host["gpus"] = capabilities.describe_gpus()
        return {
            "keypair": keypair,
            "discovered": discovered,
            "host": host,
            "worker_id": self.keys.worker_id_for(key_id),
            "max_concurrent_tasks": capabilities.max_concurrent_tasks(discovered),
        }

    async def _client_factory(
        self, artifacts: KeyedArtifactTransport, key_id: str
    ):
        # Imported here so a machine that never accepts connections does not
        # pay for the executor or grpc at startup.
        from worker import capabilities  # noqa: PLC0415
        from worker.executor import TaskExecutor  # noqa: PLC0415
        from worker.transport.client import (  # noqa: PLC0415
            WorkerClient,
            WorkerConfig,
        )

        prepared = await to_thread_and_drain_on_cancel(
            self._prepare_client, key_id
        )

        executor = TaskExecutor()
        return WorkerClient(
            WorkerConfig(
                endpoint="",
                cert_fingerprint="",
                certificate_pem=b"",
                keypair=prepared["keypair"],
                # Per panel key, not per node: each panel keeps its own
                # registry, so the same machine is a different worker id to
                # each of them, and the node signs its challenge over that id.
                worker_id=prepared["worker_id"],
                enrollment_token="",
                max_concurrent_tasks=prepared["max_concurrent_tasks"],
                capabilities=prepared["discovered"],
                host=prepared["host"],
            ),
            execute=executor.execute,
            capability_probe=lambda: capabilities.discover(include_unavailable=True),
            on_registered=lambda wid: self.keys.remember_worker_id(key_id, wid),
            artifacts=artifacts,
            drain_active_work=executor.drain_active_work,
        )

    async def start(self) -> None:
        async with self._lifecycle_lock:
            await self._start()

    async def _start(self) -> None:
        if self._listener is not None:
            return
        self.startup_error = None
        listener = NodeListener(
            keys=self.keys,
            log=self._log,
            artifacts=ArtifactStore(paths()["staged"]),
            client_factory=self._client_factory,
            credentials=_tls_credentials(),
        )
        try:
            await listener.start(host=bind_host(), port=bind_port())
        except asyncio.CancelledError:
            # NodeListener cleans a partially bound server before returning.
            # If that cleanup itself failed it retains the handle; publish it
            # here so a later stop can retry rather than losing a live socket.
            if listener.running:
                self._listener = listener
            raise
        except Exception as exc:
            # A node that cannot listen must say so in the UI rather than look
            # enabled and quietly accept nothing.
            if listener.running:
                self._listener = listener
            self.startup_error = str(exc)
            logger.error("Could not start the inbound listener: %s", exc)
            return
        self._listener = listener
        self._credentials = listener.credentials
        # A node that only accepts inbound connections never starts the
        # dial-out agent, which is where the idle sweep used to live — so
        # without this a shared GPU box held its weights forever.
        from worker.agent import idle_unload_loop  # noqa: PLC0415

        self._idle_sweep = asyncio.create_task(
            idle_unload_loop(listener.refresh_all), name="inbound-idle-unload"
        )

    async def stop(self) -> None:
        async with self._lifecycle_lock:
            await self._stop()

    async def _stop(self) -> None:
        sweep = self._idle_sweep
        listener = self._listener

        async def shutdown() -> None:
            if sweep is not None:
                sweep.cancel()
                await asyncio.gather(sweep, return_exceptions=True)
            if listener is not None:
                await listener.stop()

        stopping = asyncio.create_task(shutdown(), name="inbound-node-stop")
        try:
            await asyncio.shield(stopping)
        except asyncio.CancelledError:
            await drain_task(stopping)
            if stopping.cancelled():
                raise
            failure = stopping.exception()
            if failure is not None:
                raise failure
            if self._idle_sweep is sweep:
                self._idle_sweep = None
            if self._listener is listener:
                self._listener = None
            raise
        except BaseException:
            await drain_task(stopping)
            raise
        if self._idle_sweep is sweep:
            self._idle_sweep = None
        if self._listener is listener:
            self._listener = None

    async def revoke_key(self, key_id: str) -> bool:
        """Durably revoke one panel and withdraw all of its live sessions."""
        if self._listener is not None:
            return await self._listener.revoke_key_and_wait(key_id)
        return self.keys.revoke(key_id)

    def connection_string(self, secret: str, *, host: Optional[str] = None) -> str:
        """The one artifact a user copies to another machine.

        Built from the ADVERTISED host, never the bind — see `advertised_host`.
        """
        if self._credentials is None:
            raise RuntimeError(
                "This machine is not accepting connections yet. Turn it on and try again."
            )
        return format_connection(
            host=host or advertised_host() or bind_host(),
            port=self.port or bind_port(),
            secret=secret,
            fingerprint=self._credentials.fingerprint,
        )

    def snapshot(self) -> dict:
        state = self._log.snapshot()
        host = bind_host()
        return {
            "enabled": enabled(),
            "running": self.running,
            "bind": host,
            "port": self.port or bind_port(),
            "exposed": is_exposed(host),
            "startup_error": self.startup_error,
            "tls_fingerprint": self._credentials.fingerprint
            if self._credentials
            else "",
            "keys": self.keys.list_keys(),
            **state,
        }


class OutboundNodes:
    """Nodes this panel dials. One connection per saved entry."""

    def __init__(self, credentials: Optional[KeyStore] = None) -> None:
        self._connections: dict[str, object] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        self._credentials = credentials
        self._lifecycle_lock = asyncio.Lock()
        self._servicer = None

    @property
    def credentials(self) -> KeyStore:
        # The module singleton shares the node's protected store. Tests and
        # embedded callers can inject an isolated one explicitly.
        return self._credentials or node.keys

    def saved(self) -> list[str]:
        raw = _setting(_SAVED_KEY)
        entries = [line.strip() for line in raw.splitlines() if line.strip()]
        endpoints: list[str] = []
        migrated = False
        for entry in entries:
            if entry.startswith("ovnode://"):
                try:
                    connection = parse_connection(entry)
                except InvalidConnectionString:
                    logger.warning("Dropping a saved inbound connection that no longer parses")
                    migrated = True
                    continue
                self.credentials.remember_connection_secret(
                    connection.endpoint, connection.secret, connection.fingerprint
                )
                endpoints.append(connection.endpoint)
                migrated = True
            else:
                endpoints.append(entry)
        if migrated:
            self._save(endpoints)
        return endpoints

    def _save(self, entries: list[str]) -> None:
        _set_setting(_SAVED_KEY, "\n".join(entries))

    async def add(self, text: str, servicer) -> Connection:
        """Parse, save and dial. Raises InvalidConnectionString on a bad paste."""
        connection = parse_connection(text)
        async with self._lifecycle_lock:
            return await self._add(connection, servicer)

    async def _add(self, connection: Connection, servicer) -> Connection:
        from worker.inbound.connector import NodeConnection  # noqa: PLC0415

        original_entries = self.saved()
        old_secret = self.credentials.connection_secret(connection.endpoint)
        old_fingerprint = self.credentials.connection_fingerprint(connection.endpoint)
        existing = self._connections.get(connection.endpoint)
        existing_task = self._tasks.get(connection.endpoint)

        # Pasting the already-running key is idempotent. Probing it would be a
        # duplicate Attach and could disturb state deliberately retained by
        # that same key.
        if (
            existing is not None
            and old_secret == connection.secret
            and old_fingerprint == connection.fingerprint
        ):
            if existing_task is not None and not existing_task.done():
                return connection
            # Terminal registration failures leave their diagnostic connector
            # in the snapshot. Re-pasting after an upgrade/repair must really
            # redial, not mistake that dead object for a healthy connection.
            if self._connections.get(connection.endpoint) is existing:
                self._connections.pop(connection.endpoint, None)
            if self._tasks.get(connection.endpoint) is existing_task:
                self._tasks.pop(connection.endpoint, None)
            try:
                await self._dial(connection, servicer, wait_until_ready=True)
            except BaseException as operation:
                try:
                    await _finish_rollback(
                        self._restore_failed_redial(
                            connection.endpoint, existing, existing_task
                        ),
                        description="restore the previous inbound connector",
                    )
                except InboundConnectionRollbackError as rollback:
                    raise rollback from operation
                raise
            return connection

        if existing is not None:
            # Authenticate and apply identity/version policy before touching
            # the only working connector or its durable credential.
            await NodeConnection(servicer, connection).probe()

        entries = [
            entry
            for entry in original_entries
            if _endpoint_of(entry) != connection.endpoint
        ]
        # Keyed by endpoint: re-pasting a rotated key for the same machine
        # replaces it rather than leaving a dead entry that retries forever.
        entries.append(connection.endpoint)
        try:
            if existing is not None:
                # An offline connector can own work retained on the node. Its
                # shutdown guard must run before replacement state is persisted.
                await self._drop(connection.endpoint)
            self.credentials.remember_connection_secret(
                connection.endpoint, connection.secret, connection.fingerprint
            )
            self._save(entries)
            await self._dial(
                connection, servicer, wait_until_ready=existing is not None
            )
        except BaseException as operation:
            try:
                await _finish_rollback(
                    self._rollback_add(
                        connection,
                        servicer,
                        existing,
                        original_entries,
                        old_secret,
                        old_fingerprint,
                    ),
                    description="restore the previous inbound connection",
                )
            except InboundConnectionRollbackError as rollback:
                raise rollback from operation
            raise
        return connection

    async def _restore_failed_redial(
        self, endpoint: str, existing, existing_task: Optional[asyncio.Task]
    ) -> None:
        failure = None
        candidate = self._connections.get(endpoint)
        candidate_task = self._tasks.get(endpoint)
        if candidate is not None and candidate is not existing:
            try:
                await self._close_candidate(endpoint, candidate, candidate_task)
            except BaseException as exc:
                failure = exc
        if endpoint not in self._connections:
            self._connections[endpoint] = existing
        if endpoint not in self._tasks and existing_task is not None:
            self._tasks[endpoint] = existing_task
        if failure is not None:
            raise InboundConnectionRollbackError(
                "The previous GPU-machine connector could not be restored safely."
            ) from failure

    async def _close_candidate(self, endpoint: str, candidate, candidate_task) -> None:
        try:
            close = getattr(candidate, "close", None)
            if callable(close):
                await close()
        finally:
            if candidate_task is not None:
                candidate_task.cancel()
                await asyncio.gather(candidate_task, return_exceptions=True)
            if self._connections.get(endpoint) is candidate:
                self._connections.pop(endpoint, None)
            if self._tasks.get(endpoint) is candidate_task:
                self._tasks.pop(endpoint, None)

    async def _rollback_add(
        self,
        connection: Connection,
        servicer,
        existing,
        original_entries: list[str],
        old_secret: str,
        old_fingerprint: str,
    ) -> None:
        """Restore both live and durable generations after a failed replacement."""
        endpoint = connection.endpoint
        failures = []
        candidate = self._connections.get(endpoint)
        candidate_task = self._tasks.get(endpoint)
        if candidate is not None and candidate is not existing:
            try:
                await self._close_candidate(endpoint, candidate, candidate_task)
            except BaseException as exc:
                failures.append(exc)
        try:
            if old_secret:
                self.credentials.remember_connection_secret(
                    endpoint, old_secret, old_fingerprint
                )
            else:
                self.credentials.forget_connection_secret(endpoint)
        except BaseException as exc:
            failures.append(exc)
        try:
            self._save(original_entries)
        except BaseException as exc:
            failures.append(exc)
        if (
            not failures
            and existing is not None
            and old_secret
            and endpoint not in self._connections
        ):
            try:
                await self._dial(
                    Connection(
                        host=connection.host,
                        port=connection.port,
                        secret=old_secret,
                        fingerprint=old_fingerprint,
                    ),
                    servicer,
                )
            except BaseException as exc:
                failures.append(exc)
        if failures:
            raise InboundConnectionRollbackError(
                "The previous GPU-machine connection could not be restored safely. "
                "It remains stopped; fix its connection/settings storage, then "
                "paste the original connection again."
            ) from failures[0]

    async def _drop(self, endpoint: str) -> None:
        connection = self._connections.get(endpoint)
        task = self._tasks.get(endpoint)
        if connection is not None:
            await connection.stop()
            if self._connections.get(endpoint) is connection:
                self._connections.pop(endpoint, None)
        if self._tasks.get(endpoint) is task:
            self._tasks.pop(endpoint, None)
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def remove(self, endpoint: str) -> bool:
        async with self._lifecycle_lock:
            return await self._remove(endpoint)

    async def _remove(self, endpoint: str) -> bool:
        existed = endpoint in self._connections
        original_entries = self.saved()
        secret = self.credentials.connection_secret(endpoint)
        fingerprint = self.credentials.connection_fingerprint(endpoint)
        previous_connection = None
        if secret and fingerprint:
            try:
                previous_connection = self._connection_for(endpoint)
            except InvalidConnectionString:
                pass
        # A disconnected node deliberately retains work for reconnect. Do not
        # erase the only connector/key capable of delivering terminal shutdown.
        try:
            await self._drop(endpoint)
            entries = [e for e in original_entries if _endpoint_of(e) != endpoint]
            # Remove the protected credential first. If that durable write
            # fails, restore both durable generations and the live connector.
            self.credentials.forget_connection_secret(endpoint)
            self._save(entries)
        except BaseException as operation:
            try:
                await _finish_rollback(
                    self._rollback_remove(
                        endpoint,
                        original_entries,
                        secret,
                        fingerprint,
                        previous_connection,
                    ),
                    description="restore removed inbound connection state",
                )
            except InboundConnectionRollbackError as rollback:
                raise rollback from operation
            raise
        return existed

    async def _rollback_remove(
        self,
        endpoint: str,
        original_entries: list[str],
        secret: str,
        fingerprint: str,
        previous_connection: Optional[Connection],
    ) -> None:
        failures = []
        try:
            if secret:
                self.credentials.remember_connection_secret(
                    endpoint, secret, fingerprint
                )
        except BaseException as exc:
            failures.append(exc)
        try:
            self._save(original_entries)
        except BaseException as exc:
            failures.append(exc)
        if (
            not failures
            and previous_connection is not None
            and self._servicer is not None
            and endpoint not in self._connections
        ):
            try:
                await self._dial(previous_connection, self._servicer)
            except BaseException as exc:
                failures.append(exc)
        if failures:
            raise InboundConnectionRollbackError(
                "The removed GPU-machine connection could not be restored safely. "
                "It remains stopped; fix its connection/settings storage, then retry."
            ) from failures[0]

    async def start_all(self, servicer) -> None:
        async with self._lifecycle_lock:
            for entry in self.saved():
                try:
                    await self._dial(self._connection_for(entry), servicer)
                except InvalidConnectionString as exc:
                    logger.warning(
                        "Ignoring a saved connection that no longer parses: %s", exc
                    )

    async def _dial(
        self, connection: Connection, servicer, *, wait_until_ready: bool = False
    ) -> None:
        from worker.inbound.connector import NodeConnection  # noqa: PLC0415

        self._servicer = servicer
        existing = self._connections.get(connection.endpoint)
        if existing is not None:
            if wait_until_ready and getattr(existing, "_connection", None) != connection:
                from worker.inbound.connector import (  # noqa: PLC0415
                    InboundConnectionError,
                )

                raise InboundConnectionError(
                    "A different connection to that GPU machine is already active."
                )
            return
        node = NodeConnection(servicer, connection)
        self._connections[connection.endpoint] = node
        task = asyncio.create_task(
            node.run_forever(), name=f"inbound-node-{connection.endpoint}"
        )
        task.add_done_callback(self._observe_connection_result)
        self._tasks[connection.endpoint] = task
        if wait_until_ready:
            await node.wait_until_registered(task)

    @staticmethod
    def _observe_connection_result(task: asyncio.Task) -> None:
        """Retrieve terminal dial errors; NodeConnection retains the UI detail."""
        if task.cancelled():
            return
        try:
            task.exception()
        except asyncio.CancelledError:
            pass

    async def stop(self) -> None:
        async with self._lifecycle_lock:
            await self._stop_all()

    async def _stop_all(self) -> None:
        for connection in list(self._connections.values()):
            close = getattr(connection, "close", None)
            if callable(close):
                await close()
            else:
                await connection.stop()
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._connections.clear()
        self._tasks.clear()

    def snapshot(self) -> list[dict]:
        rows = []
        for entry in self.saved():
            endpoint = _endpoint_of(entry)
            live = self._connections.get(endpoint)
            rows.append(
                {
                    "endpoint": endpoint,
                    "connected": bool(live and live.worker_id),
                    "worker_id": getattr(live, "worker_id", ""),
                    "last_error": getattr(live, "last_error", ""),
                }
            )
        return rows

    def _connection_for(self, endpoint: str) -> Connection:
        try:
            parsed = urlsplit(f"//{endpoint}")
            host, port = parsed.hostname, parsed.port
        except ValueError as exc:
            raise InvalidConnectionString("That saved node address is not valid.") from exc
        secret = self.credentials.connection_secret(endpoint)
        fingerprint = self.credentials.connection_fingerprint(endpoint)
        if not host or not port or not secret or not fingerprint:
            raise InvalidConnectionString(
                "That saved GPU connection has no protected key. Paste its connection string again."
            )
        return Connection(
            host=host, port=port, secret=secret, fingerprint=fingerprint
        )


def _endpoint_of(entry: str) -> str:
    if "://" not in entry:
        return entry.strip()
    try:
        return parse_connection(entry).endpoint
    except InvalidConnectionString:
        return ""


node = InboundNode()
outbound = OutboundNodes()
