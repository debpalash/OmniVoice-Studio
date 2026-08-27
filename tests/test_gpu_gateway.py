"""The single door to a GPU: same call, either machine, honest fallback.

Three properties carry this module, and each of them was a real defect before
the gateway existed:

  * **The target is a parameter.** One decision governs prewarm and run, so a
    job cannot pay a local model load and then dispatch remotely.
  * **Fallback is three rules.** Nothing-ran falls back quietly; work-that-ran
    raises; a multi-unit job falls back per unit and latches after N.
  * **Local-only policy stays on the local branch.** `check_gpu_admission`
    reads local pool statistics, so under a remote target it would answer 429
    about local saturation while the chosen GPU sat idle.
"""
from __future__ import annotations

import asyncio
import io
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from services import gpu_gateway
from worker.errors import ErrorClass, WorkerError
from worker.lifecycle import Attempt, AttemptState, Task, TaskState
from worker.routing import Decision

REMOTE = Decision(remote=True, worker_id="abc123456789", label="gpu2", reason="chosen")
LOCAL_CHOSEN = Decision(remote=False, reason="chosen")
LOCAL_FALLBACK = Decision(remote=False, reason="gpu2 is offline — running locally")


# ── Fakes ──────────────────────────────────────────────────────────────────


class FakeScheduler:
    """Enough scheduler to exercise submit / wait / cancel / get."""

    def __init__(self, *, outcome="completed", result_ref=None, started=True,
                 error=None, raises=None, delay=0.0):
        self.outcome = outcome
        self.result_ref = result_ref
        self.started = started
        self.error = error
        self.raises = raises
        self.delay = delay
        self.tasks: dict[str, Task] = {}
        self.submitted: list[dict] = []
        self.cancelled: list[tuple[str, str]] = []

    def submit(self, **kwargs):
        self.submitted.append(kwargs)
        task = Task(
            task_id=f"t{len(self.submitted)}",
            operation=kwargs["operation"],
            engine=kwargs["engine"],
            model_id=kwargs.get("model_id") or "",
            params=kwargs.get("params") or {},
        )
        self.tasks[task.task_id] = task
        return task

    def get(self, task_id):
        return self.tasks.get(task_id)

    def cancel(self, task_id, reason=""):
        self.cancelled.append((task_id, reason))
        return True

    async def wait(self, task_id, timeout=None):
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.raises is not None:
            raise self.raises
        task = self.tasks[task_id]
        attempt = Attempt(
            attempt_id="a1", task_id=task_id, worker_id="abc123456789",
            session_epoch=1, attempt_number=1,
        )
        if self.started:
            # Accepting is what makes a failure "mid-job" — the boundary the
            # whole fallback policy turns on.
            attempt.accepted_at = 100.0
            attempt.state = AttemptState.RUNNING
        task.attempts.append(attempt)
        task.state = {
            "completed": TaskState.COMPLETED,
            "failed": TaskState.FAILED,
            "timeout": TaskState.TIMEOUT,
            "cancelled": TaskState.CANCELLED,
        }[self.outcome]
        task.result_ref = self.result_ref
        task.error = self.error
        return task


class FakePlane:
    def __init__(self, scheduler=None, running=True, pool=None):
        self.running = running
        self.scheduler = scheduler
        self.pool = pool


class FakePool:
    def __init__(self, worker=None):
        self._worker = worker

    def get(self, worker_id):
        return self._worker


class CapabilityWorker:
    class Record:
        def __init__(self):
            self.capabilities = [{
                "engine": "indextts", "model_id": "indextts:default",
                "supported": True, "installed": True, "downloaded": False,
                "repo_ids": ["IndexTeam/IndexTTS-2"], "operations": ["tts"],
            }]

    def __init__(self):
        self.record = self.Record()


def test_capability_workers_do_not_share_mutable_records():
    first = CapabilityWorker()
    second = CapabilityWorker()
    first.record.capabilities.clear()
    assert second.record.capabilities


def local_call(value="local", *, boom=None):
    def _fn():
        if boom is not None:
            raise boom
        return value

    return gpu_gateway.LocalCall(_fn, what="TTS generate")


def remote_call(**kw):
    kw.setdefault("engine", "indextts")
    kw.setdefault("params", {"text": "hello"})
    kw.setdefault("decode", lambda result: "remote")
    return gpu_gateway.RemoteCall(**kw)


@pytest.fixture
def pool_executor():
    ex = ThreadPoolExecutor(max_workers=1)
    yield ex
    ex.shutdown(wait=False)


