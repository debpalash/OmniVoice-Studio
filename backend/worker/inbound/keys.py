"""Per-panel API keys for inbound mode, and the throttle that protects them.

One key per panel, never one key for the node. A single shared key means
revoking one person kicks everybody and forces a re-paste on every machine, so
in practice nobody revokes and the credential outlives the reason it was
issued. Per-key costs nothing extra at issue time and is painful to retrofit,
because a shared key leaves no record of who used it.

Keys issued by this node are stored hashed. The plaintext exists exactly once,
in the response to the issuing call, and is unrecoverable afterwards — the node
cannot show a key again later, only replace it. Keys pasted into this panel for
outbound reconnection live in the same machine-local 0600 file, never in the UI
settings store.
"""

from __future__ import annotations

import errno
import json
import logging
import os
import secrets
import threading
import time
from dataclasses import asdict, dataclass
from typing import Optional

from worker.identity import constant_time_equals, hash_secret

logger = logging.getLogger(__name__)

# Distinguishes an inbound panel key from the `ovw_` enrollment token used by
# outbound mode. They are never interchangeable and the prefix makes a
# pasted-the-wrong-one mistake diagnosable instead of just "invalid".
KEY_PREFIX = "ovnode_"

# 32 bytes. The same size as the enrollment-token secret, and the reason
# `hash_secret` may be a plain SHA-256 rather than a password KDF.
_KEY_BYTES = 32

# Failed-auth throttle. A key is a bearer credential with no second factor, so
# the only thing standing between a LAN attacker and unlimited guesses is this.
# The window is per source address: one panel typing a stale key must not lock
# out a different panel with a good one.
_MAX_FAILURES = 5
_LOCKOUT_SECONDS = 60.0
_FAILURE_WINDOW_SECONDS = 300.0

# ``Attach`` is the only RPC that records presence.  Persisting on every
# reconnect lets an authenticated peer turn harmless telemetry into an fsync
# storm on the gRPC event loop, so coalesce it to a useful reporting cadence.
_LAST_SEEN_PERSIST_INTERVAL_SECONDS = 60.0

# Authentication deliberately scans every stored hash in constant time. Keep
# that work and the JSON credential file bounded even if an administrator
# repeatedly issues replacements.
MAX_PANEL_KEYS = 256


class KeyLimitExceeded(RuntimeError):
    """No additional panel credential can be retained safely."""


@dataclass
class PanelKey:
    """One panel's admission credential. The secret itself is not in here."""

    key_id: str
    label: str
    secret_hash: str
    created_at: float
    last_seen_at: float = 0.0
    last_seen_peer: str = ""
    revoked: bool = False
    # The id THIS panel assigned to this node. One per key, not one per node:
    # every panel keeps its own registry, so the same machine is a different
    # worker id to each of them. Persisted because the node signs its challenge
    # over the id, so a node that forgets it can never authenticate again —
    # the inbound equivalent of the worker-id file outbound keeps.
    worker_id: str = ""

    def public(self) -> dict:
        """The shape the UI sees. Deliberately has no field for the secret."""
        data = asdict(self)
        data.pop("secret_hash")
        return data


@dataclass
class _Failures:
    count: int = 0
    first_at: float = 0.0
    locked_until: float = 0.0


def _peer_host(peer: str) -> str:
    """Strip the ephemeral source port used by gRPC from a peer address."""
    if peer.startswith("["):
        closing = peer.find("]")
        if closing != -1:
            return peer[: closing + 1]
    if peer.count(":") == 1:
        return peer.rsplit(":", 1)[0]
    return peer


def _fsync_parent_directory(directory: str) -> None:
    """Make a preceding directory-entry replacement durable when supported."""
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


@dataclass
class IssuedKey:
    """The one and only time the plaintext exists outside the caller's hands."""

    key: PanelKey
    secret: str


