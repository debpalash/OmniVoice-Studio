"""Reliable file deletion for user-visible destructive operations."""
from __future__ import annotations

import os


class FileCleanupError(OSError):
    """A requested file exists but could not be removed."""


def unlink_if_present(path: str | os.PathLike[str]) -> bool:
    """Delete *path*, returning whether it existed.

    Missing files make delete operations idempotent. Other failures must reach
    the caller so it cannot discard the only record from which cleanup can be
    retried.
    """
    try:
        os.unlink(path)
    except FileNotFoundError:
        return False
    except OSError as exc:
        raise FileCleanupError("file cleanup failed") from exc
    return True
