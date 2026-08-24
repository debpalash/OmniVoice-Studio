"""One door to a GPU — this machine's, or the one the user picked.

Every GPU call in this app used to be the same three lines inlined at ~30 call
sites: resolve a backend, ``run_on_gpu_pool_guarded`` it, translate the pool's
exceptions into an HTTP answer. That shape has exactly one destination baked
into it, so "run this on my 4090" could never be more than a badge. This module
is the seam that makes the destination a *parameter*:

    decision = gpu_gateway.decide("tts")          # local, or the chosen worker
    await gpu_gateway.prewarm("tts", backend=b, decision=decision)
    audio = await gpu_gateway.run("tts", local=..., remote=..., decision=decision)

Four calls, and each of them answers for both targets:

  * :func:`prewarm` — the model-load budget
  * :func:`run`     — the generate budget
  * :func:`status`  — supported / installed / downloaded / resident
  * :func:`download` — fetching weights

Design decisions that are load-bearing, and why they are not obvious:

**``prewarm`` and ``run`` are separate calls.** Collapsing them loses the
two-phase split documented at ``tts_backend.ensure_ready`` (#1033/#1037): a cold
adapter that loads lazily inside ``generate()`` spends the *generate* budget on
a multi-GB download and dies with "too heavy for the available compute". The
protocol mirrors the same split (``TaskModelLoading`` and
``Deadlines.model_load_seconds``), so keeping the two calls apart is what lets
one policy serve both targets.

**The local branch calls ``run_on_gpu_pool_guarded``; the remote branch does
not.** That function means "submit a zero-arg blocking callable to the local
thread pool". Its error taxonomy (``GpuPoolBusyError`` / ``GpuJobTimeoutError``,
plus a pool ``reset()``) describes local saturation, and its ``started.set()``
handshake is a second timeout regime that would race the attempt ``Deadlines``.
A remote job is bounded by the lease and the phase budgets instead.

**This is not a ``RemoteBackend(TTSBackend)``.** ``generate()`` is synchronous
and returns a tensor, so a remote implementation would block a pool thread on
an async round-trip *while holding a GPU-pool slot* — a hard deadlock at
``OMNIVOICE_GPU_WORKERS=1``, which is the default on the machines that most
want to offload. It would also cover none of the non-TTS GPU work.

**Admission control lives here.** ``check_gpu_admission`` reads *local* pool
stats; called unconditionally it would answer 429 "the local GPU pool is
saturated" while the remote 4090 sat idle. It runs on the local branch only.

**Fallback is three rules, not one** (see ``worker/routing.py``'s header):

  1. *Pre-dispatch* unavailability — the worker is offline, disabled, paused,
     the queue is full, or nothing ever accepted the task — runs locally,
     quietly, with the named reason. Nothing ran remotely, so nothing is lost.
  2. *Mid-job* failure on a single-shot interactive op raises
     :class:`RemoteJobFailed`. Silently redoing minutes of work on the slower
     machine, with no explanation, is not a kindness.
  3. *Multi-unit* jobs (audiobook chapters, batches) pass a :class:`JobRun`;
     after N consecutive remote failures the job latches local for the rest of
     its units and reports **one** aggregated notice, instead of 160 identical
     error rows because a 4090 went to sleep at chapter 40.
"""
from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from worker import routing
from worker.routing import LOCAL, Decision

logger = logging.getLogger("omnivoice.gateway")

# How often the awaiting coroutine samples a remote task to report coarse
# progress. Polling rather than `scheduler.on_change`: that listener list has
# no unregister (scheduler.py), so one subscription per job would leak for the
# life of the process.
_POLL_SECONDS = 0.5

# Consecutive remote failures a multi-unit job tolerates before it stops trying
# the remote worker. One is a blip (a dropped stream, a worker restart); two in
# a row is a machine that has gone away, and the remaining 160 chapters should
# not each pay a full deadline to discover that.
_MULTI_UNIT_FAILURE_LIMIT = 2

# Coarse phases the UI can render for a remote job. `workers.py`'s task view is
# poll-only, so without these a five-minute remote render shows the same bare
# spinner as a local one and looks wedged.
PHASE_QUEUED = "queued"
PHASE_LOADING = "loading"
PHASE_RUNNING = "running"
PHASE_UPLOADING = "uploading"


