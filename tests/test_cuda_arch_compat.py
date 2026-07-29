"""#1285: every RTX 40-series card was declared unsupported and sent to CPU.

The SM-arch gate required the device's exact tag to appear in
``torch.cuda.get_arch_list()``. NVIDIA's rules are not exact, and PyTorch
depends on that: SASS is binary-compatible *upward within a major version*, so
the official wheels ship ``sm_80``/``sm_86`` and deliberately **no ``sm_89``**
— the 8.6 kernels already cover Ada. Exact matching therefore failed for
sm_89, and `get_best_device()` silently returned ``"cpu"``.

The reporter's arch list is the real one from a cu128 wheel; note sm_89's
absence and sm_86's presence. An RTX 4060, 4070, 4080 and 4090 are all sm_89.
"""
from __future__ import annotations

import types

import pytest

def _dc():
    """Resolve the app module at call time.

    Module-level imports of app modules go stale under sys.modules pollution
    from other suites (the `tests/**` review contract, and the live cause of
    #1269's cross-suite failures), so every test binds it fresh.
    """
    from core import device_caps

    return device_caps


def arch_unsupported(torch):
    return _dc().arch_unsupported(torch)


def cuda_build_covers(arch_list, major, minor):
    return _dc().cuda_build_covers(arch_list, major, minor)

# Verbatim from the #1285 report.
CU128_ARCHS = ["sm_61", "sm_70", "sm_75", "sm_80", "sm_86", "sm_90", "sm_100", "sm_120"]


def _cuda_torch(capability, arch_list, device_name="NVIDIA GeForce RTX 4060"):
    """A CUDA (non-HIP) torch mock — `version` carries no `hip` attribute."""
    return types.SimpleNamespace(
        cuda=types.SimpleNamespace(
            is_available=lambda: True,
            get_device_name=lambda i=0: device_name,
            get_device_capability=lambda i=0: capability,
            get_arch_list=lambda: list(arch_list),
        ),
        version=types.SimpleNamespace(),
    )


@pytest.mark.parametrize(
    "capability, name",
    [((8, 9), "RTX 4060"), ((8, 9), "RTX 4090"), ((8, 7), "Jetson Orin")],
)
def test_ada_runs_on_ampere_kernels(capability, name):
    """The regression: 8.6 cubins run on any 8.x device with minor >= 6."""
    torch = _cuda_torch(capability, CU128_ARCHS, device_name=name)
    assert arch_unsupported(torch) is None, (
        f"{name} {capability} was declared unsupported against {CU128_ARCHS} — "
        f"sm_86 covers it, and rejecting it force-routes the user to CPU"
    )


def test_exact_match_still_supported():
    assert cuda_build_covers(["sm_86"], 8, 6) is True


def test_downward_within_major_is_not_compatible():
    """8.9 cubins do NOT run on an 8.6 device — compatibility is upward only."""
    assert cuda_build_covers(["sm_89"], 8, 6) is False


def test_across_major_sass_is_not_compatible():
    """A 9.0 cubin is not a 10.0 kernel, and 8.6 does not reach across majors."""
    assert cuda_build_covers(["sm_90"], 10, 0) is False
    assert cuda_build_covers(["sm_86"], 9, 0) is False


def test_ptx_jits_forward_across_majors():
    """Embedded PTX at or below the device capability JIT-compiles forward."""
    assert cuda_build_covers(["compute_80"], 8, 9) is True
    assert cuda_build_covers(["compute_80"], 12, 0) is True
    # ...but never backward.
    assert cuda_build_covers(["compute_90"], 8, 6) is False


def test_arch_specific_suffix_does_not_forward_run():
    """`sm_90a` is architecture-SPECIFIC: exact capability only."""
    assert cuda_build_covers(["sm_90a"], 9, 0) is True
    assert cuda_build_covers(["sm_90a"], 9, 1) is False
    assert cuda_build_covers(["compute_100f"], 12, 0) is False


def test_genuinely_unsupported_still_reported():
    """The gate must keep working — a Blackwell card on an old wheel is real."""
    torch = _cuda_torch((12, 0), ["sm_61", "sm_70", "sm_75"], device_name="RTX 5090")
    assert arch_unsupported(torch) == ("sm_120", ("sm_61", "sm_70", "sm_75"))


def test_unparseable_entries_are_skipped_not_guessed():
    assert cuda_build_covers(["", "sm_", "banana", "sm_x6"], 8, 9) is False
    assert cuda_build_covers(["banana", "sm_86"], 8, 9) is True


def test_empty_arch_list_is_compatible():
    """Unknown metadata degrades to "compatible" — the fail-open contract."""
    assert arch_unsupported(_cuda_torch((8, 9), [])) is None


def test_cpu_fallback_not_triggered_for_ada(monkeypatch):
    """End-to-end through the consumer that actually picks the device."""
    from services import model_manager

    torch = _cuda_torch((8, 9), CU128_ARCHS)
    monkeypatch.setattr(model_manager, "_lazy_torch", lambda: torch)
    _dc().detect_host_caps.cache_clear()
    compatible, warning = model_manager.check_device_compatibility()
    assert compatible is True
    assert warning is None
