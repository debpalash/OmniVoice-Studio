"""Terminate a desktop-contained backend when its owning shell disappears."""
from __future__ import annotations

import os
import sys
import threading
from typing import BinaryIO, Callable


def _watch_parent_pipe(reader: BinaryIO, exit_process: Callable[[int], None]) -> None:
    """Block until the desktop-owned stdin pipe closes, then exit immediately."""
    try:
        while reader.read(1):
            pass
    except (OSError, ValueError):
        # A broken or already-closed parent-owned pipe is equivalent to EOF.
        pass
    exit_process(0)


def arm_desktop_parent_watchdog() -> bool:
    """Use stdin EOF as an unforgeable parent-liveness signal for desktop runs."""
    if os.environ.get("OMNIVOICE_DESKTOP_CONTAINED") != "1":
        return False
    reader = getattr(sys.stdin, "buffer", None)
    if reader is None:
        return False
    threading.Thread(
        target=_watch_parent_pipe,
        args=(reader, os._exit),
        name="desktop-parent-watchdog",
        daemon=True,
    ).start()
    return True