# ── Errors ─────────────────────────────────────────────────────────────────


class GatewayError(RuntimeError):
    """Base for every error this module raises on its own behalf."""


class ModelLoadTimeout(GatewayError):
    """A local engine did not finish loading inside the model-load budget."""


class ModelNotDownloaded(GatewayError):
    """The selected worker positively reported that required weights are absent."""

    def __init__(
        self, *, engine: str, repo_ids: list[str], target: str, target_label: str,
        downloadable: bool = True,
    ):
        super().__init__(f"This model is not downloaded on {target_label}.")
        self.engine = engine
        self.repo_ids = repo_ids
        self.target = target
        self.target_label = target_label
        self.downloadable = downloadable


class RemoteJobFailed(GatewayError):
    """Remote work started and then failed. Rule 2: this is not a fallback.

    Carries what a caller needs to offer "Run locally instead" — the same
    request with ``target=local`` — rather than a bare 500.
    """

    def __init__(
        self,
        message: str,
        *,
        worker_label: str = "",
        task_id: str = "",
        code: str = "",
        hint: str = "",
    ) -> None:
        super().__init__(message)
        self.worker_label = worker_label
        self.task_id = task_id
        self.code = code
        self.hint = hint
        # Nothing about this failure implicates the local machine, so a retry
        # here is genuinely likely to work. Callers surface it as one click.
        self.retry_local = True


class RemoteUnsupported(GatewayError):
    """Asked for something the remote path cannot do yet.

    Deliberately not a quiet local fallback: downloading weights onto *this*
    machine when the user asked for them on the 4090 is not the same operation,
    and pretending it is leaves the remote box exactly as unprepared as before.
    """


