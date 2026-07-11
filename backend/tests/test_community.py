"""Tests for the community gallery (marketplace) loader.

Covers the no-network surface: strict item validation (invalid presets and
unsafe audio URLs are dropped so they can never crash synthesis or fetch from
an arbitrary host), manifest merge/dedup, offline cache reads, filtering, and
the prefilled submit URL. The render/download paths need the model/network and
are exercised at runtime.
"""
from __future__ import annotations

import json

import pytest

# conftest.py puts `backend/` on sys.path and points OMNIVOICE_DATA_DIR at a
# throwaway tmpdir before this module imports the REAL core.config (the old
# sys.modules stub leaked at collection time and broke mixed runs).
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from api.routers import community  # noqa: E402

_FIXTURE = {
    "schema_version": 1,
    "items": [
        {"id": "p1", "type": "preset", "name": "Test Narrator", "use_case": "narration",
         "facets": {"gender": "female", "age": "middle-aged", "pitch": "low pitch", "lang": "English"},
         "instruct": "female, middle-aged, low pitch", "language": "English", "source": "community"},
        # invalid instruct token -> dropped
        {"id": "p_bad", "type": "preset", "name": "Bad", "use_case": "narration",
         "instruct": "female, raspy, smoky"},
        # unsafe audio host -> dropped
        {"id": "v_bad", "type": "voice", "name": "Sketchy", "use_case": "narration",
         "audio": {"url": "http://evil.example.com/x.wav"}},
        # valid voice (allow-listed host)
        {"id": "v1", "type": "voice", "name": "Recorded One", "use_case": "narration",
         "facets": {"gender": "male", "lang": "English"},
         "audio": {"url": "https://github.com/debpalash/omnivoice-gallery/releases/download/voices-v1/v1.wav"}},
        # unknown use_case -> dropped
        {"id": "u1", "type": "preset", "name": "Mystery", "use_case": "banana", "instruct": "male"},
    ],
    "packs": [{"id": "starter", "name": "Starter", "item_ids": ["p1"]}],
}


@pytest.fixture(scope="module", autouse=True)
def seed_cache():
    cache = community._cache_path("debpalash/omnivoice-gallery")
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(_FIXTURE), encoding="utf-8")
    yield


@pytest.fixture(scope="module")
def client():
    app = FastAPI()
    app.include_router(community.router)
    return TestClient(app)


# ── pure validation ───────────────────────────────────────────────────────────
def test_valid_preset_kept():
    assert community.validate_item(_FIXTURE["items"][0]) is not None


def test_invalid_instruct_dropped():
    assert community.validate_item(_FIXTURE["items"][1]) is None


def test_unsafe_audio_url_dropped():
    assert community.validate_item(_FIXTURE["items"][2]) is None


def test_unknown_use_case_dropped():
    assert community.validate_item(_FIXTURE["items"][4]) is None


def test_is_valid_instruct():
    assert community.is_valid_instruct("male, elderly, very low pitch")
    assert not community.is_valid_instruct("male, sultry")
    assert not community.is_valid_instruct("")


# ── merge keeps only valid items ──────────────────────────────────────────────
def test_merge_drops_invalid_and_dedups():
    items, packs = community._merge([("debpalash/omnivoice-gallery", _FIXTURE)])
    ids = {i["id"] for i in items}
    assert ids == {"p1", "v1"}
    assert packs and packs[0]["id"] == "starter"


# ── endpoints (served from cache, no network) ─────────────────────────────────
def test_manifest_endpoint_from_cache(client):
    body = client.get("/community/manifest").json()
    assert body["count"] == 2
    assert {i["id"] for i in body["items"]} == {"p1", "v1"}
    assert "debpalash/omnivoice-gallery" in body["sources"]


def test_items_filter_by_type(client):
    body = client.get("/community/items", params={"type": "voice"}).json()
    assert [i["id"] for i in body["items"]] == ["v1"]


def test_items_filter_by_use_case(client):
    body = client.get("/community/items", params={"use_case": "narration"}).json()
    assert body["total"] == 2


def test_sources_endpoint(client):
    assert client.get("/community/sources").json()["sources"]


def test_submit_url(client):
    preset = client.get("/community/submit-url", params={"type": "preset"}).json()["url"]
    voice = client.get("/community/submit-url", params={"type": "voice"}).json()["url"]
    assert "preset-submission.yml" in preset and "omnivoice-gallery" in preset
    assert "voice-submission.yml" in voice
