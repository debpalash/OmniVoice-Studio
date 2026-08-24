"""TLS for a control plane that lives on someone's desktop.

The awkward fact the goal doc skipped: the OSS control server is a laptop. It
has no domain name, no publicly-valid certificate, and its IP changes. "All
remote communication must use TLS" is easy to write and, stated that way,
unimplementable — which in practice means somebody adds an
``insecure_skip_verify`` flag and the whole thing becomes theatre, because on a
café network that flag *is* the attack.

So the trust anchor is the enrollment token, not the public CA system. The
control plane generates a self-signed certificate once and keeps it; the token
the user copies carries that certificate's fingerprint; the worker pins it on
first connect and refuses anything else afterwards. This is the join-token
pattern from k3s and Tailscale, and it gives a desktop the same practical
security a real CA would, without asking the user to run one.

There is deliberately no way to disable verification.
"""

from __future__ import annotations

import datetime as _dt
import errno
import ipaddress
import logging
import os
import socket
import ssl
import tempfile
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Optional

from cryptography import x509
from cryptography.exceptions import InvalidSignature, UnsupportedAlgorithm
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from worker.identity import certificate_fingerprint

logger = logging.getLogger("omnivoice.worker")

_CERT_VALID_DAYS = 825  # the CA/Browser Forum maximum; long enough to be quiet
_RENEW_WITHIN_DAYS = 30
_PENDING_PAIR_MAGIC = b"omnivoice-tls-pair-v1\n"
_PROCESS_CREDENTIAL_LOCK = threading.Lock()


def unverified_client_context() -> ssl.SSLContext:
    """Build the pin-bootstrap context without permitting legacy TLS."""
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return context


@dataclass(frozen=True)
class ServerCredentials:
    """A control plane's certificate and its pinnable fingerprint."""

    certificate_pem: bytes
    private_key_pem: bytes
    certificate_der: bytes

    @property
    def fingerprint(self) -> str:
        return certificate_fingerprint(self.certificate_der)


def _san_entries(hostnames: list[str]) -> list[x509.GeneralName]:
    """Cover every address a worker might legitimately dial.

    A tailnet name, a LAN hostname, and a bare IP are all normal ways to reach
    a desktop, and a certificate that only names one of them fails as soon as
    the user's network changes shape.
    """
    entries: list[x509.GeneralName] = []
    for host in hostnames:
        host = _normalise_host(host)
        if not host:
            continue
        try:
            entries.append(x509.IPAddress(ipaddress.ip_address(host)))
        except ValueError:
            entries.append(x509.DNSName(host))
    if not entries:
        entries.append(x509.DNSName("localhost"))
    return entries


def primary_ip() -> str:
    """This host's address on the route to the outside world.

    Opening a UDP socket sends no packets — it only makes the kernel choose a
    source address, which is exactly the one a worker on the LAN would reach us
    on. Enumerating interfaces instead would leave us guessing between docker0,
    a VPN, and the real NIC.
    """
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # TEST-NET-1 (RFC 5737): reserved, never routed, never contacted.
        probe.connect(("192.0.2.1", 9))
        return probe.getsockname()[0]
    except OSError:
        return ""
    finally:
        probe.close()


def covers(credentials: "ServerCredentials", host: str) -> bool:
    """Does this certificate actually name ``host``?

    Used to regenerate when the machine's address changes — a laptop that moved
    networks otherwise keeps a certificate no worker can validate.
    """
    if not host:
        return True
    try:
        certificate = x509.load_der_x509_certificate(credentials.certificate_der)
        san = certificate.extensions.get_extension_for_class(
            x509.SubjectAlternativeName
        ).value
    except Exception:
        return False
    names = {_normalise_host(name) for name in san.get_values_for_type(x509.DNSName)}
    names |= {
        _normalise_host(str(ip)) for ip in san.get_values_for_type(x509.IPAddress)
    }
    return _normalise_host(host) in names


