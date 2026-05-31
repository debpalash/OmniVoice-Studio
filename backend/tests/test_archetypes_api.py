"""API contract tests for the archetype router (``api.routers.archetypes``).

These cover the parts that don't need the 5 GB TTS model: category listing,
filtering, pagination, lookup, 404s, and the preview *cache-hit* path (a
pre-existing cached WAV is served without invoking the model). The on-demand
render paths (``/preview`` cold, ``/use``) call the real inference pipeline and
are exercised by runtime/manual verification — they're structured to reuse
generation.py's proven ``_run_inference`` rather than re-implementing it.
"""
from __future__ import annotations

import os
import sys
import tempfile
import types
from pathlib import Path

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

# Stub core.config before the router imports VOICES_DIR / OUTPUTS_DIR from it.
_TMP = tempfile.mkdtemp(prefix="omnivoice_arch_test_")
_VOICES = Path(_TMP) / "voices"
_OUTPUTS = Path(_TMP) / "outputs"
_VOICES.mkdir(parents=True, exist_ok=True)
_OUTPUTS.mkdir(parents=True, exist_ok=True)

_config = types.ModuleType("core.config")
_config.DATA_DIR = _TMP
_config.VOICES_DIR = str(_VOICES)
_config.OUTPUTS_DIR = str(_OUTPUTS)
sys.modules["core.config"] = _config

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core import archetypes  # noqa: E402
from api.routers import archetypes as arch_router  # noqa: E402


@pytest.fixture(scope="module")
def client():
    app = FastAPI()
    app.include_router(arch_router.router)
    return TestClient(app)


# ── Categories ────────────────────────────────────────────────────────────────
def test_categories_endpoint(client):
    r = client.get("/archetypes/categories")
    assert r.status_code == 200
    ids = {c["id"] for c in r.json()}
    assert ids == {
        "narration", "conversational", "characters",
        "social", "entertainment", "advertisement", "informative",
    }


# ── Listing + pagination ──────────────────────────────────────────────────────
def test_list_returns_paginated_envelope(client):
    r = client.get("/archetypes", params={"limit": 10})
    assert r.status_code == 200
    body = r.json()
    assert set(body) >= {"total", "limit", "offset", "items"}
    assert body["total"] >= 250
    assert len(body["items"]) == 10


def test_list_offset_advances(client):
    first = client.get("/archetypes", params={"limit": 5, "offset": 0}).json()
    second = client.get("/archetypes", params={"limit": 5, "offset": 5}).json()
    assert first["total"] == second["total"]
    assert [i["id"] for i in first["items"]] != [i["id"] for i in second["items"]]


# ── Filters ───────────────────────────────────────────────────────────────────
def test_filter_featured(client):
    body = client.get("/archetypes", params={"featured": "true", "limit": 100}).json()
    assert body["items"]
    assert all(a["is_featured"] for a in body["items"])


def test_filter_use_case(client):
    body = client.get("/archetypes", params={"use_case": "narration", "limit": 20}).json()
    assert body["items"]
    assert all(a["use_case"] == "narration" for a in body["items"])


def test_filter_gender(client):
    body = client.get("/archetypes", params={"gender": "female", "limit": 20}).json()
    assert body["items"]
    assert all(a["facets"]["gender"] == "female" for a in body["items"])


def test_filter_language_chinese(client):
    body = client.get("/archetypes", params={"lang": "Chinese", "limit": 20}).json()
    assert body["items"]
    assert all(a["language"] == "Chinese" for a in body["items"])


# ── Lookup + 404s ─────────────────────────────────────────────────────────────
def test_get_single(client):
    sample = archetypes.list_archetypes(featured=True)[0]
    r = client.get(f"/archetypes/{sample['id']}")
    assert r.status_code == 200
    assert r.json()["id"] == sample["id"]


def test_get_missing_404(client):
    assert client.get("/archetypes/nope-xyz").status_code == 404


def test_preview_missing_404(client):
    assert client.get("/archetypes/nope-xyz/preview").status_code == 404


def test_use_missing_404(client):
    assert client.post("/archetypes/nope-xyz/use").status_code == 404


# ── Preview cache-hit (no model needed) ───────────────────────────────────────
def test_preview_serves_cached_wav_without_model(client):
    sample = archetypes.list_archetypes(featured=True)[0]
    key = arch_router._preview_key(sample)
    cache_dir = Path(arch_router._PREVIEW_DIR)
    cache_dir.mkdir(parents=True, exist_ok=True)
    dummy = b"RIFF\x24\x00\x00\x00WAVEfmt cached-archetype-preview"
    (cache_dir / f"{key}.wav").write_bytes(dummy)

    r = client.get(f"/archetypes/{sample['id']}/preview")
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/wav"
    assert r.content == dummy
