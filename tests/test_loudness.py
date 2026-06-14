"""Orchestrator tests for the two-pass loudness measure (#28 slice 2).

Drives services.loudness.measure_loudness with a stubbed run_ffmpeg (no real
ffmpeg, no torch) — asserts the never-raises / single-pass-fallback contract
across the full failure matrix.
"""
from __future__ import annotations

import asyncio

import pytest

from services.loudness import measure_loudness

_JSON = """[Parsed_loudnorm_0 @ 0x55]
{
    "input_i" : "-21.75", "input_tp" : "-18.06", "input_lra" : "0.00",
    "input_thresh" : "-31.75", "target_offset" : "0.05"
}
[out#0/null @ 0x66] size=N/A
"""


def _run(coro):
    return asyncio.run(coro)


def _stub(monkeypatch, *, rc=0, err=b"", raises=None, spy=None):
    async def fake(cmd, *a, **kw):
        if spy is not None:
            spy["cmd"] = cmd
            spy["job_id"] = kw.get("job_id")
            spy["called"] = True
        if raises is not None:
            raise raises
        return (rc, b"", err)
    if spy is not None:
        spy["called"] = False
    monkeypatch.setattr("services.ffmpeg_utils.run_ffmpeg", fake)


def test_happy_parses_fixture(monkeypatch):
    _stub(monkeypatch, rc=0, err=_JSON.encode())
    m = _run(measure_loudness("ffmpeg", "c.txt", "acx", job_id="j1"))
    assert m is not None and m.input_i == -21.75 and m.target_offset == 0.05


@pytest.mark.parametrize("preset", ["off", "none", "bogus", " acx ", "", None])
def test_skips_without_spawning(monkeypatch, preset):
    spy = {}
    _stub(monkeypatch, rc=0, err=_JSON.encode(), spy=spy)
    assert _run(measure_loudness("ffmpeg", "c.txt", preset, job_id="j")) is None
    assert spy["called"] is False  # never ran ffmpeg for a non-preset


def test_nonzero_rc_returns_none(monkeypatch):
    _stub(monkeypatch, rc=1, err=_JSON.encode())
    assert _run(measure_loudness("ffmpeg", "c.txt", "acx", job_id="j")) is None


def test_rc_none_returns_none(monkeypatch):
    _stub(monkeypatch, rc=None, err=_JSON.encode())
    assert _run(measure_loudness("ffmpeg", "c.txt", "acx", job_id="j")) is None


def test_timeout_does_not_propagate(monkeypatch):
    _stub(monkeypatch, raises=asyncio.TimeoutError())
    assert _run(measure_loudness("ffmpeg", "c.txt", "acx", job_id="j")) is None


def test_oserror_returns_none(monkeypatch):
    _stub(monkeypatch, raises=OSError("spawn failed"))
    assert _run(measure_loudness("ffmpeg", "c.txt", "acx", job_id="j")) is None


def test_empty_and_unparseable_stderr_return_none(monkeypatch):
    _stub(monkeypatch, rc=0, err=b"")
    assert _run(measure_loudness("ffmpeg", "c.txt", "acx", job_id="j")) is None
    _stub(monkeypatch, rc=0, err=b"garbage no json {trunc")
    assert _run(measure_loudness("ffmpeg", "c.txt", "acx", job_id="j")) is None


def test_non_utf8_stderr_still_parses(monkeypatch):
    # cp1252 byte + the ASCII JSON block → decode('replace') keeps the JSON.
    _stub(monkeypatch, rc=0, err=b"\xff broken byte\n" + _JSON.encode())
    m = _run(measure_loudness("ffmpeg", "c.txt", "acx", job_id="j"))
    assert m is not None and m.input_i == -21.75


def test_forwards_job_id_and_uses_measure_argv(monkeypatch):
    spy = {}
    _stub(monkeypatch, rc=0, err=_JSON.encode(), spy=spy)
    _run(measure_loudness("ffmpeg", "c.txt", "acx", job_id="job-xyz"))
    assert spy["job_id"] == "job-xyz"
    assert spy["cmd"][:5] == ["ffmpeg", "-y", "-hide_banner", "-loglevel", "info"]
    assert spy["cmd"][-3:] == ["-f", "null", "-"]
