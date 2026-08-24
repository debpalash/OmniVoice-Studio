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
import base64
import binascii
import errno
import hashlib
import json
import logging
import os
import ssl
import tempfile
from typing import Optional
from urllib.parse import urlsplit

from worker.async_utils import to_thread_and_drain_on_cancel

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
_ENROLLMENT_MANIFEST_SCHEMA = 1


class EnrollmentStateError(RuntimeError):
    """A committed enrollment exists but cannot be trusted or used."""


class EnrollmentRollbackError(EnrollmentStateError):
    """A failed join could not restore the enrollment it replaced."""


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


def _snapshot_file_generation(path: str, description: str) -> dict:
    """Capture exact bytes/presence for one file a join may overwrite."""
    try:
        with open(path, "rb") as fh:
            content = fh.read()
        return {"path": path, "present": True, "bytes": content}
    except FileNotFoundError:
        return {"path": path, "present": False, "bytes": None}
    except OSError as exc:
        raise EnrollmentStateError(
            f"The current worker {description} cannot be backed up safely. "
            "Fix its file permissions, then try joining again."
        ) from exc


def snapshot_enrollment() -> dict:
    """Everything a join overwrites, kept so a failed one can be undone."""
    locations = _paths()
    manifest_path = _enrollment_manifest_path(locations)
    manifest_snapshot = _snapshot_file_generation(manifest_path, "enrollment")
    root = os.path.dirname(os.path.abspath(manifest_path))
    file_snapshots = {
        "pinned_cert": _snapshot_file_generation(
            locations["pinned_cert"], "pinned certificate"
        ),
        "worker_id": _snapshot_file_generation(
            locations.get("worker_id") or os.path.join(root, "worker-id"),
            "identity",
        ),
        "token_hash": _snapshot_file_generation(
            locations.get("enrollment_token_hash")
            or os.path.join(root, "enrollment-token.sha256"),
            "enrollment-token marker",
        ),
    }
    preserve_enrollment_files = False
    try:
        manifest = _load_enrollment_manifest(manifest_path)
    except EnrollmentStateError:
        # A fresh explicit join can replace corrupt committed state safely.
        # Until acceptance nothing is written, so a failed repair should leave
        # those files untouched rather than "restoring" stale legacy mirrors.
        manifest = None
        preserve_enrollment_files = True
    certificate: Optional[bytes] = manifest["certificate"] if manifest else None
    if certificate is None and not preserve_enrollment_files:
        certificate = file_snapshots["pinned_cert"]["bytes"]
    try:
        from services import settings_store  # noqa: PLC0415

        worker_mode_setting_present, stored_mode = settings_store.get_text_state(
            _WORKER_MODE_SETTING
        )
        endpoint_setting_present, stored_endpoint_setting = (
            settings_store.get_text_state(_ENDPOINT_SETTING)
        )
    except Exception as exc:
        raise EnrollmentStateError(
            "The current worker settings cannot be backed up safely. "
            "Fix the settings database, then try joining again."
        ) from exc
    return {
        "certificate": certificate,
        "endpoint": (
            manifest["endpoint"]
            if manifest
            else ("" if preserve_enrollment_files else stored_endpoint_setting.strip())
        ),
        "preserve_enrollment_files": preserve_enrollment_files,
        "manifest_path": manifest_path,
        "manifest_present": manifest_snapshot["present"],
        "manifest_bytes": manifest_snapshot["bytes"],
        "manifest_snapshot_captured": True,
        "file_snapshots": file_snapshots,
        "endpoint_setting": stored_endpoint_setting,
        "endpoint_setting_present": endpoint_setting_present,
        "agent_endpoint": getattr(agent, "endpoint", ""),
        # The RAW setting, not worker_mode_enabled(): restoring "" as "false"
        # would persist a decision the machine never made.
        "worker_mode": stored_mode,
        "worker_mode_setting_present": worker_mode_setting_present,
    }


def _restore_file_generation(snapshot: dict) -> None:
    path = snapshot["path"]
    if snapshot.get("present"):
        content = snapshot.get("bytes")
        if not isinstance(content, bytes):
            raise OSError("the enrollment snapshot is incomplete")
        _replace_enrollment_manifest(path, content)
        return
    try:
        os.remove(path)
    except FileNotFoundError:
        return
    _fsync_parent_directory(os.path.dirname(os.path.abspath(path)))


