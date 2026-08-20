"""AudioSeal must watermark eagerly — never through torch.compile (#1615).

AudioSeal vendors moshi's ``@torch_compile_lazy`` on ``SEANetEncoder.forward``,
so the FIRST embed (not the model load — #1577's prefetch loads fine) calls
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

import pytest
import torch

from services import watermark
from services.watermark import detect_watermark, embed_watermark

SR = 24000


def _moshi_compile_module():
    """AudioSeal's vendored moshi compile switch, or None when unavailable."""
    try:
        from audioseal.libs.moshi.utils import compile as moshi_compile
    except Exception:  # pragma: no cover — exercised via the skip below
        return None
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
    def __init__(self, moshi_compile):
        self._moshi = moshi_compile
        self.compile_disabled: list[bool] = []

    def detect_watermark(self, audio, sample_rate, message_threshold=0.5):
        self.compile_disabled.append(bool(self._moshi._compile_disabled))
        return (0.9, torch.tensor(watermark.OMNI_MESSAGE))


@pytest.fixture
def moshi_compile():
    mod = _moshi_compile_module()
    if mod is None:
        pytest.skip("audioseal not installed in this environment")
    return mod


@pytest.fixture
def fakes(monkeypatch, moshi_compile):
    gen = RecordingGenerator(moshi_compile)
    det = RecordingDetector(moshi_compile)
    monkeypatch.setattr(watermark, "_generator", gen)
    monkeypatch.setattr(watermark, "_detector", det)
    monkeypatch.setattr(watermark, "_audioseal_available", True)
    monkeypatch.setattr(watermark, "is_enabled", lambda: True)
    return gen, det


def test_the_upstream_eager_switch_still_exists(moshi_compile):
    """An audioseal bump that moves this seam must fail here, loudly, rather
    than silently restoring the 30-40 s compile on every user's first take."""
    assert hasattr(moshi_compile, "no_compile")
    assert hasattr(moshi_compile, "_compile_disabled")


def test_embedding_runs_the_generator_eagerly(fakes):
    gen, _ = fakes
    embed_watermark(torch.zeros(1, SR), SR)
    assert gen.compile_disabled == [True]


def test_detection_runs_the_detector_eagerly(fakes):
    _, det = fakes
    detect_watermark(torch.zeros(1, SR), SR)
    assert det.compile_disabled == [True]


def test_the_eager_guard_is_restored_after_the_call(fakes, moshi_compile):
    """The switch is a process-global; leaving it latched would silently
    disable compile for every other model in the backend."""
    embed_watermark(torch.zeros(1, SR), SR)
    assert moshi_compile._compile_disabled is False


def test_the_eager_guard_is_restored_when_embedding_raises(monkeypatch, moshi_compile):
    def boom(*_a, **_k):
        raise RuntimeError("C++ compile error")

    monkeypatch.setattr(watermark, "_generator", boom)
    monkeypatch.setattr(watermark, "_audioseal_available", True)
    monkeypatch.setattr(watermark, "is_enabled", lambda: True)
    wave = torch.zeros(1, SR)
    assert embed_watermark(wave, SR) is wave  # fail-open contract holds
    assert moshi_compile._compile_disabled is False


def test_embedding_still_works_without_the_upstream_switch(monkeypatch, fakes):
    """A future audioseal without the moshi helper must degrade to a plain
    call, not crash the provenance chokepoint."""
    gen, _ = fakes
    monkeypatch.setattr(watermark, "_moshi_no_compile", lambda: None)
    out = embed_watermark(torch.zeros(1, SR), SR)
    assert out.shape == (1, SR)
    assert gen.compile_disabled == [False]
