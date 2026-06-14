"""API contract tests for the persona router (``api.routers.personas``).

Torch-free by construction: bundles are hand-crafted ZIPs (manifest + raw audio
bytes), so the import/inspect paths (parse → file-copy → DB insert) run without
the model. The export path's preview generation needs torchaudio and is covered
by the service-layer round-trip in ``tests/test_persona_bundle.py`` + CI; here we
only assert export's 404 (which fails before any audio work).

Follows the config-stub pattern of ``test_archetypes_api.py`` / ``test_community.py``
so it mounts ONLY the persona router on a bare FastAPI app (no ``main`` import,
no torch at collection).
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import types
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

_TMP = tempfile.mkdtemp(prefix="omnivoice_personas_test_")
_VOICES = Path(_TMP) / "voices"
_VOICES.mkdir(parents=True, exist_ok=True)
_config = types.ModuleType("core.config")
_config.DATA_DIR = _TMP
_config.VOICES_DIR = str(_VOICES)
_config.OUTPUTS_DIR = str(Path(_TMP) / "outputs")
_config.DB_PATH = str(Path(_TMP) / "omnivoice.db")
sys.modules["core.config"] = _config

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core.db import db_conn, init_db  # noqa: E402
from services.persona_bundle import build_manifest, DEFAULT_LICENSE  # noqa: E402
from api.routers import personas as personas_router  # noqa: E402

init_db()


@pytest.fixture(scope="module")
def client():
    app = FastAPI()
    app.include_router(personas_router.router)
    return TestClient(app)


# ── bundle builders (no torch) ───────────────────────────────────────────────

def _ovsvoice(*, manifest_over=None, ref=b"R" * 200, locked=None, preview=b"P" * 200,
              consent_audio=None, consent_json=None) -> bytes:
    profile = {"name": "Aria", "kind": "clone", "seed": 7, "vd_states": None}
    members = {"ref_audio": "ref_audio.wav" if ref else None,
               "locked_audio": "locked_audio.wav" if locked else None,
               "consent_audio": "consent_audio.wav" if consent_audio else None}
    manifest = build_manifest(profile, license_spdx="CC-BY-4.0", tags=["x"],
                              preview={"file": "preview.wav", "watermarked": True,
                                       "duration_s": 6.0, "sample_rate": 24000},
                              members=members)
    if manifest_over:
        manifest.update(manifest_over)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        if ref:
            zf.writestr("ref_audio.wav", ref)
        if locked:
            zf.writestr("locked_audio.wav", locked)
        if preview:
            zf.writestr("preview.wav", preview)
        if consent_audio:
            zf.writestr("consent_audio.wav", consent_audio)
        if consent_json is not None:
            zf.writestr("consent.json", json.dumps(consent_json))
    return buf.getvalue()


def _legacy_omnivoice() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("metadata.json", json.dumps(
            {"profile_name": "Old Voice", "kind": "clone", "language": "English"}))
        zf.writestr("ref_audio.wav", b"R" * 200)
    return buf.getvalue()


def _upload(content: bytes, filename="x.ovsvoice"):
    return {"file": (filename, content, "application/zip")}


# ── export ───────────────────────────────────────────────────────────────────

def test_export_404_when_profile_missing(client):
    r = client.post("/personas/export/nope")
    assert r.status_code == 404


# ── import ───────────────────────────────────────────────────────────────────

def test_import_rejects_bad_extension(client):
    r = client.post("/personas/import", files=_upload(b"x", filename="evil.txt"))
    assert r.status_code == 400


def test_import_rejects_non_zip(client):
    r = client.post("/personas/import", files=_upload(b"not a zip"))
    assert r.status_code == 400


def test_import_missing_manifest_400(client):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("ref_audio.wav", b"R" * 200)
    r = client.post("/personas/import", files=_upload(buf.getvalue()))
    assert r.status_code == 400


def test_import_roundtrip_creates_profile(client):
    r = client.post("/personas/import", files=_upload(_ovsvoice(), filename="Aria.ovsvoice"))
    assert r.status_code == 200
    body = r.json()
    assert body["success"] and body["name"] == "Aria" and body["kind"] == "clone"
    assert body["verified_own_voice"] is False
    assert body["license_spdx"] == "CC-BY-4.0"
    assert body["source_bundle"] == "Aria.ovsvoice"
    pid = body["profile_id"]
    with db_conn() as conn:
        row = conn.execute("SELECT * FROM voice_profiles WHERE id=?", (pid,)).fetchone()
    assert row is not None and row["name"] == "Aria" and row["seed"] == 7
    # the ref file landed under a server-derived name, inside VOICES_DIR
    assert os.path.isfile(os.path.join(_config.VOICES_DIR, row["ref_audio_path"]))
    assert row["ref_audio_path"].startswith(pid)


def test_import_case_insensitive_extension(client):
    r = client.post("/personas/import", files=_upload(_ovsvoice(), filename="A.OVSVOICE"))
    assert r.status_code == 200


def test_import_forgery_guard_unverified(client):
    # consent.json claims verified, but NO consent_audio member → unverified (B12).
    bundle = _ovsvoice(consent_json={"verified_own_voice": True, "method": "self-recorded-statement",
                                     "consent_text": "I consent.", "recorded_at": 1.0})
    body = client.post("/personas/import", files=_upload(bundle)).json()
    assert body["verified_own_voice"] is False


def test_import_verified_with_recording(client):
    bundle = _ovsvoice(
        consent_audio=b"C" * 2000,  # >= 1000-byte floor
        consent_json={"verified_own_voice": True, "method": "self-recorded-statement",
                      "consent_text": "I consent to my voice.", "recorded_at": 123.0})
    body = client.post("/personas/import", files=_upload(bundle)).json()
    assert body["verified_own_voice"] is True
    with db_conn() as conn:
        row = conn.execute("SELECT * FROM voice_profiles WHERE id=?",
                           (body["profile_id"],)).fetchone()
    assert row["verified_own_voice"] == 1
    assert row["consent_audio_path"].startswith(body["profile_id"])
    assert row["consent_recorded_at"] == 123.0


def test_import_short_recording_is_unverified(client):
    bundle = _ovsvoice(
        consent_audio=b"C" * 50,  # below floor
        consent_json={"verified_own_voice": True, "consent_text": "ok", "recorded_at": 1.0})
    body = client.post("/personas/import", files=_upload(bundle)).json()
    assert body["verified_own_voice"] is False


def test_import_preview_only(client):
    bundle = _ovsvoice(ref=None, locked=None, manifest_over={
        "members": {"ref_audio": None, "locked_audio": None, "consent_audio": None}})
    body = client.post("/personas/import", files=_upload(bundle)).json()
    assert body["preview_only"] is True
    with db_conn() as conn:
        row = conn.execute("SELECT * FROM voice_profiles WHERE id=?",
                           (body["profile_id"],)).fetchone()
    # the preview became the usable ref clip
    assert os.path.isfile(os.path.join(_config.VOICES_DIR, row["ref_audio_path"]))


def test_import_legacy_omnivoice(client):
    body = client.post("/personas/import",
                       files=_upload(_legacy_omnivoice(), filename="old.omnivoice")).json()
    assert body["name"] == "Old Voice" and body["kind"] == "clone"
    assert body["verified_own_voice"] is False
    assert body["watermarked_preview"] is False
    assert body["license_spdx"] == DEFAULT_LICENSE


# ── inspect (no DB write, no file) ───────────────────────────────────────────

def test_inspect_no_write(client):
    before = set(os.listdir(_config.VOICES_DIR))
    with db_conn() as conn:
        n_before = conn.execute("SELECT COUNT(*) c FROM voice_profiles").fetchone()["c"]
    r = client.post("/personas/inspect", files=_upload(_ovsvoice()))
    assert r.status_code == 200
    body = r.json()
    assert body["format"] == "ovsvoice" and body["name"] == "Aria"
    assert body["license_spdx"] == "CC-BY-4.0"
    after = set(os.listdir(_config.VOICES_DIR))
    with db_conn() as conn:
        n_after = conn.execute("SELECT COUNT(*) c FROM voice_profiles").fetchone()["c"]
    assert before == after and n_before == n_after  # nothing written


def test_inspect_consent_summary(client):
    bundle = _ovsvoice(consent_audio=b"C" * 2000, consent_json={
        "verified_own_voice": True, "method": "self-recorded-statement",
        "consent_text": "yes", "recorded_at": 1.0})
    body = client.post("/personas/inspect", files=_upload(bundle)).json()
    assert body["consent"]["verified_claimed"] is True
    assert body["consent"]["has_recording"] is True
    assert body["consent"]["would_verify"] is True