def wav_bytes(seconds=0.25, sample_rate=48_000):
    import numpy as np
    import soundfile as sf

    samples = np.zeros(int(seconds * sample_rate), dtype="float32")
    buffer = io.BytesIO()
    sf.write(buffer, samples, sample_rate, format="WAV")
    return buffer.getvalue()


# ── The local branch ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_local_target_runs_on_the_pool(pool_executor):
    value = await gpu_gateway.run(
        "tts", local=local_call("audio"), remote=remote_call(),
        decision=LOCAL_CHOSEN, executor=pool_executor,
    )
    assert value == "audio"


@pytest.mark.asyncio
async def test_admission_is_local_only(tmp_path, pool_executor, monkeypatch):
    """A remote target must never be refused for LOCAL pool saturation.

    `check_gpu_admission` reads local queue depth; calling it on the remote
    branch answers "the local GPU worker pool is saturated" while the chosen
    4090 is idle — the exact 429 the gateway exists to stop.
    """
    calls = []
    monkeypatch.setattr(
        "services.model_manager.check_gpu_admission",
        lambda **kw: calls.append(kw),
    )
    artifact = tmp_path / "a1.bin"
    artifact.write_bytes(b"wav")
    plane = FakePlane(FakeScheduler(result_ref=str(artifact)))

    await gpu_gateway.run(
        "tts", local=local_call(), remote=remote_call(), decision=REMOTE,
        admit=True, control_plane=plane, executor=pool_executor,
    )
    assert calls == []

    await gpu_gateway.run(
        "tts", local=local_call(), decision=LOCAL_CHOSEN,
        admit=True, executor=pool_executor,
    )
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_gateway_input_staging_does_not_block_the_control_plane(
    tmp_path, monkeypatch
):
    from worker import task_store
    from worker.lifecycle import TaskState
    from worker.pool import WorkerPool
    from worker.scheduler import Scheduler

    scheduler = Scheduler(WorkerPool(), persist=True)
    stage_started = threading.Event()
    release_stage = threading.Event()
    staging_thread = []

    def blocked_create(task, **_kwargs):
        staging_thread.append(threading.current_thread())
        stage_started.set()
        assert release_stage.wait(timeout=2)
        return task

    async def no_preflight(*_args, **_kwargs):
        pass

    async def settle(active, task_id, **_kwargs):
        task = active.get(task_id)
        task.state = TaskState.COMPLETED
        result = tmp_path / "result.bin"
        result.write_bytes(b"result")
        task.result_ref = str(result)
        return task

    monkeypatch.setattr(task_store, "create", blocked_create)
    monkeypatch.setattr(gpu_gateway, "preflight", no_preflight)
    monkeypatch.setattr(gpu_gateway, "_await_task", settle)
    running = asyncio.create_task(
        gpu_gateway._run_remote(
            remote_call(decode=lambda result: result.task_id),
            REMOTE,
            control_plane=FakePlane(scheduler),
        )
    )
    while not stage_started.is_set():
        await asyncio.sleep(0)

    try:
        await asyncio.wait_for(asyncio.sleep(0), timeout=0.1)
        assert not running.done()
        assert len(staging_thread) == 1
        assert staging_thread[0] is not threading.current_thread()
    finally:
        release_stage.set()

    assert await running


@pytest.mark.asyncio
async def test_prewarm_skips_the_local_load_when_the_work_goes_remote():
    """Warming here before dispatching elsewhere costs minutes and VRAM on the
    machine that is not doing the work."""
    loaded = []

    class Backend:
        def ensure_ready(self):
            loaded.append(True)

    decision = await gpu_gateway.prewarm("tts", backend=Backend(), decision=REMOTE)
    assert decision is REMOTE
    assert loaded == []


@pytest.mark.asyncio
async def test_prewarm_loads_under_the_model_load_budget(pool_executor, monkeypatch):
    loaded = []

    class Backend:
        def ensure_ready(self):
            loaded.append(True)

    monkeypatch.setattr("services.model_manager._model_load_timeout", lambda: 30.0)
    await gpu_gateway.prewarm(
        "tts", backend=Backend(), engine="indextts",
        decision=LOCAL_CHOSEN, executor=pool_executor,
    )
    assert loaded == [True]


