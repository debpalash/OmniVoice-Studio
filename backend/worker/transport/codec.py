"""Translation between protobuf messages and the domain objects.

Kept separate from the server and the client because both directions need it
and because it is the one place where a wire-format change shows up. Nothing
here makes decisions; it converts.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

from worker.capacity import clamp_concurrency, derive_concurrency
from worker.deadlines import Deadlines
from worker.errors import ErrorClass, WorkerError
from worker.lifecycle import Attempt, PriorityClass, Task
from worker.protocol.gen import worker_v1_pb2 as pb

logger = logging.getLogger("omnivoice.worker")

# Where a staging failure is reported to the worker. Named here because both
# sides of the wire read it: the executor turns it into a terminal error.
_INPUT_ERRORS_KEY = "input_errors"

# Domain ErrorClass ↔ protobuf enum. Explicit rather than by-name so renaming
# one side cannot silently change the meaning of a wire value.
_ERROR_TO_PB = {
    ErrorClass.TRANSIENT: pb.ERROR_CLASS_TRANSIENT,
    ErrorClass.CAPABILITY: pb.ERROR_CLASS_CAPABILITY,
    ErrorClass.TERMINAL: pb.ERROR_CLASS_TERMINAL,
    ErrorClass.CAPACITY: pb.ERROR_CLASS_CAPACITY,
    ErrorClass.TIMEOUT: pb.ERROR_CLASS_TIMEOUT,
    ErrorClass.PROTOCOL: pb.ERROR_CLASS_PROTOCOL,
}
_PB_TO_ERROR = {v: k for k, v in _ERROR_TO_PB.items()}


def error_to_pb(error: Optional[WorkerError]) -> Optional[pb.Error]:
    if error is None:
        return None
    return pb.Error(
        error_class=_ERROR_TO_PB.get(error.error_class, pb.ERROR_CLASS_TRANSIENT),
        code=error.code,
        message=error.message,
        hint=error.hint,
    )


def error_from_pb(message: Optional[pb.Error]) -> Optional[WorkerError]:
    if message is None or not message.code:
        return None
    return WorkerError(
        # Unknown/unspecified maps to TRANSIENT: one wasted retry beats
        # permanently failing work a newer peer merely described differently.
        error_class=_PB_TO_ERROR.get(message.error_class, ErrorClass.TRANSIENT),
        code=message.code,
        message=message.message,
        hint=message.hint,
    )


def task_ref(task_id: str, attempt_id: str, epoch: int) -> pb.TaskRef:
    return pb.TaskRef(task_id=task_id, attempt_id=attempt_id, session_epoch=epoch)


def ref_for(attempt: Attempt) -> pb.TaskRef:
    return task_ref(attempt.task_id, attempt.attempt_id, attempt.session_epoch)


def deadlines_to_pb(budget: Deadlines) -> pb.Deadlines:
    return pb.Deadlines(
        accept_seconds=budget.accept_seconds,
        model_load_seconds=budget.model_load_seconds,
        execution_seconds=budget.execution_seconds,
        progress_lease_seconds=budget.progress_lease_seconds,
        result_delivery_seconds=budget.result_delivery_seconds,
    )


def assignment_to_pb(
    task: Task, attempt: Attempt, budget: Deadlines, *, artifact_root: Optional[str] = None
) -> pb.TaskAssignment:
    """Build the wire assignment.

    ``params_json`` carries the operation's parameters opaquely; the transport
    has no business knowing what a dub or a clone needs.

    The one thing it cannot stay opaque about is a **path**. A parameter like
    ``ref_audio`` names a file on the control plane's disk, which is not a
    thing on the worker's — so a clone assignment used to arrive naming a file
    that did not exist, and the worker either failed to open it or rendered
    the default voice. Every file-valued parameter is therefore staged into
    the artifact store, declared in ``inputs`` for the worker to fetch over
    ``DownloadArtifact``, and replaced in ``params_json`` by its artifact id.
    No local path ever crosses the wire.
    """
    import json  # noqa: PLC0415 — only needed on this path

    entries, errors = _staged_inputs(task, artifact_root)
    return pb.TaskAssignment(
        ref=ref_for(attempt),
        operation=task.operation,
        engine=task.engine,
        model_id=task.model_id,
        params_json=json.dumps(remote_params(task.params, entries, errors)),
        inputs=[input_ref(entry, task, attempt) for entry in entries],
        deadlines=deadlines_to_pb(budget),
        priority_class=int(task.priority),
        attempt_number=attempt.attempt_number,
        max_attempts=task.max_attempts,
    )


def input_ref(entry: dict, task: Task, attempt: Attempt) -> pb.ArtifactRef:
    """One staged input as the worker will ask for it back.

    ``sha256`` and ``size_bytes`` are populated rather than left at their
    defaults because they are what lets the worker verify the transfer and,
    more usefully, recognise a reference clip it already holds.
    """
    return pb.ArtifactRef(
        artifact_id=str(entry.get("artifact_id") or ""),
        task_id=task.task_id,
        attempt_id=attempt.attempt_id,
        filename=str(entry.get("filename") or ""),
        content_type=str(entry.get("content_type") or ""),
        size_bytes=int(entry.get("size_bytes") or 0),
        sha256=str(entry.get("sha256") or ""),
    )


def remote_params(params: dict, entries: list[dict], errors: list[str]) -> dict:
    """The parameters as the worker should see them.

    Two rules. The staging bookkeeping (which holds control-plane paths) is
    stripped. And any remaining file-valued parameter is *removed* rather than
    passed through: an unstaged local path is worse than an absent one,
    because absent fails loudly while a dead path can silently produce audio
    in the wrong voice.
    """
    from worker.task_store import INPUT_PARAM_KEYS, INPUTS_PARAM_KEY  # noqa: PLC0415

    remote = {
        key: value
        for key, value in (params or {}).items()
        if key not in (INPUTS_PARAM_KEY, _INPUT_ERRORS_KEY)
    }
    mapped: dict[str, dict[Optional[int], str]] = {}
    for entry in entries:
        artifact_id = str(entry.get("artifact_id") or "")
        if artifact_id:
            mapped.setdefault(str(entry.get("key") or ""), {})[entry.get("index")] = artifact_id

    for key in INPUT_PARAM_KEYS:
        if key not in remote:
            continue
        by_index = mapped.get(key, {})
        value = remote[key]
        if isinstance(value, list):
            rewritten = [
                by_index.get(index, item)
                for index, item in enumerate(value)
                if index in by_index or not _is_local_path(item)
            ]
            remote[key] = rewritten
        elif isinstance(value, str):
            if None in by_index:
                remote[key] = by_index[None]
            elif _is_local_path(value):
                remote.pop(key)
    if errors:
        remote[_INPUT_ERRORS_KEY] = errors
    return remote


def _is_local_path(value) -> bool:
    """Does this value name a place on this machine rather than a plain id?"""
    if not isinstance(value, str) or not value:
        return False
    return os.path.isabs(value) or os.sep in value or "/" in value or os.path.exists(value)


def _staged_inputs(task: Task, artifact_root: Optional[str]) -> tuple[list[dict], list[str]]:
    """Stage this task's inputs, or say why they could not be staged.

    A staging failure must not take down the dispatch loop, and it must not
    fall back to sending the path: the assignment goes out with an explicit
    error the worker turns into a terminal failure the user can read.
    """
    from worker import task_store  # noqa: PLC0415 — control-plane only

    try:
        entries = task_store.ensure_staged(task, root=artifact_root)
    except task_store.InputStagingError as exc:
        logger.warning("Could not stage inputs for task %s: %s", task.task_id, exc)
        return [], [str(exc)]
    except Exception as exc:  # pragma: no cover — defensive
        logger.warning("Input staging failed for task %s", task.task_id, exc_info=True)
        return [], [f"Task inputs could not be prepared: {exc}"]
    return [e for e in entries if e.get("artifact_id")], []


def capability_to_pb(cap: dict) -> pb.ModelCapability:
    """Convert a discovered capability.

    ``derived_concurrency`` is computed here when the reporter did not supply
    it, never defaulted to a constant: a wrong value corrupts output under
    torch.compile (#315) or aborts the process on a small card (#567).
    """
    declared = int(cap.get("derived_concurrency") or 0)
    if declared <= 0:
        declared = derive_concurrency(
            backend=str(cap.get("backend") or ""),
            free_memory_bytes=int(cap.get("free_memory_bytes") or 0),
            min_model_bytes=int(cap.get("min_memory_bytes") or 0),
            compiled=bool(cap.get("compiled")),
        )
    return pb.ModelCapability(
        engine=str(cap.get("engine") or ""),
        model_id=str(cap.get("model_id") or ""),
        operations=list(cap.get("operations") or []),
        supported=bool(cap.get("supported")),
        installed=bool(cap.get("installed")),
        downloaded=bool(cap.get("downloaded")),
        resident=bool(cap.get("resident")),
        min_memory_bytes=int(cap.get("min_memory_bytes") or 0),
        precision=str(cap.get("precision") or ""),
        derived_concurrency=clamp_concurrency(declared, allow_zero=True),
        cpu_fallback=bool(cap.get("cpu_fallback")),
        repo_ids=list(cap.get("repo_ids") or []),
        display_name=str(cap.get("display_name") or ""),
    )


def capability_from_pb(message: pb.ModelCapability) -> dict:
    return {
        "engine": message.engine,
        "model_id": message.model_id,
        "operations": list(message.operations),
        "supported": message.supported,
        "installed": message.installed,
        "downloaded": message.downloaded,
        "resident": message.resident,
        "min_memory_bytes": message.min_memory_bytes,
        "precision": message.precision,
        "derived_concurrency": clamp_concurrency(
            message.derived_concurrency, allow_zero=True
        ),
        "cpu_fallback": message.cpu_fallback,
        "repo_ids": list(message.repo_ids),
        "display_name": message.display_name,
    }


def host_to_pb(host: dict) -> pb.HostInfo:
    gpus = [
        pb.GpuInfo(
            vendor=str(g.get("vendor") or ""),
            model=str(g.get("model") or ""),
            backend=str(g.get("backend") or ""),
            memory_bytes=int(g.get("memory_bytes") or 0),
            free_memory_bytes=int(g.get("free_memory_bytes") or 0),
            driver_version=str(g.get("driver_version") or ""),
            compute_capability=str(g.get("compute_capability") or ""),
        )
        for g in (host.get("gpus") or [])
    ]
    return pb.HostInfo(
        hostname=str(host.get("hostname") or ""),
        os=str(host.get("os") or ""),
        arch=str(host.get("arch") or ""),
        worker_version=str(host.get("worker_version") or ""),
        cpu_count=int(host.get("cpu_count") or 0),
        system_memory_bytes=int(host.get("system_memory_bytes") or 0),
        gpus=gpus,
    )


def host_from_pb(message: pb.HostInfo) -> dict:
    return {
        "hostname": message.hostname,
        "os": message.os,
        "arch": message.arch,
        "worker_version": message.worker_version,
        "cpu_count": message.cpu_count,
        "system_memory_bytes": message.system_memory_bytes,
        "gpus": [
            {
                "vendor": g.vendor,
                "model": g.model,
                "backend": g.backend,
                "memory_bytes": g.memory_bytes,
                "free_memory_bytes": g.free_memory_bytes,
                "driver_version": g.driver_version,
                "compute_capability": g.compute_capability,
            }
            for g in message.gpus
        ],
    }


def priority_from_pb(value: int) -> PriorityClass:
    try:
        return PriorityClass(value)
    except ValueError:
        return PriorityClass.BATCH


__all__ = [
    "assignment_to_pb",
    "capability_from_pb",
    "capability_to_pb",
    "deadlines_to_pb",
    "error_from_pb",
    "error_to_pb",
    "host_from_pb",
    "host_to_pb",
    "input_ref",
    "priority_from_pb",
    "remote_params",
    "ref_for",
    "task_ref",
]