async def _abort_enrollment_rollback(exc: BaseException, storage: str) -> None:
    message = (
        "The previous worker enrollment could not be restored safely. "
        f"Worker mode remains stopped; fix the {storage}, then try again."
    )
    try:
        await agent.stop()
    except Exception:
        logger.warning(
            "Worker agent also failed to stop after rollback failed.",
            exc_info=True,
        )
    agent.endpoint = ""
    agent.last_error = message
    raise EnrollmentRollbackError(message) from exc


async def restore_enrollment(previous: dict) -> None:
    """Put a machine back the way a failed rejoin found it.

    Compatibility mirrors are best effort, but the authoritative manifest is
    not: reconnecting after that restoration fails could silently run the
    replacement enrollment that this request just reported as rejected.
    """
    locations = _paths()
    manifest_path = previous.get("manifest_path") or _enrollment_manifest_path(locations)
    if previous.get("manifest_snapshot_captured"):
        try:
            _restore_file_generation(
                {
                    "path": manifest_path,
                    "present": previous.get("manifest_present"),
                    "bytes": previous.get("manifest_bytes"),
                }
            )
        except OSError as exc:
            await _abort_enrollment_rollback(exc, "enrollment storage")

    file_snapshots = previous.get("file_snapshots")
    if isinstance(file_snapshots, dict):
        for description, snapshot in file_snapshots.items():
            try:
                _restore_file_generation(snapshot)
            except OSError as exc:
                if not previous.get("manifest_present"):
                    await _abort_enrollment_rollback(
                        exc, f"worker {description.replace('_', ' ')} storage"
                    )
                logger.warning(
                    "Could not restore the previous worker %s.",
                    description.replace("_", " "),
                    exc_info=True,
                )
    else:
        certificate = previous.get("certificate")
        path = locations["pinned_cert"]
        if not previous.get("preserve_enrollment_files"):
            try:
                if certificate is None:
                    if os.path.exists(path):
                        os.remove(path)
                else:
                    _durable_makedirs(os.path.dirname(path))
                    with open(path, "wb") as fh:
                        fh.write(certificate)
            except OSError as exc:
                if not previous.get("manifest_present"):
                    await _abort_enrollment_rollback(
                        exc, "worker pinned-certificate storage"
                    )
                logger.warning(
                    "Could not restore the previous pinned certificate.", exc_info=True
                )

    has_exact_settings_snapshot = "worker_mode_setting_present" in previous
    if "endpoint_setting" in previous:
        try:
            from services import settings_store  # noqa: PLC0415

            if previous.get("endpoint_setting_present"):
                settings_store.set_text(
                    _ENDPOINT_SETTING, previous.get("endpoint_setting") or ""
                )
            else:
                settings_store.clear_text(_ENDPOINT_SETTING)
        except Exception as exc:
            if previous.get("manifest_snapshot_captured") and not previous.get(
                "manifest_present"
            ):
                await _abort_enrollment_rollback(exc, "settings storage")
            logger.warning(
                "Could not restore the previous worker endpoint.", exc_info=True
            )
    else:
        _remember_endpoint(previous.get("endpoint", ""))
    agent.endpoint = previous.get("agent_endpoint") or previous.get("endpoint", "")
    if has_exact_settings_snapshot:
        try:
            from services import settings_store  # noqa: PLC0415

            if previous.get("worker_mode_setting_present"):
                settings_store.set_text(
                    _WORKER_MODE_SETTING, previous.get("worker_mode") or ""
                )
            else:
                settings_store.clear_text(_WORKER_MODE_SETTING)
        except Exception as exc:
            if previous.get("manifest_snapshot_captured") and not previous.get(
                "manifest_present"
            ):
                await _abort_enrollment_rollback(exc, "settings storage")
            logger.warning(
                "Could not restore the previous worker-mode setting.", exc_info=True
            )
    stored_mode = (previous.get("worker_mode") or "").strip().lower()
    if stored_mode not in ("1", "true", "yes", "on"):
        if stored_mode and not has_exact_settings_snapshot:
            set_worker_mode_enabled(False)
        return
    if not has_exact_settings_snapshot:
        set_worker_mode_enabled(True)
    try:
        await agent.start()
    except Exception:
        # It was working a moment ago; if it will not come back the panel
        # already shows the join error and the user can retry.
        logger.warning("Could not resume the previous control plane.", exc_info=True)