@pytest.mark.asyncio
async def test_prewarm_names_a_load_timeout(pool_executor, monkeypatch):
    class Backend:
        def ensure_ready(self):
            import time

            time.sleep(0.4)

    monkeypatch.setattr("services.model_manager._model_load_timeout", lambda: 0.05)
    with pytest.raises(gpu_gateway.ModelLoadTimeout):
        await gpu_gateway.prewarm(
            "tts", backend=Backend(), engine="indextts",
            decision=LOCAL_CHOSEN, executor=pool_executor,
        )


@pytest.mark.asyncio
async def test_prewarm_does_not_disguise_pool_saturation(pool_executor, monkeypatch):
    """GpuPoolBusyError is a TimeoutError, and means the opposite thing."""
    from services.model_manager import GpuPoolBusyError

    async def _busy(*a, **kw):
        raise GpuPoolBusyError("saturated", retry_after=12)

    monkeypatch.setattr("services.model_manager.run_on_gpu_pool_guarded", _busy)
    monkeypatch.setattr("services.model_manager._model_load_timeout", lambda: 30.0)

    class Backend:
        def ensure_ready(self):
            pass

    with pytest.raises(GpuPoolBusyError):
        await gpu_gateway.prewarm(
            "tts", backend=Backend(), decision=LOCAL_CHOSEN, executor=pool_executor
        )


# ── The remote branch ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_positive_missing_model_stops_before_submit():
    scheduler = FakeScheduler()
    plane = FakePlane(scheduler, pool=FakePool(CapabilityWorker()))
    with pytest.raises(gpu_gateway.ModelNotDownloaded) as caught:
        await gpu_gateway.run(
            "tts", local=local_call(), remote=remote_call(), decision=REMOTE,
            control_plane=plane,
        )
    assert scheduler.submitted == []
    assert caught.value.repo_ids == ["IndexTeam/IndexTTS-2"]


@pytest.mark.asyncio
async def test_legacy_positive_absence_without_repo_ids_stops_before_submit():
    """Phase-4 peers predate repo_ids but still positively report absence."""
    class Worker:
        class Record:
            capabilities = [{
                "engine": "cosyvoice", "model_id": "cosyvoice:default",
                "supported": True, "installed": True, "downloaded": False,
                "operations": ["tts"],
            }]
        record = Record()

    worker = Worker()
    scheduler = FakeScheduler()
    plane = FakePlane(scheduler, pool=FakePool(worker))

    with pytest.raises(gpu_gateway.ModelNotDownloaded) as caught:
        await gpu_gateway.run(
            "tts", local=local_call(), remote=remote_call(engine="cosyvoice"),
            decision=REMOTE, control_plane=plane,
        )

    assert scheduler.submitted == []
    assert caught.value.repo_ids == ["FunAudioLLM/Fun-CosyVoice3-0.5B-2512"]
    assert caught.value.target_label == "gpu2"


@pytest.mark.asyncio
async def test_missing_download_fact_fails_open(tmp_path):
    worker = CapabilityWorker()
    worker.record.capabilities = [{"engine": "indextts", "installed": True}]
    artifact = tmp_path / "a1.bin"
    artifact.write_bytes(b"ok")
    scheduler = FakeScheduler(result_ref=str(artifact))
    plane = FakePlane(scheduler, pool=FakePool(worker))
    assert await gpu_gateway.run(
        "tts", local=local_call(), remote=remote_call(decode=lambda r: r.read()),
        decision=REMOTE, control_plane=plane,
    ) == b"ok"


@pytest.mark.asyncio
async def test_remote_target_submits_and_decodes(tmp_path, pool_executor):
    artifact = tmp_path / "a1.bin"
    artifact.write_bytes(b"wav")
    scheduler = FakeScheduler(result_ref=str(artifact))
    plane = FakePlane(scheduler)

    value = await gpu_gateway.run(
        "tts",
        local=local_call("LOCAL RAN"),
        remote=remote_call(decode=lambda r: r.read()),
        decision=REMOTE, control_plane=plane, executor=pool_executor,
    )
    assert value == b"wav"
    assert scheduler.submitted[0]["engine"] == "indextts"
    assert scheduler.submitted[0]["deadline_seconds"] > 0
    assert scheduler.submitted[0]["pinned_worker_id"] == REMOTE.worker_id


@pytest.mark.asyncio
async def test_audio_decoder_reads_the_artifacts_own_sample_rate(tmp_path):
    """Assuming 24 kHz plays a 48 kHz engine back at half speed."""
    artifact = tmp_path / "a1.wav"
    artifact.write_bytes(wav_bytes(sample_rate=48_000))
    result = gpu_gateway.RemoteResult(
        task_id="t1", worker_id="w", worker_label="gpu2", path=str(artifact)
    )
    _waveform, sample_rate = gpu_gateway.decode_audio_artifact(result)
    assert sample_rate == 48_000


