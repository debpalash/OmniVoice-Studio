"""Audiobook cover-upload endpoint (`POST /audiobook/cover`).

Calls the handler directly (constructing an UploadFile) rather than through
TestClient(app), so it doesn't import main+torch (which segfaults locally).
"""
from __future__ import annotations

import asyncio
import io
import os

import pytest
from fastapi import HTTPException, UploadFile

from api.routers.audiobook import audiobook_cover


def _upload(name: str, data: bytes) -> UploadFile:
    return UploadFile(io.BytesIO(data), filename=name)


def test_cover_upload_saves(tmp_path, monkeypatch):
    import core.config as cfg
    monkeypatch.setattr(cfg, "OUTPUTS_DIR", str(tmp_path))
    res = asyncio.run(audiobook_cover(_upload("cover.jpg", b"\xff\xd8\xff" + b"x" * 50)))
    assert res["path"].endswith(".jpg")
    assert os.path.isfile(res["path"])
    assert res["path"].startswith(str(tmp_path))


def test_cover_upload_rejects_bad_type():
    with pytest.raises(HTTPException) as ei:
        asyncio.run(audiobook_cover(_upload("c.txt", b"hi")))
    assert ei.value.status_code == 400


def test_cover_upload_rejects_oversize(tmp_path, monkeypatch):
    import core.config as cfg
    monkeypatch.setattr(cfg, "OUTPUTS_DIR", str(tmp_path))
    with pytest.raises(HTTPException) as ei:
        asyncio.run(audiobook_cover(_upload("big.png", b"\x89PNG" + b"0" * (8 * 1024 * 1024 + 1))))
    assert ei.value.status_code == 400


def test_cover_upload_rejects_empty(tmp_path, monkeypatch):
    import core.config as cfg
    monkeypatch.setattr(cfg, "OUTPUTS_DIR", str(tmp_path))
    with pytest.raises(HTTPException):
        asyncio.run(audiobook_cover(_upload("empty.jpg", b"")))
