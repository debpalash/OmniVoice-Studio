"""FDL-08: segmented (multi-connection) downloader — correctness + auth safety.

Each test runs a single self-contained coroutine via ``asyncio.run`` (fresh
event loop per call). Do NOT use ``asyncio.get_event_loop()`` here: in the full
suite an earlier async test can leave the global loop closed, which would make
these RuntimeError even though they pass standalone.
"""
from __future__ import annotations

import asyncio
import os

import httpx
import pytest

from services.segmented_download import segmented_download, DownloadCancelled


PAYLOAD = bytes((i % 256) for i in range(1_000_000))  # 1 MB deterministic body


def _ranged_handler(payload=PAYLOAD, *, accept_ranges=True, record=None):
    """A mock origin that honours Range requests over `payload`."""
    def handler(request: httpx.Request) -> httpx.Response:
        if record is not None:
            record.append(request)
        if request.method == "HEAD":
            h = {"content-length": str(len(payload))}
            if accept_ranges:
                h["accept-ranges"] = "bytes"
            return httpx.Response(200, headers=h)
        rng = request.headers.get("range")
        if rng and accept_ranges:
            lo, hi = rng.replace("bytes=", "").split("-")
            lo, hi = int(lo), int(hi)
            return httpx.Response(206, content=payload[lo:hi + 1])
        return httpx.Response(200, content=payload)
    return handler


def _client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)


def _download(handler, dest, **kw):
    """Run one segmented_download against a mock origin in a fresh event loop."""
    url = kw.pop("url", "https://cdn.example.com/f.bin")

    async def _do():
        async with _client(handler) as client:
            return await segmented_download(url, dest, client=client, **kw)

    return asyncio.run(_do())


def test_parallel_ranges_reassemble_exactly(tmp_path):
    dest = str(tmp_path / "model.bin")
    _download(_ranged_handler(), dest, expected_size=len(PAYLOAD), num_connections=8)
    with open(dest, "rb") as f:
        assert f.read() == PAYLOAD
    assert not os.path.exists(dest + ".part")
    assert not os.path.exists(dest + ".part.done")


def test_single_stream_fallback_when_no_range(tmp_path):
    dest = str(tmp_path / "f.bin")
    _download(_ranged_handler(accept_ranges=False), dest, expected_size=len(PAYLOAD))
    with open(dest, "rb") as f:
        assert f.read() == PAYLOAD


def test_auth_header_never_sent_to_cdn_host(tmp_path):
    record = []
    dest = str(tmp_path / "f.bin")
    _download(_ranged_handler(record=record), dest,
              url="https://cdn.cloudfront.net/blob",  # NOT a huggingface.co host
              token="hf_secrettoken", expected_size=len(PAYLOAD))
    assert record
    assert all("authorization" not in {k.lower() for k in r.headers} for r in record), \
        "Authorization must never be sent to a non-huggingface.co host"


def test_auth_header_sent_to_hf_host(tmp_path):
    record = []
    dest = str(tmp_path / "f.bin")
    _download(_ranged_handler(record=record), dest,
              url="https://huggingface.co/api/x/resolve/main/f",
              token="hf_tok", expected_size=len(PAYLOAD))
    assert any(r.headers.get("authorization") == "Bearer hf_tok" for r in record)


def test_size_mismatch_raises(tmp_path):
    dest = str(tmp_path / "f.bin")
    with pytest.raises(ValueError):
        _download(_ranged_handler(), dest, expected_size=len(PAYLOAD) + 999)
    assert not os.path.exists(dest)


def test_cancel_raises_and_leaves_no_commit(tmp_path):
    dest = str(tmp_path / "f.bin")
    with pytest.raises(DownloadCancelled):
        _download(_ranged_handler(), dest, expected_size=len(PAYLOAD), cancel_check=lambda: True)
    assert not os.path.exists(dest)


def test_on_bytes_reports_total(tmp_path):
    dest = str(tmp_path / "f.bin")
    seen = []
    _download(_ranged_handler(), dest, expected_size=len(PAYLOAD), on_bytes=lambda d: seen.append(d))
    assert sum(seen) == len(PAYLOAD)
