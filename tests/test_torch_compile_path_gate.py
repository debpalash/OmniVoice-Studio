"""#1266: a torch lib path with whitespace can never survive inductor's linker.

Inductor passes the torch library directory to clang++/g++ as an unquoted
``-L`` flag, so a path containing a space splits into two arguments and the
compile dies with ``no such file or directory: 'Support/...'``. The bug is
inside PyTorch; what we control is not paying for a compile attempt that cannot
succeed and not flooding the log tail with its failure — which is how it turned
up in #1259, consuming a chunk of the captured crash output while not being the
actual fault.

Not hypothetical anywhere: macOS keeps app data under
``~/Library/Application Support/`` and a Windows profile is routinely
``C:/Users/First Last``.
"""
from __future__ import annotations

import types

import pytest


def _env(monkeypatch, *, torch_file, triton=True):
    """Bind should_torch_compile's dependencies to a controlled fake."""
    from services import engine_env

    monkeypatch.setattr(
        engine_env.importlib.util,
        "find_spec",
        lambda name: object() if (triton and name == "triton") else None,
    )
    monkeypatch.setattr(engine_env, "_compile_runtime_failure", None, raising=False)
    monkeypatch.setattr(
        engine_env, "_cuda_arch_supported_for_compile", lambda: (True, "")
    )
    monkeypatch.setitem(
        __import__("sys").modules, "torch", types.SimpleNamespace(__file__=torch_file)
    )
    return engine_env


CLEAN = "/opt/venv/lib/python3.11/site-packages/torch/__init__.py"
SPACED = "/Users/x/Library/Application Support/omnivoice/.venv/lib/torch/__init__.py"


def test_compile_allowed_on_a_clean_path(monkeypatch):
    ee = _env(monkeypatch, torch_file=CLEAN)
    assert ee.should_torch_compile("cuda") is True


def test_compile_skipped_when_the_torch_path_has_a_space(monkeypatch, caplog):
    """The regression: this used to attempt, fail in clang++, and log the wreck."""
    ee = _env(monkeypatch, torch_file=SPACED)
    with caplog.at_level("INFO", logger="omnivoice.engine_env"):
        assert ee.should_torch_compile("cuda") is False
    assert any("whitespace" in r.getMessage() for r in caplog.records), (
        "the skip must say WHY, or it is indistinguishable from the other skips"
    )


def test_force_env_still_overrides(monkeypatch, caplog):
    """Consistent with the arch gate: the user can insist."""
    ee = _env(monkeypatch, torch_file=SPACED)
    monkeypatch.setenv(ee._FORCE_COMPILE_ENV, "1")
    with caplog.at_level("WARNING", logger="omnivoice.engine_env"):
        assert ee.should_torch_compile("cuda") is True


def test_unreadable_torch_path_is_not_a_reason_to_skip(monkeypatch):
    """No torch metadata means no evidence of a problem — fail open, matching
    the module's other probes."""
    ee = _env(monkeypatch, torch_file=None)
    assert ee.should_torch_compile("cuda") is True


@pytest.mark.parametrize("device", ["mps", "cpu", "xpu"])
def test_non_cuda_devices_are_unaffected(monkeypatch, device):
    """The device gate runs first and must keep short-circuiting."""
    ee = _env(monkeypatch, torch_file=SPACED)
    assert ee.should_torch_compile(device) is False
