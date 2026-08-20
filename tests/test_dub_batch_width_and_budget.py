"""Native dub batching must not get riskier on the host (#1620 review).

Batching the default engine 8 segments wide was unconditional. That widens the
forward pass with no capability check on hardware where a SINGLE job already
declares ``min_vram_gb = 6.0`` — so 4-8 GB CUDA cards and MPS Macs could OOM
on a path that succeeds today, one segment at a time. #1616 is a 4 GB card
reporting capacity failures on the un-batched path already.

The batch budget had the same shape of problem in the other direction:
``generate_timeout_s`` returns a floor plus per-length overage, so summing it
over eight items produced a ~2400s budget and a wedged batch would hold a
GPU-pool worker for forty minutes before the #730 reset.
"""
from __future__ import annotations

import importlib

import pytest


@pytest.fixture
def batch():
    return importlib.import_module("api.routers.batch")


class _Engine:
    min_vram_gb = 6.0


@pytest.fixture
def host(monkeypatch, batch):
    """Force a specific detected host."""
    def _set(family, vram_gb):
        import core.device_caps as caps_mod

        class _Caps:
            pass

        caps = _Caps()
        caps.family = family
        caps.vram_gb = vram_gb
        monkeypatch.setattr(caps_mod, "detect_host_caps", lambda: caps)
    return _set


@pytest.mark.parametrize("family,vram_gb,expected", [
    ("cpu", 0.0, 1),      # batching buys nothing, costs RAM
    ("cuda", 4.0, 1),     # #1616's card — must not widen
    ("cuda", 6.0, 1),     # exactly the single-job floor: no headroom
    ("mps", 8.0, 2),      # 16 GB Mac
    ("cuda", 12.0, 4),
    ("cuda", 24.0, 8),
])
def test_the_width_follows_measured_headroom(batch, host, family, vram_gb, expected):
    host(family, vram_gb)
    assert batch._native_batch_width(_Engine()) == expected


def test_an_unprobeable_host_does_not_batch(batch, monkeypatch):
    """Unknown capability is not permission to widen the forward pass."""
    import core.device_caps as caps_mod

    def boom():
        raise RuntimeError("probe failed")

    monkeypatch.setattr(caps_mod, "detect_host_caps", boom)
    assert batch._native_batch_width(_Engine()) == 1


def test_the_width_is_overridable(batch, host, monkeypatch):
    host("cuda", 4.0)
    monkeypatch.setenv(batch.BATCH_WIDTH_ENV, "6")
    assert batch._native_batch_width(_Engine()) == 6


def test_the_override_is_bounded_and_survives_nonsense(batch, host, monkeypatch):
    host("cuda", 24.0)
    monkeypatch.setenv(batch.BATCH_WIDTH_ENV, "9999")
    assert batch._native_batch_width(_Engine()) == 16     # capped
    monkeypatch.setenv(batch.BATCH_WIDTH_ENV, "0")
    assert batch._native_batch_width(_Engine()) == 1      # floored
    monkeypatch.setenv(batch.BATCH_WIDTH_ENV, "banana")
    assert batch._native_batch_width(_Engine()) == 8      # falls back to the host


def test_the_batch_budget_is_not_the_sum_of_the_floors(batch, monkeypatch):
    """One floor covers wedge detection for the whole call; only the
    length-driven overage is additive."""
    import services.model_manager as mm

    FLOOR = 300.0

    def fake_timeout(text, *, engine=None, execution_device=None):
        return FLOOR + len(text or "")

    monkeypatch.setattr(mm, "generate_timeout_s", fake_timeout)

    texts = ["a" * 10] * 8
    budget = batch._batch_timeout_s(texts, _Engine())

    assert budget == FLOOR + 8 * 10          # one floor + summed overage
    assert budget < sum(fake_timeout(t) for t in texts)  # not 8 floors
    assert budget < 2400                     # the wedge window stays minutes


def test_the_batch_budget_still_covers_the_longest_item(batch, monkeypatch):
    import services.model_manager as mm

    monkeypatch.setattr(
        mm, "generate_timeout_s",
        lambda text, *, engine=None, execution_device=None: 300.0 + len(text or ""),
    )
    texts = ["x" * 500, "y", "z"]
    budget = batch._batch_timeout_s(texts, _Engine())
    assert budget >= 300.0 + 500  # the long segment alone still fits


# ── cached-segment payload guard (Greptile, #1620 review) ─────────────────

class _Info:
    def __init__(self, *, frames, channels=1, bits=16, sample_rate=24000):
        self.num_frames = frames
        self.num_channels = channels
        self.bits_per_sample = bits
        self.sample_rate = sample_rate


@pytest.fixture
def dub():
    return importlib.import_module("api.routers.dub_generate")


def test_a_complete_cache_takes_the_fast_path(dub, tmp_path):
    p = tmp_path / "seg.wav"
    p.write_bytes(b"\0" * (44 + 1000 * 2))
    assert dub._cached_payload_intact(str(p), _Info(frames=1000)) is True


def test_a_truncated_cache_is_rejected(dub, tmp_path):
    """The header still says 1000 frames; the file holds ~100. Taking the
    header at face value would plan timing around audio that isn't there."""
    p = tmp_path / "seg.wav"
    p.write_bytes(b"\0" * (44 + 100 * 2))
    assert dub._cached_payload_intact(str(p), _Info(frames=1000)) is False


def test_a_compressed_cache_is_left_to_the_decoder(dub, tmp_path):
    """No fixed bits-per-sample means the size comparison is meaningless —
    don't reject a cache we cannot reason about."""
    p = tmp_path / "seg.opus"
    p.write_bytes(b"\0" * 128)
    assert dub._cached_payload_intact(str(p), _Info(frames=48000, bits=0)) is True


def test_a_missing_cache_is_rejected(dub, tmp_path):
    assert dub._cached_payload_intact(str(tmp_path / "gone.wav"), _Info(frames=10)) is False


def test_a_multichannel_cache_accounts_for_channels(dub, tmp_path):
    p = tmp_path / "stereo.wav"
    p.write_bytes(b"\0" * (44 + 1000 * 2))          # enough for mono only
    assert dub._cached_payload_intact(str(p), _Info(frames=1000, channels=2)) is False
