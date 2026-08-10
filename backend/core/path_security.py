"""Filesystem trust-boundary helpers.

Paths persisted in SQLite are still untrusted: older clients and imported job
records can contain absolute paths, traversal components, or symlink escapes.
Keep containment checks at the filesystem boundary instead of relying on the
route or database layer to have sanitised a value earlier.
"""

from __future__ import annotations

import ntpath
import os
from pathlib import Path


class UnsafePath(ValueError):
    """Raised when a path crosses its allowed filesystem boundary."""


def safe_filename(value: object) -> str:
    """Return a portable bare filename, rejecting traversal and drive paths."""
    name = str(value or "")
    if (
        not name
        or name in {".", ".."}
        or "/" in name
        or "\\" in name
        or os.path.isabs(name)
        or ntpath.isabs(name)
        or ntpath.basename(name) != name
    ):
        raise UnsafePath("expected a bare filename")
    return name


def resolve_within(root: os.PathLike[str] | str, value: os.PathLike[str] | str) -> Path:
    """Resolve *value* beneath *root*, rejecting traversal and symlink escapes.

    Absolute values are accepted only when they already resolve inside the
    root. This preserves existing database rows, which historically stored a
    mixture of relative filenames and absolute job-artifact paths.
    """
    raw = os.fspath(value) if value is not None else ""
    if not isinstance(raw, str) or not raw:
        raise UnsafePath("path is empty")
    # Treat both separator families as structural on every host. Otherwise a
    # Windows traversal string is an innocent-looking filename when validated
    # on Linux (and can become dangerous after persisted data is moved).
    if os.sep != "\\" and ("\\" in raw or bool(ntpath.splitdrive(raw)[0])):
        raise UnsafePath("path uses a foreign separator or drive")
    root_path = Path(root).expanduser().resolve(strict=False)
    root_text = str(root_path)
    if os.path.isabs(raw):
        prefix = root_text.rstrip(os.sep) + os.sep
        if not os.path.normcase(raw).startswith(os.path.normcase(prefix)):
            raise UnsafePath("path escapes its allowed root")
        raw = raw[len(prefix):]

    # Rebuild from individually sanitized basenames. Besides making the
    # containment proof explicit to static analysis, this rejects empty,
    # dot, parent, drive, and separator-bearing components before Path sees
    # any persisted/request-derived string.
    parts = raw.split(os.sep)
    clean_parts: list[str] = []
    for part in parts:
        clean = os.path.basename(part)
        if not clean or clean in {".", ".."} or clean != part:
            raise UnsafePath("path contains an unsafe component")
        clean_parts.append(clean)
    candidate = root_path.joinpath(*clean_parts)
    resolved = candidate.resolve(strict=False)
    try:
        if os.path.commonpath((str(root_path), str(resolved))) != str(root_path):
            raise UnsafePath("path escapes its allowed root")
    except ValueError as exc:  # Windows paths on different drives
        raise UnsafePath("path escapes its allowed root") from exc
    if resolved == root_path:
        raise UnsafePath("path must name an item below its allowed root")
    return resolved