# ── Fallback rule 1: nothing ran, so run it here quietly ───────────────────


@pytest.mark.asyncio
async def test_control_plane_off_falls_back_quietly(pool_executor):
    value = await gpu_gateway.run(
        "tts", local=local_call("LOCAL"), remote=remote_call(),
        decision=REMOTE, control_plane=FakePlane(None, running=False),
        executor=pool_executor,
    )
    assert value == "LOCAL"


@pytest.mark.asyncio
async def test_queue_full_falls_back_quietly(pool_executor):
    from worker.scheduler import QueueFull

    class Full(FakeScheduler):
        def submit(self, **kwargs):
            raise QueueFull("the queue is full")

    value = await gpu_gateway.run(
        "tts", local=local_call("LOCAL"), remote=remote_call(),
        decision=REMOTE, control_plane=FakePlane(Full()), executor=pool_executor,
    )
    assert value == "LOCAL"


@pytest.mark.asyncio
async def test_failure_before_any_worker_accepted_falls_back_quietly(pool_executor):
    """A rejected or never-dispatched assignment cost nothing anywhere."""
    scheduler = FakeScheduler(outcome="failed", started=False)
    value = await gpu_gateway.run(
        "tts", local=local_call("LOCAL"), remote=remote_call(),
        decision=REMOTE, control_plane=FakePlane(scheduler), executor=pool_executor,
    )
    assert value == "LOCAL"


# ── Fallback rule 2: work ran, so say so ───────────────────────────────────


@pytest.mark.asyncio
async def test_mid_job_failure_raises_for_a_single_shot_op(pool_executor):
    scheduler = FakeScheduler(
        outcome="failed",
        error=WorkerError(
            error_class=ErrorClass.TIMEOUT, code="EXECUTION_TIMEOUT",
            message="Synthesis exceeded its budget", hint="try a shorter input",
        ),
    )
    with pytest.raises(gpu_gateway.RemoteJobFailed) as excinfo:
        await gpu_gateway.run(
            "tts", local=local_call("LOCAL"), remote=remote_call(),
            decision=REMOTE, control_plane=FakePlane(scheduler),
            executor=pool_executor,
        )
    assert excinfo.value.worker_label == "gpu2"
    assert excinfo.value.retry_local is True
    assert "Synthesis exceeded its budget" in str(excinfo.value)


@pytest.mark.asyncio
async def test_completed_without_an_artifact_is_a_failure_not_a_fallback(pool_executor):
    scheduler = FakeScheduler(outcome="completed", result_ref=None)
    with pytest.raises(gpu_gateway.RemoteJobFailed):
        await gpu_gateway.run(
            "tts", local=local_call("LOCAL"), remote=remote_call(),
            decision=REMOTE, control_plane=FakePlane(scheduler),
            executor=pool_executor,
        )


@pytest.mark.asyncio
async def test_unreadable_artifact_is_a_mid_job_failure(tmp_path, pool_executor):
    artifact = tmp_path / "a1.bin"
    artifact.write_bytes(b"not audio")
    scheduler = FakeScheduler(result_ref=str(artifact))
    with pytest.raises(gpu_gateway.RemoteJobFailed) as excinfo:
        await gpu_gateway.run(
            "tts", local=local_call(),
            remote=remote_call(decode=gpu_gateway.decode_audio_artifact),
            decision=REMOTE, control_plane=FakePlane(scheduler),
            executor=pool_executor,
        )
    assert excinfo.value.code == "RESULT_UNREADABLE"


# ── Fallback rule 3: per unit, then latch, with one notice ─────────────────


@pytest.mark.asyncio
async def test_multi_unit_job_falls_back_per_unit_and_latches(tmp_path, pool_executor):
    scheduler = FakeScheduler(outcome="failed")
    plane = FakePlane(scheduler)
    job = gpu_gateway.JobRun("tts")

    values = []
    for _ in range(4):
        values.append(
            await gpu_gateway.run(
                "tts", local=local_call("LOCAL"), remote=remote_call(),
                decision=REMOTE, job=job, control_plane=plane,
                executor=pool_executor,
            )
        )

    assert values == ["LOCAL"] * 4
    # Latched after two consecutive failures: the remaining units never paid
    # another remote deadline to rediscover the same dead machine.
    assert job.latched_local is True
    assert len(scheduler.submitted) == 2
    status, reason = job.notice()
    assert status == "local_fallback"
    assert "gpu2" in reason and "rest of this job ran locally" in reason


