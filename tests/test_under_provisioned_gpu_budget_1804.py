"""#1804: a GPU below the engine's VRAM floor was budgeted as fast hardware.

Third report of one shape. #1226 (GTX 1650 Ti), #1222 (Quadro P2000) and now
#1804 (GTX 1650) are all 4 GB cards running the `omnivoice` engine, which
declares `min_vram_gb = 6.0` precisely because "below this the driver pages to
system RAM and a render that should take seconds runs for minutes".

The reporter's own breadcrumbs show the budget, not the hardware, ending the
job::

    11:53:02 generate:start → 11:59:14 stream-retryable-abort  = 372 s
    12:00:15 generate:start → 12:05:16 stream-retryable-abort  = 301 s

which is `generate_timeout_s()` exactly: 300 + max(0, len - 1200) / 40.

Everything downstream of the routing verdict already acted on it — the caveat
(`resolve_routing`), the preflight toast, the timeout message naming the card
(`test_low_vram_advisory.py`). The budget alone did not, so the slowest
supported configuration got **half** the 600 s a plain CPU host gets. These
tests pin the corrected floor, and the boundaries it must not cross.
"""
from __future__ import annotations

import importlib
import sys

import pytest

from core.device_caps import HostCaps
from services.engine_routing import _caveat, under_provisioned_vram
from services.tts_backend import OmniVoiceBackend


@pytest.fixture
def model_manager(monkeypatch):
    for mod_name in ("core.config", "services.model_manager"):
        if getattr(sys.modules.get(mod_name), "__file__", None) is None:
            sys.modules.pop(mod_name, None)
    import services.model_manager as mm
    return mm


def _gpu(vram_gb: float, *, family: str = "cuda",
         name: str = "NVIDIA GeForce GTX 1650") -> HostCaps:
    return HostCaps(
        family=family,
        available_families=(family, "cpu"),
        device_name=name,
        vram_gb=vram_gb,
    )


@pytest.fixture
def on_host(monkeypatch, model_manager):
    """Pin the host probe and the two budgets to their shipped defaults."""
    import core.device_caps as caps

    def _pin(host):
        monkeypatch.setattr(caps, "detect_host_caps", lambda: host)
        monkeypatch.setattr(model_manager, "GPU_JOB_TIMEOUT_S", 300.0)
        monkeypatch.setattr(model_manager, "CPU_JOB_TIMEOUT_S", 600.0)
        return model_manager

    return _pin


FLOOR = OmniVoiceBackend.min_vram_gb  # 6.0


# ── the reported bug ─────────────────────────────────────────────────────


def test_a_4gb_card_gets_the_cpu_budget_not_half_of_it(on_host):
    """The regression. A card that pages to system RAM performs like a CPU, so
    it must not be budgeted like a 24 GB one."""
    mm = on_host(_gpu(4.0))
    assert mm.generate_timeout_s(
        "A short render", execution_device="cuda", min_vram_gb=FLOOR,
    ) == 600.0


def test_the_engine_alone_is_enough_to_derive_the_floor(on_host):
    """Callers that pass `engine=` (tts_stream, batch, dub, openai_compat,
    archetypes) need no change — the floor is read off the engine."""
    mm = on_host(_gpu(4.0))
    assert mm.generate_timeout_s(
        "A short render", execution_device="cuda", engine=OmniVoiceBackend,
    ) == 600.0


def test_length_scaling_still_applies_on_top_of_the_raised_floor(on_host):
    """The reporter's longer take (4080 chars ⇒ 372 s before) keeps its bonus;
    the floor moved, the slope did not."""
    mm = on_host(_gpu(4.0))
    assert mm.generate_timeout_s(
        "x" * 4080, execution_device="cuda", min_vram_gb=FLOOR,
    ) == 600.0 + (4080 - 1200) / 40.0


def test_the_whole_class_not_just_cuda(on_host):
    """ROCm is the other dedicated-VRAM family; the same paging happens there."""
    mm = on_host(_gpu(4.0, family="rocm", name="AMD Radeon RX 6500 XT"))
    assert mm.generate_timeout_s(
        "A short render", execution_device="rocm", min_vram_gb=FLOOR,
    ) == 600.0


# ── the boundaries it must not cross ─────────────────────────────────────


def test_a_large_card_keeps_the_accelerated_budget(on_host):
    mm = on_host(_gpu(24.0, name="NVIDIA RTX 4090"))
    assert mm.generate_timeout_s(
        "A short render", execution_device="cuda", min_vram_gb=FLOOR,
    ) == 300.0


