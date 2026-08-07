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

from core.device_caps import why_no_gpu


def _torch(*, hip=None, cuda=None):
    return SimpleNamespace(version=SimpleNamespace(hip=hip, cuda=cuda))


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
    monkeypatch.setattr("core.device_caps.os.path.exists", lambda p: True)
    monkeypatch.setattr("core.device_caps.os.access", lambda p, m: True)
    msg = _joined(_torch(hip="6.4.0"))
    assert "no gpu was enumerated" in msg
    assert "newer than this build" in msg
    assert "rocminfo" in msg


def test_rocm_off_linux_does_not_invent_a_device_node_reason(monkeypatch):
    """/dev/kfd is a Linux path; its absence anywhere else says nothing, and a
    confident wrong reason is worse than a vague right one."""
    monkeypatch.setattr(sys, "platform", "win32")
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


def test_the_probe_attaches_the_reason(monkeypatch):
    """End to end: the note has to reach `HostCaps.notes`, which is what the
    About page and the diagnostics bundle read. Fail-before, this branch
    produced nothing at all."""
    import core.device_caps as dc

    fake = SimpleNamespace(
        version=SimpleNamespace(hip="6.4.0", cuda=None),
        cuda=SimpleNamespace(is_available=lambda: False),
    )
    monkeypatch.setitem(sys.modules, "torch", fake)
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(dc.os.path, "exists", lambda p: False)
    dc.refresh()
    caps = dc.detect_host_caps()
    assert caps.family == "cpu"
    assert any("/dev/kfd" in n for n in caps.notes), caps.notes
    dc.refresh()