def _normalise_host(host: str) -> str:
    """Canonicalise a SAN identity for comparison, not for DNS resolution."""
    candidate = (host or "").strip().strip("[]")
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        # DNS names are case-insensitive, and a trailing root dot does not
        # name a different host. cryptography intentionally does no matching
        # for us because the certificate is its own trust root.
        return candidate.rstrip(".").lower()


def default_hostnames() -> list[str]:
    """Best-effort local identities, deduplicated and order-stable.

    The routable IP matters as much as the names: gRPC resolves through c-ares,
    which does NOT speak mDNS, so a macOS ``host.local`` that Python resolves
    happily is unreachable to a worker. Whatever we advertise must appear here
    or TLS verification fails on the name.
    """
    names = ["localhost", "127.0.0.1", "::1"]
    address = primary_ip()
    if address:
        names.append(address)
    try:
        hostname = socket.gethostname()
        if hostname:
            names.append(hostname)
            # A tailnet or mDNS name is the realistic way a worker reaches a
            # laptop that has no fixed address. macOS already reports the
            # hostname WITH the .local suffix, so only add it when absent —
            # otherwise the SAN carries a bogus "host.local.local".
            if "." not in hostname:
                names.append(f"{hostname}.local")
    except OSError:
        pass
    seen: set[str] = set()
    return [n for n in names if not (n in seen or seen.add(n))]


def generate_self_signed(
    *, hostnames: Optional[list[str]] = None, now: Optional[_dt.datetime] = None
) -> ServerCredentials:
    """Mint the control plane's certificate.

    EC P-256 rather than RSA: far faster to generate, which matters because
    this runs on first launch while the user is waiting.
    """
    stamp = now or _dt.datetime.now(_dt.timezone.utc)
    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, "OmniVoice Control Plane"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "OmniVoice Studio"),
        ]
    )
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(stamp - _dt.timedelta(minutes=5))  # tolerate clock skew
        .not_valid_after(stamp + _dt.timedelta(days=_CERT_VALID_DAYS))
        .add_extension(
            x509.SubjectAlternativeName(_san_entries(hostnames or default_hostnames())),
            critical=False,
        )
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.ExtendedKeyUsage([x509.ExtendedKeyUsageOID.SERVER_AUTH]),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    return ServerCredentials(
        certificate_pem=certificate.public_bytes(serialization.Encoding.PEM),
        private_key_pem=key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ),
        certificate_der=certificate.public_bytes(serialization.Encoding.DER),
    )


def load_or_create(
    cert_path: str, key_path: str, *, hostnames: Optional[list[str]] = None
) -> ServerCredentials:
    """Return the stored certificate, regenerating it if absent or expiring.

    Renewing early matters more here than usual: an expired certificate on a
    desktop control plane presents as "my workers all went offline" with
    nothing in the UI explaining why.
    """
    with _credential_lock(cert_path):
        existing = _load(cert_path, key_path)
        pending_present, pending = _load_pending_pair(cert_path, key_path)
        if existing is not None and pending_present:
            # A valid final pair is either the old generation (the transaction
            # never began replacing it) or the fully committed new one. Both
            # are safer than rotating a pin merely because cleanup was cut
            # short. The lock makes it safe to remove the stale journal here.
            _remove_pending_pair(cert_path, key_path)
        elif existing is None and pending is not None:
            logger.warning(
                "Recovering an interrupted control-plane TLS credential update."
            )
            _install_pair(cert_path, key_path, pending)
            _remove_pending_pair(cert_path, key_path)
            existing = pending

        wanted = hostnames or default_hostnames()
        # Every explicitly requested identity must be present. This matters for
        # a listener bound to a user-entered address: keeping a stable
        # certificate that does not name it makes mandatory hostname
        # verification fail even though its fingerprint is correct.
        missing = [
            host
            for host in wanted
            if existing is not None and not covers(existing, host)
        ]
        if existing is not None and not _expiring_soon(existing) and not missing:
            return existing
        if existing is not None:
            reason = (
                "expiring"
                if _expiring_soon(existing)
                else "missing a requested hostname"
            )
            logger.info("Control-plane certificate is %s — regenerating.", reason)
        elif pending_present and pending is None:
            logger.warning(
                "Ignoring a corrupt interrupted TLS credential update and "
                "generating a new pair."
            )
        credentials = generate_self_signed(hostnames=wanted)
        _save(cert_path, key_path, credentials)
        return credentials


