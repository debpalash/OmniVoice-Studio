"""Plan 02-04 — API contract for /engines + /engines/{id}/health.

Asserts:
  * ``GET /engines`` returns the documented per-entry shape
    (id, display_name, available, reason, install_hint, last_error,
     isolation_mode, gpu_compat) for every backend.
  * ``GET /engines/{engine_id}/health`` round-trips for both
    SubprocessBackend (mocked health_check) and in-process backends.
  * Loopback gate is enforced on the health route — non-loopback origin
    returns 403.
  * Unknown engine id returns 404.
  * HF-shaped tokens that a backend's is_available() leaks into its
    error message do NOT reach the response body — T-02-12.

The fixture builds a minimal FastAPI app with just the engines router so
the test stays fast and doesn't require torch / whisperx / demucs to be
fully importable.
"""
from __future__ import annotations

import re
import sys

import pytest


SAMPLE_HF_TOKEN = "hf_abcdefghijklmnopqrstuvwxyz01234567890abcd"
HF_TOKEN_RE = re.compile(r"hf_[A-Za-z0-9]{30,}")


# ── helpers ────────────────────────────────────────────────────────────────


@pytest.fixture
def fresh_app(monkeypatch, tmp_path):
    """Build a fresh FastAPI app instance with isolated DB.

    The full main.py app factory pulls in torch / whisperx / demucs; we
    only need the engines router for these tests so we mount it
    directly, matching the pattern in tests/backend/test_engine_spawn_token.py.
    """
    monkeypatch.setenv("OMNIVOICE_DATA_DIR", str(tmp_path))

    # Wipe cached services so each test gets a clean _LAST_ERRORS dict +
    # _REGISTRY (the engines router imports them on first call).
    for mod in list(sys.modules):
        if (
            mod == "core" or mod.startswith("core.")
            or mod == "services" or mod.startswith("services.")
            or mod == "api" or mod.startswith("api.")
        ):
            del sys.modules[mod]

    from core import db as _db
    _db.init_db()

    from fastapi import FastAPI
    from api.routers import engines as engines_router

    app = FastAPI()
    app.include_router(engines_router.router)
    return app


def _client(app, host="127.0.0.1"):
    """TestClient anchored to a loopback (or non-loopback) client tuple.

    `require_loopback` reads `request.client.host`; the default
    TestClient tuple is `('testclient', 50000)` which the dep rejects.
    """
    from fastapi.testclient import TestClient
    return TestClient(app, client=(host, 12345))


# ── /engines response shape (gpu_compat, isolation_mode, last_error) ──────


def test_engines_response_includes_new_fields(fresh_app):
    client = _client(fresh_app)
    r = client.get("/engines")
    assert r.status_code == 200
    body = r.json()

    required = {
        "id", "display_name", "available", "reason",
        "install_hint", "last_error", "isolation_mode", "gpu_compat",
    }
    for entry in body["tts"]["backends"]:
        missing = required - entry.keys()
        assert not missing, f"entry {entry.get('id')!r} missing keys: {missing}"
        assert isinstance(entry["gpu_compat"], list)
        assert all(isinstance(x, str) for x in entry["gpu_compat"])
        assert entry["isolation_mode"] in {"in-process", "subprocess"}


def test_indextts2_entry_has_subprocess_isolation_mode(fresh_app):
    """Cross-checks Plan 02-03's IndexTTS subprocess migration via the API."""
    client = _client(fresh_app)
    r = client.get("/engines")
    assert r.status_code == 200
    by_id = {b["id"]: b for b in r.json()["tts"]["backends"]}
    assert "indextts2" in by_id
    assert by_id["indextts2"]["isolation_mode"] == "subprocess"


def test_omnivoice_entry_has_in_process_isolation_mode(fresh_app):
    client = _client(fresh_app)
    r = client.get("/engines")
    assert r.status_code == 200
    by_id = {b["id"]: b for b in r.json()["tts"]["backends"]}
    assert "omnivoice" in by_id
    assert by_id["omnivoice"]["isolation_mode"] == "in-process"


def test_gpu_compat_omnivoice_has_cuda_mps_cpu(fresh_app):
    """OmniVoice ships with CUDA/MPS/CPU paths — surface that in the matrix."""
    client = _client(fresh_app)
    r = client.get("/engines")
    by_id = {b["id"]: b for b in r.json()["tts"]["backends"]}
    assert set(by_id["omnivoice"]["gpu_compat"]) == {"cuda", "mps", "cpu"}


# ── /engines/{id}/health round-trip ────────────────────────────────────────


def test_engine_health_subprocess_success(fresh_app, monkeypatch):
    """Mock IndexTTS2Backend.health_check so we don't spawn a real sidecar."""
    from services.tts_backend import _REGISTRY

    # Resolve the lazy entry without spawning anything heavy.
    cls = _REGISTRY["indextts2"]
    monkeypatch.setattr(cls, "health_check", lambda self: (True, "pong"))

    client = _client(fresh_app)
    r = client.get("/engines/indextts2/health")
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == "indextts2"
    assert body["ok"] is True
    assert body["message"] == "pong"
    assert isinstance(body["latency_ms"], (int, float))
    assert body["latency_ms"] >= 0.0