@pytest.mark.asyncio
async def test_one_bad_unit_does_not_demote_a_working_worker(tmp_path, pool_executor):
    artifact = tmp_path / "a1.bin"
    artifact.write_bytes(b"wav")
    scheduler = FakeScheduler(outcome="failed")
    plane = FakePlane(scheduler)
    job = gpu_gateway.JobRun("tts")

    await gpu_gateway.run(
        "tts", local=local_call("LOCAL"), remote=remote_call(),
        decision=REMOTE, job=job, control_plane=plane, executor=pool_executor,
    )
    scheduler.outcome = "completed"
    scheduler.result_ref = str(artifact)
    value = await gpu_gateway.run(
        "tts", local=local_call("LOCAL"), remote=remote_call(),
        decision=REMOTE, job=job, control_plane=plane, executor=pool_executor,
    )

    assert value == "remote"
    assert job.latched_local is False
    assert job.consecutive_failures == 0


def test_a_clean_job_has_nothing_to_say():
    job = gpu_gateway.JobRun("tts")
    job.record_success()
    assert job.notice() is None


# ── Abandonment ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_caller_cancellation_cancels_the_remote_task(pool_executor):
    """A worker holds its only slot until this side says otherwise."""
    scheduler = FakeScheduler(delay=5.0)
    plane = FakePlane(scheduler)

    task = asyncio.ensure_future(
        gpu_gateway.run(
            "tts", local=local_call(), remote=remote_call(),
            decision=REMOTE, control_plane=plane, executor=pool_executor,
        )
    )
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert [t for t, _ in scheduler.cancelled] == ["t1"]


@pytest.mark.asyncio
async def test_deadline_cancels_the_remote_task_and_reports_it(pool_executor):
    scheduler = FakeScheduler(raises=TimeoutError("deadline"), started=True)
    scheduler.tasks = {}
    plane = FakePlane(scheduler)

    with pytest.raises(gpu_gateway._NotDispatched):
        # No attempt was ever accepted, so rule 1 applies — but the task is
        # still cancelled, which is what stops an orphaned render.
        await gpu_gateway._run_remote(remote_call(), REMOTE, control_plane=plane)
    assert scheduler.cancelled and scheduler.cancelled[0][0] == "t1"


@pytest.mark.asyncio
async def test_shutdown_does_not_claim_someone_elses_gpu_stopped(pool_executor):
    from worker.scheduler import SchedulerStopped

    scheduler = FakeScheduler(raises=SchedulerStopped("the control plane stopped"))
    value = await gpu_gateway.run(
        "tts", local=local_call("LOCAL"), remote=remote_call(),
        decision=REMOTE, control_plane=FakePlane(scheduler), executor=pool_executor,
    )
    # Nothing had been accepted, so this side runs the work; and it never told
    # the worker anything, because it no longer can.
    assert value == "LOCAL"
    assert scheduler.cancelled == []


# ── Coarse progress ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_remote_progress_is_reported_by_phase(tmp_path, pool_executor, monkeypatch):
    """`workers.py` is poll-only, so without this a five-minute remote render
    shows the same bare spinner as a local one."""
    monkeypatch.setattr(gpu_gateway, "_POLL_SECONDS", 0.01)
    artifact = tmp_path / "a1.bin"
    artifact.write_bytes(b"wav")

    scheduler = FakeScheduler(result_ref=str(artifact), delay=0.08)
    plane = FakePlane(scheduler)

    seen: list[dict] = []

    async def _drive():
        return await gpu_gateway.run(
            "tts", local=local_call(), remote=remote_call(),
            decision=REMOTE, control_plane=plane, on_state=seen.append,
            executor=pool_executor,
        )

    runner = asyncio.ensure_future(_drive())
    await asyncio.sleep(0.03)
    task = scheduler.tasks["t1"]
    attempt = Attempt(
        attempt_id="a0", task_id="t1", worker_id="abc123456789",
        session_epoch=1, attempt_number=1, state=AttemptState.MODEL_LOADING,
    )
    task.attempts.append(attempt)
    task.state = TaskState.MODEL_LOADING
    await asyncio.sleep(0.05)
    await runner

    phases = [event["phase"] for event in seen]
    assert phases[0] == gpu_gateway.PHASE_QUEUED
    assert gpu_gateway.PHASE_LOADING in phases
    assert all(event["worker"] == "gpu2" for event in seen)


