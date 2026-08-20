"""AudioSeal must watermark eagerly — never through torch.compile (#1615).

AudioSeal vendors moshi's ``@torch_compile_lazy`` on ``SEANetEncoder.forward``,
so the FIRST embed (not the model load — #1576's prefetch loads fine) calls
``torch.compile`` and drops into Inductor's C++ codegen. On a macOS arm64
deployment that compile fails outright with ``CppCompileError`` on 10/10
attempts: embedding then fail-opens, so audio ships UNMARKED — an EU AI Act
Art. 50(2) provenance gap — after burning 30-40 s on the first take and 5-8 s
on later ones.

The compile is pure cost even where it succeeds. Measured on an M3 (5 s of
24 kHz audio, three consecutive embeds):

    compiled:  9.70 s, 0.26 s, 0.23 s
    eager:     0.30 s, 0.28 s, 0.27 s

A ~10 s first-embed tax to save 0.03 s per later embed — and a hard failure
wherever the host's C++ toolchain can't serve Inductor. Watermarking is small
CPU work behind a 30 s chunk loop; it runs eager.

Fail-before/pass-after: on the pre-fix code the fakes below observe
``_compile_disabled`` False while the generator/detector run.
"""
from __future__ import annotations

import importlib
import threading

import pytest
import torch

SR = 24000


@pytest.fixture
def watermark():
    """Resolve app state after per-test setup, never at collection time —
    a module-level import can retain globals a prior test left behind."""
    return importlib.import_module("services.watermark")


@pytest.fixture
def moshi_compile():
    """AudioSeal's vendored moshi compile switch.

    Skips only when audioseal is absent. If audioseal IS installed but the
    switch has moved, that is a real regression — the compile silently comes
    back — so it fails here rather than quietly skipping.
    """
    pytest.importorskip("audioseal", reason="audioseal not installed in this environment")
    from audioseal.libs.moshi.utils import compile as moshi_compile

    return moshi_compile


class RecordingGenerator:
    """Records whether compile was disabled at the moment it was called."""

    def __init__(self, moshi_compile):
        self._moshi = moshi_compile
        self.compile_disabled: list[bool] = []

    def __call__(self, audio, sample_rate, message=None):
        self.compile_disabled.append(bool(self._moshi._compile_disabled))
        return audio


class RecordingDetector:
    def __init__(self, moshi_compile, omni_message):
        self._moshi = moshi_compile
        self._msg = omni_message
        self.compile_disabled: list[bool] = []

    def detect_watermark(self, audio, sample_rate, message_threshold=0.5):
        self.compile_disabled.append(bool(self._moshi._compile_disabled))
        return (0.9, torch.tensor(self._msg))


@pytest.fixture
def fakes(monkeypatch, watermark, moshi_compile):
    gen = RecordingGenerator(moshi_compile)
    det = RecordingDetector(moshi_compile, watermark.OMNI_MESSAGE)
    monkeypatch.setattr(watermark, "_generator", gen)
    monkeypatch.setattr(watermark, "_detector", det)
    monkeypatch.setattr(watermark, "_audioseal_available", True)
    monkeypatch.setattr(watermark, "is_enabled", lambda: True)
    monkeypatch.setattr(watermark, "_eager_state", {"depth": 0, "saved": None})
    return gen, det


def test_the_upstream_eager_switch_still_exists(moshi_compile):
    """An audioseal bump that moves this seam must fail here, loudly, rather
    than silently restoring the 30-40 s compile on every user's first take."""
    assert hasattr(moshi_compile, "no_compile")
    assert hasattr(moshi_compile, "_compile_disabled")


def test_embedding_runs_the_generator_eagerly(fakes, watermark):
    gen, _ = fakes
    watermark.embed_watermark(torch.zeros(1, SR), SR)
    assert gen.compile_disabled == [True]


def test_detection_runs_the_detector_eagerly(fakes, watermark):
    _, det = fakes
    watermark.detect_watermark(torch.zeros(1, SR), SR)
    assert det.compile_disabled == [True]


def test_the_eager_guard_is_restored_after_the_call(fakes, watermark, moshi_compile):
    """The switch is a process-global; leaving it latched would silently
    disable compile for every other model in the backend."""
    watermark.embed_watermark(torch.zeros(1, SR), SR)
    assert moshi_compile._compile_disabled is False


def test_the_eager_guard_is_restored_when_embedding_raises(
    monkeypatch, watermark, moshi_compile,
):
    def boom(*_a, **_k):
        raise RuntimeError("C++ compile error")

    monkeypatch.setattr(watermark, "_generator", boom)
    monkeypatch.setattr(watermark, "_audioseal_available", True)
    monkeypatch.setattr(watermark, "is_enabled", lambda: True)
    wave = torch.zeros(1, SR)
    assert watermark.embed_watermark(wave, SR) is wave  # fail-open contract holds
    assert moshi_compile._compile_disabled is False


def test_embedding_still_works_without_the_upstream_switch(monkeypatch, fakes, watermark):
    """A future audioseal without the moshi helper must degrade to a plain
    call, not crash the provenance chokepoint."""
    gen, _ = fakes
    monkeypatch.setattr(watermark, "_moshi_compile_module", lambda: None)
    out = watermark.embed_watermark(torch.zeros(1, SR), SR)
    assert out.shape == (1, SR)
    assert gen.compile_disabled == [False]


def test_overlapping_embeds_never_hand_compile_back(fakes, watermark, moshi_compile):
    """Upstream's no_compile() saves/restores per call, which is only correct
    for LIFO nesting. Concurrent embeds are not LIFO: when the FIRST scope to
    open is also the first to close, its restore writes back the pre-entry
    False while a second embed is still running — handing that embed the exact
    compile this fix removes. The guard is reference counted, so the flag holds
    until the LAST scope exits.

    Ordering is driven explicitly (first-in-first-out), because the LIFO
    interleaving this test used to exercise passes on the buggy code.
    """
    first_in = threading.Event()
    second_in = threading.Event()
    first_out = threading.Event()
    seen: list[bool] = []
    errors: list[BaseException] = []

    def first():
        try:
            with watermark._eager_audioseal():
                first_in.set()
                assert second_in.wait(timeout=10), "second scope never opened"
            first_out.set()                      # closes while `second` is open
        except BaseException as exc:  # noqa: BLE001 — surfaced via the assert below
            errors.append(exc)
            first_in.set()
            first_out.set()

    def second():
        try:
            assert first_in.wait(timeout=10), "first scope never opened"
            with watermark._eager_audioseal():
                second_in.set()
                assert first_out.wait(timeout=10), "first scope never closed"
                seen.append(bool(moshi_compile._compile_disabled))
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)
            second_in.set()

    t1 = threading.Thread(target=first, name="eager-first")
    t2 = threading.Thread(target=second, name="eager-second")
    t1.start()
    t2.start()
    t1.join(timeout=15)
    t2.join(timeout=15)

    assert not errors, errors
    assert seen == [True], "compile was handed back mid-embed by the other scope's exit"
    assert moshi_compile._compile_disabled is False, "guard stayed latched after both exits"
    assert watermark._eager_state["depth"] == 0
