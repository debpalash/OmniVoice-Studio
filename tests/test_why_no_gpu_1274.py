"""A GPU host that runs on CPU must say why (#1274, #1228).

The reporter's About page said, in full:

    Compute device: cpu
    GPU active: no
    VRAM (allocated): 0.00 GB

on a Strix Halo box running the ROCm image with ``--device /dev/kfd``,
``--group-add 39 --group-add 105`` and ``HSA_OVERRIDE_GFX_VERSION=11.0.0``.
Every one of those lines is true and none of them is usable. It is also
exactly what a machine with no GPU at all reports, so the report could not
distinguish "the driver isn't loaded" from "the container can't open the
device" from "this ROCm is older than this GPU" — and the numeric group IDs
in that command are copied from some other host, which is the single most
common way this ends up on CPU in Docker.

The probe already knew all of it. ``torch.cuda.is_available()`` returning
False simply produced no note at all, so nothing reached the user.
"""
from __future__ import annotations

import sys
from types import SimpleNamespace

import pytest



def _torch(*, hip=None, cuda=None):
    return SimpleNamespace(version=SimpleNamespace(hip=hip, cuda=cuda))


def why_no_gpu(torch):
    """Resolved per call, not bound at import.

    A module-level `from core.device_caps import why_no_gpu` captures whatever
    object existed at collection time. Tests here patch `sys.modules["torch"]`
    and other suites purge `sys.modules`, so the imported name can end up
    referring to a module object nothing else in the process is using — the
    assertions then pass against a stale copy (CodeRabbit, #1425).
    """
    import importlib

    return importlib.import_module("core.device_caps").why_no_gpu(torch)


def _joined(torch) -> str:
    return " ".join(why_no_gpu(torch)).lower()


# ── the wheel itself has no GPU support ────────────────────────────────────

def test_a_cpu_only_wheel_says_nothing():
    """Silence is right here, not an oversight: a wheel with no GPU support is
    also every macOS build (MPS is probed separately) and every CPU Docker
    image. A note would fire on hosts working exactly as intended, and the
    baseline `notes == ()` contract in test_device_caps.py pins that."""
    assert why_no_gpu(_torch()) == ()


# ── ROCm ───────────────────────────────────────────────────────────────────

