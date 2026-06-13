"""Input bounds on the longform endpoints (review findings #4/#5).

Direct handler calls (no main/torch import). Caps are monkeypatched small so the
tests stay cheap.
"""
from __future__ import annotations

import asyncio
import io

import pytest
from fastapi import HTTPException, UploadFile

import api.routers.audiobook as ab
from api.routers.audiobook import (
    LongformChapter,
    LongformRenderRequest,
    LongformSpan,
    audiobook_import,
    longform_render,
)


def test_import_rejects_oversize(monkeypatch):
    monkeypatch.setattr(ab, "_IMPORT_MAX_BYTES", 10)
    up = UploadFile(io.BytesIO(b"x" * 50), filename="big.txt")
    with pytest.raises(HTTPException) as ei:
        asyncio.run(audiobook_import(up))
    assert ei.value.status_code == 400


def test_longform_render_rejects_too_many_chapters(monkeypatch):
    monkeypatch.setattr(ab, "_MAX_CHAPTERS", 1)
    req = LongformRenderRequest(chapters=[
        LongformChapter(title="A", spans=[LongformSpan(text="hi")]),
        LongformChapter(title="B", spans=[LongformSpan(text="yo")]),
    ])
    with pytest.raises(HTTPException) as ei:
        asyncio.run(longform_render(req))
    assert ei.value.status_code == 422
