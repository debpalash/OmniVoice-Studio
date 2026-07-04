"""P1.2 — per-language translation storage on the dub job.

``job["segments"]`` is single-slot: every generate rebuilds it with the text
of the language generated LAST. On a multi-language job, subtitle export for
track A after generating track B therefore emitted B's words under A's
language label — ExportModal's "all dubs" subtitle batch produced N files
with IDENTICAL text.

Fix (additive, back-compat): ``_sync_job_segments`` also writes
``job["segments_i18n"] = { langCode: { segKey: text } }`` (segKey = stable
segment id, or the list index for id-less legacy segments), preserving each
generated track's text. ``/dub/srt|vtt?lang=`` and subtitle burn-in overlay
that language's text when present, falling back to today's behaviour for
legacy jobs / unknown languages. ``job["segments"]`` itself is untouched for
every existing consumer.
"""

import os
import uuid

import pytest

os.environ.setdefault("OMNIVOICE_MODEL", "test")


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient
    from main import app
    return TestClient(app, client=("127.0.0.1", 50000))


def _make_req(texts, seg_ids=None, language_code="und", **kwargs):
    from schemas.requests import DubRequest, DubSegment
    segs = [
        DubSegment(start=float(i), end=float(i) + 1.0, text=t)
        for i, t in enumerate(texts)
    ]
    return DubRequest(
        segments=segs, segment_ids=seg_ids, language_code=language_code, **kwargs
    )


@pytest.fixture()
def two_track_job():
    """A job that generated Spanish first, then Bengali — the way
    _sync_job_segments leaves it after the multi-language batch loop."""
    from services.dub_pipeline import _dub_jobs
    from api.routers.dub_generate import _sync_job_segments

    job_id = str(uuid.uuid4())[:8]
    job = {
        "video_path": "/nonexistent/original.mp4",
        "duration": 2.0,
        "filename": "test_video.mp4",
        "segments": [
            {"id": "a1", "start": 0.0, "end": 1.0, "text": "hello world",
             "speaker_id": "Speaker 1"},
            {"id": "a2", "start": 1.0, "end": 2.0, "text": "see you soon",
             "speaker_id": "Speaker 1"},
        ],
        "dubbed_tracks": {
            "es": {"path": "/nonexistent/dubbed_es.wav",
                   "language": "Spanish", "language_code": "es"},
            "bn": {"path": "/nonexistent/dubbed_bn.wav",
                   "language": "Bengali", "language_code": "bn"},
        },
    }
    _sync_job_segments(job, _make_req(
        ["hola mundo", "hasta pronto"], seg_ids=["a1", "a2"], language_code="es"))
    _sync_job_segments(job, _make_req(
        ["ohe prithibi", "abar dekha hobe"], seg_ids=["a1", "a2"], language_code="bn"))
    _dub_jobs[job_id] = job
    yield job_id, job
    _dub_jobs.pop(job_id, None)


# ---------------------------------------------------------------------------
# _sync_job_segments — the additive per-language map
# ---------------------------------------------------------------------------


class TestSegmentsI18n:
    def test_each_generated_language_is_preserved(self, two_track_job):
        _, job = two_track_job
        assert job["segments_i18n"]["es"] == {"a1": "hola mundo", "a2": "hasta pronto"}
        assert job["segments_i18n"]["bn"] == {"a1": "ohe prithibi", "a2": "abar dekha hobe"}
        # job["segments"] keeps the legacy single-slot contract: last language.
        assert [s["text"] for s in job["segments"]] == ["ohe prithibi", "abar dekha hobe"]

    def test_regenerating_a_language_replaces_only_that_language(self, two_track_job):
        from api.routers.dub_generate import _sync_job_segments
        _, job = two_track_job
        _sync_job_segments(job, _make_req(
            ["hola mundo v2"], seg_ids=["a1"], language_code="es"))
        # The es map was rebuilt from the (shorter) request — stale ids gone…
        assert job["segments_i18n"]["es"] == {"a1": "hola mundo v2"}
        # …and bn was untouched.
        assert job["segments_i18n"]["bn"] == {"a1": "ohe prithibi", "a2": "abar dekha hobe"}

    def test_idless_segments_key_by_index(self):
        from api.routers.dub_generate import _sync_job_segments
        job = {"segments": [{"start": 0.0, "end": 1.0, "text": "src"}]}
        _sync_job_segments(job, _make_req(["übersetzt"], language_code="de"))
        assert job["segments_i18n"]["de"] == {"0": "übersetzt"}


# ---------------------------------------------------------------------------
# /dub/srt + /dub/vtt — ?lang= now selects the TEXT, not just cue times
# ---------------------------------------------------------------------------