@pytest.fixture
def linux(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")


def test_rocm_without_the_kernel_interface_names_the_docker_flags(linux, monkeypatch):
    monkeypatch.setattr("core.device_caps.os.path.exists", lambda p: False)
    msg = _joined(_torch(hip="6.4.0"))
    assert "/dev/kfd" in msg
    assert "--device /dev/kfd" in msg
    assert "amdgpu" in msg


def test_rocm_that_cannot_open_the_device_names_the_group_trap(linux, monkeypatch):
    """The reporter's most likely case, and the one a generic message cannot
    help with: the render/video GIDs differ per host, so a copied
    `--group-add 39 --group-add 105` silently grants nothing."""
    monkeypatch.setattr("core.device_caps.os.path.exists", lambda p: True)
    monkeypatch.setattr("core.device_caps.os.access", lambda p, m: False)
    msg = _joined(_torch(hip="6.4.0"))
    assert "cannot open it" in msg
    assert "--group-add" in msg
    assert "differ between machines" in msg
    # It must tell them how to find the right numbers, not just that theirs
    # might be wrong.
    assert "ls -l /dev/kfd" in msg


def test_rocm_with_everything_reachable_points_at_the_rocm_version(linux, monkeypatch):
    monkeypatch.delenv("HSA_OVERRIDE_GFX_VERSION", raising=False)
    monkeypatch.setattr("core.device_caps.os.path.exists", lambda p: True)
    monkeypatch.setattr("core.device_caps.os.access", lambda p, m: True)
    msg = _joined(_torch(hip="6.4.0"))
    assert "no gpu was enumerated" in msg
    assert "newer than this build" in msg
    assert "rocminfo" in msg


def test_an_hsa_override_is_the_first_suspect(linux, monkeypatch):
    """The #1274 reporter set HSA_OVERRIDE_GFX_VERSION=11.0.0 on a gfx1151
    card that the shipped ROCm 7.2.4 supports natively. Remapping a card the
    runtime already handles can leave it with no usable agent at all — which
    reads as "no GPU", not as a kernel failure. It is both the likelier cause
    and the cheaper one to test, so it is named before the ROCm version."""
    monkeypatch.setenv("HSA_OVERRIDE_GFX_VERSION", "11.0.0")
    monkeypatch.setattr("core.device_caps.os.path.exists", lambda p: True)
    monkeypatch.setattr("core.device_caps.os.access", lambda p, m: True)
    msg = _joined(_torch(hip="7.2.4"))
    assert "hsa_override_gfx_version=11.0.0" in msg
    assert "removing that override first" in msg
    # Must not send them chasing the ROCm version instead.
    assert "newer than this build" not in msg


def test_no_override_still_points_at_the_rocm_version(linux, monkeypatch):
    monkeypatch.delenv("HSA_OVERRIDE_GFX_VERSION", raising=False)
    monkeypatch.setattr("core.device_caps.os.path.exists", lambda p: True)
    monkeypatch.setattr("core.device_caps.os.access", lambda p, m: True)
    msg = _joined(_torch(hip="7.2.4"))
    assert "newer than this build" in msg
    assert "hsa_override" not in msg


def test_rocm_off_linux_does_not_invent_a_device_node_reason(monkeypatch):
    """/dev/kfd is a Linux path; its absence anywhere else says nothing, and a
    confident wrong reason is worse than a vague right one."""
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.delenv("HSA_OVERRIDE_GFX_VERSION", raising=False)
    msg = _joined(_torch(hip="6.4.0"))
    assert "/dev/kfd" not in msg
    assert "no gpu was enumerated" in msg


# ── CUDA ───────────────────────────────────────────────────────────────────

def test_cuda_without_a_device_names_its_own_causes():
    msg = _joined(_torch(cuda="12.8"))
    assert "cuda 12.8" in msg
    assert "driver" in msg
    assert "--gpus all" in msg


def test_rocm_wins_over_cuda_when_both_are_set():
    """A ROCm wheel reports a `torch.version.cuda` too; the HIP branch is the
    correct reading and its advice is completely different."""
    msg = _joined(_torch(hip="6.4.0", cuda="12.8"))
    assert "rocm 6.4.0" in msg
    assert "--gpus all" not in msg


# ── contract ───────────────────────────────────────────────────────────────

def test_it_never_raises_on_odd_torch_objects():
    """This runs inside a probe whose whole contract is that it cannot raise."""
    for weird in (SimpleNamespace(), object(), None):
        assert isinstance(why_no_gpu(weird), tuple)


def test_metadata_access_that_raises_is_not_an_exception_either():
    """`torch.version` is a plain module attribute on a real torch, but a
    partially-initialised or shimmed torch-like object can expose it as a
    property that throws — and `getattr(torch, "version", None)` does not
    swallow that, the default only covers a MISSING attribute.

    This runs on the diagnostics path, so raising here takes out the very
    report meant to explain why the GPU is unavailable (CodeRabbit, #1425).
    """

    class _Hostile:
        @property
        def version(self):
            raise RuntimeError("torch is half-initialised")

    assert why_no_gpu(_Hostile()) == ()

    class _HostileInner:
        """Raises one level down — `torch.version` resolves, `.hip` does not."""

        class _V:
            @property
            def hip(self):
                raise RuntimeError("hip probe exploded")

        version = _V()

    assert why_no_gpu(_HostileInner()) == ()


def test_the_probe_attaches_the_reason(monkeypatch, request):
    """End to end: the note has to reach `HostCaps.notes`, which is what the
    About page and the diagnostics bundle read. Fail-before, this branch
    produced nothing at all."""
    import core.device_caps as dc

    fake = SimpleNamespace(
        version=SimpleNamespace(hip="6.4.0", cuda=None),
        cuda=SimpleNamespace(is_available=lambda: False),
    )
    request.addfinalizer(dc.refresh)
    # Registered BEFORE the fake torch goes in, so it runs even if an
    # assertion below fails. `detect_host_caps()` memoises, and a cached probe
    # built from this fake would be handed to every later test in the process
    # — the trailing `dc.refresh()` alone only cleans up on the happy path
    # (CodeRabbit, #1425).
    monkeypatch.setitem(sys.modules, "torch", fake)
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(dc.os.path, "exists", lambda p: False)
    dc.refresh()
    caps = dc.detect_host_caps()
    assert caps.family == "cpu"
    assert any("/dev/kfd" in n for n in caps.notes), caps.notes


def test_a_failed_cuda_probe_does_not_also_claim_no_device_was_found(monkeypatch, request):
    """`torch.cuda.is_available()` raising tells us nothing about the host.

    The probe reports `CUDA init raised: …` for that, which is true. Running
    `why_no_gpu()` afterwards adds a second note asserting what it found —
    "no CUDA device was found" — as though the probe had completed. Two notes,
    one of them a diagnosis drawn from an unfinished measurement, is worse
    than the one true note alone (CodeRabbit, #1425).
    """
    import core.device_caps as dc

    def _boom():
        raise RuntimeError("CUDA driver initialisation failed")

    fake = SimpleNamespace(
        version=SimpleNamespace(hip=None, cuda="12.8"),
        cuda=SimpleNamespace(is_available=_boom),
    )
    request.addfinalizer(dc.refresh)
    monkeypatch.setitem(sys.modules, "torch", fake)
    monkeypatch.setattr(sys, "platform", "linux")
    dc.refresh()
    caps = dc.detect_host_caps()

    assert any("cuda init raised" in n.lower() for n in caps.notes), caps.notes
    assert not any("no cuda device" in n.lower() for n in caps.notes), (
        "the probe reported what it found after failing to look"
    )