def test_an_engine_with_no_declared_floor_is_never_judged(on_host):
    """Only engines with a measured figure opt in; inventing a floor for the
    rest would silently double the watchdog for every other engine."""
    mm = on_host(_gpu(4.0))
    assert mm.generate_timeout_s("A short render", execution_device="cuda") == 300.0


def test_mps_is_not_judged_by_a_cuda_measured_floor(on_host):
    """`HostCaps.vram_gb` on MPS is system RAM / 2 for a UNIFIED pool — an 8 GB
    Mac reports 4.0 and runs this engine fine."""
    mm = on_host(_gpu(4.0, family="mps", name="Apple Silicon (MPS)"))
    assert mm.generate_timeout_s(
        "A short render", execution_device="mps", min_vram_gb=FLOOR,
    ) == 300.0


def test_a_failed_vram_probe_does_not_guess(on_host):
    """vram_gb == 0 means the probe failed, not that the card has no memory."""
    mm = on_host(_gpu(0.0))
    assert mm.generate_timeout_s(
        "A short render", execution_device="cuda", min_vram_gb=FLOOR,
    ) == 300.0


def test_a_cpu_fallback_render_is_unaffected(on_host):
    """Routing already sent this one to the CPU; it gets the CPU budget by the
    device branch, and the VRAM branch must not double-apply."""
    mm = on_host(_gpu(4.0))
    assert mm.generate_timeout_s(
        "A short render", execution_device="cpu", min_vram_gb=FLOOR,
    ) == 600.0


# ── an operator's explicit setting still wins ────────────────────────────


def test_an_explicit_universal_budget_is_honoured_verbatim(monkeypatch):
    """Same contract the CPU branch has kept since #1787: someone who lowered
    the watchdog to fail fast keeps failing fast, small card or not."""
    import core.device_caps as caps
    import services.model_manager as mm_mod

    # `monkeypatch.context()` so the environment is restored BEFORE the reload
    # below (CodeRabbit on the PR). Deleting the var by hand and reloading
    # inside a `finally` leaves the module constants describing an environment
    # pytest is about to put back, and every later test reads the mismatch.
    with monkeypatch.context() as m:
        m.setenv("OMNIVOICE_GENERATE_TIMEOUT_S", "123.5")
        mm = importlib.reload(mm_mod)
        m.setattr(caps, "detect_host_caps", lambda: _gpu(4.0))
        assert mm.generate_timeout_s(
            "A short render", execution_device="cuda", min_vram_gb=FLOOR,
        ) == 123.5
    importlib.reload(mm_mod)


def test_a_raised_accelerated_budget_is_never_cut_down_to_the_cpu_one(
    monkeypatch, model_manager,
):
    """The floor is a `max`, not an assignment."""
    import core.device_caps as caps

    monkeypatch.setattr(caps, "detect_host_caps", lambda: _gpu(4.0))
    monkeypatch.setattr(model_manager, "GPU_JOB_TIMEOUT_S", 900.0)
    monkeypatch.setattr(model_manager, "CPU_JOB_TIMEOUT_S", 600.0)
    assert model_manager.generate_timeout_s(
        "A short render", execution_device="cuda", min_vram_gb=FLOOR,
    ) == 900.0


# ── the verdict cannot drift from the warning built on it ────────────────


@pytest.mark.parametrize(
    "caps, expected",
    [
        (_gpu(4.0), True),
        (_gpu(24.0, name="NVIDIA RTX 4090"), False),
        (_gpu(0.0), False),
        (_gpu(4.0, family="mps", name="Apple Silicon (MPS)"), False),
        (_gpu(4.0, family="rocm", name="AMD Radeon RX 6500 XT"), True),
    ],
)
def test_the_budget_and_the_caveat_read_the_same_verdict(caps, expected):
    """One predicate, three consumers (caveat, timeout message, budget). Three
    inline copies is how the budget came to disagree with the warning printed
    next to it."""
    assert under_provisioned_vram(caps, FLOOR) is expected
    assert bool(_caveat(caps, FLOOR)) is expected


def test_an_undeclared_floor_and_a_missing_probe_are_both_silent():
    assert under_provisioned_vram(_gpu(4.0), 0.0) is False
    assert under_provisioned_vram(None, FLOOR) is False


