"""Worker mode — the other half of the feature.

A worker is the ordinary backend with this agent running alongside it. That is
the whole point of not writing a slim agent: the engines, sidecar venvs, model
downloads, and VRAM budgeting the executor needs are already there.

The interesting problem here is bootstrapping trust. The control plane has a
self-signed certificate, so the worker has nothing to validate it against —
except the fingerprint baked into the enrollment token. So on first contact the
worker fetches the certificate the server presents, checks it against that
fingerprint, and only then uses it as the *sole* trusted root for every later
connection. Trust on first use, with the token as the anchor that makes the
"first use" safe.

If the fingerprint does not match, the agent stops. It does not warn and
continue: a mismatch is precisely the attack pinning exists to catch.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import ssl
import tempfile
from typing import Optional

logger = logging.getLogger("omnivoice.worker")

# How often the idle-engine sweep runs. Well under the ten-minute idle
# threshold it enforces, so a model is released promptly after it goes cold
# rather than up to a full interval later. Override with
# OMNIVOICE_IDLE_SWEEP_SECONDS when shortening the threshold for testing —
# leaving the interval at 60s while the threshold is 30s means waiting a full
# minute to observe a thirty-second rule, which reads as a broken sweep.
def _sweep_seconds_from_env(default: float = 60.0, floor: float = 1.0) -> float:
    raw = (os.environ.get("OMNIVOICE_IDLE_SWEEP_SECONDS") or "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        logger.warning("Ignoring OMNIVOICE_IDLE_SWEEP_SECONDS=%r: not a number.", raw)
        return default
    if value < floor:
        logger.warning(
            "Ignoring OMNIVOICE_IDLE_SWEEP_SECONDS=%s: below the %ss floor.", value, floor
        )
        return default
    return value


IDLE_SWEEP_INTERVAL_SECONDS = _sweep_seconds_from_env()


_WORKER_MODE_SETTING = "worker_mode_enabled"
_LOWER_HEX = frozenset("0123456789abcdef")


def worker_mode_enabled() -> bool:
    """Is this machine lending its GPU to someone else's control plane?

    Environment first so a headless box can be a worker with no UI at all, then
    settings for the desktop case — the same precedence as
    ``service.remote_workers_enabled``. The settings half is what lets a user
    join from the app and still be a worker after a restart; before it, joining
    meant setting OMNIVOICE_WORKER_MODE and OMNIVOICE_WORKER_TOKEN by hand and
    relaunching, which is the whole reason the feature was unreachable in the
    UI.
    """
    env = (os.environ.get("OMNIVOICE_WORKER_MODE") or "").strip().lower()
    if env in ("1", "true", "yes", "on"):
        return True
    if env in ("0", "false", "no", "off"):
        return False
    try:
        from services import settings_store  # noqa: PLC0415

        stored = (settings_store.get_text(_WORKER_MODE_SETTING, "") or "").strip().lower()
        return stored in ("1", "true", "yes", "on")
    except Exception:
        return False


def set_worker_mode_enabled(enabled: bool) -> None:
    from services import settings_store  # noqa: PLC0415

    settings_store.set_text(_WORKER_MODE_SETTING, "true" if enabled else "false")


_ENDPOINT_SETTING = "worker_endpoint"


def _stored_endpoint() -> str:
    try:
        from services import settings_store  # noqa: PLC0415

        return (settings_store.get_text(_ENDPOINT_SETTING, "") or "").strip()
    except Exception:
        return ""


def _remember_endpoint(endpoint: str) -> None:
    if not endpoint:
        return
    try:
        from services import settings_store  # noqa: PLC0415

        settings_store.set_text(_ENDPOINT_SETTING, endpoint)
    except Exception:
        logger.debug("Could not remember the control-plane endpoint.", exc_info=True)


def snapshot_enrollment() -> dict:
    """Everything a join overwrites, kept so a failed one can be undone."""
    certificate: Optional[bytes] = None
    try:
        with open(_paths()["pinned_cert"], "rb") as fh:
            certificate = fh.read()
    except (FileNotFoundError, PermissionError, OSError):
        certificate = None
    try:
        from services import settings_store  # noqa: PLC0415

        stored_mode = settings_store.get_text(_WORKER_MODE_SETTING, "")
    except Exception:
        stored_mode = ""
    return {
        "certificate": certificate,
        "endpoint": _stored_endpoint(),
        # The RAW setting, not worker_mode_enabled(): restoring "" as "false"
        # would persist a decision the machine never made.
        "worker_mode": stored_mode,
    }


async def restore_enrollment(previous: dict) -> None:
    """Put a machine back the way a failed rejoin found it.

    Best effort by design: the user's next action is to paste a fresh code
    either way, and an exception raised here would replace the join error —
    the one that says what actually went wrong — with a rollback error.
    """
    certificate = previous.get("certificate")
    path = _paths()["pinned_cert"]
    try:
        if certificate is None:
            # There was no enrollment before this attempt; leave none behind
            # rather than a certificate the user never agreed to.
            if os.path.exists(path):
                os.remove(path)
        else:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as fh:
                fh.write(certificate)
    except OSError:
        logger.warning("Could not restore the previous pinned certificate.", exc_info=True)
    _remember_endpoint(previous.get("endpoint", ""))
    stored_mode = (previous.get("worker_mode") or "").strip().lower()
    if stored_mode not in ("1", "true", "yes", "on"):
        if stored_mode:
            set_worker_mode_enabled(False)
        return
    set_worker_mode_enabled(True)
    try:
        await agent.start()
    except Exception:
        # It was working a moment ago; if it will not come back the panel
        # already shows the join error and the user can retry.
        logger.warning("Could not resume the previous control plane.", exc_info=True)


def enrolled() -> bool:
    """Has this machine ever completed a join?

    The pinned control-plane certificate is written only by a successful
    enrollment, so its presence is the honest answer — and it is what lets the
    agent reconnect later without a fresh token.
    """
    try:
        return os.path.exists(_paths()["pinned_cert"])
    except Exception:
        return False


def _paths() -> dict[str, str]:
    from worker.service import paths  # noqa: PLC0415

    locations = paths()
    locations["pinned_cert"] = os.path.join(locations["root"], "control-plane.pinned.crt")
    # The server-assigned id, remembered so a restarted worker can prove who it
    # is. The challenge signature binds to this id, so a worker that forgets it
    # cannot authenticate with the key it already enrolled.
    locations["worker_id"] = os.path.join(locations["root"], "worker-id")
    locations["enrollment_token_hash"] = os.path.join(
        locations["root"], "enrollment-token.sha256"
    )
    return locations


def load_worker_id(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read().strip()
    except (FileNotFoundError, PermissionError):
        return ""


def save_worker_id(path: str, worker_id: str) -> None:
    if not worker_id:
        return
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(worker_id)


def _token_hash(token_text: str) -> str:
    return hashlib.sha256(token_text.encode("utf-8")).hexdigest() if token_text else ""


def _load_consumed_token_hash(path: str) -> str:
    try:
        with open(path, encoding="ascii") as fh:
            digest = fh.read()
    except (OSError, UnicodeError):
        return ""
    if len(digest) != 64 or any(character not in _LOWER_HEX for character in digest):
        return ""
    return digest


def _save_consumed_token_hash(path: str, token_text: str) -> None:
    digest = _token_hash(token_text)
    if not digest:
        return
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    file_descriptor, temporary = tempfile.mkstemp(
        prefix=".enrollment-token.", suffix=".tmp", dir=directory
    )
    try:
        with os.fdopen(file_descriptor, "w", encoding="ascii") as fh:
            fh.write(digest)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except OSError:  # best effort: preserve the original write/replace error
            pass
        raise


def fetch_server_certificate(endpoint: str, *, timeout: float = 10.0) -> bytes:
    """Retrieve the certificate the control plane presents, unvalidated.

    Unvalidated on purpose and safe only because the caller immediately checks
    it against the token's fingerprint — this is the fetch half of pin-on-first-
    use, not a trust decision.
    """
    host, _, port = endpoint.rpartition(":")
    if not host:
        raise ValueError(f"Endpoint must be host:port — got {endpoint!r}")
    from worker import tls  # noqa: PLC0415

    context = tls.unverified_client_context()
    with ssl.create_connection((host, int(port)), timeout=timeout) as raw:
        with context.wrap_socket(raw, server_hostname=host) as tls:
            der = tls.getpeercert(binary_form=True)
    if not der:
        raise ConnectionError("The control plane presented no certificate.")
    return ssl.DER_cert_to_PEM_cert(der).encode("ascii")


def pin_certificate(token_text: str, *, cert_path: Optional[str] = None) -> tuple[str, bytes]:
    """Resolve a token into (endpoint, trusted certificate), pinning on first use.

    Raises ``ValueError`` when the presented certificate does not match the
    token. There is deliberately no override.
    """
    from worker.identity import EnrollmentToken  # noqa: PLC0415
    from worker.transport.client import verify_pin  # noqa: PLC0415

    token = EnrollmentToken.decode(token_text)
    if token.expired():
        raise ValueError("This enrollment token has expired. Generate a new one.")

    certificate = fetch_server_certificate(token.endpoint)
    if not verify_pin(certificate, token.cert_fingerprint):
        raise ValueError(
            "The control plane's certificate does not match this enrollment token. "
            "Stop — this is what the token's fingerprint exists to catch. Generate a "
            "fresh token on the control plane and try again."
        )

    path = cert_path or _paths()["pinned_cert"]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(certificate)
    return token.endpoint, certificate


class WorkerAgent:
    """Keeps this machine connected to a control plane and running its work."""

    def __init__(self) -> None:
        self._task: Optional[asyncio.Task] = None
        self._idle_sweep: Optional[asyncio.Task] = None
        self._client = None
        # Why the last start failed, kept so the panel can say "that token has
        # expired" instead of leaving a toggle that silently springs back.
        self.last_error: str = ""
        self.endpoint: str = ""
        # Set the first time the control plane accepts this worker. `start()`
        # only SCHEDULES the connection, so without waiting on this a caller
        # cannot tell "connected" from "will retry forever in the background".
        self._registered = asyncio.Event()
        # One lock for every lifecycle change. Two concurrent requests — a join
        # and a toggle, or two joins — used to interleave their stop/start
        # pairs, and `start()` returns early when something is already running,
        # so a join could report success for a control plane it never dialled.
        self.lifecycle = asyncio.Lock()

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def status(self) -> dict:
        """What the "lend this machine" panel renders, in one call."""
        return {
            "worker_mode": worker_mode_enabled(),
            "running": self.running,
            "enrolled": enrolled(),
            "endpoint": self.endpoint
            or (os.environ.get("OMNIVOICE_WORKER_ENDPOINT") or "").strip()
            or _stored_endpoint(),
            "last_error": self.last_error,
            "env_pinned": bool((os.environ.get("OMNIVOICE_WORKER_MODE") or "").strip()),
        }

    def readiness(self) -> dict[str, object]:
        """Whether a worker-only deployment completed its first registration."""
        if not worker_mode_enabled():
            return {"ready": False, "status": "disabled"}
        if self.running and self._registered.is_set():
            return {"ready": True, "status": "ready"}
        if self.last_error:
            return {"ready": False, "status": "failed"}
        if self.running:
            return {"ready": False, "status": "registering"}
        return {"ready": False, "status": "stopped"}

    async def start(self, *, token_text: str = "", endpoint: str = "") -> None:
        from worker import capabilities  # noqa: PLC0415
        from worker.executor import TaskExecutor  # noqa: PLC0415
        from worker.identity import load_or_create_worker_key  # noqa: PLC0415
        from worker.transport.client import (  # noqa: PLC0415
            WorkerClient,
            WorkerConfig,
            describe_host,
        )

        if self.running:
            return

        self._registered.clear()
        self.last_error = ""
        locations = _paths()
        os.makedirs(locations["root"], exist_ok=True)
        # Generated once and never transmitted; this is the worker's identity
        # for the life of the machine.
        keypair = load_or_create_worker_key(locations["worker_key"])

        # A container's environment persists across process restarts, while an
        # enrollment token is single-use. Once registration has persisted a
        # worker id, reconnect with the identity key instead of trying to
        # spend that environment token again. An explicit token still means
        # "re-enrol", which keeps the in-app join flow able to replace an
        # existing control plane.
        explicit_token = token_text.strip()
        environment_token = (os.environ.get("OMNIVOICE_WORKER_TOKEN") or "").strip()
        worker_id = load_worker_id(locations["worker_id"])
        token_hash_path = locations.get("enrollment_token_hash") or os.path.join(
            locations["root"], "enrollment-token.sha256"
        )
        consumed_token_hash = _load_consumed_token_hash(token_hash_path)
        environment_token_is_new = bool(
            environment_token
            and consumed_token_hash
            and _token_hash(environment_token) != consumed_token_hash
        )
        token_text = explicit_token or environment_token
        should_enroll = bool(
            token_text and (explicit_token or not worker_id or environment_token_is_new)
        )
        if should_enroll:
            endpoint, certificate = await asyncio.to_thread(pin_certificate, token_text)
            # The token carries the address; remembering it is what makes the
            # NEXT launch work. Without this a machine that joined from the UI
            # came back up enrolled but with nowhere to dial, and the only fix
            # was an environment variable — the barrier the join flow exists to
            # remove.
            _remember_endpoint(endpoint)
        else:
            token_text = ""
            # Already enrolled: reuse the certificate pinned at join time.
            try:
                with open(locations["pinned_cert"], "rb") as fh:
                    certificate = fh.read()
            except (FileNotFoundError, PermissionError) as exc:
                raise RuntimeError(
                    "This machine has not been enrolled yet. Ask for a join code on the "
                    "control plane (Settings → System → Remote workers) and paste it into "
                    "Lend this machine's GPU."
                ) from exc
            endpoint = (
                endpoint
                or (os.environ.get("OMNIVOICE_WORKER_ENDPOINT") or "").strip()
                or _stored_endpoint()
            )
            if not endpoint:
                raise RuntimeError(
                    "This machine does not know which control plane to dial. Paste a fresh "
                    "join code, or set OMNIVOICE_WORKER_ENDPOINT to its host:port."
                )
        self.endpoint = endpoint

        # Unavailable engines are reported too, so the control plane can tell
        # "this worker has no such engine" from "it has it but the weights
        # aren't downloaded" — a row that never arrives can only look like the
        # former, and the download-first flow has nothing to offer.
        discovered = capabilities.discover(include_unavailable=True)
        host = describe_host()
        host["gpus"] = capabilities.describe_gpus()

        config = WorkerConfig(
            endpoint=endpoint,
            cert_fingerprint="",
            certificate_pem=certificate,
            keypair=keypair,
            worker_id=worker_id,
            enrollment_token=token_text,
            max_concurrent_tasks=capabilities.max_concurrent_tasks(discovered),
            capabilities=discovered,
            host=host,
        )
        # No reporters here on purpose: the client injects a pair bound to each
        # assignment's ref (``execute(assignment, on_progress=…,
        # on_model_loading=…)``), which is the only way a multi-slot worker can
        # say which task a progress fraction belongs to. Those reports are what
        # renews the server's progress lease.
        executor = TaskExecutor()
        self._client = WorkerClient(
            config,
            execute=executor.execute,
            # Re-probed on every reconnect so a model loaded (or evicted) since
            # the last connection is reported honestly rather than from a
            # snapshot taken at startup.
            capability_probe=lambda: capabilities.discover(include_unavailable=True),
            on_registered=self._on_registered(
                locations["worker_id"],
                token_hash_path=token_hash_path,
                enrollment_token=(token_text if should_enroll else environment_token),
            ),
        )
        self._task = asyncio.create_task(self._client.run_forever(), name="worker-agent")
        self._idle_sweep = asyncio.create_task(
            self._unload_idle_engines(), name="worker-idle-unload"
        )
        logger.info(
            "Worker agent connecting to %s with %d engine(s)", endpoint, len(discovered)
        )

    def _on_registered(
        self, worker_id_path: str, *, token_hash_path: str = "", enrollment_token: str = ""
    ):
        def handle(worker_id) -> None:
            save_worker_id(worker_id_path, worker_id)
            if token_hash_path:
                try:
                    _save_consumed_token_hash(token_hash_path, enrollment_token)
                except OSError:
                    logger.warning("Could not persist the consumed enrollment token hash.")
            self._registered.set()

        return handle

    async def wait_until_registered(self, timeout: float = 20.0) -> None:
        """Block until the control plane has accepted this worker.

        `start()` returns as soon as the connection is scheduled, so a join
        that the control plane rejects — expired token, wrong address, a
        server that never answers — looked exactly like a successful one:
        the setting was persisted, the panel said "connected", and the machine
        retried in the background forever. Raises with the connection's own
        reason so the caller can undo the join and show it.
        """
        if self._task is None:
            raise RuntimeError("The worker agent is not running.")
        registered = asyncio.ensure_future(self._registered.wait())
        try:
            done, _ = await asyncio.wait(
                {registered, self._task},
                timeout=timeout,
                return_when=asyncio.FIRST_COMPLETED,
            )
        finally:
            if not registered.done():
                registered.cancel()
        if registered in done:
            return
        if self._task in done:
            # The connection loop gave up. Surface ITS error, not a timeout.
            error = self._task.exception() if not self._task.cancelled() else None
            raise RuntimeError(
                str(error) if error else "The connection to the control plane stopped."
            )
        raise RuntimeError(
            "The control plane did not answer in time. Check that it is running and "
            "reachable at this address, then try the code again."
        )

    # ── Idle unloading ────────────────────────────────────────────────────

    async def _unload_idle_engines(self) -> None:
        await idle_unload_loop(self._refresh_capabilities)

    async def _refresh_capabilities(self) -> None:
        if self._client is not None:
            await self._client.refresh_capabilities()

    async def stop(self) -> None:
        if self._client is not None:
            await self._client.stop()
        for attribute in ("_task", "_idle_sweep"):
            task = getattr(self, attribute)
            if task is not None:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                setattr(self, attribute, None)
        self._client = None


async def idle_unload_loop(on_released=None) -> None:
    """Hand back engines this machine has not used for ten minutes.

    Module-level because BOTH transports need it and only one of them used to
    have it: the sweep lived inside the dial-out agent, which an inbound-only
    node never starts, so a machine lending its GPU to panels that dial IN held
    several GB of weights forever against a task that might never come. That is
    the exact cost this exists to avoid, and it was silently absent in the mode
    most likely to be a shared box.

    Local behaviour is unchanged: nothing sweeps unless a worker role is
    running. `on_released` re-advertises capabilities when something was
    actually freed, so a control plane's view of what is resident does not go
    stale the moment it becomes useful.
    """
    from services import tts_backend  # noqa: PLC0415

    while True:
        await asyncio.sleep(IDLE_SWEEP_INTERVAL_SECONDS)
        try:
            # This process serves the desktop user as well as remote
            # assignments. Local work runs through the shared GPU pool but
            # does not enter the worker executor's per-engine guard.
            from services import model_manager  # noqa: PLC0415

            local = model_manager.gpu_pool_stats()
            if local.get("running", 0) or local.get("queued", 0):
                continue
            # unload() frees device caches and reaps sidecars — blocking, so it
            # must not run on the loop that answers heartbeats.
            released = await asyncio.to_thread(tts_backend.release_idle_engines)
            if released and on_released is not None:
                await on_released()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Idle engine sweep failed (the worker continues)")


agent = WorkerAgent()


async def start_if_worker_mode() -> None:
    """Called from the app lifespan on the worker machine.

    Never fatal: a machine that cannot reach its control plane is still a
    perfectly good OmniVoice install for the person sitting at it.
    """
    if not worker_mode_enabled():
        return
    try:
        await agent.start()
    except Exception as exc:
        agent.last_error = str(exc)
        logger.exception("Worker agent failed to start (the app continues normally)")


async def stop() -> None:
    try:
        await agent.stop()
    except Exception:
        logger.exception("Worker agent failed to stop cleanly")


__all__ = [
    "WorkerAgent",
    "agent",
    "fetch_server_certificate",
    "pin_certificate",
    "start_if_worker_mode",
    "stop",
    "worker_mode_enabled",
]
