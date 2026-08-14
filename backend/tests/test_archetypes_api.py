"""API contract tests for the archetype router (``api.routers.archetypes``).

These cover the parts that don't need the 5 GB TTS model: category listing,
filtering, pagination, lookup, 404s, and the preview *cache-hit* path (a
pre-existing cached WAV is served without invoking the model). The on-demand
render paths (``/preview`` cold, ``/use``) call the real inference pipeline and
are exercised by runtime/manual verification — they're structured to reuse
generation.py's proven ``_run_inference`` rather than re-implementing it.
"""
from __future__ import annotations

import io
import json
from pathlib import Path
import wave

import pytest

# conftest.py puts `backend/` on sys.path and points OMNIVOICE_DATA_DIR at a
# throwaway tmpdir before the router imports VOICES_DIR / OUTPUTS_DIR from
# the REAL core.config (the old sys.modules stub leaked at collection time).
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core import archetypes  # noqa: E402
from api.routers import archetypes as arch_router  # noqa: E402


def _wav_bytes() -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24_000)
        wav.writeframes(b"\x00\x01" * 64)
    return buf.getvalue()


def _write_wav(path: Path) -> bytes:
    data = _wav_bytes()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


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


# ── Free-text search (voice-picker gallery search) ────────────────────────────
def test_q_substring_search_by_name(client):
    """`q` reaches a featured voice by name — the gallery picker's search box."""
    body = client.get("/archetypes", params={"q": "librarian", "limit": 50}).json()
    assert body["items"]
    assert all("librarian" in a["name"].lower() for a in body["items"])


def test_q_matches_instruct_tokens(client):
    """`q` also matches instruct tokens (e.g. an accent) so typing narrows the
    several-hundred-voice catalog instead of only the loaded page."""
    body = client.get("/archetypes", params={"q": "british", "limit": 500}).json()
    assert body["items"]
    assert all("british" in a["instruct"].lower() or "british" in a["name"].lower()
               for a in body["items"])


def test_q_empty_is_noop(client):
    """A blank/whitespace `q` must not filter — it's the default picker state."""
    everything = client.get("/archetypes", params={"limit": 500}).json()["total"]
    blank = client.get("/archetypes", params={"q": "   ", "limit": 500}).json()["total"]
    assert blank == everything


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
    dummy = _write_wav(cache_dir / f"{key}.wav")

    r = client.get(f"/archetypes/{sample['id']}/preview")
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/wav"
    assert r.content == dummy


# ── Materialize-on-use idempotency (dedup, no re-render) ───────────────────────
def test_use_is_idempotent_dedup(client, tmp_path, monkeypatch, symlinks_supported):
    """The 2nd `/use` of the same archetype reuses its one materialized profile
    and does NOT render again — the guarantee that materialize-on-select in any
    voice picker can't spawn duplicate rows on repeated picks.

    The render boundary (``_render_archetype_wav``) is mocked so no model/GPU is
    needed: it just drops a stub WAV where the row expects one.
    """
    from core import event_bus
    from core.db import init_db

    init_db()  # ensure the voice_profiles table exists in the hermetic tmp DB

    render_calls = {"n": 0}

    async def _fake_render(a, out_path):
        render_calls["n"] += 1
        _write_wav(Path(out_path))

    monkeypatch.setattr(arch_router, "_render_archetype_wav", _fake_render)
    emitted = []
    monkeypatch.setattr(
        event_bus, "emit", lambda topic, payload: emitted.append((topic, payload)),
    )

    sample = archetypes.list_archetypes(featured=True)[0]

    first = client.post(f"/archetypes/{sample['id']}/use")
    assert first.status_code == 200
    pid = first.json()["profile_id"]
    assert pid
    assert render_calls["n"] == 1

    second = client.post(f"/archetypes/{sample['id']}/use")
    assert second.status_code == 200
    assert second.json()["profile_id"] == pid  # same row reused
    assert render_calls["n"] == 1  # NOT re-rendered

    # Exactly one row exists for this archetype (no duplicate materialization).
    from core.db import db_conn
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM voice_profiles WHERE personality = ?",
            (arch_router._archetype_personality(sample),),
        ).fetchall()
    assert len(rows) == 1
    assert rows[0]["kind"] == "design"
    assert json.loads(rows[0]["vd_states"]) == sample["attrs"]

    with db_conn() as conn:
        row = conn.execute("SELECT * FROM voice_profiles WHERE id=?", (pid,)).fetchone()
    assert row["kind"] == "design"
    assert row["instruct"] == sample["instruct"]
    assert json.loads(row["vd_states"]) == sample["attrs"]

    # A missing sample or synthesis-input drift must be repaired before the
    # existing profile is returned; Preview and Use must describe one voice.
    audio_path = arch_router._profile_audio_path(row["ref_audio_path"])
    assert audio_path is not None
    audio_path.unlink()
    repaired = client.post(f"/archetypes/{sample['id']}/use")
    assert repaired.status_code == 200 and repaired.json()["profile_id"] == pid
    assert render_calls["n"] == 2
    assert audio_path.read_bytes().startswith(b"RIFF")

    with db_conn() as conn:
        conn.execute("UPDATE voice_profiles SET instruct='male' WHERE id=?", (pid,))
    refreshed = client.post(f"/archetypes/{sample['id']}/use")
    assert refreshed.status_code == 200
    assert refreshed.json()["profile_id"] != pid
    assert render_calls["n"] == 3
    with db_conn() as conn:
        edited = conn.execute("SELECT instruct FROM voice_profiles WHERE id=?", (pid,)).fetchone()
    assert edited["instruct"] == "male"

    # Continue corruption checks against the new canonical materialization.
    pid = refreshed.json()["profile_id"]
    with db_conn() as conn:
        row = conn.execute("SELECT * FROM voice_profiles WHERE id=?", (pid,)).fetchone()
    audio_path = arch_router._profile_audio_path(row["ref_audio_path"])
    assert audio_path is not None

    audio_path.write_bytes(b"not a WAV")
    repaired_corrupt = client.post(f"/archetypes/{sample['id']}/use")
    assert repaired_corrupt.status_code == 200
    assert render_calls["n"] == 4

    if symlinks_supported:  # Windows needs Developer Mode to create symlinks
        outside = tmp_path / "outside.wav"
        outside_bytes = _write_wav(outside)
        audio_path.unlink()
        audio_path.symlink_to(outside)
        repaired_symlink = client.post(f"/archetypes/{sample['id']}/use")
        assert repaired_symlink.status_code == 200
        assert render_calls["n"] == 5
        assert not audio_path.is_symlink()
        assert outside.read_bytes() == outside_bytes

    # A valid header with a missing payload is not playable and must self-heal.
    renders_before = render_calls["n"]
    truncated = _wav_bytes()[:44]
    audio_path.write_bytes(truncated)
    repaired_truncated = client.post(f"/archetypes/{sample['id']}/use")
    assert repaired_truncated.status_code == 200
    assert render_calls["n"] == renders_before + 1
    assert audio_path.read_bytes() != truncated