def enrolled() -> bool:
    """Has this machine ever completed a join?

    The atomic manifest is committed only after acceptance. Its presence still
    counts when corrupt so the UI reports broken saved state instead of
    pretending this is a never-enrolled machine; the certificate is the legacy
    pre-manifest signal.
    """
    try:
        locations = _paths()
        try:
            manifest = _load_enrollment_manifest(
                _enrollment_manifest_path(locations)
            )
        except EnrollmentStateError:
            # Do not present corrupt committed state as a never-enrolled
            # machine and then fall through to stale compatibility mirrors.
            return True
        return bool(manifest or os.path.exists(locations["pinned_cert"]))
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
    locations["enrollment_manifest"] = os.path.join(
        locations["root"], "enrollment.json"
    )
    return locations


def _enrollment_manifest_path(locations: dict[str, str]) -> str:
    configured = locations.get("enrollment_manifest")
    if configured:
        return configured
    root = locations.get("root")
    if not root:
        root = os.path.dirname(os.path.abspath(locations["pinned_cert"]))
    return os.path.join(root, "enrollment.json")


def _load_enrollment_manifest(path: str) -> Optional[dict]:
    """Read the atomic enrollment generation, or fall back to legacy files."""
    try:
        with open(path, encoding="utf-8") as fh:
            record = json.load(fh)
        if (
            not isinstance(record, dict)
            or record.get("schema") != _ENROLLMENT_MANIFEST_SCHEMA
        ):
            raise ValueError("unsupported enrollment schema")
        endpoint = record.get("endpoint")
        worker_id = record.get("worker_id")
        token_hash = record.get("token_hash")
        encoded_certificate = record.get("certificate_pem")
        if not isinstance(endpoint, str) or not endpoint.strip():
            raise ValueError("missing enrollment endpoint")
        if not isinstance(worker_id, str) or not worker_id.strip():
            raise ValueError("missing worker id")
        if not isinstance(token_hash, str) or (
            token_hash
            and (
                len(token_hash) != 64
                or any(character not in _LOWER_HEX for character in token_hash)
            )
        ):
            raise ValueError("invalid enrollment-token hash")
        if not isinstance(encoded_certificate, str):
            raise ValueError("missing pinned certificate")
        certificate = base64.b64decode(encoded_certificate, validate=True)
        if not certificate:
            raise ValueError("empty pinned certificate")
        return {
            "endpoint": endpoint.strip(),
            "worker_id": worker_id.strip(),
            "token_hash": token_hash,
            "certificate": certificate,
        }
    except FileNotFoundError:
        return None
    except (
        OSError,
        UnicodeError,
        json.JSONDecodeError,
        binascii.Error,
        ValueError,
    ) as exc:
        raise EnrollmentStateError(
            "Saved worker enrollment is unreadable. Restore or remove its enrollment "
            "file, then join the control plane again."
        ) from exc