def _load(cert_path: str, key_path: str) -> Optional[ServerCredentials]:
    try:
        with open(cert_path, "rb") as fh:
            cert_pem = fh.read()
        with open(key_path, "rb") as fh:
            key_pem = fh.read()
    except FileNotFoundError:
        return None
    return _credentials_from_pem(cert_pem, key_pem)


def _credentials_from_pem(
    cert_pem: bytes, key_pem: bytes
) -> Optional[ServerCredentials]:
    """Parse a credential pair only when the private key belongs to the cert."""
    try:
        certificate = x509.load_pem_x509_certificate(cert_pem)
        private_key = serialization.load_pem_private_key(key_pem, password=None)
        certificate_public_key = certificate.public_key().public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        private_public_key = private_key.public_key().public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        certificate.public_key().verify(
            certificate.signature,
            certificate.tbs_certificate_bytes,
            ec.ECDSA(certificate.signature_hash_algorithm),
        )
    except (
        AttributeError,
        InvalidSignature,
        TypeError,
        UnsupportedAlgorithm,
        ValueError,
    ):
        return None
    if certificate_public_key != private_public_key:
        return None
    return ServerCredentials(
        certificate_pem=cert_pem,
        private_key_pem=key_pem,
        certificate_der=certificate.public_bytes(serialization.Encoding.DER),
    )


def _expiring_soon(
    credentials: ServerCredentials, *, now: Optional[_dt.datetime] = None
) -> bool:
    certificate = x509.load_der_x509_certificate(credentials.certificate_der)
    stamp = now or _dt.datetime.now(_dt.timezone.utc)
    expires = getattr(certificate, "not_valid_after_utc", None)
    if expires is None:  # cryptography 41 and older
        expires = certificate.not_valid_after.replace(tzinfo=_dt.timezone.utc)
    return (expires - stamp) < _dt.timedelta(days=_RENEW_WITHIN_DAYS)


def _save(cert_path: str, key_path: str, credentials: ServerCredentials) -> None:
    """Durably replace a pair, leaving enough state to finish after a crash.

    No filesystem atomically renames two independent paths. A mode-0600
    journal is therefore made durable first; the loader uses it only when the
    final paths are torn or corrupt. Each final path is itself an atomic
    sibling rename, and the journal is removed only after both directory
    entries and their contents are durable.
    """
    pending_path = _pending_pair_path(cert_path, key_path)
    _atomic_write(pending_path, _encode_pending_pair(credentials))
    _install_pair(cert_path, key_path, credentials)
    _remove_pending_pair(cert_path, key_path)


def _install_pair(
    cert_path: str, key_path: str, credentials: ServerCredentials
) -> None:
    # Key first, certificate second: the public certificate is the commit
    # marker. A crash between them is detected by _load and recovered from the
    # already-durable pending pair.
    _atomic_write(key_path, credentials.private_key_pem)
    try:
        os.chmod(key_path, 0o600)
    except OSError:
        # Windows and some network filesystems do not honour POSIX modes; the
        # key remains in the app's per-user data directory there.
        pass
    _atomic_write(cert_path, credentials.certificate_pem)
    installed = _load(cert_path, key_path)
    if installed is None or installed.fingerprint != credentials.fingerprint:
        raise OSError("TLS credential pair failed verification after persistence")


def _atomic_write(path: str, payload: bytes) -> None:
    """Fsync and atomically replace one mode-restricted credential file."""
    directory = os.path.dirname(os.path.abspath(path))
    _durable_makedirs(directory)
    fd, temporary = tempfile.mkstemp(
        prefix=f".{os.path.basename(path)}.", suffix=".tmp", dir=directory
    )
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(temporary, path)
        _fsync_parent_directory(directory)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def _pending_pair_path(cert_path: str, key_path: str) -> str:
    cert_name = os.path.basename(cert_path)
    key_name = os.path.basename(key_path)
    directory = os.path.dirname(os.path.abspath(cert_path))
    return os.path.join(directory, f".{cert_name}.{key_name}.pending")


