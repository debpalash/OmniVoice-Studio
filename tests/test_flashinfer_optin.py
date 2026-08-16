"""The FlashInfer opt-in (OMNIVOICE_FLASHINFER, upstream k2-fsa port).

An optimization must never be a point of failure (#278 contract, same as
torch.compile): the env knob is CUDA-only, off by default, refuses with a
named reason when the host can't honor it, latches off for the session after
a runtime failure, and a mid-generation FlashInfer error unapplies the patch
and retries the standard path once.
"""
from __future__ import annotations

import pytest

torch = pytest.importorskip("torch")


def _ee():
    import services.engine_env as m
    return m


def _mm():
    import services.model_manager as m
    return m


@pytest.fixture(autouse=True)
def _reset_latch(monkeypatch):
    monkeypatch.setattr(_ee(), "_flashinfer_runtime_failure", None)
    monkeypatch.delenv("OMNIVOICE_FLASHINFER", raising=False)


# ── the env knob ────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "value,expected",
    [
        ("", "off"), ("0", "off"), ("false", "off"), ("off", "off"),
        ("1", "on"), ("true", "on"), ("ON", "on"),
        ("graph", "graph"), ("GRAPH", "graph"),
        ("banana", "off"),  # typo → default path, not a crash
    ],
)
def test_flashinfer_mode_parsing(monkeypatch, value, expected):
    if value:
        monkeypatch.setenv("OMNIVOICE_FLASHINFER", value)
    assert _ee().flashinfer_mode() == expected


def test_should_flashinfer_refuses_non_cuda(monkeypatch):
    monkeypatch.setenv("OMNIVOICE_FLASHINFER", "1")
    assert _ee().should_flashinfer("cpu") == "off"
    assert _ee().should_flashinfer("mps") == "off"


def test_should_flashinfer_refuses_without_the_package(monkeypatch):
    monkeypatch.setenv("OMNIVOICE_FLASHINFER", "1")
    ee = _ee()
    monkeypatch.setattr(ee.importlib.util, "find_spec", lambda name: None)
    assert ee.should_flashinfer("cuda") == "off"


def test_latched_reason_is_sanitized(monkeypatch):
    # Wheel import errors embed the user's home path — the latch must store
    # the redacted form (core.failure.sanitize maps $HOME → "~").
    import os

    home = os.path.expanduser("~")
    _ee().mark_flashinfer_runtime_failure(
        f"ImportError: {home}/.venv/lib/flashinfer/_kernels.so: bad ELF"
    )
    latched = _ee()._flashinfer_runtime_failure
    assert home not in latched
    assert "ImportError" in latched


def test_sanitizer_failure_never_latches_the_raw_reason(monkeypatch):
    # Fail closed: a broken redactor must not leak the original message.
    import core.failure

    def _boom(_):
        raise RuntimeError("sanitizer exploded (test)")

    monkeypatch.setattr(core.failure, "sanitize", _boom)
    _ee().mark_flashinfer_runtime_failure(
        "ImportError: /home/someone/secret-project/creds.so missing"
    )
    latched = _ee()._flashinfer_runtime_failure
    assert "secret-project" not in latched and "/home/" not in latched
    assert latched.startswith("ImportError")
    assert "redacted" in latched


def test_runtime_failure_latches_the_session_off(monkeypatch):
    monkeypatch.setenv("OMNIVOICE_FLASHINFER", "graph")
    ee = _ee()
    monkeypatch.setattr(ee.importlib.util, "find_spec", lambda name: object())
    assert ee.should_flashinfer("cuda") == "graph"
    ee.mark_flashinfer_runtime_failure("boom")
    assert ee.should_flashinfer("cuda") == "off"


# ── failure classification ──────────────────────────────────────────────────


def test_classifier_matches_flashinfer_markers():
    mm = _mm()
    assert mm._is_flashinfer_runtime_failure(RuntimeError("flashinfer plan failed"))
    assert mm._is_flashinfer_runtime_failure(RuntimeError("CUDA graph capture aborted"))
    assert not mm._is_flashinfer_runtime_failure(ValueError("Unsupported instruct items"))
    assert not mm._is_flashinfer_runtime_failure(RuntimeError("CUDA out of memory"))


def test_classifier_walks_the_cause_chain():
    mm = _mm()
    inner = RuntimeError("flashinfer workspace too small")
    outer = RuntimeError("generation failed")
    outer.__cause__ = inner
    assert mm._is_flashinfer_runtime_failure(outer)
    # `raise ... from None` severs the chain — a genuine error must not be
    # re-classified via a suppressed FlashInfer context.
    severed = RuntimeError("generation failed")
    severed.__context__ = inner
    severed.__suppress_context__ = True
    assert not mm._is_flashinfer_runtime_failure(severed)


# ── unapply restores the class implementations ──────────────────────────────


class _MiniModel:
    class _Llm(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.lin = torch.nn.Linear(2, 2)
            self.config = type("C", (), {"use_cache": False})()
            self.attn_impl = None

        def set_attn_implementation(self, name):
            self.attn_impl = name

    def __init__(self):
        self.llm = self._Llm()

    def _generate_iterative(self, *a):
        return "class-impl"


def test_unapply_flashinfer_restores_instance_state():
    from types import MethodType

    m = _MiniModel()
    # Simulate apply_flashinfer's instance-level patching.
    m.llm.lin.forward = MethodType(lambda self, x: "patched", m.llm.lin)
    m.llm.lin._fi_w_qkv = torch.zeros(1)
    m._generate_iterative = MethodType(lambda self, *a: "patched", m)
    m._fi_runner = object()
    m._fi_graph_cache = {}
    m._fi_enable_cuda_graph = True

    _mm()._unapply_flashinfer(m)

    assert "forward" not in vars(m.llm.lin), "instance forward override must go"
    assert not hasattr(m.llm.lin, "_fi_w_qkv")
    assert m._generate_iterative() == "class-impl"
    assert not hasattr(m, "_fi_runner")
    assert m.llm.attn_impl == "sdpa"
    assert m.llm.config.use_cache is True


def test_unapply_restores_the_captured_attention_impl():
    # The pre-apply impl may be flash_attention_2, not sdpa — unapply must
    # put back what was actually there (CodeRabbit/Greptile, #1565).
    m = _MiniModel()
    m._fi_orig_attn_impl = "flash_attention_2"
    _mm()._unapply_flashinfer(m)
    assert m.llm.attn_impl == "flash_attention_2"
    assert not hasattr(m, "_fi_orig_attn_impl")


# ── generate-time fallback ──────────────────────────────────────────────────


def test_generate_fallback_unapplies_and_retries_once():
    mm = _mm()
    calls = {"n": 0}

    class _Model(_MiniModel):
        def generate(self, **kw):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("flashinfer ragged attention failed")
            return ["ok"]

    m = _Model()
    m._fi_runner = object()
    mm._install_flashinfer_fallback(m)
    assert m.generate() == ["ok"]
    assert calls["n"] == 2
    assert not hasattr(m, "_fi_runner"), "fallback must unapply the patch"
    assert _ee()._flashinfer_runtime_failure is not None


def test_generate_fallback_leaves_real_errors_alone():
    mm = _mm()

    class _Model(_MiniModel):
        def generate(self, **kw):
            raise ValueError("Unsupported instruct items")

    m = _Model()
    mm._install_flashinfer_fallback(m)
    with pytest.raises(ValueError):
        m.generate()
