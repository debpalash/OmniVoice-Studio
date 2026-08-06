"""Pre-exec validation for bundled / managed executables (issue #1172 class).

Field evidence (#1172, macOS Apple Silicon): a source checkout ships the
zero-byte ``bin/omnivoice-tts-*`` placeholders (real binaries are produced
by CI / bundled by the installer), and the GGUF engine exec'd one anyway —
the request died with a bare ``[Errno 8] Exec format error`` 500. The same
failure shape exists for any managed executable: a truncated download, a
git-lfs pointer checked out without ``git lfs pull``, an HTML error page
saved as a binary, or a half-installed engine venv interpreter.

Contract: every code path that spawns an executable VoiceStudio *manages*
(bundled runtimes in ``bin/``, per-engine venv interpreters, downloaded
tools) validates it here **before** exec, so the failure surfaces as a
typed, user-actionable :class:`InvalidBinaryError` instead of an OSError
errno at spawn time. Routes map :class:`InvalidBinaryError` to 503.

Deliberately dependency-free (stdlib only) so it is importable from
engine packages and services without pulling torch / huggingface_hub.
"""
from __future__ import annotations

from pathlib import Path


class InvalidBinaryError(RuntimeError):
    """A managed executable failed pre-exec validation (missing, empty, or
    not a real executable), or the OS refused to exec it. The message is
    user-actionable; API routes map this to HTTP 503."""

    def __init__(self, path, reason: str, hint: str = ""):
        self.path = Path(path)
        self.reason = reason
        msg = f"{self.path.name}: {reason}"
        if hint:
            msg = f"{msg} — {hint}"
        super().__init__(msg)


#: Magic numbers of every executable container we bundle or manage:
#: ELF (Linux), PE (Windows), Mach-O thin/fat in both byte orders
#: (macOS), and ``#!`` shebang scripts (venv entry points / wrappers).
_EXEC_MAGICS: tuple[bytes, ...] = (
    b"\x7fELF",                                  # Linux ELF
    b"MZ",                                       # Windows PE
    b"\xfe\xed\xfa\xce", b"\xfe\xed\xfa\xcf",    # Mach-O 32/64 BE
    b"\xce\xfa\xed\xfe", b"\xcf\xfa\xed\xfe",    # Mach-O 32/64 LE
    b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca",    # Mach-O universal (fat)
    b"#!",                                       # shebang script
)

_LFS_POINTER_PREFIX = b"version https://git-lfs"


def looks_like_executable(path) -> tuple[bool, str]:
    """Return ``(ok, reason)`` — never raises.

    Checks the file exists, is non-empty, and starts with a known
    executable magic. This is placeholder/corruption detection, not
    architecture validation: a binary for the wrong OS/arch still fails at
    spawn, which callers convert to :class:`InvalidBinaryError` too.
    """
    p = Path(path)
    try:
        if not p.is_file():
            return False, "file is missing"
        if p.stat().st_size == 0:
            return False, "file is empty (0 bytes) — a placeholder, not a real binary"
        with p.open("rb") as f:
            head = f.read(64)
    except OSError as exc:
        return False, f"file is unreadable ({exc})"
    if not head.startswith(_EXEC_MAGICS):
        if head.startswith(_LFS_POINTER_PREFIX):
            return False, (
                "file is a git-lfs pointer, not the binary itself — "
                "run `git lfs pull`"
            )
        return False, (
            "file is not a recognized executable (Mach-O/ELF/PE/script) — "
            "likely a truncated or corrupt download"
        )
    return True, "ok"


def validate_executable(path, *, hint: str = "") -> None:
    """Raise :class:`InvalidBinaryError` unless *path* looks like a real
    executable. ``hint`` is appended to the message and should tell the
    user what to do (reinstall / rebuild / re-download)."""
    ok, reason = looks_like_executable(path)
    if not ok:
        raise InvalidBinaryError(path, reason, hint)