# ── Notices ────────────────────────────────────────────────────────────────


def test_notice_says_nothing_when_the_user_chose_local():
    assert gpu_gateway.notice_for(LOCAL_CHOSEN) is None


def test_notice_names_the_machine_that_was_skipped():
    status, reason = gpu_gateway.notice_for(LOCAL_FALLBACK)
    assert status == "local_fallback"
    assert "gpu2 is offline" in reason


def test_notice_is_header_safe():
    """It rides the X-OmniVoice-Routing channel, which is latin-1."""
    from services.engine_routing import header_safe_reason

    _status, reason = gpu_gateway.notice_for(REMOTE)
    assert header_safe_reason(reason) == reason


# ── Status and downloads ───────────────────────────────────────────────────


class _Record:
    capabilities = [
        {"engine": "indextts", "model_id": "indextts:default", "supported": True,
         "installed": True, "downloaded": True, "resident": False},
        {"engine": "mlx-audio", "model_id": "mlx-audio:kokoro", "supported": True,
         "installed": True, "downloaded": True, "resident": True},
    ]


class _Worker:
    record = _Record()


@pytest.mark.asyncio
async def test_status_answers_for_the_remote_host_not_this_one(monkeypatch):
    """Asking the local engine layer about another machine is how a UI offers
    an engine that only exists here."""
    monkeypatch.setattr(
        gpu_gateway, "_local_capabilities",
        lambda: [{"engine": "local-only", "model_id": "local-only:default"}],
    )
    plane = FakePlane(FakeScheduler(), pool=FakePool(_Worker()))
    answer = await gpu_gateway.status(decision=REMOTE, control_plane=plane)
    assert answer["remote"] is True
    assert [m["engine"] for m in answer["models"]] == ["indextts", "mlx-audio"]

    filtered = await gpu_gateway.status(
        "indextts", decision=REMOTE, control_plane=plane
    )
    assert [m["engine"] for m in filtered["models"]] == ["indextts"]


@pytest.mark.asyncio
async def test_status_falls_back_when_the_worker_dropped(monkeypatch):
    monkeypatch.setattr(
        gpu_gateway, "_local_capabilities",
        lambda: [{"engine": "indextts", "model_id": "indextts:default"}],
    )
    plane = FakePlane(FakeScheduler(), pool=FakePool(None))
    answer = await gpu_gateway.status(decision=REMOTE, control_plane=plane)
    assert answer["remote"] is False
    assert answer["reason"] == "the chosen worker is not connected"


@pytest.mark.asyncio
async def test_remote_download_refuses_instead_of_downloading_here():
    """Weights fetched onto the wrong machine leave the 4090 as unprepared as
    before, having reported success."""
    with pytest.raises(gpu_gateway.RemoteUnsupported) as excinfo:
        await gpu_gateway.download("k2-fsa/OmniVoice", decision=REMOTE)
    assert "gpu2" in str(excinfo.value)


@pytest.mark.asyncio
async def test_local_download_rejects_anything_outside_the_catalog():
    with pytest.raises(gpu_gateway.GatewayError):
        await gpu_gateway.download("../../etc/passwd", decision=LOCAL_CHOSEN)


@pytest.mark.asyncio
async def test_local_download_delegates_to_the_installer(monkeypatch):
    from api.routers.setup import download as installer
    from api.routers.setup import models as catalog

    monkeypatch.setattr(catalog, "KNOWN_MODELS", [{"repo_id": "acme/tts"}])
    seen = {}

    async def _install(req):
        seen["repo_id"] = req.repo_id
        return {"status": "install_started", "repo_id": req.repo_id}

    monkeypatch.setattr(installer, "install_model", _install)
    answer = await gpu_gateway.download("acme/tts", decision=LOCAL_CHOSEN)
    assert seen["repo_id"] == "acme/tts"
    assert answer["status"] == "install_started"


# ── One decision per job ───────────────────────────────────────────────────


def test_decide_is_the_single_answer(monkeypatch):
    """prewarm and run take the SAME decision; re-deciding between them could
    warm an engine nothing uses, or dispatch after paying a local cold load."""
    calls = []

    def _decide(plane, *, op=None):
        calls.append(op)
        return LOCAL_CHOSEN

    monkeypatch.setattr("worker.routing.decide", _decide)
    assert gpu_gateway.decide("tts") is LOCAL_CHOSEN
    assert calls == ["tts"]