class _NotDispatched(Exception):
    """Internal: the remote target never started the work. Rule 1 applies."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


# ── Call descriptions ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class LocalCall:
    """The local branch: a zero-arg blocking callable for the GPU pool.

    ``fn`` must take no arguments — wrap with ``functools.partial``, exactly as
    ``run_on_gpu_pool_guarded`` already requires.
    """

    fn: Optional[Callable[[], Any]] = None
    what: str = "GPU job"
    timeout: Optional[float] = None
    queue_timeout: Optional[float] = None
    # The engine's declared VRAM floor; only shapes the timeout message.
    min_vram_gb: float = 0.0
    # Some remote-first callers cannot construct the local callable without
    # loading the very model they are trying to offload.  Prepare it only when
    # routing/fallback actually selects this machine.
    prepare: Optional[Callable[[], Any]] = None


@dataclass(frozen=True)
class RemoteResult:
    """A committed remote result, as this side holds it.

    The artifact is a path inside the control plane's own artifact directory —
    minted from the attempt record, never from anything on the wire.
    """

    task_id: str
    worker_id: str
    worker_label: str
    path: Optional[str] = None
    meta: dict = field(default_factory=dict)

    def read(self) -> bytes:
        if not self.path:
            raise RemoteJobFailed(
                f"{self.worker_label or 'The worker'} reported success but sent no audio.",
                worker_label=self.worker_label,
                task_id=self.task_id,
                code="RESULT_MISSING",
            )
        with open(self.path, "rb") as handle:
            return handle.read()


@dataclass(frozen=True)
class RemoteCall:
    """The remote branch: one task for the scheduler, and how to read it back.

    ``decode`` converts the committed artifact into whatever the local branch
    returns, so ``run`` has one return type regardless of where the work ran.
    Left unset for ``tts``/``clone`` it defaults to :func:`decode_audio_artifact`
    — the audio ops are the only ones with a remote producer today, and a
    caller that has to branch on the target has gained nothing from this module.
    """

    engine: str
    params: dict = field(default_factory=dict)
    operation: str = "tts"
    # Stable, opaque, engine-scoped ("indextts:default") — never a repo id or a
    # path. Empty means "any model this engine advertises".
    model_id: str = ""
    deadline_seconds: Optional[float] = None
    idempotency_key: Optional[str] = None
    decode: Optional[Callable[[RemoteResult], Any]] = None


# ── Multi-unit jobs (rule 3) ───────────────────────────────────────────────


class JobRun:
    """State for a job made of many units, so rule 3 can be applied once.

    Created per audiobook / batch / dub run and passed to every ``run`` call it
    makes. It counts *consecutive* remote failures — an intermittent blip
    should not permanently demote a working worker — and latches local once the
    limit is reached, because the alternative is paying a full remote deadline
    per remaining unit to rediscover the same dead machine.
    """

    def __init__(self, op: str, *, limit: int = _MULTI_UNIT_FAILURE_LIMIT) -> None:
        self.op = op
        self.limit = max(1, int(limit))
        self.consecutive_failures = 0
        self.remote_failures = 0
        self.local_units = 0
        self.remote_units = 0
        self.latched_local = False
        self.worker_label = ""
        self.last_reason = ""

    def record_success(self) -> None:
        self.consecutive_failures = 0
        self.remote_units += 1

    def record_failure(self, reason: str, *, worker_label: str = "") -> bool:
        """Charge one failed unit. ``True`` if this unit may fall back locally.

        Always true today: the first failed unit already falls back rather than
        failing the row, and the counter decides whether *later* units still try
        the worker at all.
        """
        self.consecutive_failures += 1
        self.remote_failures += 1
        self.last_reason = reason
        self.worker_label = worker_label or self.worker_label
        if self.consecutive_failures >= self.limit:
            self.latched_local = True
        return True

    def record_local(self) -> None:
        self.local_units += 1

    def notice(self) -> Optional[tuple[str, str]]:
        """The single aggregated notice for the whole job, or ``None``."""
        if not self.remote_failures:
            return None
        who = self.worker_label or "the remote worker"
        if self.latched_local:
            return (
                "local_fallback",
                f"{who} failed {self.remote_failures} time(s) "
                f"({self.last_reason}) — the rest of this job ran locally.",
            )
        return (
            "local_fallback",
            f"{self.remote_failures} item(s) ran locally after {who} failed "
            f"({self.last_reason}).",
        )


# ── Routing ────────────────────────────────────────────────────────────────


def decide(op: str, *, control_plane=None) -> Decision:
    """Where this job runs, decided **once**.

    Callers pass the result to ``prewarm`` and ``run`` rather than calling this
    per step: the target is user-settable at any moment, and a decision that
    flipped between the two would either warm an engine nothing will use or
    dispatch remotely after paying a local cold load.
    """
    return routing.decide(control_plane, op=op)


def notice_for(decision: Decision) -> Optional[tuple[str, str]]:
    """``(status, reason)`` for the ``X-OmniVoice-Routing`` header channel.

    Same two-tuple shape ``engine_routing.routing_notice`` produces, so the
    existing header plumbing and the de-duped toast at ``routingNotice.js``
    carry it without a second channel. ``None`` when there is nothing to say —
    a user who chose Local does not need to be told their audio ran locally.
    """
    if decision.remote:
        return ("remote", f"running on {decision.label}")
    if decision.reason and decision.reason != "chosen":
        return ("local_fallback", decision.reason)
    return None


# ── Prewarm: the model-load budget ─────────────────────────────────────────


async def prewarm(
    op: str,
    *,
    backend=None,
    engine: str = "",
    decision: Optional[Decision] = None,
    timeout: Optional[float] = None,
    executor=None,
    control_plane=None,
) -> Decision:
    """Make the model ready under the LOAD budget, on whichever GPU will run it.

    Returns the decision so the caller can hand the *same* one to :func:`run`.

    On the remote branch this deliberately does nothing local. Warming an
    engine here before dispatching to another machine costs minutes and VRAM on
    the box that is not doing the work; the worker loads under its own
    ``model_load_seconds`` and reports ``TaskModelLoading`` while it does, which
    is the whole point of the phase existing on the wire.
    """
    decision = decision or decide(op, control_plane=control_plane)
    if decision.remote:
        await preflight(engine, decision, control_plane=control_plane)
        plane = _plane(control_plane)
        if engine and plane is not None and getattr(plane, "servicer", None) is not None:
            await plane.servicer.prewarm(decision.worker_id, engine=engine)
        return decision
    if backend is None:
        # The native model path warms itself through `model_manager.get_model`;
        # there is nothing engine-shaped to call.
        return decision

    call = LocalCall(
        backend.ensure_ready,
        what=f"TTS engine '{engine or getattr(backend, 'engine_id', '') or 'model'}' model load",
        timeout=timeout if timeout is not None else _model_load_timeout(),
    )
    try:
        await _run_local(call, executor=executor)
    except TimeoutError as exc:
        # Builtin TimeoutError, not GpuJobTimeoutError — reload-proof class
        # identity, the same catch generation.py and openai_compat.py use.
        # GpuPoolBusyError is a TimeoutError too and means the opposite thing
        # (the load never started, nothing was spent, retry as-is); it is
        # identified by its `retry_after` rather than by class, so a module
        # reload cannot turn saturation into a bogus load timeout.
        if hasattr(exc, "retry_after"):
            raise
        raise ModelLoadTimeout(
            f"{call.what} did not finish within its budget. The first load of an "
            f"engine can include a multi-GB download; check the connection or set "
            f"a Hugging Face mirror in Settings, then retry."
        ) from exc
    return decision


# ── Run: the generate budget ───────────────────────────────────────────────


async def run(
    op: str,
    *,
    local: LocalCall,
    remote: Optional[RemoteCall] = None,
    decision: Optional[Decision] = None,
    job: Optional[JobRun] = None,
    admit: bool = False,
    on_state: Optional[Callable[[dict], None]] = None,
    executor=None,
    control_plane=None,
) -> Any:
    """Run one unit of GPU work, here or on the chosen worker.

    ``local`` is always required — it is both the local branch and the landing
    ground for rules 1 and 3, and a gateway that could not run anything locally
    would turn every offline worker into a failed request.
    """
    if job is not None and job.latched_local:
        decision = Decision(remote=False, reason=job.last_reason or "the remote worker failed")
    decision = decision or decide(op, control_plane=control_plane)

    if decision.remote and remote is not None:
        try:
            value = await _run_remote(
                remote, decision, on_state=on_state, control_plane=control_plane
            )
        except _NotDispatched as exc:
            # Rule 1. Nothing ran remotely, so this is the quiet fallback the
            # picker already promises — no compute was spent anywhere.
            logger.info("Remote dispatch declined (%s); running locally", exc.reason)
            if job is not None:
                job.record_local()
            return await _run_local(local, admit=admit, executor=executor)
        except RemoteJobFailed as exc:
            # Rules 2 and 3. Work started on the worker and did not finish.
            if job is None:
                raise
            job.record_failure(str(exc), worker_label=exc.worker_label)
            logger.warning(
                "Remote unit failed on %s (%s); running this unit locally",
                exc.worker_label or "the worker", exc,
            )
            job.record_local()
            return await _run_local(local, admit=admit, executor=executor)
        if job is not None:
            job.record_success()
        return value

    if job is not None:
        job.record_local()
    return await _run_local(local, admit=admit, executor=executor)


async def _run_local(call: LocalCall, *, admit: bool = False, executor=None) -> Any:
    """The local branch: admission, then the guarded pool."""
    if call.prepare is not None:
        prepared = await call.prepare()
        if not isinstance(prepared, LocalCall):
            raise TypeError("LocalCall.prepare must return a LocalCall")
        return await _run_local(prepared, admit=admit, executor=executor)
    if call.fn is None:
        raise TypeError("LocalCall requires fn or prepare")
    from services.model_manager import (  # noqa: PLC0415 — torch lives down here
        check_gpu_admission,
        run_on_gpu_pool_guarded,
    )

    if admit:
        # Only ever on this branch: these are local pool statistics, and a 429
        # about local saturation while the remote GPU idles is a lie.
        check_gpu_admission(what=call.what, executor=executor)
    return await run_on_gpu_pool_guarded(
        call.fn,
        what=call.what,
        timeout=call.timeout,
        queue_timeout=call.queue_timeout,
        min_vram_gb=call.min_vram_gb,
        executor=executor,
    )


async def _run_remote(
    call: RemoteCall,
    decision: Decision,
    *,
    on_state: Optional[Callable[[dict], None]] = None,
    control_plane=None,
) -> Any:
    """The remote branch: submit, await, decode.

    Raises ``_NotDispatched`` while nothing has run yet (rule 1) and
    :class:`RemoteJobFailed` once a worker accepted the work (rules 2/3). That
    boundary is the whole fallback policy: "no compute was spent" is the only
    honest licence to silently redo the job somewhere else.
    """
    from worker.scheduler import QueueFull, SchedulerStopped  # noqa: PLC0415

    plane = _plane(control_plane)
    if plane is None or not getattr(plane, "running", False):
        raise _NotDispatched("remote workers are turned off")
    scheduler = plane.scheduler
    if scheduler is None:
        raise _NotDispatched("the control plane has no scheduler")

    await preflight(call.engine, decision, call.model_id, control_plane=plane)

    params = dict(call.params or {})
    deadline = call.deadline_seconds
    if deadline is None:
        deadline = _default_deadline(call.operation, params.get("text"))

    try:
        submit = getattr(scheduler, "submit_async", None)
        submit = submit if callable(submit) else scheduler.submit
        submitted = submit(
            operation=call.operation,
            engine=call.engine,
            model_id=call.model_id,
            params=params,
            idempotency_key=call.idempotency_key,
            deadline_seconds=deadline,
            pinned_worker_id=decision.worker_id,
        )
        task = await submitted if asyncio.iscoroutine(submitted) else submitted
    except QueueFull as exc:
        raise _NotDispatched(str(exc)) from exc

    _emit(on_state, {"phase": PHASE_QUEUED, "progress": 0.0, "stage": "",
                     "worker": decision.label, "task_id": task.task_id})
    try:
        settled = await _await_task(
            scheduler, task.task_id, timeout=deadline,
            on_state=on_state, label=decision.label,
            control_plane=plane,
        )
    except KeyError as exc:
        # The scheduler no longer holds the task (purged, or restored into a
        # different instance). Nothing ran here, so rule 1 applies.
        raise _NotDispatched("the remote task was dropped before it ran") from exc
    except SchedulerStopped as exc:
        raise _classify(scheduler.get(task.task_id) or task, str(exc), decision) from exc
    except TimeoutError as exc:
        raise _classify(
            scheduler.get(task.task_id) or task,
            f"it did not finish within {float(deadline):g}s",
            decision,
        ) from exc

    return _decode(call, settled, decision)


async def preflight(
    engine: str,
    decision: Decision,
    model_id: str = "",
    *,
    control_plane=None,
) -> None:
    """Refuse a positively absent remote model before scheduler admission.

    ``downloaded`` predates ``repo_ids`` on the wire.  A worker in the
    protocol compatibility window can therefore prove absence while lacking
    the newer field that names the download.  Recover catalog ids for that
    case; an absent/unknown ``downloaded`` fact still fails open.
    """
    if not engine:
        return
    target = await status(engine, decision=decision, control_plane=control_plane)
    for cap in target["models"]:
        if model_id and cap.get("model_id") not in (model_id, "", None):
            continue
        if cap.get("downloaded") is False:
            repo_ids = list(cap.get("repo_ids") or [])
            if not repo_ids:
                from worker.capabilities import repo_ids_for  # noqa: PLC0415

                repo_ids = repo_ids_for({"id": engine})
            if not repo_ids:
                # Positive absence without a safe catalog target is actionable
                # only as "cannot run"; never invent a path or reject an
                # opaque/user-managed installation.
                return
            from services.sidecar_install import SPECS  # noqa: PLC0415

            sidecar_repos = {s.weights_repo_id for s in SPECS.values()}
            raise ModelNotDownloaded(
                engine=engine,
                repo_ids=repo_ids,
                target=decision.worker_id,
                target_label=decision.label,
                downloadable=not any(repo in sidecar_repos for repo in repo_ids),
            )


async def _await_task(
    scheduler, task_id: str, *, timeout: float, on_state, label: str, control_plane=None
):
    """Await a terminal task, reporting coarse progress, cancelling if we leave.

    Every exit that is not a terminal task cancels the remote task, because a
    worker holds its slot — often its only one — until this side says
    otherwise, and the sweeper only enforces deadlines on tasks that are still
    queued. Without this, ``useTTS.js``'s AbortController abandons the request
    while the 4090 keeps rendering audio nobody will ever read.

    The one exception is shutdown: ``SchedulerStopped`` means this side is
    quitting, the worker was never told to stop and may still be rendering, so
    recording a cancellation would be a claim about someone else's GPU that we
    are in no position to make.
    """
    from worker.scheduler import SchedulerStopped  # noqa: PLC0415

    waiter = asyncio.ensure_future(scheduler.wait(task_id, timeout=timeout))
    last: Optional[tuple] = None
    try:
        while True:
            done, _pending = await asyncio.wait({waiter}, timeout=_POLL_SECONDS)
            if not done:
                last = _report(scheduler, task_id, on_state, label, last)
                continue
            # Raises here for a deadline or a shutdown; both are handled below.
            return waiter.result()
    except SchedulerStopped:
        waiter.cancel()
        raise
    except asyncio.CancelledError:
        waiter.cancel()
        await _cancel(control_plane, scheduler, task_id, "the client stopped waiting")
        raise
    except BaseException:
        waiter.cancel()
        await _cancel(control_plane, scheduler, task_id, "the task passed its deadline")
        raise


def _report(scheduler, task_id: str, on_state, label: str, last: Optional[tuple]):
    """Emit a coarse phase when it changes. Never raises."""
    if on_state is None:
        return last
    try:
        task = scheduler.get(task_id)
    except Exception:
        return last
    if task is None:
        return last
    attempt = task.active_attempt
    phase = _PHASES.get(getattr(task.state, "value", ""), PHASE_QUEUED)
    progress = round(float(getattr(attempt, "progress", 0.0) or 0.0), 2)
    stage = getattr(attempt, "stage", "") or ""
    current = (phase, progress, stage)
    if current == last:
        return last
    _emit(on_state, {"phase": phase, "progress": progress, "stage": stage,
                     "worker": label, "task_id": task_id})
    return current


_PHASES = {
    "queued": PHASE_QUEUED,
    "assigned": PHASE_QUEUED,
    "accepted": PHASE_QUEUED,
    "model_loading": PHASE_LOADING,
    "running": PHASE_RUNNING,
    "result_uploading": PHASE_UPLOADING,
}


def _emit(on_state, payload: dict) -> None:
    if on_state is None:
        return
    try:
        on_state(payload)
    except Exception:
        logger.debug("Remote progress listener failed", exc_info=True)


async def _cancel(control_plane, scheduler, task_id: str, reason: str) -> None:
    try:
        if control_plane is not None and hasattr(control_plane, "cancel"):
            await control_plane.cancel(task_id, reason=reason)
        else:
            scheduler.cancel(task_id, reason=reason)
    except Exception:
        logger.exception("Could not cancel abandoned remote task %s", task_id)


def _decode(call: RemoteCall, task, decision: Decision) -> Any:
    """Turn a settled task into the local branch's return value, or fail."""
    state = getattr(task.state, "value", str(task.state))
    if state != "completed":
        raise _classify(task, _reason(task), decision)

    result = RemoteResult(
        task_id=task.task_id,
        worker_id=decision.worker_id or "",
        worker_label=decision.label,
        path=task.result_ref,
        meta={"engine": task.engine, "model_id": task.model_id},
    )
    if result.path is None or not os.path.exists(result.path):
        # Completed with nothing to read. Treated as a mid-job failure, not a
        # quiet fallback: the worker spent the compute, and a caller told
        # "nothing ran" would be misled about where its minutes went.
        raise RemoteJobFailed(
            f"{decision.label} finished the job but its audio did not arrive.",
            worker_label=decision.label,
            task_id=task.task_id,
            code="RESULT_MISSING",
            hint="Run it locally instead, or check the worker's connection.",
        )
    decoder = call.decode or (
        decode_audio_artifact if call.operation in ("tts", "clone") else None
    )
    if decoder is None:
        return result
    try:
        return decoder(result)
    except RemoteJobFailed:
        raise
    except Exception as exc:  # noqa: BLE001 — any decode failure is one class
        # A truncated or unreadable artifact is a mid-job failure, not a quiet
        # fallback: the compute happened, and a multi-unit job must be able to
        # count it against the worker like any other.
        raise RemoteJobFailed(
            f"{decision.label} returned audio this app could not read: {exc}",
            worker_label=decision.label,
            task_id=task.task_id,
            code="RESULT_UNREADABLE",
        ) from exc