def test_archetype_staged_repair_preserves_concurrently_edited_profile(
    client, monkeypatch,
):
    """A repair may publish only if the row still belongs to the archetype."""
    from core.config import VOICES_DIR
    from core.db import db_conn, init_db

    init_db()
    sample = archetypes.list_archetypes(featured=True)[3]
    personality = arch_router._archetype_personality(sample)
    edited_personality = f"user-edited:{sample['id']}"
    with db_conn() as conn:
        conn.execute(
            "DELETE FROM voice_profiles WHERE personality IN (?, ?, ?)",
            (sample["id"], personality, edited_personality),
        )

    original_id = {"value": None}
    mutation_seen = {"value": False}

    async def racing_render(_item, path):
        destination = Path(path)
        if destination.name.endswith(".staged.wav"):
            assert original_id["value"] is not None
            with db_conn() as conn:
                conn.execute(
                    "UPDATE voice_profiles SET name='User edit', personality=? WHERE id=?",
                    (edited_personality, original_id["value"]),
                )
            mutation_seen["value"] = True
        _write_wav(destination)

    monkeypatch.setattr(arch_router, "_render_archetype_wav", racing_render)
    first = client.post(f"/archetypes/{sample['id']}/use")
    assert first.status_code == 200
    original_id["value"] = first.json()["profile_id"]

    with db_conn() as conn:
        original = conn.execute(
            "SELECT ref_audio_path FROM voice_profiles WHERE id=?",
            (original_id["value"],),
        ).fetchone()
    original_audio = arch_router._profile_audio_path(original["ref_audio_path"])
    assert original_audio is not None
    corrupt_bytes = b"corrupt user-owned sample"
    original_audio.write_bytes(corrupt_bytes)

    repaired = client.post(f"/archetypes/{sample['id']}/use")
    assert repaired.status_code == 200
    repaired_id = repaired.json()["profile_id"]
    assert mutation_seen["value"]
    assert repaired_id != original_id["value"]

    with db_conn() as conn:
        edited = conn.execute(
            "SELECT * FROM voice_profiles WHERE id=?", (original_id["value"],),
        ).fetchone()
        canonical = conn.execute(
            "SELECT * FROM voice_profiles WHERE id=?", (repaired_id,),
        ).fetchone()
        canonical_count = conn.execute(
            "SELECT count(*) FROM voice_profiles WHERE personality=?", (personality,),
        ).fetchone()[0]
    assert edited["name"] == "User edit"
    assert edited["personality"] == edited_personality
    assert edited["instruct"] == sample["instruct"]
    assert original_audio.read_bytes() == corrupt_bytes
    assert canonical["personality"] == personality
    assert canonical["ref_audio_path"] == arch_router._profile_audio_filename(repaired_id)
    assert canonical_count == 1
    assert (Path(VOICES_DIR) / canonical["ref_audio_path"]).read_bytes() == _wav_bytes()
    assert not list(Path(VOICES_DIR).glob(f".{original_id['value']}-*.staged.wav"))


