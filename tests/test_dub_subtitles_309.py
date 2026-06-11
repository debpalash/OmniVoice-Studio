"""Regression tests for issue #309 — dubbed subtitles export/burn-in.

Two symptoms, one root cause each:

1. Subtitle burn-in / SRT / VTT used the original-language ASR transcript
   (``job["segments"]``) because the translated text only ever lived in the
   ``/dub/generate`` request payload. ``_sync_job_segments`` now persists the
   generated segments back onto the job.

2. "Save error: Unexpected non-whitespace character after JSON" — the Tauri
   save dialog appends ``?save_path=…`` to every export URL and parses the
   response as JSON, but ``/dub/srt`` and ``/dub/vtt`` ignored the param and
   returned the raw subtitle body (which starts with the cue index ``1``, a
   valid JSON document, followed by the timestamp line → parse error at
   line 2 column 1). Both endpoints now honour ``save_path`` and return the
   standard native-save JSON envelope.
"""

import os
import uuid

import pytest

os.environ.setdefault("OMNIVOICE_MODEL", "test")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def client():
    from fastapi.testclient import TestClient
    from main import app
    return TestClient(app, client=("127.0.0.1", 50000))


@pytest.fixture()
def translated_job():
    """A dub job whose segments carry source text + translated text, the way
    they look after transcribe → translate → generate (post-#309 sync)."""
    from services.dub_pipeline import _dub_jobs

    job_id = str(uuid.uuid4())[:8]
    job = {
        "video_path": "/nonexistent/original.mp4",
        "duration": 3.0,
        "filename": "test_video.mp4",
        "segments": [
            {"id": "a1", "start": 0.0, "end": 1.0, "text": "Hello world",
             "text_original": "shalom olam", "speaker_id": "Speaker 1"},
            {"id": "a2", "start": 1.0, "end": 2.0, "text": "How are you",
             "text_original": "ma shlomcha", "speaker_id": "Speaker 1"},
        ],
        "dubbed_tracks": {"en": {"path": "/nonexistent/dubbed_en.wav",
                                 "language": "English", "language_code": "en"}},
    }
    _dub_jobs[job_id] = job
    yield job_id, job
    _dub_jobs.pop(job_id, None)


def _make_req(texts, seg_ids=None, **kwargs):
    from schemas.requests import DubRequest, DubSegment
    segs = [
        DubSegment(start=float(i), end=float(i) + 1.0, text=t)
        for i, t in enumerate(texts)
    ]
    return DubRequest(segments=segs, segment_ids=seg_ids, **kwargs)


# ---------------------------------------------------------------------------
# Symptom 1 — translated text must reach job["segments"] (burn-in source)
# ---------------------------------------------------------------------------

class TestSyncJobSegments:
    def test_translated_text_replaces_source_text(self):
        from api.routers.dub_generate import _sync_job_segments
        job = {"segments": [
            {"id": "a1", "start": 0.0, "end": 1.0, "text": "shalom olam", "speaker_id": "Speaker 1"},
            {"id": "a2", "start": 1.0, "end": 2.0, "text": "ma shlomcha", "speaker_id": "Speaker 2"},
        ]}
        req = _make_req(["Hello world", "How are you"], seg_ids=["a1", "a2"])
        _sync_job_segments(job, req)

        assert [s["text"] for s in job["segments"]] == ["Hello world", "How are you"]
        # Source text preserved for dual-subtitle layouts.
        assert [s["text_original"] for s in job["segments"]] == ["shalom olam", "ma shlomcha"]
        # Metadata carried over from the matched existing segment.
        assert [s["speaker_id"] for s in job["segments"]] == ["Speaker 1", "Speaker 2"]
        assert [s["id"] for s in job["segments"]] == ["a1", "a2"]

    def test_existing_text_original_never_clobbered(self):
        from api.routers.dub_generate import _sync_job_segments
        job = {"segments": [
            {"id": "a1", "start": 0.0, "end": 1.0, "text": "Hallo Welt",
             "text_original": "shalom olam"},
        ]}
        # Second generate pass (e.g. re-translate to English): text_original
        # must stay the ASR source, not the previous translation.
        req = _make_req(["Hello world"], seg_ids=["a1"])
        _sync_job_segments(job, req)
        assert job["segments"][0]["text"] == "Hello world"
        assert job["segments"][0]["text_original"] == "shalom olam"

    def test_index_fallback_without_segment_ids(self):
        from api.routers.dub_generate import _sync_job_segments
        job = {"segments": [
            {"start": 0.0, "end": 1.0, "text": "shalom olam", "speaker_id": "Speaker 1"},
        ]}
        req = _make_req(["Hello world"])  # no segment_ids
        _sync_job_segments(job, req)
        assert job["segments"][0]["text"] == "Hello world"
        assert job["segments"][0]["text_original"] == "shalom olam"
        assert job["segments"][0]["speaker_id"] == "Speaker 1"

    def test_split_segments_extend_beyond_existing(self):
        from api.routers.dub_generate import _sync_job_segments
        job = {"segments": [
            {"id": "a1", "start": 0.0, "end": 2.0, "text": "shalom olam"},
        ]}
        req = _make_req(["Hello", "world"], seg_ids=["a1", "a1b"])
        _sync_job_segments(job, req)
        assert len(job["segments"]) == 2
        assert job["segments"][1]["text"] == "world"
        assert job["segments"][1]["id"] == "a1b"

    def test_empty_request_keeps_existing_segments(self):
        from api.routers.dub_generate import _sync_job_segments
        from schemas.requests import DubRequest
        job = {"segments": [{"id": "a1", "start": 0.0, "end": 1.0, "text": "keep me"}]}
        _sync_job_segments(job, DubRequest(segments=[]))
        assert job["segments"][0]["text"] == "keep me"

    def test_request_timing_wins(self):
        from api.routers.dub_generate import _sync_job_segments
        job = {"segments": [{"id": "a1", "start": 0.0, "end": 1.0, "text": "x"}]}
        req = _make_req(["y"], seg_ids=["a1"])
        req.segments[0].start = 0.5
        req.segments[0].end = 1.5
        _sync_job_segments(job, req)
        assert job["segments"][0]["start"] == 0.5
        assert job["segments"][0]["end"] == 1.5