def test_engine_health_in_process_falls_back_to_is_available(fresh_app):
    """No health_check method on OmniVoiceBackend → fall back to is_available."""
    client = _client(fresh_app)
    r = client.get("/engines/omnivoice/health")
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == "omnivoice"
    assert isinstance(body["ok"], bool)
    assert isinstance(body["message"], str)
    assert isinstance(body["latency_ms"], (int, float))


def test_engine_health_unknown_id(fresh_app):
    client = _client(fresh_app)
    r = client.get("/engines/does_not_exist/health")
    assert r.status_code == 404
    assert "unknown engine id" in r.json()["detail"]


def test_engine_health_loopback_only(fresh_app):
    """Non-loopback client tuple is rejected by require_loopback."""
    client = _client(fresh_app, host="10.0.0.5")
    r = client.get("/engines/omnivoice/health")
    assert r.status_code == 403
    assert r.json()["detail"] == "loopback origin required"


def test_engine_health_caches_instance_across_calls(fresh_app, monkeypatch):
    """Two health checks on the same engine reuse the same singleton.

    SubprocessBackend.__init__ registers atexit hooks; recreating it per
    request would leak handler entries and (on real engines) spawn extra
    sidecars on the first lock acquire.
    """
    from api.routers import engines as engines_router
    from services.tts_backend import _REGISTRY

    cls = _REGISTRY["indextts2"]
    call_count = {"n": 0}
    monkeypatch.setattr(cls, "health_check", lambda self: (True, "pong"))
    # Clear the cache so the first call constructs an instance.
    engines_router._ENGINE_INSTANCES.pop(cls, None)
    original_init = cls.__init__

    def _counting_init(self):
        call_count["n"] += 1
        original_init(self)

    monkeypatch.setattr(cls, "__init__", _counting_init)

    client = _client(fresh_app)
    r1 = client.get("/engines/indextts2/health")
    r2 = client.get("/engines/indextts2/health")
    assert r1.status_code == 200 and r2.status_code == 200
    assert call_count["n"] == 1, (
        f"expected exactly one IndexTTS2Backend() construction across "
        f"two health checks, got {call_count['n']}"
    )


# ── HF-token leak prevention (T-02-12) ─────────────────────────────────────


def test_no_hf_token_leak_in_engines_response(fresh_app):
    """A backend whose is_available() embeds a real HF token in its error
    must NOT leak it to the response body. The redaction lives inside
    ``tts_backend.list_backends`` via _mask_hf_tokens.
    """
    from services import tts_backend as tts_mod

    class TaintedBackend(tts_mod.TTSBackend):
        id = "tainted-test"
        display_name = "Tainted backend (test)"

        @property
        def sample_rate(self) -> int:
            return 24000

        @property
        def supported_languages(self) -> list[str]:
            return ["en"]

        @classmethod
        def is_available(cls) -> tuple[bool, str]:
            return False, f"auth failed for {SAMPLE_HF_TOKEN}"

        def generate(self, text: str, **kw):
            raise NotImplementedError

    # Sandbox so the production registry shape doesn't grow permanently.
    saved = dict(tts_mod._REGISTRY)
    saved_errors = dict(tts_mod._LAST_ERRORS)
    try:
        tts_mod._REGISTRY["tainted-test"] = TaintedBackend
        client = _client(fresh_app)
        r = client.get("/engines")
        assert r.status_code == 200
        body_text = r.text
        matches = HF_TOKEN_RE.findall(body_text)
        assert matches == [], (
            f"HF tokens leaked into /engines response body: {matches}"
        )

        # The masked sentinel must be present — otherwise the test isn't
        # actually exercising the redaction path.
        by_id = {b["id"]: b for b in r.json()["tts"]["backends"]}
        assert "tainted-test" in by_id
        assert "hf_***REDACTED***" in (by_id["tainted-test"]["reason"] or "")
    finally:
        tts_mod._REGISTRY.clear()
        tts_mod._REGISTRY.update(saved)
        tts_mod._LAST_ERRORS.clear()
        tts_mod._LAST_ERRORS.update(saved_errors)


def test_no_hf_token_leak_in_health_response(fresh_app, monkeypatch):
    """The health route's message field runs through the same redactor."""
    from services.tts_backend import _REGISTRY

    cls = _REGISTRY["indextts2"]
    monkeypatch.setattr(
        cls, "health_check",
        lambda self: (False, f"sidecar 401 for {SAMPLE_HF_TOKEN}"),
    )

    client = _client(fresh_app)
    r = client.get("/engines/indextts2/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert not HF_TOKEN_RE.search(body["message"])
    assert "hf_***REDACTED***" in body["message"]