def test_archetype_use_adopts_only_a_compatible_legacy_row(client, monkeypatch):
    from core.config import VOICES_DIR
    from core.db import db_conn, init_db

    init_db()
    sample = archetypes.list_archetypes(featured=True)[1]
    legacy_id = "legacyarch"
    legacy_audio = Path(VOICES_DIR) / f"{legacy_id}.wav"
    _write_wav(legacy_audio)
    with db_conn() as conn:
        conn.execute(
            "DELETE FROM voice_profiles WHERE personality IN (?, ?)",
            (sample["id"], arch_router._archetype_personality(sample)),
        )
        conn.execute(
            "INSERT INTO voice_profiles "
            "(id, name, ref_audio_path, ref_text, instruct, language, seed, personality, "
            "kind, vd_states, created_at) VALUES (?, 'Legacy archetype', ?, ?, ?, ?, 42, ?, "
            "'clone', NULL, 1)",
            (
                legacy_id, legacy_audio.name, sample["sample_script"], sample["instruct"],
                sample["language"], sample["id"],
            ),
        )

    async def unexpected_render(*_args):
        raise AssertionError("a valid legacy archetype sample must be reused")

    monkeypatch.setattr(arch_router, "_render_archetype_wav", unexpected_render)
    response = client.post(f"/archetypes/{sample['id']}/use")
    assert response.status_code == 200
    assert response.json()["profile_id"] == legacy_id
    with db_conn() as conn:
        row = conn.execute("SELECT * FROM voice_profiles WHERE id=?", (legacy_id,)).fetchone()
    assert row["personality"] == arch_router._archetype_personality(sample)
    assert row["kind"] == "design"
    assert json.loads(row["vd_states"]) == sample["attrs"]


def test_archetype_use_does_not_rewrite_an_imported_personality_collision(
    client, monkeypatch,
):
    from core.config import VOICES_DIR
    from core.db import db_conn, init_db

    init_db()
    sample = archetypes.list_archetypes(featured=True)[2]
    imported_id = "importedarch"
    imported_ns_id = "importedarchns"
    imported_audio = Path(VOICES_DIR) / f"{imported_id}.wav"
    imported_ns_audio = Path(VOICES_DIR) / f"{imported_ns_id}.wav"
    original_audio = _write_wav(imported_audio)
    original_ns_audio = _write_wav(imported_ns_audio)
    with db_conn() as conn:
        conn.execute(
            "DELETE FROM voice_profiles WHERE personality IN (?, ?)",
            (sample["id"], arch_router._archetype_personality(sample)),
        )
        conn.execute(
            "INSERT INTO voice_profiles "
            "(id, name, ref_audio_path, ref_text, instruct, language, seed, personality, "
            "kind, is_locked, verified_own_voice, created_at) VALUES "
            "(?, 'Imported collision', ?, 'user transcript', 'male', 'Auto', NULL, ?, "
            "'clone', 1, 1, 1)",
            (imported_id, imported_audio.name, sample["id"]),
        )
        conn.execute(
            "INSERT INTO voice_profiles "
            "(id, name, ref_audio_path, ref_text, instruct, language, seed, personality, "
            "kind, vd_states, is_locked, verified_own_voice, created_at) VALUES "
            "(?, 'Imported namespaced collision', ?, ?, ?, ?, 42, ?, "
            "'design', NULL, 0, 0, 2)",
            (
                imported_ns_id, imported_ns_audio.name, sample["sample_script"],
                sample["instruct"], sample["language"],
                arch_router._archetype_personality(sample),
            ),
        )

    async def render(_item, path):
        _write_wav(Path(path))

    monkeypatch.setattr(arch_router, "_render_archetype_wav", render)
    response = client.post(f"/archetypes/{sample['id']}/use")
    assert response.status_code == 200
    assert response.json()["profile_id"] != imported_id
    with db_conn() as conn:
        imported = conn.execute(
            "SELECT * FROM voice_profiles WHERE id=?", (imported_id,),
        ).fetchone()
        imported_ns = conn.execute(
            "SELECT * FROM voice_profiles WHERE id=?", (imported_ns_id,),
        ).fetchone()
        created = conn.execute(
            "SELECT * FROM voice_profiles WHERE id=?", (response.json()["profile_id"],),
        ).fetchone()
    assert imported["personality"] == sample["id"]
    assert imported["instruct"] == "male"
    assert imported["ref_text"] == "user transcript"
    assert imported_audio.read_bytes() == original_audio
    assert imported_ns["instruct"] == sample["instruct"]
    assert imported_ns["ref_text"] == sample["sample_script"]
    assert imported_ns["vd_states"] is None
    assert imported_ns_audio.read_bytes() == original_ns_audio
    assert created["personality"] == arch_router._archetype_personality(sample)