# ── the remote half: a small card on a WORKER ────────────────────────────
#
# Greptile P1 on the PR. The control plane sets a remote attempt's deadline, so
# the same inversion applies there — but it cannot be fixed by handing
# `generate_timeout_s()` the engine floor: that function probes THIS host, and
# the control plane's hardware is not the worker's. A Mac control plane
# dispatching to a 4 GB Windows box would learn nothing (MPS is excluded), and a
# 4 GB box dispatching to a 24 GB worker would wrongly get the longer budget.
# The worker already advertises both figures, so it is the one that decides.


def _worker(*, backend: str = "cuda", vram_gb: float = 4.0,
            floor_gb: float = 6.0, cpu_fallback: bool = False):
    from worker.capacity import WorkerCapacity
    from worker.pool import ConnectedWorker
    from worker.registry import RemoteWorker

    gb = 1024 ** 3
    record = RemoteWorker(
        id="w1", name="w1", key_id="key-w1", public_key=b"\x00" * 32, priority=50,
        capabilities=[{
            "engine": "omnivoice",
            "model_id": "OmniVoice",
            "operations": ["tts"],
            "supported": True,
            "installed": True,
            "downloaded": True,
            "backend": backend,
            "cpu_fallback": cpu_fallback,
            "min_memory_bytes": int(floor_gb * gb),
            "free_memory_bytes": int(vram_gb * gb),
        }],
        consent_granted_at=1.0, created_at=1.0,
    )
    return ConnectedWorker(
        record=record, session=None, epoch=1,
        capacity=WorkerCapacity(worker_id="w1", max_concurrent_tasks=1,
                                backend=backend),
        connected_at=0.0, last_heartbeat_at=0.0,
    )


@pytest.mark.parametrize(
    "kwargs, expected",
    [
        ({}, True),                                   # 4 GB card, 6 GB engine
        ({"backend": "rocm"}, True),                  # whole class
        ({"vram_gb": 24.0}, False),                   # big card
        ({"floor_gb": 0.0}, False),                   # engine declares no floor
        ({"vram_gb": 0.0}, False),                    # probe failed on the worker
        ({"backend": "mps"}, False),                  # unified memory
        ({"cpu_fallback": True}, False),              # already routed to CPU
    ],
)
def test_the_worker_decides_from_the_figures_it_advertises(kwargs, expected):
    w = _worker(**kwargs)
    assert w.under_provisioned("omnivoice", "OmniVoice", "tts") is expected


def test_an_unknown_capability_is_never_called_under_provisioned():
    w = _worker()
    assert w.under_provisioned("some-other-engine", "", "tts") is False


def test_a_remote_attempt_on_a_small_card_gets_the_cpu_execution_budget():
    from worker import deadlines

    accelerated = deadlines.for_task("tts", text="short", execution_device="cuda")
    corrected = deadlines.for_task(
        "tts", text="short", execution_device="cuda", under_provisioned=True,
    )
    on_cpu = deadlines.for_task("tts", text="short", execution_device="cpu")
    assert accelerated.execution_seconds < corrected.execution_seconds
    assert corrected.execution_seconds == on_cpu.execution_seconds


def test_a_healthy_remote_worker_is_unchanged():
    from worker import deadlines

    assert (
        deadlines.for_task("tts", text="short", execution_device="cuda").execution_seconds
        == deadlines.for_task(
            "tts", text="short", execution_device="cuda", under_provisioned=False,
        ).execution_seconds
    )


@pytest.mark.parametrize("device", ["cuda", "rocm"])
def test_the_task_deadline_still_covers_the_raised_execution_budget(device):
    """`gpu_gateway._default_deadline` is computed before a worker is bound, so
    it cannot know the card. It already asks for the CPU budget (no
    `execution_device`), which is the larger of the two — so the ceiling the
    awaiting side grants still covers the corrected lease rather than
    abandoning a worker that is inside its own deadline.

    Calls the gateway function itself rather than restating its formula
    (CodeRabbit on the PR): a future change that started passing a device there
    would pick a shorter ceiling, and a test that only re-derived the number
    would not notice."""
    from services import gpu_gateway
    from worker import deadlines

    ceiling = gpu_gateway._default_deadline("tts", "short")
    corrected = deadlines.for_task(
        "tts", text="short", execution_device=device, under_provisioned=True,
    )
    assert ceiling >= corrected.total_seconds