class TestBurnSrtUsesTranslatedText:
    def test_burn_srt_contains_translated_not_source(self, tmp_path, translated_job):
        from api.routers.dub_export import _write_burn_srt
        _, job = translated_job
        sub_path = _write_burn_srt(job, str(tmp_path), "stamp", dual=False)
        content = open(sub_path, encoding="utf-8").read()
        assert "Hello world" in content
        assert "How are you" in content
        assert "shalom olam" not in content  # source text must not burn in

    def test_burn_srt_dual_stacks_original_below(self, tmp_path, translated_job):
        from api.routers.dub_export import _write_burn_srt
        _, job = translated_job
        sub_path = _write_burn_srt(job, str(tmp_path), "stamp", dual=True)
        content = open(sub_path, encoding="utf-8").read()
        assert "Hello world\n<i>shalom olam</i>" in content


# ---------------------------------------------------------------------------
# Symptom 2 — SRT/VTT save_path must return JSON, raw GET must return text
# ---------------------------------------------------------------------------

class TestSubtitleSaveResponseShape:
    def test_srt_save_path_returns_json_envelope(self, client, translated_job, tmp_path):
        job_id, _ = translated_job
        dest = tmp_path / "subs.srt"
        res = client.get(f"/dub/srt/{job_id}", params={"save_path": str(dest)})
        assert res.status_code == 200
        assert res.headers["content-type"].startswith("application/json")
        data = res.json()  # must not raise — this was the #309 failure mode
        assert data["saved"] is True
        assert data["path"] == str(dest)
        assert data["size"] > 0
        assert data["display_name"].endswith(".srt")
        on_disk = dest.read_text(encoding="utf-8")
        assert "Hello world" in on_disk
        assert "-->" in on_disk

    def test_vtt_save_path_returns_json_envelope(self, client, translated_job, tmp_path):
        job_id, _ = translated_job
        dest = tmp_path / "subs.vtt"
        res = client.get(f"/dub/vtt/{job_id}", params={"save_path": str(dest), "dual": 1})
        assert res.status_code == 200
        assert res.headers["content-type"].startswith("application/json")
        data = res.json()
        assert data["saved"] is True
        on_disk = dest.read_text(encoding="utf-8")
        assert on_disk.startswith("WEBVTT")
        assert "Hello world" in on_disk
        assert "shalom olam" in on_disk  # dual layout includes original

    def test_srt_save_path_with_filename_route(self, client, translated_job, tmp_path):
        # The Export drawer uses the /{filename} route variant.
        job_id, _ = translated_job
        dest = tmp_path / "named.srt"
        res = client.get(
            f"/dub/srt/{job_id}/subtitles_en.srt", params={"save_path": str(dest)},
        )
        assert res.status_code == 200
        assert res.json()["saved"] is True
        assert dest.exists()

    def test_srt_relative_save_path_rejected(self, client, translated_job):
        job_id, _ = translated_job
        res = client.get(f"/dub/srt/{job_id}", params={"save_path": "relative/subs.srt"})
        assert res.status_code == 400

    def test_plain_srt_get_still_returns_text_body(self, client, translated_job):
        job_id, _ = translated_job
        res = client.get(f"/dub/srt/{job_id}")
        assert res.status_code == 200
        assert not res.headers["content-type"].startswith("application/json")
        assert res.text.startswith("1\n")
        assert "Hello world" in res.text

    def test_plain_vtt_get_still_returns_text_body(self, client, translated_job):
        job_id, _ = translated_job
        res = client.get(f"/dub/vtt/{job_id}")
        assert res.status_code == 200
        assert res.text.startswith("WEBVTT")
        assert "text/vtt" in res.headers["content-type"]