def _classify(task, reason: str, decision: Decision):
    """``_NotDispatched`` while nothing ran; ``RemoteJobFailed`` once it did."""
    error = getattr(task, "error", None)
    code = getattr(error, "code", "") or ""
    # An explicit target is a user choice, not permission to leak onto local
    # compute when that machine is asleep. Preserve the scheduler's named
    # pinned verdict even though no worker accepted the attempt.
    if not _work_started(task) and not code.startswith("PINNED_WORKER_"):
        return _NotDispatched(reason)
    return RemoteJobFailed(
        f"{decision.label} did not finish this job: {reason}",
        worker_label=decision.label,
        task_id=task.task_id,
        code=code,
        hint=getattr(error, "hint", "") or "",
    )


def _work_started(task) -> bool:
    """Did any worker actually accept this task?

    ``accepted_at`` rather than "an attempt exists": an assignment that was
    rejected for capacity, or that died in a dispatch race before the worker
    answered, cost nothing anywhere and is exactly the case rule 1 exists for.
    """
    for attempt in getattr(task, "attempts", []) or []:
        if getattr(attempt, "accepted_at", None) is not None:
            return True
        if getattr(attempt, "started_at", None) is not None:
            return True
    return False


def _reason(task) -> str:
    error = getattr(task, "error", None)
    message = getattr(error, "message", "") if error is not None else ""
    if message:
        return message
    state = getattr(task.state, "value", str(task.state))
    return {
        "cancelled": "the task was cancelled",
        "timeout": "the task passed its deadline",
    }.get(state, "the task failed")


