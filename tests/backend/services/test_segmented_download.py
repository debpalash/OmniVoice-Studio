"""FDL-08: segmented (multi-connection) downloader — correctness + auth safety."""
from __future__ import annotations

import asyncio
import os

import httpx
import pytest

from services.segmented_download import segmented_download, DownloadCancelled


PAYLOAD = bytes((i % 256) for i in range(1_000_000))  # 1 MB deterministic body


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


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


def test_parallel_ranges_reassemble_exactly(tmp_path):
    dest = str(tmp_path / "model.bin")
    client = _client(_ranged_handler())
    _run(segmented_download(
        "https://cdn.example.com/model.bin", dest,
        expected_size=len(PAYLOAD), num_connections=8, client=client,
    ))
    _run(client.aclose())
    with open(dest, "rb") as f:
        assert f.read() == PAYLOAD
    assert not os.path.exists(dest + ".part")          # .part renamed away
    assert not os.path.exists(dest + ".part.done")     # manifest cleaned


def test_single_stream_fallback_when_no_range(tmp_path):
    dest = str(tmp_path / "f.bin")
    client = _client(_ranged_handler(accept_ranges=False))
    _run(segmented_download(
        "https://cdn.example.com/f.bin", dest,
        expected_size=len(PAYLOAD), client=client,
    ))
    _run(client.aclose())
    with open(dest, "rb") as f:
        assert f.read() == PAYLOAD


def test_auth_header_never_sent_to_cdn_host(tmp_path):
    record = []
    dest = str(tmp_path / "f.bin")
    client = _client(_ranged_handler(record=record))
    _run(segmented_download(
        "https://cdn.cloudfront.net/blob", dest,    # NOT a huggingface.co host
        token="hf_secrettoken", expected_size=len(PAYLOAD), client=client,
    ))
    _run(client.aclose())
    assert record, "expected requests"
    assert all("authorization" not in {k.lower() for k in r.headers} for r in record), \
        "Authorization must never be sent to a non-huggingface.co host"


def test_auth_header_sent_to_hf_host(tmp_path):
    record = []
    dest = str(tmp_path / "f.bin")
    client = _client(_ranged_handler(record=record))
    _run(segmented_download(
        "https://huggingface.co/api/x/resolve/main/f", dest,
        token="hf_tok", expected_size=len(PAYLOAD), client=client,
    ))
    _run(client.aclose())
    assert any(r.headers.get("authorization") == "Bearer hf_tok" for r in record)


def test_size_mismatch_raises(tmp_path):
    dest = str(tmp_path / "f.bin")
    client = _client(_ranged_handler())
    with pytest.raises(ValueError):
        _run(segmented_download(
            "https://cdn.example.com/f.bin", dest,
            expected_size=len(PAYLOAD) + 999, client=client,   # wrong size
        ))
    _run(client.aclose())
    assert not os.path.exists(dest)            # never committed on mismatch


def test_cancel_raises_and_leaves_resumable_part(tmp_path):
    dest = str(tmp_path / "f.bin")
    client = _client(_ranged_handler())
    _run(client.__aenter__()) if False else None
    with pytest.raises(DownloadCancelled):
        _run(segmented_download(
            "https://cdn.example.com/f.bin", dest,
            expected_size=len(PAYLOAD), cancel_check=lambda: True, client=client,
        ))
    _run(client.aclose())
    assert not os.path.exists(dest)            # not committed
    # a .part may remain for resume (best-effort) — must not have committed dest


def test_on_bytes_reports_total(tmp_path):
    dest = str(tmp_path / "f.bin")
    seen = []
    client = _client(_ranged_handler())
    _run(segmented_download(
        "https://cdn.example.com/f.bin", dest,
        expected_size=len(PAYLOAD), on_bytes=lambda d: seen.append(d), client=client,
    ))
    _run(client.aclose())
    assert sum(seen) == len(PAYLOAD)