class TestPerLanguageSubtitles:
    def test_srt_lang_selects_that_tracks_text(self, client, two_track_job):
        """FAILED pre-fix: both languages returned the last-generated text."""
        job_id, _ = two_track_job
        es = client.get(f"/dub/srt/{job_id}", params={"lang": "es"}).text
        bn = client.get(f"/dub/srt/{job_id}", params={"lang": "bn"}).text
        assert "hola mundo" in es and "ohe prithibi" not in es
        assert "ohe prithibi" in bn and "hola mundo" not in bn
        assert es != bn

    def test_vtt_lang_selects_that_tracks_text(self, client, two_track_job):
        job_id, _ = two_track_job
        es = client.get(f"/dub/vtt/{job_id}", params={"lang": "es"}).text
        bn = client.get(f"/dub/vtt/{job_id}", params={"lang": "bn"}).text
        assert "hasta pronto" in es and "abar dekha hobe" not in es
        assert "abar dekha hobe" in bn and "hasta pronto" not in bn

    def test_no_lang_keeps_legacy_behaviour(self, client, two_track_job):
        # No ?lang= → job["segments"] text (last generated), exactly as today.
        job_id, _ = two_track_job
        res = client.get(f"/dub/srt/{job_id}")
        assert res.status_code == 200
        assert "ohe prithibi" in res.text

    def test_unknown_lang_falls_back_to_job_segments(self, client, two_track_job):
        job_id, _ = two_track_job
        res = client.get(f"/dub/srt/{job_id}", params={"lang": "fr"})
        assert res.status_code == 200
        assert "ohe prithibi" in res.text  # graceful fallback, no 404/empty

    def test_legacy_job_without_segments_i18n_falls_back(self, client):
        """Jobs written by previous builds lack segments_i18n entirely."""
        from services.dub_pipeline import _dub_jobs
        job_id = str(uuid.uuid4())[:8]
        _dub_jobs[job_id] = {
            "filename": "old.mp4",
            "segments": [{"id": "a1", "start": 0.0, "end": 1.0, "text": "vecchio"}],
            "dubbed_tracks": {"it": {"path": "/nonexistent/dubbed_it.wav",
                                     "language": "Italian", "language_code": "it"}},
        }
        try:
            res = client.get(f"/dub/srt/{job_id}", params={"lang": "it"})
            assert res.status_code == 200
            assert "vecchio" in res.text
        finally:
            _dub_jobs.pop(job_id, None)

    def test_dual_layout_keeps_original_under_lang_text(self, client, two_track_job):
        job_id, _ = two_track_job
        res = client.get(f"/dub/srt/{job_id}", params={"lang": "es", "dual": 1})
        assert "hola mundo" in res.text
        assert "<i>hello world</i>" in res.text  # text_original untouched


class TestSegmentsForLang:
    def test_index_fallback_for_idless_segments(self):
        from api.routers.dub_export import _segments_for_lang
        job = {
            "segments": [{"start": 0.0, "end": 1.0, "text": "src"}],
            "segments_i18n": {"de": {"0": "übersetzt"}},
        }
        assert _segments_for_lang(job, "de")[0]["text"] == "übersetzt"

    def test_missing_per_segment_entry_keeps_row_text(self):
        from api.routers.dub_export import _segments_for_lang
        job = {
            "segments": [
                {"id": "a1", "start": 0.0, "end": 1.0, "text": "uno"},
                {"id": "a2", "start": 1.0, "end": 2.0, "text": "dos"},
            ],
            "segments_i18n": {"de": {"a1": "eins"}},
        }
        out = _segments_for_lang(job, "de")
        assert [s["text"] for s in out] == ["eins", "dos"]

    def test_never_mutates_job_segments(self):
        from api.routers.dub_export import _segments_for_lang
        job = {
            "segments": [{"id": "a1", "start": 0.0, "end": 1.0, "text": "uno"}],
            "segments_i18n": {"de": {"a1": "eins"}},
        }
        _segments_for_lang(job, "de")
        assert job["segments"][0]["text"] == "uno"

    def test_malformed_i18n_shapes_are_ignored(self):
        from api.routers.dub_export import _segments_for_lang
        segs = [{"id": "a1", "start": 0.0, "end": 1.0, "text": "uno"}]
        for bad in (None, [], "x", {"de": "not-a-dict"}, {"de": {}}):
            job = {"segments": segs, "segments_i18n": bad}
            assert _segments_for_lang(job, "de") == segs


class TestBurnSrtPerLanguage:
    def test_burn_uses_named_tracks_text(self, tmp_path, two_track_job):
        from api.routers.dub_export import _write_burn_srt
        _, job = two_track_job
        content = open(
            _write_burn_srt(job, str(tmp_path), "s1", dual=False, lang="es"),
            encoding="utf-8",
        ).read()
        assert "hola mundo" in content
        assert "ohe prithibi" not in content

    def test_burn_without_lang_keeps_legacy_behaviour(self, tmp_path, two_track_job):
        from api.routers.dub_export import _write_burn_srt
        _, job = two_track_job
        content = open(
            _write_burn_srt(job, str(tmp_path), "s2", dual=False),
            encoding="utf-8",
        ).read()
        assert "ohe prithibi" in content  # last-generated text, as today


# ---------------------------------------------------------------------------
# /tools/incremental — optional per-track lang (P1.3 client recompute)
# ---------------------------------------------------------------------------


class TestIncrementalEndpointLang:
    def test_lang_scopes_the_plan(self, client):
        from services.incremental import segment_fingerprint
        stored = {"a1": segment_fingerprint({"text": "hola"}, track_lang="es")}
        body = {"segments": [{"id": "a1", "text": "hola"}], "stored_hashes": stored}
        # Judged for the track that produced the hashes → fresh.
        res = client.post("/tools/incremental", json={**body, "lang": "es"}).json()
        assert res["fresh"] == ["a1"]
        # Judged for another track → stale (no cross-language reuse).
        res = client.post("/tools/incremental", json={**body, "lang": "bn"}).json()
        assert res["stale"] == ["a1"]

    def test_omitted_lang_keeps_legacy_hashing(self, client):
        from services.incremental import segment_fingerprint
        stored = {"a1": segment_fingerprint({"text": "hola"})}
        res = client.post(
            "/tools/incremental",
            json={"segments": [{"id": "a1", "text": "hola"}], "stored_hashes": stored},
        ).json()
        assert res["fresh"] == ["a1"]