class KeyStore:
    """Thread-safe, file-backed store of per-panel keys.

    Backed by a plain JSON file rather than the settings store because the
    settings store is read by the UI process and synced into places a
    credential hash has no business being.
    """

    def __init__(self, path: str, *, now: Optional[callable] = None) -> None:
        self._path = path
        self._now = now or time.time
        self._lock = threading.Lock()
        self._keys: dict[str, PanelKey] = {}
        self._connection_secrets: dict[str, str] = {}
        self._connection_fingerprints: dict[str, str] = {}
        self._failures: dict[str, _Failures] = {}
        # A failed persistence attempt must remain denied in this process but
        # still be retryable.  Keeping this separate from PanelKey.revoked lets
        # the next DELETE attempt write the durable transition again.
        self._pending_revocations: set[str] = set()
        self._load()

    # ── Persistence ───────────────────────────────────────────────────────

    def _load(self) -> None:
        try:
            with open(self._path, encoding="utf-8") as fh:
                raw = json.load(fh)
        except (FileNotFoundError, PermissionError):
            return
        except (json.JSONDecodeError, UnicodeDecodeError):
            # A corrupt file must not take the node down, but it must also not
            # silently become "no keys configured" — that reads to the user as
            # "my keys vanished" with no cause anywhere.
            logger.error(
                "The inbound key file at %s is unreadable and was ignored. "
                "Existing panels cannot connect until a key is re-issued.",
                self._path,
            )
            return
        for entry in raw.get("keys", []):
            try:
                key = PanelKey(**entry)
            except TypeError:
                continue
            self._keys[key.key_id] = key
        connections = raw.get("connection_secrets", {})
        if isinstance(connections, dict):
            self._connection_secrets = {
                str(endpoint): str(secret)
                for endpoint, secret in connections.items()
                if endpoint and secret
            }
        fingerprints = raw.get("connection_fingerprints", {})
        if isinstance(fingerprints, dict):
            self._connection_fingerprints = {
                str(endpoint): str(fingerprint)
                for endpoint, fingerprint in fingerprints.items()
                if endpoint and fingerprint
            }

    def _save_locked(self) -> None:
        directory = os.path.dirname(os.path.abspath(self._path))
        os.makedirs(directory, exist_ok=True)
        payload = json.dumps(
            {
                "keys": [asdict(k) for k in self._keys.values()],
                "connection_secrets": self._connection_secrets,
                "connection_fingerprints": self._connection_fingerprints,
            },
            indent=2,
        ).encode("utf-8")
        tmp = f"{self._path}.tmp"
        # 0600 from creation, never a world-readable moment — the same idiom
        # `identity.save_worker_key` uses for the Ed25519 private key.
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            remaining = memoryview(payload)
            while remaining:
                written = os.write(fd, remaining)
                if written <= 0:
                    raise OSError("could not finish writing the inbound key file")
                remaining = remaining[written:]
            os.fsync(fd)
        except Exception:
            os.close(fd)
            try:
                os.unlink(tmp)
            except FileNotFoundError:
                pass
            raise
        else:
            os.close(fd)
        try:
            os.replace(tmp, self._path)
        except Exception:
            try:
                os.unlink(tmp)
            except FileNotFoundError:
                pass
            raise
        _fsync_parent_directory(directory)
        try:
            os.chmod(self._path, 0o600)
        except OSError:
            # Windows and some network filesystems do not honour POSIX modes.
            pass

    # ── Issue and revoke ──────────────────────────────────────────────────

    def issue(self, label: str) -> IssuedKey:
        """Mint a key for one panel. The secret is returned exactly once."""
        secret = KEY_PREFIX + secrets.token_urlsafe(_KEY_BYTES)
        now = self._now()
        key = PanelKey(
            # Derived from the secret's hash, not from a counter: it identifies
            # the key in logs without being a second thing to store, and cannot
            # be used to reconstruct the secret.
            key_id=hash_secret(secret)[:12],
            label=label.strip() or "Panel",
            secret_hash=hash_secret(secret),
            created_at=now,
        )
        with self._lock:
            previous = self._keys.get(key.key_id)
            pruned: dict[str, PanelKey] = {}
            if previous is None and len(self._keys) >= MAX_PANEL_KEYS:
                revoked = sorted(
                    (
                        stored
                        for stored in self._keys.values()
                        if stored.revoked
                        and stored.key_id not in self._pending_revocations
                    ),
                    key=lambda stored: stored.created_at,
                )
                while len(self._keys) >= MAX_PANEL_KEYS and revoked:
                    stale = revoked.pop(0)
                    pruned[stale.key_id] = self._keys.pop(stale.key_id)
                if len(self._keys) >= MAX_PANEL_KEYS:
                    self._keys.update(pruned)
                    raise KeyLimitExceeded(
                        "This GPU machine already has as many panel keys as it accepts. "
                        "Revoke an unused key, then try again."
                    )
            self._keys[key.key_id] = key
            try:
                self._save_locked()
            except Exception:
                if previous is None:
                    self._keys.pop(key.key_id, None)
                else:
                    self._keys[key.key_id] = previous
                self._keys.update(pruned)
                raise
        return IssuedKey(key=key, secret=secret)

    def revoke(self, key_id: str) -> bool:
        """Revoke one panel's key. Others keep working — that is the point."""
        with self._lock:
            key = self._keys.get(key_id)
            if key is None or key.revoked:
                return False
            self._pending_revocations.add(key_id)
            key.revoked = True
            try:
                self._save_locked()
            except Exception:
                key.revoked = False
                raise
            self._pending_revocations.discard(key_id)
        return True

    def remember_worker_id(self, key_id: str, worker_id: str) -> None:
        """Record the id a panel assigned, so the next reconnect can sign for it."""
        if not worker_id:
            return
        with self._lock:
            key = self._keys.get(key_id)
            if (
                key is None
                or key.revoked
                or key_id in self._pending_revocations
            ):
                raise PermissionError("the panel key was revoked during registration")
            if key.worker_id == worker_id:
                return
            previous_worker_id = key.worker_id
            key.worker_id = worker_id
            try:
                self._save_locked()
            except Exception:
                # A callback retry must attempt the durable write again. If
                # the failed value remains in memory, the equality fast path
                # above accepts it as saved and the node reconnects with an id
                # that disappears on process restart.
                key.worker_id = previous_worker_id
                raise

    def worker_id_for(self, key_id: str) -> str:
        with self._lock:
            key = self._keys.get(key_id)
            return (
                key.worker_id
                if key is not None
                and not key.revoked
                and key_id not in self._pending_revocations
                else ""
            )

    def is_active(self, key_id: str) -> bool:
        """Whether this key still has authority to use an existing session."""
        with self._lock:
            key = self._keys.get(key_id)
            return (
                key is not None
                and not key.revoked
                and key_id not in self._pending_revocations
            )

    def list_keys(self) -> list[dict]:
        with self._lock:
            return [k.public() for k in sorted(self._keys.values(), key=lambda k: k.created_at)]

    def any_active(self) -> bool:
        with self._lock:
            return any(
                not key.revoked and key.key_id not in self._pending_revocations
                for key in self._keys.values()
            )

    # ── Panel-side connection credentials ───────────────────────────────

    def remember_connection_secret(
        self, endpoint: str, secret: str, fingerprint: str = ""
    ) -> None:
        """Persist a pasted node secret outside the UI-readable settings store."""
        with self._lock:
            previous_secret = self._connection_secrets.get(endpoint)
            previous_fingerprint = self._connection_fingerprints.get(endpoint)
            self._connection_secrets[endpoint] = secret
            if fingerprint:
                self._connection_fingerprints[endpoint] = fingerprint
            try:
                self._save_locked()
            except Exception:
                if previous_secret is None:
                    self._connection_secrets.pop(endpoint, None)
                else:
                    self._connection_secrets[endpoint] = previous_secret
                if previous_fingerprint is None:
                    self._connection_fingerprints.pop(endpoint, None)
                else:
                    self._connection_fingerprints[endpoint] = previous_fingerprint
                raise

    def connection_secret(self, endpoint: str) -> str:
        with self._lock:
            return self._connection_secrets.get(endpoint, "")

    def connection_fingerprint(self, endpoint: str) -> str:
        with self._lock:
            return self._connection_fingerprints.get(endpoint, "")

    def forget_connection_secret(self, endpoint: str) -> None:
        with self._lock:
            previous_secret = self._connection_secrets.get(endpoint)
            if previous_secret is None:
                return
            previous_fingerprint = self._connection_fingerprints.get(endpoint)
            self._connection_secrets.pop(endpoint, None)
            self._connection_fingerprints.pop(endpoint, None)
            try:
                self._save_locked()
            except Exception:
                self._connection_secrets[endpoint] = previous_secret
                if previous_fingerprint is not None:
                    self._connection_fingerprints[endpoint] = previous_fingerprint
                raise

    # ── Authentication ────────────────────────────────────────────────────

    def locked_out(self, peer: str) -> bool:
        peer = _peer_host(peer)
        with self._lock:
            record = self._failures.get(peer)
            return record is not None and record.locked_until > self._now()

    def authenticate(
        self, secret: str, *, peer: str = "", record_seen: bool = True
    ) -> Optional[PanelKey]:
        """Return the matching live key, or None.

        Compares against every stored key in constant time and does not stop at
        the first match. Short-circuiting would make the reply time a function
        of how many keys are configured and which one matched — a slow oracle,
        but an oracle.
        """
        now = self._now()
        peer_host = _peer_host(peer)
        with self._lock:
            record = self._failures.get(peer_host)
            if record is not None and record.locked_until > now:
                return None

            candidate = hash_secret(secret) if secret else ""
            matched: Optional[PanelKey] = None
            for key in self._keys.values():
                if (
                    key.revoked
                    or key.key_id in self._pending_revocations
                    or not candidate
                ):
                    continue
                if constant_time_equals(key.secret_hash, candidate):
                    matched = key

            if matched is None:
                self._record_failure_locked(peer_host, now)
                return None

            self._failures.pop(peer_host, None)
            if record_seen and (
                matched.last_seen_at <= 0.0
                or now - matched.last_seen_at
                >= _LAST_SEEN_PERSIST_INTERVAL_SECONDS
            ):
                previous_at = matched.last_seen_at
                previous_peer = matched.last_seen_peer
                matched.last_seen_at = now
                matched.last_seen_peer = peer
                try:
                    self._save_locked()
                except Exception:
                    matched.last_seen_at = previous_at
                    matched.last_seen_peer = previous_peer
                    raise
            return matched

    def _record_failure_locked(self, peer: str, now: float) -> None:
        peer = _peer_host(peer)
        record = self._failures.get(peer)
        if record is None or now - record.first_at > _FAILURE_WINDOW_SECONDS:
            record = _Failures(count=0, first_at=now)
            self._failures[peer] = record
        record.count += 1
        if record.count >= _MAX_FAILURES:
            record.locked_until = now + _LOCKOUT_SECONDS
            logger.warning(
                "Refusing inbound connections from %s for %.0fs after %d failed keys.",
                peer or "an unknown address",
                _LOCKOUT_SECONDS,
                record.count,
            )