def test_losing_the_worker_never_shortens_an_under_provisioned_budget():
    """`Scheduler._budget_for` recomputes with no worker once one disconnects,
    so `under_provisioned` goes False there. That must not shorten anything: no
    worker means no `execution_device`, which `_base_execution_seconds` already
    coerces to "cpu" — the very budget the floor raises an under-provisioned
    card to.

    Driven through a real scheduler rather than the policy alone (CodeRabbit on
    the PR): the coercion lives in the disconnect path, so a test that only
    called `for_task` would pass even if that path stopped doing it."""
    from worker import deadlines
    from worker.identity import issue_session
    from worker.pool import WorkerPool
    from worker.scheduler import Scheduler

    now = 1000.0
    worker = _worker()  # 4 GB card, 6 GB engine
    pool = WorkerPool()
    pool.connect(
        worker.record,
        session=issue_session(
            worker_id=worker.record.id, key_id=worker.record.key_id,
            epoch=1, now=now,
        ),
        epoch=1, max_concurrent_tasks=1, backend="cuda", now=now,
    )
    sched = Scheduler(pool, persist=False)
    task = sched.submit(
        operation="tts", engine="omnivoice", model_id="OmniVoice",
        params={"text": "short"}, now=now,
    )
    assignment = sched.next_assignment(now=now)
    assert assignment is not None, "the under-provisioned worker should still be used"

    # Bound: the worker is present, so its own verdict raises the budget.
    bound = sched._budget_for(task)
    on_cpu = deadlines.for_task("tts", text="short", execution_device="cpu")
    assert bound.execution_seconds == on_cpu.execution_seconds

    # …and it survives the worker vanishing.
    pool.disconnect(worker.record.id)
    orphaned = sched._budget_for(task)
    assert orphaned.execution_seconds >= bound.execution_seconds


# ── the pairing, repo-wide ───────────────────────────────────────────────


def test_every_dispatch_that_tells_the_guard_its_floor_tells_the_budget_too():
    """The class, not the instance.

    `/generate` was the reported one and `/convert` had the identical split
    (CodeRabbit on the PR): both handed the guard `min_vram_gb` so a timeout
    could name the card, and both computed the budget without it. Rather than
    one test per router, this is the rule — if a dispatch knows the engine's
    floor well enough to explain the timeout, it knows it well enough to set
    the budget. A new router that forgets fails here.
    """
    import ast
    import pathlib

    routers = pathlib.Path(__file__).resolve().parents[1] / "backend" / "api" / "routers"
    offenders = []
    for path in sorted(routers.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for call in ast.walk(tree):
            if not isinstance(call, ast.Call):
                continue
            kw = {k.arg: k.value for k in call.keywords if k.arg}
            if "min_vram_gb" not in kw or "timeout" not in kw:
                continue
            # The SAME floor, not merely some floor: a budget computed with 0
            # or another engine's figure would otherwise pass while the guard
            # used the right one (CodeRabbit on the PR).
            wanted = ast.dump(kw["min_vram_gb"])
            if not any(
                isinstance(n, ast.keyword) and n.arg == "min_vram_gb"
                and ast.dump(n.value) == wanted
                for n in ast.walk(kw["timeout"])
            ):
                offenders.append(f"{path.name}:{call.lineno}")
    assert not offenders, (
        "these dispatches tell the guard the engine's VRAM floor but judge the "
        f"job by a budget that ignores it (#1804): {offenders}"
    )


def test_both_budgets_explicit_leaves_the_accelerated_one_in_charge(monkeypatch):
    """The precedence `docs/performance.md` documents, pinned.

    Filling in BOTH Settings rows is the case #1787 had to disambiguate for CPU
    hosts. For an under-provisioned GPU the accelerated value wins: the host is
    still accelerated, so the number the user chose for accelerated hosts is
    used verbatim rather than floored — which is what keeps "lower it to fail
    fast everywhere" working.
    """
    import core.device_caps as caps
    import services.model_manager as mm_mod

    with monkeypatch.context() as m:  # see the note on the test above
        m.setenv("OMNIVOICE_GENERATE_TIMEOUT_S", "200")
        m.setenv("OMNIVOICE_CPU_GENERATE_TIMEOUT_S", "600")
        mm = importlib.reload(mm_mod)
        m.setattr(caps, "detect_host_caps", lambda: _gpu(4.0))
        assert mm.generate_timeout_s(
            "A short render", execution_device="cuda", min_vram_gb=FLOOR,
        ) == 200.0
        # …while a CPU dispatch still gets the CPU row it was told it would.
        assert mm.generate_timeout_s(
            "A short render", execution_device="cpu",
        ) == 600.0
    importlib.reload(mm_mod)
