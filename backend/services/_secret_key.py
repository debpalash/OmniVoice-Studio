"""Per-install Fernet key derivation for the encrypted settings store.

Threat T-01-01 mitigation: the HF token in `settings.value` (key='hf_token')
is encrypted with Fernet. The Fernet key is derived via scrypt from:

  - OS machine identifier (platform-specific lookup, falls back to
    hostname+user if unavailable)
  - A 16-byte random salt persisted in the same `settings` table as row
    `_secret_key_salt`

The key is **not** at-rest portable: copying `omnivoice.db` to another
machine will produce a Fernet that can't decrypt the existing token row
(machine-id changed). `settings_store.get_hf_token()` handles this by
logging a warning and returning None, after which the resolver falls
through to env / HF-CLI naturally — see Open Question #5 in 01-RESEARCH.md.

We do not use OS keyring (Capability 1 / Keyring deferred — see
STATE Key Decision #5).
"""
from __future__ import annotations

import base64
import getpass
import logging
import os
import socket
import subprocess
import sys
import threading
import time

logger = logging.getLogger("omnivoice.secret_key")

_KEY_CACHE: bytes | None = None
_CACHE_LOCK = threading.Lock()

_SALT_KEY = "_secret_key_salt"
_SALT_BYTES = 16

# scrypt parameters per cryptography docs + Pitfall #5 in RESEARCH.md.
# n=2**14 is the lowest "interactive" cost that still resists offline
# brute-force on a leaked DB. r=8, p=1 are the OWASP-recommended defaults
# for password storage; we use them for KDF here since the input
# (machine-id) is similarly low-entropy.
_SCRYPT_N = 2**14
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_KEYLEN = 32  # Fernet requires a 32-byte key, base64-encoded


def _read_machine_id() -> bytes:
    """Best-effort cross-platform machine identifier.

    Per RESEARCH.md Pattern 3:
      - macOS: parse `ioreg -rd1 -c IOPlatformExpertDevice` for IOPlatformUUID
      - Linux: read /etc/machine-id (fallback /var/lib/dbus/machine-id)
      - Windows: read HKLM\\SOFTWARE\\Microsoft\\Cryptography MachineGuid via winreg
      - Final fallback: hostname + login user (warn-logged once)
    """
    plat = sys.platform
    try:
        if plat == "darwin":
            out = subprocess.check_output(
                ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
                stderr=subprocess.DEVNULL,
                timeout=5,
            ).decode("utf-8", errors="replace")
            for line in out.splitlines():
                if "IOPlatformUUID" in line:
                    # Format: `    "IOPlatformUUID" = "abc-def..."`
                    parts = line.split("=", 1)
                    if len(parts) == 2:
                        uuid = parts[1].strip().strip('"').strip()
                        if uuid:
                            return uuid.encode("utf-8")
        elif plat.startswith("linux"):
            for path in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
                if os.path.isfile(path):
                    with open(path, "r") as f:
                        mid = f.read().strip()
                    if mid:
                        return mid.encode("utf-8")
        elif plat.startswith("win"):
            import winreg  # type: ignore[import-not-found]
            try:
                key = winreg.OpenKey(
                    winreg.HKEY_LOCAL_MACHINE,
                    r"SOFTWARE\Microsoft\Cryptography",
                )
                try:
                    val, _ = winreg.QueryValueEx(key, "MachineGuid")
                    if val:
                        return str(val).encode("utf-8")
                finally:
                    winreg.CloseKey(key)
            except OSError:
                pass
    except (subprocess.SubprocessError, OSError, ValueError) as exc:
        logger.debug("machine-id primary lookup failed: %s", exc)

    # Fallback: hostname + login user. Documented limitation — same user on
    # same hostname across two machines (unusual) would share an encryption
    # key. The settings_store warn-log on InvalidToken covers that case.
    logger.warning(
        "Could not read OS machine-id; falling back to hostname+user. "
        "If you migrate omnivoice_data/ across machines, the saved HF "
        "token won't decrypt and the resolver will fall back to env/HF-CLI."
    )
    fallback = f"{socket.gethostname()}::{getpass.getuser()}"
    return fallback.encode("utf-8")


def _load_or_create_salt() -> bytes:
    """Read the persisted salt row, or create one on first call."""
    # Local import — avoids circular import at module load (settings_store
    # imports _secret_key, _secret_key reads the settings table directly).
    from core.db import db_conn

    with db_conn() as conn:
        row = conn.execute(
            "SELECT value FROM settings WHERE key = ?", (_SALT_KEY,)
        ).fetchone()
        if row is not None and row[0]:
            try:
                return base64.b64decode(row[0])
            except (ValueError, TypeError):
                logger.warning("Persisted salt is corrupt; regenerating.")
        # Generate + persist.
        salt = os.urandom(_SALT_BYTES)
        conn.execute(
            "INSERT OR REPLACE INTO settings(key, value, updated_at) "
            "VALUES (?, ?, ?)",
            (_SALT_KEY, base64.b64encode(salt).decode("ascii"), time.time()),
        )
    return salt


def derive_fernet_key() -> bytes:
    """Return a 32-byte base64 Fernet key derived from machine-id + per-install salt.

    The result is cached in a module-level variable so repeat calls during a
    single backend session don't re-run scrypt (~tens of milliseconds each).
    Call `invalidate()` from tests to force re-derivation.
    """
    global _KEY_CACHE
    with _CACHE_LOCK:
        if _KEY_CACHE is not None:
            return _KEY_CACHE

        # Local imports — keeps cryptography out of import-time chains that
        # might run before the dep is installed (e.g. setup tooling).
        from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

        salt = _load_or_create_salt()
        machine_id = _read_machine_id()
        kdf = Scrypt(
            salt=salt,
            length=_SCRYPT_KEYLEN,
            n=_SCRYPT_N,
            r=_SCRYPT_R,
            p=_SCRYPT_P,
        )
        raw = kdf.derive(machine_id)
        _KEY_CACHE = base64.urlsafe_b64encode(raw)
        return _KEY_CACHE


def invalidate() -> None:
    """Drop the cached key. Tests call this before changing the salt or
    machine-id env to force the next derive_fernet_key() to re-run scrypt."""
    global _KEY_CACHE
    with _CACHE_LOCK:
        _KEY_CACHE = None
