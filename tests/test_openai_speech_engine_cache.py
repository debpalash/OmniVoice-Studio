"""_resolve_engine must reuse engine instances across /v1/audio/speech requests.

Regression: the direct engine-ID path did ``return cls()`` per request, so every
``model: "pockettts"`` (or any SubprocessBackend engine) spawned a fresh sidecar
process, re-imported torch and reloaded the engine's model — a ~28s floor per
request on real hardware — and registered another atexit hook each time. The
cached-singleton seam (``get_engine_instance_for``) exists precisely for this;
the route just wasn't using it for explicit engine IDs (only tts-1/tts-1-hd got
the shared active-engine instance).

The flip side of caching is accumulation: cached explicit engines must not
stack multi-GB residents when requests switch ``model`` ids. That is NOT a
router-local unload cache (an id-keyed instance ref goes stale against the
class-keyed shared cache — registry rebinds, idle sweeps) — the route calls
``evict_other_tts_engines`` before warming the engine, the exact seam
/generate uses (single-engine-resident policy, MM2-01), pinned here at the
route level.
"""
from __future__ import annotations

import os

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

import pytest


def _tts_mod():
    import importlib

    return importlib.import_module("services.tts_backend")


@pytest.fixture()
def oc():
    import importlib

    return importlib.import_module("api.routers.openai_compat")


def test_explicit_engine_id_resolves_to_the_cached_singleton(oc, monkeypatch):
    svc = _tts_mod()

    class _FakeBackend:
        instances = 0

        def __init__(self):
            _FakeBackend.instances += 1

        @staticmethod
        def is_available():
            return True, "ok"

    monkeypatch.setattr(svc, "get_backend_class", lambda _id: _FakeBackend)

    first = oc._resolve_engine("pockettts")
    second = oc._resolve_engine("pockettts")
    assert first is second
    # Exactly one construction across both resolves: the cached singleton did
    # the work, not a fresh cls() per request.
    assert _FakeBackend.instances == 1


def test_unknown_engine_id_still_400s(oc, monkeypatch):
    from fastapi import HTTPException

    svc = _tts_mod()

    def _unknown(_id):
        raise ValueError("no such engine")

    monkeypatch.setattr(svc, "get_backend_class", _unknown)
    with pytest.raises(HTTPException) as exc:
        oc._resolve_engine("not-an-engine")
    assert exc.value.status_code == 400
    assert "Unknown model" in exc.value.detail


# ── Cross-request memory discipline ─────────────────────────────────────────


def _make_engine(tb, eid: str):
    """A registry-real fake engine (same harness shape as
    tests/test_text_normalization_routes.py) that counts its unloads."""
    import torch

    class _E(tb.TTSBackend):
        id = eid
        display_name = f"{eid} (test)"
        supports_cloning = True
        gpu_compat = ("cpu",)
        unloads = 0

        @property
        def sample_rate(self) -> int:
            return 24000

        @property
        def supported_languages(self) -> list[str]:
            return ["multi"]

        @classmethod
        def is_available(cls):
            return True, "ready"

        def generate(self, text, **kw) -> torch.Tensor:
            return torch.zeros(1, 24000)

        def unload(self):
            type(self).unloads += 1

    return _E


def test_speech_request_evicts_other_resident_engines(monkeypatch):
    """Switching explicit `model` ids across requests must hand back the
    outgoing engine's model (single-engine-resident policy) — the cached
    singletons cannot accumulate residents."""
    svc = _tts_mod()
    a = _make_engine(svc, "fake-cache-a")
    b = _make_engine(svc, "fake-cache-b")
    monkeypatch.setitem(svc._REGISTRY, "fake-cache-a", a)
    monkeypatch.setitem(svc._REGISTRY, "fake-cache-b", b)

    from fastapi.testclient import TestClient
    from main import app

    client = TestClient(app, client=("127.0.0.1", 50000))

    r1 = client.post("/v1/audio/speech", json={
        "model": "fake-cache-a", "input": "hi", "response_format": "wav",
    })
    assert r1.status_code == 200, r1.text
    assert a.unloads == 0  # the engine that just ran stays warm

    r2 = client.post("/v1/audio/speech", json={
        "model": "fake-cache-b", "input": "hi", "response_format": "wav",
    })
    assert r2.status_code == 200, r2.text
    assert a.unloads == 1  # outgoing engine handed its model back
    assert b.unloads == 0  # incoming engine untouched
