"""#1032 perf regression: /generate must not re-transcribe a profile's
reference clip on every request.

The #308 auto-transcribe path (transcript-less reference → ASR registry) runs
per request, and `get_active_asr_backend()` builds a FRESH backend — a full
whisper model load — each time. A clone profile saved without a transcript
(POST /profiles defaults ref_text to "") therefore paid that load on EVERY
generate. The fix persists the first auto-transcript onto the profile row so
subsequent generates read it like a user-entered one.

Guards, tested here too:
  * only an EMPTY ref_text column is ever filled (user text is never clobbered);
  * a request-supplied ref_text skips the transcribe entirely (no persist);
  * locked profiles are excluded — their reference is the locked take, and
    unlocking would strand a mismatched transcript against the original clip.

The engine layer is stubbed (no real model loads), matching
``tests/test_profile_language_propagation.py``.
"""
import importlib
import os
import uuid

import pytest
import torch

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")


def _tts_mod():
    return importlib.import_module("services.tts_backend")


def _make_fake_engine(engine_id="fake-reftext-engine"):
    class _FakeEngine(_tts_mod().TTSBackend):
        id = engine_id
        display_name = "Fake RefText Engine (test)"
        applies_own_mastering = False
        gpu_compat = ("cpu",)
        calls: list = []

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
            type(self).calls.append((text, kw))
            return torch.zeros(1, 24000)

    return _FakeEngine


class _CountingTranscribe:
    def __init__(self, result="auto transcript words"):
        self.calls = 0
        self.result = result

    def __call__(self, audio_path):
        self.calls += 1
        return self.result


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient
    from main import app

    return TestClient(app, client=("127.0.0.1", 50000))


@pytest.fixture()
def _init_db():
    from core.db import init_db

    init_db()


def _insert_profile(pid, **cols):
    from core.db import db_conn

    base = {
        "id": pid, "name": "RefText Test", "kind": "clone", "created_at": 0.0,
        "ref_text": "", "ref_audio_path": "reftext-test.wav",
    }
    base.update(cols)
    keys = list(base)
    with db_conn() as conn:
        conn.execute(
            f"INSERT INTO voice_profiles ({', '.join(keys)}) "
            f"VALUES ({', '.join('?' * len(keys))})",
            [base[k] for k in keys],
        )


def _profile_ref_text(pid):
    from core.db import db_conn

    with db_conn() as conn:
        return conn.execute(
            "SELECT ref_text FROM voice_profiles WHERE id=?", (pid,)
        ).fetchone()["ref_text"]


@pytest.fixture()
def clone_profile(_init_db):
    """Unlocked clone profile with a reference clip but NO stored transcript —
    the shape POST /profiles produces when the user doesn't type one."""
    from core.db import db_conn

    pid = f"vp-rt-{uuid.uuid4().hex[:8]}"
    _insert_profile(pid)
    yield pid
    with db_conn() as conn:
        conn.execute("DELETE FROM generation_history WHERE profile_id=?", (pid,))
        conn.execute("DELETE FROM voice_profiles WHERE id=?", (pid,))


@pytest.fixture()
def locked_profile(_init_db):
    """Locked profile with an empty ref_text (legacy pre-lock-write rows)."""
    from core.db import db_conn

    pid = f"vp-rtl-{uuid.uuid4().hex[:8]}"
    _insert_profile(pid, is_locked=1, locked_audio_path="locked-take.wav")
    yield pid
    with db_conn() as conn:
        conn.execute("DELETE FROM generation_history WHERE profile_id=?", (pid,))
        conn.execute("DELETE FROM voice_profiles WHERE id=?", (pid,))


def _generate(client, pid, fake_engine, **extra):
    data = {"text": "Hello world", "profile_id": pid, "engine": fake_engine.id}
    data.update(extra)
    res = client.post("/generate", data=data)
    assert res.status_code == 200, res.text
    return res


def test_auto_transcript_persisted_and_reused(client, monkeypatch, clone_profile):
    """First generate transcribes ONCE and writes the transcript to the row;
    the second reads it back — no second transcribe. Before the fix the
    counter hit 2 and the column stayed empty."""
    import services.asr_backend as ab

    fake = _make_fake_engine()
    monkeypatch.setitem(_tts_mod()._REGISTRY, fake.id, fake)
    fake.calls.clear()
    counting = _CountingTranscribe()
    monkeypatch.setattr(ab, "transcribe_reference", counting)

    _generate(client, clone_profile, fake)
    assert counting.calls == 1
    assert _profile_ref_text(clone_profile) == "auto transcript words"

    _generate(client, clone_profile, fake)
    assert counting.calls == 1  # persisted row short-circuits the ASR path
    # Both engine calls saw the transcript — the second from the DB row.
    assert [kw.get("ref_text") for _, kw in fake.calls] == [
        "auto transcript words", "auto transcript words",
    ]


def test_request_ref_text_wins_and_is_not_persisted(client, monkeypatch, clone_profile):
    """A request-supplied transcript must skip ASR and must NOT be written to
    the profile (it may be a one-off override)."""
    import services.asr_backend as ab

    fake = _make_fake_engine()
    monkeypatch.setitem(_tts_mod()._REGISTRY, fake.id, fake)
    fake.calls.clear()
    counting = _CountingTranscribe()
    monkeypatch.setattr(ab, "transcribe_reference", counting)

    _generate(client, clone_profile, fake, ref_text="typed by user")
    assert counting.calls == 0
    assert _profile_ref_text(clone_profile) == ""


def test_stored_transcript_never_overwritten(client, monkeypatch, _init_db):
    """A profile that already has a transcript is untouched (and untranscribed)."""
    import services.asr_backend as ab
    from core.db import db_conn

    pid = f"vp-rts-{uuid.uuid4().hex[:8]}"
    _insert_profile(pid, ref_text="the user's own words")
    try:
        fake = _make_fake_engine()
        monkeypatch.setitem(_tts_mod()._REGISTRY, fake.id, fake)
        fake.calls.clear()
        counting = _CountingTranscribe()
        monkeypatch.setattr(ab, "transcribe_reference", counting)

        _generate(client, pid, fake)
        assert counting.calls == 0
        assert _profile_ref_text(pid) == "the user's own words"
    finally:
        with db_conn() as conn:
            conn.execute("DELETE FROM generation_history WHERE profile_id=?", (pid,))
            conn.execute("DELETE FROM voice_profiles WHERE id=?", (pid,))


def test_locked_profile_transcript_not_persisted(client, monkeypatch, locked_profile):
    """Locked profiles still transcribe (their audio is the locked take) but
    never persist — unlocking must not pair that transcript with the original
    reference clip."""
    import services.asr_backend as ab

    fake = _make_fake_engine()
    monkeypatch.setitem(_tts_mod()._REGISTRY, fake.id, fake)
    fake.calls.clear()
    counting = _CountingTranscribe(result="locked take words")
    monkeypatch.setattr(ab, "transcribe_reference", counting)

    _generate(client, locked_profile, fake)
    assert counting.calls == 1
    assert _profile_ref_text(locked_profile) == ""
