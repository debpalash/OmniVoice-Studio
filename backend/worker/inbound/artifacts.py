"""Artifact staging for inbound mode, where the node cannot initiate a call.

Outbound moves bytes with RPCs the worker starts: it pulls inputs with
DownloadArtifact and pushes results with UploadResult. A node that was dialled
can do neither, so both directions are driven by the panel and the node's job
becomes staging:

  * inputs  — the panel pushes them (PushInput) *before* sending the
    assignment, so by the time the executor asks for one it is already here;
  * results — the node writes them here and names them in TaskResult; the panel
    fetches them afterwards (FetchResult).

Everything lands under one directory that is resolved with the repo's existing
containment helpers. The wire supplies task ids, attempt ids and filenames, and
none of them are trusted: this is the same asymmetry that made B13 a real
arbitrary-write bug on the control-plane side, and it is not going to be
reintroduced from the other end.
"""

from __future__ import annotations

import asyncio
import errno
import functools
import hashlib
import logging
import os
import shutil
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Optional

from core.path_security import UnsafePath, resolve_within, safe_filename
from worker.async_utils import (
    to_thread_and_defer_cancellation,
    to_thread_and_drain_on_cancel,
)
from worker.protocol.gen import worker_v1_pb2 as pb

logger = logging.getLogger(__name__)

# Staged bytes are deleted only after the panel acknowledges its durable task
# commit. A panel that dies before then leaves them behind, so old generations
# are swept on the next write.
_STALE_SECONDS = 24 * 60 * 60

# An authenticated panel may mint arbitrarily many artifact ids.  The
# per-stream ceiling in NodeService.PushInput therefore is not a disk bound on
# its own: a peer could simply send another legal stream after every commit.
# Keep both one authority and the whole listener bounded.  Reservations count
# before a byte is written, so concurrent uploads cannot all pass admission
# against the same stale total.
MAX_STAGED_INPUT_BYTES_PER_KEY = 2 * 1024**3
MAX_STAGED_INPUT_BYTES_TOTAL = 8 * 1024**3
MAX_STAGED_INPUTS_PER_KEY = 1024
MAX_STAGED_INPUTS_TOTAL = 4096
MAX_STAGED_RESULT_BYTES_PER_KEY = 2 * 1024**3
MAX_STAGED_RESULT_BYTES_TOTAL = 8 * 1024**3
MAX_STAGED_RESULTS_PER_KEY = 1024
MAX_STAGED_RESULTS_TOTAL = 4096


class ArtifactQuotaExceeded(RuntimeError):
    """An artifact would exceed a node-side staging ceiling."""


@dataclass
class _Staged:
    key_id: str
    path: str
    sha256: str
    size_bytes: int
    created_at: float


@dataclass(frozen=True)
class _InputReservation:
    key_id: str
    size_bytes: int


@dataclass
class _ResultReservation:
    key_id: str
    size_bytes: int
    path: str
    temporary: str
    active: bool = True