def _save_enrollment_manifest(
    path: str,
    *,
    endpoint: str,
    certificate: bytes,
    worker_id: str,
    token_hash: str,
) -> None:
    """Atomically commit all state needed to reconnect after acceptance."""
    endpoint = endpoint.strip()
    worker_id = worker_id.strip()
    if not endpoint or not worker_id or not certificate:
        raise ValueError("Accepted enrollment state is incomplete")
    if token_hash and (
        len(token_hash) != 64 or any(character not in _LOWER_HEX for character in token_hash)
    ):
        raise ValueError("Accepted enrollment token hash is invalid")
    encoded = json.dumps(
        {
            "schema": _ENROLLMENT_MANIFEST_SCHEMA,
            "endpoint": endpoint,
            "worker_id": worker_id,
            "token_hash": token_hash,
            "certificate_pem": base64.b64encode(certificate).decode("ascii"),
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    _replace_enrollment_manifest(path, encoded)


def _replace_enrollment_manifest(path: str, encoded: bytes) -> None:
    """Durably replace one complete enrollment generation."""
    directory = os.path.dirname(os.path.abspath(path))
    _durable_makedirs(directory)
    file_descriptor, temporary = tempfile.mkstemp(
        prefix=".enrollment.", suffix=".tmp", dir=directory
    )
    try:
        with os.fdopen(file_descriptor, "wb") as fh:
            fh.write(encoded)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(temporary, path)
        _fsync_parent_directory(directory)
    except Exception:
        try:
            os.unlink(temporary)
        except OSError:  # best effort: preserve the original write/replace error
            pass
        raise


def _fsync_parent_directory(directory: str) -> None:
    """Make a preceding directory-entry replacement durable where supported."""
    directory_flag = getattr(os, "O_DIRECTORY", None)
    if directory_flag is None:
        return
    unsupported = {
        errno.EINVAL,
        getattr(errno, "ENOTSUP", errno.EINVAL),
        getattr(errno, "EOPNOTSUPP", errno.EINVAL),
    }
    try:
        descriptor = os.open(directory, os.O_RDONLY | directory_flag)
    except OSError as exc:
        if exc.errno in unsupported:
            return
        raise
    try:
        os.fsync(descriptor)
    except OSError as exc:
        if exc.errno not in unsupported:
            raise
    finally:
        os.close(descriptor)


def _durable_makedirs(path: str) -> None:
    """Create a directory chain and persist each new parent entry."""
    target = os.path.abspath(path)
    if os.path.isdir(target):
        return
    if os.path.exists(target):
        raise FileExistsError(f"Not a directory: {target}")

    missing: list[str] = []
    cursor = target
    while not os.path.exists(cursor):
        missing.append(cursor)
        parent = os.path.dirname(cursor)
        if parent == cursor:
            break
        cursor = parent
    if not os.path.isdir(cursor):
        raise NotADirectoryError(cursor)

    for directory in reversed(missing):
        parent = os.path.dirname(directory)
        try:
            os.mkdir(directory)
        except FileExistsError:
            if not os.path.isdir(directory):
                raise
        # A file fsync cannot make the directory entry that names its parent
        # durable. Persist each level so a fresh workers/ tree survives power
        # loss before the enrollment manifest is acknowledged.
        _fsync_parent_directory(parent)


def _persisted_endpoint() -> str:
    try:
        locations = _paths()
        manifest = _load_enrollment_manifest(_enrollment_manifest_path(locations))
        if manifest:
            return manifest["endpoint"]
    except EnrollmentStateError:
        return ""
    except Exception:
        pass
    return _stored_endpoint()


def load_worker_id(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read().strip()
    except (FileNotFoundError, PermissionError):
        return ""


def save_worker_id(path: str, worker_id: str) -> None:
    if not worker_id:
        return
    _durable_makedirs(os.path.dirname(os.path.abspath(path)))
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
    _durable_makedirs(directory)
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


def _save_pinned_certificate(path: str, certificate: bytes) -> None:
    """Atomically replace the certificate only after enrollment is accepted."""
    directory = os.path.dirname(os.path.abspath(path))
    _durable_makedirs(directory)
    file_descriptor, temporary = tempfile.mkstemp(
        prefix=".control-plane.", suffix=".tmp", dir=directory
    )
    try:
        with os.fdopen(file_descriptor, "wb") as fh:
            fh.write(certificate)
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
    try:
        parsed = urlsplit(f"//{endpoint}")
        host = parsed.hostname
        port = parsed.port
    except ValueError as exc:
        raise ValueError(f"Endpoint must be host:port — got {endpoint!r}") from exc
    if (
        not host
        or port is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError(f"Endpoint must be host:port — got {endpoint!r}")
    from worker import tls  # noqa: PLC0415

    context = tls.unverified_client_context()
    with ssl.create_connection((host, port), timeout=timeout) as raw:
        with context.wrap_socket(raw, server_hostname=host) as tls:
            der = tls.getpeercert(binary_form=True)
    if not der:
        raise ConnectionError("The control plane presented no certificate.")
    return ssl.DER_cert_to_PEM_cert(der).encode("ascii")


def _verify_enrollment_token(token_text: str) -> tuple[str, bytes]:
    """Resolve a token into a verified endpoint and certificate without persisting it.

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

    return token.endpoint, certificate


def pin_certificate(token_text: str, *, cert_path: Optional[str] = None) -> tuple[str, bytes]:
    """Verify and atomically pin the certificate from an enrollment token."""
    endpoint, certificate = _verify_enrollment_token(token_text)
    _save_pinned_certificate(cert_path or _paths()["pinned_cert"], certificate)
    return endpoint, certificate


def _classify_legacy_environment_token(
    token_text: str,
    *,
    endpoint: str,
    cert_path: str,
    certificate: Optional[bytes] = None,
) -> tuple[bool, str]:
    """Return ``(is_replacement, decoded_endpoint)`` for a legacy token.

    Releases before the token-hash marker persisted the original Compose token
    beside a worker id. Re-spending that token breaks every restart, while
    ignoring every unmarked token prevents a non-revoked worker from moving to
    another control plane. The token's endpoint and certificate fingerprint
    identify which enrollment it belongs to without contacting either server.

    A malformed token is treated as the already-spent legacy value. That keeps
    a working key enrollment usable. A valid same-origin token remains
    ambiguous and available only if a later key reconnect is rejected.
    """
    from worker.identity import EnrollmentToken  # noqa: PLC0415
    from worker.transport.client import verify_pin  # noqa: PLC0415

    try:
        token = EnrollmentToken.decode(token_text)
    except (TypeError, ValueError):
        return False, ""

    token_endpoint = token.endpoint.strip()
    if endpoint.strip() and token_endpoint != endpoint.strip():
        return True, token_endpoint
    try:
        if certificate is None:
            with open(cert_path, "rb") as fh:
                certificate = fh.read()
        return not verify_pin(certificate, token.cert_fingerprint), token_endpoint
    except (OSError, TypeError, ValueError):
        # A valid token can recover an enrollment whose local trust material is
        # absent or corrupt; it cannot be the token for that unusable state.
        return True, token_endpoint


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
        # Set only after the control plane activates the Control stream. A
        # Register response saves identity but is still provisional server-side.
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
            or _persisted_endpoint(),
            "last_error": self.last_error,
            "env_pinned": bool((os.environ.get("OMNIVOICE_WORKER_MODE") or "").strip()),
        }

    def readiness(self) -> dict[str, object]:
        """Whether a worker-only deployment activated its first Control stream."""
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
            TerminalRegistrationError,
            WorkerClient,
            WorkerConfig,
            describe_host,
        )

        if self.running:
            return

        # A terminal connection failure ends `_task` but not the independent
        # idle-unload loop. Retire that whole generation before replacing any
        # references, or each retry leaks one infinite sweep that stop() can no
        # longer find (and leaves the failed client's work undrained).
        await self._retire_generation()

        self._registered.clear()
        self.last_error = ""
        locations = _paths()
        _durable_makedirs(locations["root"])
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
        manifest_path = _enrollment_manifest_path(locations)
        replace_invalid_manifest = False
        try:
            manifest = _load_enrollment_manifest(manifest_path)
        except EnrollmentStateError:
            if not explicit_token:
                raise
            # An explicit join is user-authorised repair. Treat none of the
            # separate compatibility files as authoritative; only the freshly
            # verified token may replace the corrupt generation on acceptance.
            manifest = None
            replace_invalid_manifest = True
        worker_id = manifest["worker_id"] if manifest else load_worker_id(
            locations["worker_id"]
        )
        token_hash_path = locations.get("enrollment_token_hash") or os.path.join(
            locations["root"], "enrollment-token.sha256"
        )
        consumed_token_hash = (
            manifest["token_hash"]
            if manifest
            else _load_consumed_token_hash(token_hash_path)
        )
        stored_endpoint = manifest["endpoint"] if manifest else _stored_endpoint()
        current_endpoint = (
            stored_endpoint
            or endpoint
            or (os.environ.get("OMNIVOICE_WORKER_ENDPOINT") or "").strip()
        )
        legacy_token_is_new = False
        legacy_token_endpoint = ""
        if environment_token and worker_id and not consumed_token_hash:
            legacy_token_is_new, legacy_token_endpoint = (
                _classify_legacy_environment_token(
                    environment_token,
                    endpoint=current_endpoint,
                    cert_path=locations["pinned_cert"],
                    certificate=(manifest["certificate"] if manifest else None),
                )
            )
        environment_token_is_new = bool(
            environment_token
            and (
                (
                    consumed_token_hash
                    and _token_hash(environment_token) != consumed_token_hash
                )
                or legacy_token_is_new
            )
        )
        token_text = explicit_token or environment_token
        should_enroll = bool(
            token_text and (explicit_token or not worker_id or environment_token_is_new)
        )
        legacy_token_fallback = bool(
            not should_enroll
            and environment_token
            and worker_id
            and not consumed_token_hash
            and not legacy_token_is_new
            and legacy_token_endpoint
        )
        if should_enroll:
            # Verify in memory, but do not replace a working enrollment until
            # the new control plane accepts this worker. A rejected token must
            # leave the certificate, endpoint, id, and token marker untouched.
            endpoint, certificate = await asyncio.to_thread(
                _verify_enrollment_token, token_text
            )
        else:
            token_text = ""
            # Already enrolled: reuse the certificate pinned at join time.
            if manifest:
                certificate = manifest["certificate"]
            else:
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
                or stored_endpoint
                or legacy_token_endpoint
            )
            if not endpoint:
                raise RuntimeError(
                    "This machine does not know which control plane to dial. Paste a fresh "
                    "join code, or set OMNIVOICE_WORKER_ENDPOINT to its host:port."
                )
        if not should_enroll:
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
            # Worker ids are panel-local.  A fresh enrollment may be moving
            # this key to a different control plane, whose accepted id is not
            # known until Register succeeds.  Sending the previous panel's id
            # also makes a lost first Register response unrecoverable: the
            # spent-token retry is signed over that stale id instead of the
            # newly enrolled identity.  Keep the durable old generation for
            # rollback, but enroll on the wire without it.
            worker_id="" if should_enroll else worker_id,
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
        accepted_enrollment = {
            # An unmarked same-origin legacy token is ambiguous: it may be the
            # old spent Compose token or a fresh token minted after a control-
            # plane reset. A successful key reconnect proves neither case, so
            # only record the hash after the token itself is accepted.
            "token": token_text if should_enroll else "",
            "certificate": certificate,
            "endpoint": endpoint,
        }

        def handle_registered(registered_worker_id: str) -> None:
            self._on_registered(
                locations["worker_id"],
                manifest_path=manifest_path,
                token_hash_path=token_hash_path,
                enrollment_token=accepted_enrollment["token"],
                consumed_token_hash=consumed_token_hash,
                cert_path=locations["pinned_cert"],
                certificate=accepted_enrollment["certificate"],
                endpoint=accepted_enrollment["endpoint"],
                replace_invalid_manifest=replace_invalid_manifest,
            )(registered_worker_id)

        def handle_activated(worker_id: str) -> None:
            # The durability callback runs on a worker thread. Publish only
            # this loop-owned status field once Config proves activation.
            self.endpoint = accepted_enrollment["endpoint"]
            self._on_activated(worker_id)

        client = WorkerClient(
            config,
            execute=executor.execute,
            # Re-probed on every reconnect so a model loaded (or evicted) since
            # the last connection is reported honestly rather than from a
            # snapshot taken at startup.
            capability_probe=lambda: capabilities.discover(include_unavailable=True),
            on_registered=handle_registered,
            on_activated=handle_activated,
            drain_active_work=executor.drain_active_work,
        )
        self._client = client

        async def run_with_legacy_token_recovery() -> None:
            try:
                await client.run_forever()
                return
            except TerminalRegistrationError as exc:
                error_code = str(exc).partition(":")[0].strip()
                if (
                    not legacy_token_fallback
                    or error_code != "AUTH_FAILED"
                ):
                    raise

            # The token looked identical to a legacy spent value, so only a
            # rejected key proves it is worth trying. Verify trust and expiry
            # now, then redeem it once; a second terminal response propagates.
            retry_endpoint, retry_certificate = await asyncio.to_thread(
                _verify_enrollment_token, environment_token
            )
            client.config.endpoint = retry_endpoint
            client.config.certificate_pem = retry_certificate
            # This is a fresh enrollment after the original panel identity was
            # rejected.  Its old id is panel-local and would make recovery of
            # a lost first token response sign the spent-token retry over the
            # wrong identity.
            client.config.worker_id = ""
            client.config.enrollment_token = environment_token
            accepted_enrollment.update(
                token=environment_token,
                certificate=retry_certificate,
                endpoint=retry_endpoint,
            )
            await client.run_forever()

        self._task = asyncio.create_task(
            run_with_legacy_token_recovery(), name="worker-agent"
        )
        self._task.add_done_callback(self._record_task_failure)
        self._idle_sweep = asyncio.create_task(
            self._unload_idle_engines(), name="worker-idle-unload"
        )
        logger.info(
            "Worker agent connecting to %s with %d engine(s)", endpoint, len(discovered)
        )

    def _on_registered(
        self,
        worker_id_path: str,
        *,
        manifest_path: str,
        token_hash_path: str = "",
        enrollment_token: str = "",
        consumed_token_hash: str = "",
        cert_path: str = "",
        certificate: bytes = b"",
        endpoint: str = "",
        replace_invalid_manifest: bool = False,
    ):
        def handle(worker_id) -> None:
            token_hash = _token_hash(enrollment_token) or consumed_token_hash
            enrollment = {
                "endpoint": endpoint.strip(),
                "worker_id": worker_id.strip(),
                "token_hash": token_hash,
                "certificate": certificate,
            }
            # One atomic replace is the source of truth. The compatibility
            # mirrors below may fail independently without creating mixed
            # enrollment state on the next restart.
            try:
                current_enrollment = _load_enrollment_manifest(manifest_path)
            except EnrollmentStateError:
                if not replace_invalid_manifest:
                    raise
                current_enrollment = None
            if current_enrollment != enrollment:
                _save_enrollment_manifest(
                    manifest_path,
                    endpoint=endpoint,
                    certificate=certificate,
                    worker_id=worker_id,
                    token_hash=token_hash,
                )
            if cert_path:
                try:
                    with open(cert_path, "rb") as fh:
                        saved_certificate = fh.read()
                except OSError:
                    saved_certificate = None
                if saved_certificate != certificate:
                    try:
                        _save_pinned_certificate(cert_path, certificate)
                    except OSError:
                        logger.warning(
                            "Could not update the legacy pinned-certificate mirror."
                        )
            if endpoint and _stored_endpoint() != endpoint.strip():
                try:
                    _remember_endpoint(endpoint)
                except Exception:
                    logger.warning("Could not update the legacy endpoint mirror.")
            if load_worker_id(worker_id_path) != worker_id.strip():
                try:
                    save_worker_id(worker_id_path, worker_id)
                except OSError:
                    logger.warning("Could not update the legacy worker-id mirror.")
            if (
                token_hash_path
                and enrollment_token
                and _load_consumed_token_hash(token_hash_path) != token_hash
            ):
                try:
                    _save_consumed_token_hash(token_hash_path, enrollment_token)
                except OSError:
                    logger.warning(
                        "Could not update the legacy enrollment-token mirror."
                    )

        return handle

    def _on_activated(self, _worker_id: str) -> None:
        """The first ConfigUpdate proves Control published this generation."""
        self._registered.set()

    def _record_task_failure(self, task: asyncio.Task) -> None:
        if task.cancelled():
            return
        try:
            error = task.exception()
        except asyncio.CancelledError:
            return
        if error is not None:
            self.last_error = str(error)

    async def wait_until_registered(self, timeout: float = 20.0) -> None:
        """Block until the control plane has activated this worker.

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

    async def _retire_generation(self) -> None:
        client = self._client
        tasks = [task for task in (self._task, self._idle_sweep) if task is not None]
        stop_error: Optional[BaseException] = None
        if client is not None:
            try:
                await client.stop()
            except BaseException as exc:
                stop_error = exc
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._task = None
        self._idle_sweep = None
        self._client = None
        if stop_error is not None:
            raise stop_error

    async def stop(self) -> None:
        await self._retire_generation()


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
            released = await to_thread_and_drain_on_cancel(
                tts_backend.release_idle_engines
            )
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
