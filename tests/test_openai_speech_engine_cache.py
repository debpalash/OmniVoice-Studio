"""_resolve_engine must reuse engine instances across /v1/audio/speech requests.

Regression: the direct engine-ID path did ``return cls()`` per request, so every
``model: "pockettts"`` (or any SubprocessBackend engine) spawned a fresh sidecar
process, re-imported torch and reloaded the engine's model — a ~28s floor per
request on real hardware — and registered another atexit hook each time. The
cached-singleton seam (``get_engine_instance_for``) exists precisely for this;
the route just wasn't using it for explicit engine IDs (only tts-1/tts-1-hd got
the shared active-engine instance).
"""
from __future__ import annotations

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


def test_switching_explicit_engine_ids_unloads_the_outgoing_one(oc, monkeypatch):
    """Cache must not accumulate residents: a different explicit `model` ID
    unloads the outgoing engine first (same switch rule as the active-engine
    path, MM2-01)."""
    svc = _tts_mod()
    unloaded = []

    def _make(name):
        class _B:
            ident = name

            def __init__(self):
                pass

            @staticmethod
            def is_available():
                return True, "ok"

            def unload(self):
                unloaded.append(name)

        return _B

    engines = {"a-engine": _make("a"), "b-engine": _make("b")}
    monkeypatch.setattr(svc, "get_backend_class", lambda i: engines[i])

    first = oc._resolve_engine("a-engine")
    second = oc._resolve_engine("a-engine")
    assert first is second
    assert unloaded == []

    third = oc._resolve_engine("b-engine")
    assert third is not first
    assert unloaded == ["a"]
