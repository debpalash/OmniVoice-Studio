"""Free-memory probe + the non-blocking low-memory advisory.

The device-caps probe reports *total* memory once per process; a load decision
needs *free* memory now — and on MPS that's free system RAM (unified memory).
These pin the threshold logic and the never-raises contract.
"""
from __future__ import annotations

import os

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

from services import memory_budget as mb


def test_available_memory_reports_system_ram():
    m = mb.available_memory()
    # psutil is a runtime dep, so RAM must be present and sane.
    assert m["ram_total_gb"] > 0
    assert 0 <= m["ram_available_gb"] <= m["ram_total_gb"]


def test_warning_fires_on_low_ram_and_is_silent_with_headroom():
    # Below headroom → advisory; comfortably above → None. Uses the pure
    # formatter so the test doesn't depend on the box's real free memory.
    low = mb._format({"ram_available_gb": 1.2, "ram_total_gb": 16.0}, headroom_gb=2.0)
    assert low and "Low memory" in low and "1.2 GB" in low

    ok = mb._format({"ram_available_gb": 9.0, "ram_total_gb": 16.0}, headroom_gb=2.0)
    assert ok is None


def test_vram_takes_precedence_on_a_dedicated_gpu():
    # When a CUDA host reports free VRAM, THAT is the figure checked (not RAM).
    warn = mb._format(
        {"vram_free_gb": 0.8, "vram_total_gb": 8.0, "ram_available_gb": 40.0},
        headroom_gb=2.0,
    )
    assert warn and "GPU memory" in warn and "0.8 GB" in warn

    ok = mb._format(
        {"vram_free_gb": 6.0, "vram_total_gb": 8.0, "ram_available_gb": 1.0},
        headroom_gb=2.0,
    )
    assert ok is None  # plenty of VRAM → no warning, even though RAM is low


def test_format_is_silent_when_memory_is_unknown():
    assert mb._format({}, headroom_gb=2.0) is None


def test_log_if_low_never_raises_and_returns_the_message(monkeypatch, caplog):
    monkeypatch.setattr(mb, "available_memory", lambda: {"ram_available_gb": 0.5, "ram_total_gb": 16.0})
    msg = mb.log_if_low("TTS load (omnivoice)", headroom_gb=2.0)
    assert msg and "Low memory" in msg

    # No memory info → no message, no raise.
    monkeypatch.setattr(mb, "available_memory", lambda: {})
    assert mb.log_if_low("TTS load", headroom_gb=2.0) is None


def test_available_memory_never_raises(monkeypatch):
    # psutil blowing up must not propagate — a broken probe returns {}, not a 500.
    import sys

    monkeypatch.setitem(sys.modules, "psutil", None)  # force ImportError path
    assert isinstance(mb.available_memory(), dict)