def _encode_pending_pair(credentials: ServerCredentials) -> bytes:
    certificate = credentials.certificate_pem
    return (
        _PENDING_PAIR_MAGIC
        + str(len(certificate)).encode("ascii")
        + b"\n"
        + certificate
        + credentials.private_key_pem
    )


def _load_pending_pair(
    cert_path: str, key_path: str
) -> tuple[bool, Optional[ServerCredentials]]:
    path = _pending_pair_path(cert_path, key_path)
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except FileNotFoundError:
        return False, None
    if not raw.startswith(_PENDING_PAIR_MAGIC):
        return True, None
    size_line, separator, payload = raw[len(_PENDING_PAIR_MAGIC) :].partition(b"\n")
    if not separator:
        return True, None
    try:
        certificate_size = int(size_line)
    except ValueError:
        return True, None
    if certificate_size <= 0 or certificate_size >= len(payload):
        return True, None
    return True, _credentials_from_pem(
        payload[:certificate_size], payload[certificate_size:]
    )


def _remove_pending_pair(cert_path: str, key_path: str) -> None:
    path = _pending_pair_path(cert_path, key_path)
    try:
        os.unlink(path)
    except FileNotFoundError:
        return
    _fsync_parent_directory(os.path.dirname(path) or ".")


def _fsync_parent_directory(directory: str) -> None:
    """Make a preceding directory-entry change durable where supported."""
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


def _durable_makedirs(directory: str) -> None:
    """Persist every newly-created credential-directory entry."""
    target = os.path.abspath(directory)
    missing: list[str] = []
    current = target
    while not os.path.isdir(current):
        if os.path.exists(current):
            if os.path.isdir(current):
                break
            raise NotADirectoryError(current)
        missing.append(current)
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent

    for path in reversed(missing):
        try:
            os.mkdir(path)
        except FileExistsError:
            if not os.path.isdir(path):
                raise
        _fsync_parent_directory(os.path.dirname(path) or ".")

    if not missing:
        # Retry the exact barrier that may have failed after a prior mkdir.
        _fsync_parent_directory(os.path.dirname(target) or ".")


@contextmanager
def _credential_lock(cert_path: str) -> Iterator[None]:
    """Serialise first-start/renewal across threads and app processes."""
    directory = os.path.dirname(os.path.abspath(cert_path))
    _durable_makedirs(directory)
    lock_path = os.path.join(directory, f".{os.path.basename(cert_path)}.lock")
    with _PROCESS_CREDENTIAL_LOCK:
        descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        is_windows = os.name == "nt"
        acquired = False
        try:
            if is_windows:
                import msvcrt  # noqa: PLC0415

                if os.fstat(descriptor).st_size == 0:
                    os.write(descriptor, b"\0")
                    os.fsync(descriptor)
                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_LOCK, 1)
            else:
                import fcntl  # noqa: PLC0415

                fcntl.flock(descriptor, fcntl.LOCK_EX)
            acquired = True
            yield
        finally:
            try:
                if acquired and is_windows:
                    import msvcrt  # noqa: PLC0415

                    os.lseek(descriptor, 0, os.SEEK_SET)
                    msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
                elif acquired:
                    import fcntl  # noqa: PLC0415

                    fcntl.flock(descriptor, fcntl.LOCK_UN)
            finally:
                os.close(descriptor)


def pin_matches(certificate_der: bytes, expected_fingerprint: str) -> bool:
    """Constant-time-ish comparison of a presented certificate against a pin."""
    import hmac  # noqa: PLC0415 — trivial, keeps the module import light

    return hmac.compare_digest(
        certificate_fingerprint(certificate_der).lower(),
        (expected_fingerprint or "").lower(),
    )


__all__ = [
    "ServerCredentials",
    "covers",
    "default_hostnames",
    "primary_ip",
    "generate_self_signed",
    "load_or_create",
    "pin_matches",
]