def decode_audio_artifact(result: RemoteResult):
    """``(waveform, sample_rate)`` from a remote WAV artifact.

    The local branch returns a tensor plus the engine's ``sample_rate``; this
    returns the same pair read from the artifact's own header rather than from
    an assumed 24 kHz — VoxCPM2 renders at 48 kHz, and guessing plays it back
    at half speed.
    """
    import io  # noqa: PLC0415

    import soundfile as sf  # noqa: PLC0415

    data, sample_rate = sf.read(io.BytesIO(result.read()), dtype="float32", always_2d=False)
    try:
        import torch  # noqa: PLC0415

        waveform = torch.from_numpy(data)
    except Exception:  # noqa: BLE001 — a torch-less host still gets its audio
        waveform = data
    return waveform, int(sample_rate)


# ── Status: what each target can actually run ──────────────────────────────


async def status(
    engine: Optional[str] = None,
    *,
    decision: Optional[Decision] = None,
    op: str = "tts",
    control_plane=None,
) -> dict:
    """The four facts per model — supported / installed / downloaded / resident
    — for whichever machine would run the work.

    One shape for both targets, from one producer: ``worker.capabilities``
    already derives them from ``tts_backend`` for the local host, and a remote
    worker reports the same records through ``Register``. Asking the local
    engine layer about a remote machine is how a UI ends up offering an engine
    that only exists here.
    """
    decision = decision or decide(op, control_plane=control_plane)
    if not decision.remote:
        return {
            "target": LOCAL,
            "remote": False,
            "label": decision.label,
            "reason": decision.reason,
            "models": _filtered(_local_capabilities(), engine),
        }

    plane = _plane(control_plane)
    worker = None
    pool = getattr(plane, "pool", None) if plane is not None else None
    if pool is not None:
        worker = pool.get(decision.worker_id)
    if worker is None:
        # Reachability changed between decide() and here.
        return {
            "target": decision.worker_id or LOCAL,
            "remote": False,
            "label": decision.label,
            "reason": "the chosen worker is not connected",
            "models": _filtered(_local_capabilities(), engine),
        }
    return {
        "target": decision.worker_id,
        "remote": True,
        "label": decision.label,
        "reason": decision.reason,
        "models": _filtered(list(worker.record.capabilities or []), engine),
    }