class ArtifactStore:
    """Node-side staging for one listener. Shared across panels."""

    def __init__(
        self,
        root: str,
        *,
        max_input_bytes_per_key: int = MAX_STAGED_INPUT_BYTES_PER_KEY,
        max_input_bytes_total: int = MAX_STAGED_INPUT_BYTES_TOTAL,
        max_inputs_per_key: int = MAX_STAGED_INPUTS_PER_KEY,
        max_inputs_total: int = MAX_STAGED_INPUTS_TOTAL,
        max_result_bytes_per_key: int = MAX_STAGED_RESULT_BYTES_PER_KEY,
        max_result_bytes_total: int = MAX_STAGED_RESULT_BYTES_TOTAL,
        max_results_per_key: int = MAX_STAGED_RESULTS_PER_KEY,
        max_results_total: int = MAX_STAGED_RESULTS_TOTAL,
    ) -> None:
        self._root = os.path.abspath(root)
        self._lock = threading.Lock()
        self._out: dict[tuple[str, str], _Staged] = {}
        self._in: dict[tuple[str, str], _Staged] = {}
        self._input_reservations: dict[str, _InputReservation] = {}
        self._result_reservations: dict[
            tuple[str, str], _ResultReservation
        ] = {}
        self._input_commit_locks: dict[tuple[str, str], asyncio.Lock] = {}
        self._input_commit_lock_users: dict[tuple[str, str], int] = {}
        self._committing_inputs: dict[tuple[str, str], str] = {}
        self._validating_inputs: set[tuple[str, str]] = set()
        self._reserved_input_bytes_by_key: dict[str, int] = {}
        self._reserved_input_bytes = 0
        self._committed_input_bytes_by_key: dict[str, int] = {}
        self._committed_input_bytes = 0
        self._max_input_bytes_per_key = max(0, int(max_input_bytes_per_key))
        self._max_input_bytes_total = max(0, int(max_input_bytes_total))
        self._max_inputs_per_key = max(0, int(max_inputs_per_key))
        self._max_inputs_total = max(0, int(max_inputs_total))
        self._reserved_result_bytes_by_key: dict[str, int] = {}
        self._reserved_result_bytes = 0
        self._committed_result_bytes_by_key: dict[str, int] = {}
        self._committed_result_bytes = 0
        self._max_result_bytes_per_key = max(0, int(max_result_bytes_per_key))
        self._max_result_bytes_total = max(0, int(max_result_bytes_total))
        self._max_results_per_key = max(0, int(max_results_per_key))
        self._max_results_total = max(0, int(max_results_total))
        self._pending_result_acks: set[tuple[str, str]] = set()
        os.makedirs(self._root, exist_ok=True)
        _fsync_parent_directory(os.path.dirname(self._root) or ".")
        # The index is deliberately process-local, so files surviving a crash
        # cannot be fetched or acknowledged after restart.  Discover and remove
        # those unreachable generations now; transient Windows locks remain in
        # a retry set consumed by every later sweep/purge.
        self._orphaned_directories: set[str] = set()
        self._orphaned_paths = self._discover_orphans()
        self._orphaned_bytes = {
            path: _file_size(path) for path in self._orphaned_paths
        }
        self._retry_orphans_locked()

    def for_key(self, key_id: str) -> "KeyedArtifactTransport":
        return KeyedArtifactTransport(self, key_id)

    # ── Placement ─────────────────────────────────────────────────────────

    def _place(self, kind: str, artifact_id: str, filename: str) -> str:
        """Build a path under the root from wire-supplied strings, safely.

        `artifact_id` is minted here rather than taken from the wire, and the
        filename is reduced to a bare portable name before it is joined. The
        `resolve_within` call is the belt to that braces: it also rejects a
        symlink planted inside the root, which validation of the components
        alone cannot see.
        """
        name = safe_filename(filename) if filename else ""
        if not name:
            name = "artifact.bin"
        relative = os.path.join(kind, safe_filename(artifact_id), name)
        return str(resolve_within(self._root, relative))

    def _sweep_locked(self, now: float, *, retry_orphans: bool = True) -> None:
        if retry_orphans:
            self._retry_orphans_locked()
        for artifact_key, staged in list(self._out.items()):
            if now - staged.created_at <= _STALE_SECONDS:
                continue
            # On Windows a FetchResult handle can transiently prevent the
            # unlink.  Keep the index entry until deletion succeeds so a
            # later sweep/ack can retry instead of orphaning an unreachable
            # file forever.
            if self._remove_artifact_locked(staged.path):
                self._out.pop(artifact_key, None)
                self._pending_result_acks.discard(artifact_key)
                self._release_committed_result_locked(staged)
        for artifact_key, staged in list(self._in.items()):
            if (
                artifact_key in self._committing_inputs
                or artifact_key in self._validating_inputs
            ):
                continue
            if now - staged.created_at <= _STALE_SECONDS:
                continue
            if self._remove_artifact_locked(staged.path):
                self._in.pop(artifact_key, None)
                self._release_committed_input_locked(staged)

    def _discover_orphans(self) -> set[str]:
        paths: set[str] = set()
        for root, directories, files in os.walk(self._root, followlinks=False):
            for name in files:
                paths.add(os.path.join(root, name))
            # A directory symlink is not traversed by os.walk, but it is still
            # an unreachable staging entry and can be safely unlinked itself.
            for name in list(directories):
                path = os.path.join(root, name)
                if os.path.islink(path):
                    paths.add(path)
                    directories.remove(name)
                else:
                    self._orphaned_directories.add(path)
        return paths

    def _retry_orphans_locked(self) -> None:
        for path in list(self._orphaned_paths):
            if self._remove_artifact_locked(path):
                self._orphaned_paths.discard(path)
                self._orphaned_bytes.pop(path, None)
            else:
                self._orphaned_bytes[path] = _file_size(path)
        for directory in sorted(
            self._orphaned_directories, key=lambda item: item.count(os.sep), reverse=True
        ):
            self._prune_empty_chain_locked(directory)

    def _prune_empty_chain_locked(self, directory: str) -> None:
        """Durably remove empty artifact/kind directories, retrying failures."""
        current = os.path.abspath(directory)
        while current != self._root and os.path.commonpath(
            (self._root, current)
        ) == self._root:
            parent = os.path.dirname(current)
            try:
                os.rmdir(current)
            except FileNotFoundError:
                pass
            except OSError as exc:
                if exc.errno in {errno.ENOTEMPTY, errno.EEXIST}:
                    self._orphaned_directories.discard(current)
                else:
                    self._orphaned_directories.add(current)
                return
            try:
                _fsync_parent_directory(parent)
            except OSError:
                # The directory may already be gone, but its parent entry is
                # not known durable. Retrying the missing-directory case
                # repeats exactly that barrier before forgetting it.
                self._orphaned_directories.add(current)
                return
            self._orphaned_directories.discard(current)
            current = parent

    def _remove_artifact_locked(self, path: str) -> bool:
        if not _remove_if_possible(path):
            return False
        directory = os.path.dirname(path)
        try:
            _fsync_parent_directory(directory or ".")
        except OSError:
            self._orphaned_directories.add(directory)
            return True
        self._orphaned_directories.add(directory)
        self._prune_empty_chain_locked(directory)
        return True

    def _remember_orphan_locked(self, path: str) -> None:
        self._orphaned_paths.add(path)
        self._orphaned_bytes[path] = _file_size(path)

    def _discard_unpublished_locked(self, *paths: str) -> None:
        for path in paths:
            if not path:
                continue
            if self._remove_artifact_locked(path):
                self._orphaned_paths.discard(path)
                self._orphaned_bytes.pop(path, None)
            else:
                self._remember_orphan_locked(path)

    def _result_usage_for_key_locked(self, key_id: str) -> int:
        return self._committed_result_bytes_by_key.get(
            key_id, 0
        ) + self._reserved_result_bytes_by_key.get(key_id, 0)

    def _global_result_usage_locked(self) -> int:
        return (
            self._committed_result_bytes
            + self._reserved_result_bytes
            + sum(self._orphaned_bytes.values())
        )

    def _reserve_result_locked(
        self,
        artifact_key: tuple[str, str],
        reservation: _ResultReservation,
    ) -> None:
        key_id = reservation.key_id
        size_bytes = reservation.size_bytes
        if self._result_usage_for_key_locked(key_id) + size_bytes > (
            self._max_result_bytes_per_key
        ):
            raise ArtifactQuotaExceeded(
                "this panel has filled its staged-result allowance"
            )
        if self._global_result_usage_locked() + size_bytes > (
            self._max_result_bytes_total
        ):
            raise ArtifactQuotaExceeded(
                "this node has filled its staged-result allowance"
            )
        key_count = sum(key[0] == key_id for key in self._out) + sum(
            item.key_id == key_id for item in self._result_reservations.values()
        )
        if key_count + 1 > self._max_results_per_key:
            raise ArtifactQuotaExceeded(
                "this panel has filled its staged-result allowance"
            )
        global_count = (
            len(self._out)
            + len(self._result_reservations)
            + len(self._orphaned_paths)
        )
        if global_count + 1 > self._max_results_total:
            raise ArtifactQuotaExceeded(
                "this node has filled its staged-result allowance"
            )
        self._result_reservations[artifact_key] = reservation
        self._reserved_result_bytes += size_bytes
        self._reserved_result_bytes_by_key[key_id] = (
            self._reserved_result_bytes_by_key.get(key_id, 0) + size_bytes
        )

    def _release_result_reservation_locked(
        self, artifact_key: tuple[str, str]
    ) -> None:
        reservation = self._result_reservations.pop(artifact_key, None)
        if reservation is None:
            return
        self._reserved_result_bytes -= reservation.size_bytes
        remaining = (
            self._reserved_result_bytes_by_key.get(reservation.key_id, 0)
            - reservation.size_bytes
        )
        if remaining:
            self._reserved_result_bytes_by_key[reservation.key_id] = remaining
        else:
            self._reserved_result_bytes_by_key.pop(reservation.key_id, None)

    def _record_committed_result_locked(self, staged: _Staged) -> None:
        self._committed_result_bytes += staged.size_bytes
        self._committed_result_bytes_by_key[staged.key_id] = (
            self._committed_result_bytes_by_key.get(staged.key_id, 0)
            + staged.size_bytes
        )

    def _release_committed_result_locked(self, staged: _Staged) -> None:
        self._committed_result_bytes -= staged.size_bytes
        remaining = (
            self._committed_result_bytes_by_key.get(staged.key_id, 0)
            - staged.size_bytes
        )
        if remaining:
            self._committed_result_bytes_by_key[staged.key_id] = remaining
        else:
            self._committed_result_bytes_by_key.pop(staged.key_id, None)

    def _input_usage_for_key_locked(self, key_id: str) -> int:
        return self._committed_input_bytes_by_key.get(
            key_id, 0
        ) + self._reserved_input_bytes_by_key.get(key_id, 0)

    def _global_input_usage_locked(self) -> int:
        return (
            self._committed_input_bytes
            + self._reserved_input_bytes
            + sum(self._orphaned_bytes.values())
        )

    def _admit_input_bytes_locked(self, key_id: str, size_bytes: int) -> None:
        if size_bytes < 0:
            raise ValueError("an input reservation cannot be negative")
        if (
            self._input_usage_for_key_locked(key_id) + size_bytes
            > self._max_input_bytes_per_key
        ):
            raise ArtifactQuotaExceeded(
                "this panel has filled its staged-input allowance"
            )
        if (
            self._global_input_usage_locked() + size_bytes
            > self._max_input_bytes_total
        ):
            raise ArtifactQuotaExceeded(
                "this node has filled its staged-input allowance"
            )

    def _admit_input_count_locked(self, key_id: str) -> None:
        key_count = sum(key[0] == key_id for key in self._in) + sum(
            reservation.key_id == key_id
            for reservation in self._input_reservations.values()
        )
        if key_count + 1 > self._max_inputs_per_key:
            raise ArtifactQuotaExceeded(
                "this panel has filled its staged-input allowance"
            )
        global_count = (
            len(self._in)
            + len(self._input_reservations)
            + len(self._orphaned_paths)
        )
        if global_count + 1 > self._max_inputs_total:
            raise ArtifactQuotaExceeded(
                "this node has filled its staged-input allowance"
            )

    def _reserve_input_locked(
        self, path: str, key_id: str, size_bytes: int
    ) -> None:
        self._admit_input_count_locked(key_id)
        self._admit_input_bytes_locked(key_id, size_bytes)
        self._input_reservations[path] = _InputReservation(
            key_id=key_id, size_bytes=size_bytes
        )
        self._reserved_input_bytes += size_bytes
        self._reserved_input_bytes_by_key[key_id] = (
            self._reserved_input_bytes_by_key.get(key_id, 0) + size_bytes
        )

    def _grow_input_reservation_locked(self, path: str, size_bytes: int) -> None:
        if size_bytes < 0:
            raise ValueError("an input reservation cannot be negative")
        reservation = self._input_reservations[path]
        if size_bytes <= reservation.size_bytes:
            return
        additional = size_bytes - reservation.size_bytes
        self._admit_input_bytes_locked(reservation.key_id, additional)
        self._input_reservations[path] = _InputReservation(
            key_id=reservation.key_id, size_bytes=size_bytes
        )
        self._reserved_input_bytes += additional
        self._reserved_input_bytes_by_key[reservation.key_id] = (
            self._reserved_input_bytes_by_key.get(reservation.key_id, 0)
            + additional
        )

    def _release_input_reservation_locked(self, path: str) -> None:
        reservation = self._input_reservations.pop(path, None)
        if reservation is None:
            return
        self._reserved_input_bytes -= reservation.size_bytes
        remaining = (
            self._reserved_input_bytes_by_key.get(reservation.key_id, 0)
            - reservation.size_bytes
        )
        if remaining:
            self._reserved_input_bytes_by_key[reservation.key_id] = remaining
        else:
            self._reserved_input_bytes_by_key.pop(reservation.key_id, None)

    def _discard_reserved_input_locked(self, path: str, *published: str) -> None:
        self._discard_unpublished_locked(path, *published)
        self._release_input_reservation_locked(path)

    def _record_committed_input_locked(self, staged: _Staged) -> None:
        self._committed_input_bytes += staged.size_bytes
        self._committed_input_bytes_by_key[staged.key_id] = (
            self._committed_input_bytes_by_key.get(staged.key_id, 0)
            + staged.size_bytes
        )

    def _release_committed_input_locked(self, staged: _Staged) -> None:
        self._committed_input_bytes -= staged.size_bytes
        remaining = (
            self._committed_input_bytes_by_key.get(staged.key_id, 0)
            - staged.size_bytes
        )
        if remaining:
            self._committed_input_bytes_by_key[staged.key_id] = remaining
        else:
            self._committed_input_bytes_by_key.pop(staged.key_id, None)

    @staticmethod
    def _input_scope(ref: pb.ArtifactRef, key_id: str) -> str:
        """Mint a stable directory without trusting the wire artifact id."""
        return hashlib.sha256(
            f"{key_id}\0{ref.artifact_id}".encode("utf-8")
        ).hexdigest()[:32]

    def _input_final_path(
        self, ref: pb.ArtifactRef, digest: str, *, key_id: str
    ) -> str:
        # Keep only a portable suffix for engines which use it to detect the
        # media type. The bytes' digest, not the remote filename, is the name.
        name = safe_filename(ref.filename) if ref.filename else "artifact.bin"
        suffix = os.path.splitext(name)[1].lower()
        if not (1 < len(suffix) <= 9 and suffix[1:].isalnum()):
            suffix = ""
        return self._place(
            "in", self._input_scope(ref, key_id), f"{digest}{suffix}"
        )

    # ── Results: node writes, panel fetches ───────────────────────────────

    def _reserve_result_publish(
        self,
        artifact_key: tuple[str, str],
        reservation: _ResultReservation,
    ) -> None:
        with self._lock:
            self._sweep_locked(time.time(), retry_orphans=False)
            try:
                self._reserve_result_locked(artifact_key, reservation)
            except ArtifactQuotaExceeded:
                self._retry_orphans_locked()
                self._reserve_result_locked(artifact_key, reservation)

    def _abort_result_publish(
        self,
        artifact_key: tuple[str, str],
        reservation: _ResultReservation,
        temporary: str,
        path: str,
    ) -> None:
        with self._lock:
            self._discard_unpublished_locked(temporary, path)
            if self._result_reservations.get(artifact_key) is reservation:
                self._release_result_reservation_locked(artifact_key)

    def _finalize_result_publish(
        self,
        artifact_key: tuple[str, str],
        reservation: _ResultReservation,
        temporary: str,
        path: str,
        digest: str,
        payload_size: int,
        now: float,
    ) -> _Staged:
        with self._lock:
            current = self._result_reservations.get(artifact_key)
            if current is not reservation or not reservation.active:
                self._discard_unpublished_locked(temporary, path)
                if current is reservation:
                    self._release_result_reservation_locked(artifact_key)
                raise OSError("the result authority was retired during publish")
            self._release_result_reservation_locked(artifact_key)
            staged = _Staged(
                key_id=reservation.key_id,
                path=path,
                sha256=digest,
                size_bytes=payload_size,
                created_at=now,
            )
            self._out[artifact_key] = staged
            self._record_committed_result_locked(staged)
            return staged

    def _rollback_finalized_result(
        self, artifact_key: tuple[str, str], staged: _Staged
    ) -> None:
        with self._lock:
            if self._out.get(artifact_key) is not staged:
                return
            if self._remove_artifact_locked(staged.path):
                self._out.pop(artifact_key, None)
                self._release_committed_result_locked(staged)

    async def publish(
        self, ref: pb.TaskRef, payload: bytes, meta: dict, *, key_id: str
    ) -> pb.ArtifactRef:
        """Stage a finished result and return the ref that names it."""
        artifact_id = uuid.uuid4().hex
        artifact_key = (key_id, artifact_id)
        filename = str(meta.get("filename") or f"{ref.attempt_id}.wav")
        path = self._place("out", artifact_id, filename)
        temporary = os.path.join(
            os.path.dirname(path), f"{uuid.uuid4().hex}.part"
        )
        reservation = _ResultReservation(
            key_id=key_id,
            size_bytes=len(payload),
            path=path,
            temporary=temporary,
        )
        reserve = functools.partial(
            self._reserve_result_publish, artifact_key, reservation
        )
        _reserved, cancelled = await to_thread_and_defer_cancellation(reserve)
        if cancelled:
            abort = functools.partial(
                self._abort_result_publish,
                artifact_key,
                reservation,
                temporary,
                path,
            )
            await to_thread_and_drain_on_cancel(abort)
            raise asyncio.CancelledError

        digest_box: list[str] = []

        def write() -> None:
            digest_box.append(hashlib.sha256(payload).hexdigest())
            _ensure_durable_directory(self._root, os.path.dirname(path))
            with open(temporary, "xb") as handle:
                _write_all(handle, payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            _fsync_parent_directory(os.path.dirname(path))

        try:
            await to_thread_and_drain_on_cancel(write)
        except BaseException:
            abort = functools.partial(
                self._abort_result_publish,
                artifact_key,
                reservation,
                temporary,
                path,
            )
            await to_thread_and_drain_on_cancel(abort)
            raise
        now = time.time()
        finalize = functools.partial(
            self._finalize_result_publish,
            artifact_key,
            reservation,
            temporary,
            path,
            digest_box[0],
            len(payload),
            now,
        )
        staged, cancelled = await to_thread_and_defer_cancellation(finalize)
        if cancelled:
            rollback = functools.partial(
                self._rollback_finalized_result, artifact_key, staged
            )
            await to_thread_and_drain_on_cancel(rollback)
            raise asyncio.CancelledError
        return pb.ArtifactRef(
            artifact_id=artifact_id,
            task_id=ref.task_id,
            attempt_id=ref.attempt_id,
            filename=os.path.basename(path),
            content_type=str(meta.get("content_type") or "audio/wav"),
            size_bytes=len(payload),
            sha256=digest_box[0],
        )

    def open_result(self, artifact_id: str, *, key_id: str) -> Optional[_Staged]:
        with self._lock:
            return self._out.get((key_id, artifact_id))

    def result_acked(self, artifact_id: str, *, key_id: str) -> None:
        """Drop a result only after the panel acknowledges its task commit."""
        with self._lock:
            artifact_key = (key_id, artifact_id)
            staged = self._out.get(artifact_key)
            if staged is None:
                self._pending_result_acks.discard(artifact_key)
                return
            self._pending_result_acks.add(artifact_key)
            if self._remove_artifact_locked(staged.path):
                self._out.pop(artifact_key, None)
                self._pending_result_acks.discard(artifact_key)
                self._release_committed_result_locked(staged)

    def retry_result_acks(self, key_id: str) -> None:
        """Retry ACK deletions after this key's FetchResult handles close."""
        with self._lock:
            for artifact_key in list(self._pending_result_acks):
                if artifact_key[0] != key_id:
                    continue
                staged = self._out.get(artifact_key)
                if staged is None or self._remove_artifact_locked(staged.path):
                    self._out.pop(artifact_key, None)
                    self._pending_result_acks.discard(artifact_key)
                    if staged is not None:
                        self._release_committed_result_locked(staged)

    # ── Inputs: panel pushes, node reads ──────────────────────────────────

    def begin_input(
        self,
        ref: pb.ArtifactRef,
        *,
        key_id: str,
        reserve_bytes: Optional[int] = None,
    ) -> str:
        """Reserve a unique temporary path for an incoming push.

        The wire id is HASHED into a directory name rather than used as one.
        Staged inputs are legitimately nested — `inputs/<digest>.wav` — so
        demanding a bare filename here rejected every real input, failed the
        dispatch, and left the scheduler retrying about eighteen times a
        second while the GPU sat idle and the user watched a spinner. Hashing
        accepts any id the protocol allows while keeping the placement
        entirely ours to decide, which is the property that actually matters.

        A committed path is never opened for writing again. Parallel retries
        therefore cannot truncate a file while an executor is staging it in.
        """
        # Validate the remote filename even though it never becomes the temp
        # name. This keeps traversal attempts at the boundary before bytes are
        # accepted and preserves the portable-extension contract.
        if ref.filename:
            safe_filename(ref.filename)
        path = self._place(
            "in",
            self._input_scope(ref, key_id),
            f"{uuid.uuid4().hex}.part",
        )
        requested = int(ref.size_bytes) if reserve_bytes is None else int(reserve_bytes)
        with self._lock:
            # Keep a matching crash-surviving final available for commit to
            # verify and adopt. If orphan bytes are the only thing preventing
            # admission, retry their deletion and make one fresh decision.
            self._sweep_locked(time.time(), retry_orphans=False)
            try:
                self._reserve_input_locked(path, key_id, requested)
            except ArtifactQuotaExceeded:
                self._retry_orphans_locked()
                self._reserve_input_locked(path, key_id, requested)
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
        except BaseException:
            with self._lock:
                self._discard_reserved_input_locked(path)
            raise
        return path

    def discard_input(self, path: str) -> None:
        """Discard one uncommitted upload and release its byte reservation."""
        if not path:
            return
        with self._lock:
            self._discard_reserved_input_locked(path)

    async def reuse_committed_input_async(
        self, ref: pb.ArtifactRef, *, key_id: str
    ) -> bool:
        """Verify and reuse a lost-ACK retry without spending a second quota slot."""
        if not ref.sha256:
            return False
        artifact_key = (key_id, ref.artifact_id)
        with self._lock:
            commit_lock = self._input_commit_locks.setdefault(
                artifact_key, asyncio.Lock()
            )
            self._input_commit_lock_users[artifact_key] = (
                self._input_commit_lock_users.get(artifact_key, 0) + 1
            )
        try:
            async with commit_lock:
                reuse = functools.partial(
                    self._reuse_committed_input,
                    ref,
                    key_id=key_id,
                )
                return await to_thread_and_drain_on_cancel(reuse)
        finally:
            with self._lock:
                remaining = self._input_commit_lock_users[artifact_key] - 1
                if remaining:
                    self._input_commit_lock_users[artifact_key] = remaining
                else:
                    self._input_commit_lock_users.pop(artifact_key, None)
                    if self._input_commit_locks.get(artifact_key) is commit_lock:
                        self._input_commit_locks.pop(artifact_key, None)

    def _reuse_committed_input(
        self, ref: pb.ArtifactRef, *, key_id: str
    ) -> bool:
        artifact_key = (key_id, ref.artifact_id)
        digest = ref.sha256.strip().lower()
        size = int(ref.size_bytes)
        with self._lock:
            self._sweep_locked(time.time())
            staged = self._in.get(artifact_key)
            if staged is None:
                return False
            if staged.sha256 != digest or staged.size_bytes != size:
                raise ValueError(
                    "an input artifact id cannot be replaced with different bytes"
                )
            self._validating_inputs.add(artifact_key)
        try:
            matches = _file_matches(staged.path, digest, size)
            if matches:
                _ensure_durable_directory(self._root, os.path.dirname(staged.path))
                _durable_existing_file(staged.path)
        finally:
            with self._lock:
                self._validating_inputs.discard(artifact_key)

        with self._lock:
            if self._in.get(artifact_key) is not staged:
                return False
            if not matches:
                if self._remove_artifact_locked(staged.path):
                    self._in.pop(artifact_key, None)
                    self._release_committed_input_locked(staged)
                return False
            staged.created_at = time.time()
            return True

    async def commit_input_async(
        self,
        ref: pb.ArtifactRef,
        path: str,
        digest: str,
        size: int,
        *,
        key_id: str,
    ) -> str:
        """Commit off-loop while serialising retries of one artifact id."""
        artifact_key = (key_id, ref.artifact_id)
        with self._lock:
            commit_lock = self._input_commit_locks.setdefault(
                artifact_key, asyncio.Lock()
            )
            self._input_commit_lock_users[artifact_key] = (
                self._input_commit_lock_users.get(artifact_key, 0) + 1
            )
        try:
            async with commit_lock:
                commit = functools.partial(
                    self.commit_input,
                    ref,
                    path,
                    digest,
                    size,
                    key_id=key_id,
                )
                return await to_thread_and_drain_on_cancel(commit)
        finally:
            with self._lock:
                remaining = self._input_commit_lock_users[artifact_key] - 1
                if remaining:
                    self._input_commit_lock_users[artifact_key] = remaining
                else:
                    self._input_commit_lock_users.pop(artifact_key, None)
                    if self._input_commit_locks.get(artifact_key) is commit_lock:
                        self._input_commit_locks.pop(artifact_key, None)

    def commit_input(
        self, ref: pb.ArtifactRef, path: str, digest: str, size: int, *, key_id: str
    ) -> str:
        """Durably publish one verified input without replacing prior bytes."""
        now = time.time()
        final = self._input_final_path(ref, digest, key_id=key_id)
        artifact_key = (key_id, ref.artifact_id)
        existing: Optional[_Staged] = None
        with self._lock:
            self._sweep_locked(now)
            reservation = self._input_reservations.get(path)
            if reservation is None or reservation.key_id != key_id:
                self._discard_reserved_input_locked(path)
                raise ValueError("the input upload does not own this reservation")
            try:
                self._grow_input_reservation_locked(path, size)
            except BaseException:
                self._discard_reserved_input_locked(path)
                raise
            existing = self._in.get(artifact_key)
            if existing is not None and not os.path.isfile(existing.path):
                self._in.pop(artifact_key, None)
                self._release_committed_input_locked(existing)
                existing = None
            if existing is not None:
                if existing.sha256 != digest or existing.size_bytes != size:
                    self._discard_reserved_input_locked(path)
                    raise ValueError(
                        "an input artifact id cannot be replaced with different bytes"
                    )
            if artifact_key in self._committing_inputs:
                self._discard_reserved_input_locked(path)
                raise RuntimeError("another input commit is already in progress")
            self._committing_inputs[artifact_key] = path

        published_new = False
        final_was_present = False
        try:
            if existing is not None:
                if not _file_matches(existing.path, digest, size):
                    raise OSError("the committed input no longer matches its digest")
                _ensure_durable_directory(
                    self._root, os.path.dirname(existing.path)
                )
                _durable_existing_file(existing.path)
            else:
                _ensure_durable_directory(self._root, os.path.dirname(final))
                final_was_present = os.path.isfile(final)
                if final_was_present:
                    if not _file_matches(final, digest, size):
                        raise OSError(
                            "the input content address contains different bytes"
                        )
                    _durable_existing_file(final)
                else:
                    _durable_replace(path, final)
                    published_new = True
        except BaseException:
            with self._lock:
                if self._committing_inputs.get(artifact_key) == path:
                    self._committing_inputs.pop(artifact_key, None)
                self._discard_reserved_input_locked(
                    path,
                    final
                    if published_new or (existing is None and not final_was_present)
                    else "",
                )
            raise

        with self._lock:
            if (
                self._committing_inputs.get(artifact_key) != path
                or path not in self._input_reservations
            ):
                if self._committing_inputs.get(artifact_key) == path:
                    self._committing_inputs.pop(artifact_key, None)
                self._discard_reserved_input_locked(
                    path, final if published_new else ""
                )
                raise OSError("the input authority was retired during commit")
            self._committing_inputs.pop(artifact_key, None)
            if existing is not None:
                if self._in.get(artifact_key) is not existing:
                    self._discard_reserved_input_locked(path)
                    raise OSError("the committed input changed during validation")
                self._orphaned_paths.discard(existing.path)
                self._orphaned_bytes.pop(existing.path, None)
                self._discard_reserved_input_locked(path)
                existing.created_at = now
                return existing.path

            if published_new:
                self._release_input_reservation_locked(path)
            else:
                self._orphaned_paths.discard(final)
                self._orphaned_bytes.pop(final, None)
                self._discard_reserved_input_locked(path)
            staged = _Staged(
                key_id=key_id,
                path=final,
                sha256=digest,
                size_bytes=size,
                created_at=now,
            )
            self._in[artifact_key] = staged
            self._record_committed_input_locked(staged)
            return final

    async def stage_in(
        self, ref: pb.ArtifactRef, destination: str, *, key_id: str
    ) -> None:
        """Hand a previously pushed input to the executor.

        Copied rather than moved: an attempt that is retried asks for the same
        input again, and a move would make the second attempt fail with a
        missing file that no log explains.
        """
        with self._lock:
            staged = self._in.get((key_id, ref.artifact_id))
        if staged is None:
            raise RuntimeError(
                f"the control plane did not send input {ref.artifact_id or '(unnamed)'} "
                "before assigning this task"
            )
        await to_thread_and_drain_on_cancel(shutil.copyfile, staged.path, destination)

    def forget_input(self, artifact_id: str, *, key_id: str) -> None:
        with self._lock:
            artifact_key = (key_id, artifact_id)
            committing = self._committing_inputs.pop(artifact_key, None)
            if committing is not None:
                self._discard_reserved_input_locked(committing)
            staged = self._in.get(artifact_key)
            if staged is not None and self._remove_artifact_locked(staged.path):
                self._in.pop(artifact_key, None)
                self._release_committed_input_locked(staged)

    def purge_key(self, key_id: str) -> None:
        """Drop one retired panel's artifacts without touching another's."""
        with self._lock:
            for reservation in self._result_reservations.values():
                if reservation.key_id != key_id:
                    continue
                reservation.active = False
                self._discard_unpublished_locked(
                    reservation.temporary, reservation.path
                )
            for artifact_key, path in list(self._committing_inputs.items()):
                if artifact_key[0] == key_id:
                    self._committing_inputs.pop(artifact_key, None)
                    self._discard_reserved_input_locked(path)
            for path, reservation in list(self._input_reservations.items()):
                if reservation.key_id == key_id:
                    self._discard_reserved_input_locked(path)
            for index in (self._out, self._in):
                for artifact_key, staged in list(index.items()):
                    if staged.key_id != key_id:
                        continue
                    if self._remove_artifact_locked(staged.path):
                        index.pop(artifact_key, None)
                        self._pending_result_acks.discard(artifact_key)
                        if index is self._in:
                            self._release_committed_input_locked(staged)
                        else:
                            self._release_committed_result_locked(staged)

    def purge(self) -> None:
        """Drop everything. Called when the listener stops."""
        with self._lock:
            self._retry_orphans_locked()
            for reservation in self._result_reservations.values():
                reservation.active = False
                self._discard_unpublished_locked(
                    reservation.temporary, reservation.path
                )
            self._committing_inputs.clear()
            for path in list(self._input_reservations):
                self._discard_reserved_input_locked(path)
            for index in (self._out, self._in):
                for artifact_key, staged in list(index.items()):
                    if self._remove_artifact_locked(staged.path):
                        index.pop(artifact_key, None)
                        self._pending_result_acks.discard(artifact_key)
                        if index is self._in:
                            self._release_committed_input_locked(staged)
                        else:
                            self._release_committed_result_locked(staged)


class KeyedArtifactTransport:
    """The artifact view one authenticated panel's worker client receives."""

    def __init__(self, store: ArtifactStore, key_id: str) -> None:
        self._store = store
        self._key_id = key_id

    async def publish(
        self, ref: pb.TaskRef, payload: bytes, meta: dict
    ) -> pb.ArtifactRef:
        return await self._store.publish(ref, payload, meta, key_id=self._key_id)

    async def stage_in(self, ref: pb.ArtifactRef, destination: str) -> None:
        await self._store.stage_in(ref, destination, key_id=self._key_id)

    def result_acked(self, artifacts: list[pb.ArtifactRef]) -> None:
        for artifact in artifacts:
            self._store.result_acked(artifact.artifact_id, key_id=self._key_id)

    async def result_acked_async(self, artifacts: list[pb.ArtifactRef]) -> None:
        """Delete acknowledged staging generations away from the RPC loop."""
        def cleanup() -> None:
            self.result_acked(artifacts)

        await to_thread_and_drain_on_cancel(cleanup)

    def purge(self) -> None:
        self._store.purge_key(self._key_id)


def _remove_if_possible(path: str) -> bool:
    try:
        os.remove(path)
    except FileNotFoundError:
        return True
    except OSError:
        return False
    return True


def _file_size(path: str) -> int:
    try:
        return max(0, int(os.lstat(path).st_size))
    except OSError:
        return 0


def _write_all(handle, payload: bytes) -> None:
    """Complete a file write even when the platform returns a short count."""
    remaining = memoryview(payload)
    while remaining:
        written = handle.write(remaining)
        if not written:
            raise OSError("artifact write made no progress")
        remaining = remaining[written:]


def _file_matches(path: str, digest: str, size: int) -> bool:
    try:
        if os.path.getsize(path) != size:
            return False
        actual = hashlib.sha256()
        with open(path, "rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                actual.update(block)
        return actual.hexdigest() == digest
    except OSError:
        return False


def _fsync_parent_directory(directory: str) -> None:
    """Persist a rename/create where the platform supports directory fsync."""
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


def _ensure_durable_directory(root: str, directory: str) -> None:
    """Create a staging hierarchy and persist each new directory entry."""
    os.makedirs(directory, exist_ok=True)
    relative = os.path.relpath(directory, root)
    if relative == os.curdir:
        return
    current = root
    for component in relative.split(os.sep):
        _fsync_parent_directory(current)
        current = os.path.join(current, component)


def _durable_replace(source: str, destination: str) -> None:
    """Publish a complete file only after its bytes and rename are durable."""
    with open(source, "r+b") as handle:
        os.fsync(handle.fileno())
    os.replace(source, destination)
    _fsync_parent_directory(os.path.dirname(destination) or ".")


def _durable_existing_file(path: str) -> None:
    """Re-establish durability before adopting a crash-surviving final."""
    with open(path, "r+b") as handle:
        os.fsync(handle.fileno())
    _fsync_parent_directory(os.path.dirname(path) or ".")


__all__ = [
    "ArtifactQuotaExceeded",
    "ArtifactStore",
    "KeyedArtifactTransport",
    "MAX_STAGED_INPUT_BYTES_PER_KEY",
    "MAX_STAGED_INPUT_BYTES_TOTAL",
    "MAX_STAGED_INPUTS_PER_KEY",
    "MAX_STAGED_INPUTS_TOTAL",
    "MAX_STAGED_RESULT_BYTES_PER_KEY",
    "MAX_STAGED_RESULT_BYTES_TOTAL",
    "MAX_STAGED_RESULTS_PER_KEY",
    "MAX_STAGED_RESULTS_TOTAL",
    "UnsafePath",
]