def _local_capabilities() -> list[dict]:
    from worker import capabilities  # noqa: PLC0415

    return capabilities.discover(include_unavailable=True)


def _filtered(models: list[dict], engine: Optional[str]) -> list[dict]:
    if not engine:
        return models
    return [m for m in models if m.get("engine") == engine]


# ── Download: weights, onto the machine that needs them ────────────────────


async def download(
    repo_id: str,
    *,
    decision: Optional[Decision] = None,
    op: str = "tts",
    control_plane=None,
) -> dict:
    """Fetch a catalog model onto the target machine.

    Remote downloads are not implemented yet, and this refuses rather than
    falling back: downloading onto *this* machine when the user asked for the
    weights on the 4090 leaves the remote box exactly as unprepared, having
    reported success.
    """
    decision = decision or decide(op, control_plane=control_plane)
    if decision.remote:
        plane = _plane(control_plane)
        if plane is None or getattr(plane, "servicer", None) is None:
            raise RemoteUnsupported(f"{decision.label} is not connected.")
        live = plane.pool.get(decision.worker_id) if plane.pool is not None else None
        capability = next(
            (
                cap for cap in (live.record.capabilities if live is not None else [])
                if repo_id in (cap.get("repo_ids") or [])
            ),
            None,
        )
        if capability is None:
            raise GatewayError(f"Unknown model for {decision.label}: {repo_id!r}.")
        # Managed sidecars currently fetch mutable source HEAD before installing
        # editable code. Do not make that supply-chain path remotely triggerable.
        from services.sidecar_install import SPECS  # noqa: PLC0415

        if any(spec.weights_repo_id == repo_id for spec in SPECS.values()):
            raise GatewayError(
                f"{repo_id!r} must be installed directly on {decision.label}; "
                "remote sidecar installation is disabled."
            )
        sent = await plane.servicer.prewarm(
            decision.worker_id,
            engine=str(capability.get("engine") or ""),
            model_id=str(capability.get("model_id") or ""),
            download_if_missing=True,
        )
        if not sent:
            raise RemoteUnsupported(f"{decision.label} is not connected.")
        return {"status": "started", "repo_id": repo_id, "target": decision.worker_id}

    from api.routers.setup.download import (  # noqa: PLC0415
        InstallModelRequest,
        install_model,
    )
    from api.routers.setup.models import KNOWN_MODELS  # noqa: PLC0415

    if repo_id not in {m.get("repo_id") for m in KNOWN_MODELS}:
        # The wire and the UI both carry catalog ids only; anything else is a
        # path by another name, and paths are what the protocol forbids.
        raise GatewayError(f"Unknown model: {repo_id!r}.")
    return await install_model(InstallModelRequest(repo_id=repo_id, target="local"))


# ── Plumbing ───────────────────────────────────────────────────────────────


def _plane(control_plane=None):
    if control_plane is not None:
        return control_plane
    try:
        from worker.service import control_plane as default_plane  # noqa: PLC0415

        return default_plane
    except Exception:
        logger.debug("No control plane available", exc_info=True)
        return None


def _default_deadline(operation: str, text: Optional[str]) -> float:
    """Worst-case wall time for one attempt, from the shared deadline policy.

    Same budget the assignment itself carries, so the awaiting side cannot give
    up on a worker that is still inside the time this side granted it.
    """
    from worker import deadlines  # noqa: PLC0415

    return float(deadlines.for_task(operation, text=text).total_seconds)


def _model_load_timeout() -> float:
    from services.model_manager import _model_load_timeout as resolve  # noqa: PLC0415

    return float(resolve())


__all__ = [
    "GatewayError",
    "ModelNotDownloaded",
    "JobRun",
    "LOCAL",
    "LocalCall",
    "ModelLoadTimeout",
    "RemoteCall",
    "RemoteJobFailed",
    "RemoteResult",
    "RemoteUnsupported",
    "decide",
    "decode_audio_artifact",
    "download",
    "notice_for",
    "preflight",
    "prewarm",
    "run",
    "status",
]
