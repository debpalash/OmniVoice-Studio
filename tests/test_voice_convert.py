"""POST /convert — Studio's speech-to-speech voice changer.

Contract under test (all engine/ASR layers stubbed — no GPU, no weights):
  * happy path: source clip → active-ASR transcript (word_timestamps=False)
    → TTS conditioned on the chosen profile's reference audio → saved take
    returned as ``{audio_url, text, duration_s}`` with a 'convert' history row;
  * a missing profile is a strict 404 (unlike /generate's silent skip);
  * an empty transcript is a 422 — nothing to convert;
  * a clone-less active engine is refused with the actionable 400 from
    ``resolve_generation_backend(require_cloning=True)``;
  * a TTS-only install (no ASR weights) answers the typed 409 download CTA;
  * duration match: the atempo ratio is clamped to one ffmpeg stage
    ([0.5, 2.0]) and lands on the ffmpeg argv; the toggle is honored;
  * the router is registered on the app (a real request routes, and the
    committed route snapshot carries POST /convert).
"""
import asyncio
import importlib
import os
import re
import uuid

import pytest
import torch

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")


def _tts_mod():
    return importlib.import_module("services.tts_backend")


def _vc_mod():
    return importlib.import_module("api.routers.voice_convert")


def _make_fake_engine(engine_id, *, cloning=True):
    class _FakeEngine(_tts_mod().TTSBackend):
        id = engine_id
        display_name = f"Fake Convert Engine ({engine_id})"
        applies_own_mastering = False
        gpu_compat = ("cpu",)
        supports_cloning = cloning
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
            return torch.zeros(1, 24000)  # 1 s of silence

    return _FakeEngine


class _FakeASR:
    id = "fake-asr"

    def __init__(self, result):
        self.result = result
        self.calls: list = []

    def transcribe(self, audio_path, *, word_timestamps=True):
        self.calls.append({"audio_path": audio_path, "word_timestamps": word_timestamps})
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


@pytest.fixture()
def clone_profile(_init_db):
    from core.db import db_conn

    pid = f"vp-conv-{uuid.uuid4().hex[:8]}"
    with db_conn() as conn:
        conn.execute(
            "INSERT INTO voice_profiles (id, name, kind, ref_audio_path, ref_text, created_at) "
            "VALUES (?,?,?,?,?,?)",
            (pid, "Convert Target", "clone", "convert-ref.wav", "reference words", 0.0),
        )
    yield pid
    with db_conn() as conn:
        conn.execute("DELETE FROM generation_history WHERE profile_id=?", (pid,))
        conn.execute("DELETE FROM voice_profiles WHERE id=?", (pid,))


def _wire_stubs(monkeypatch, *, engine_cls, asr):
    """Point the active engine + ASR seams at the fakes (no weights load)."""
    import services.asr_backend as ab

    monkeypatch.setitem(_tts_mod()._REGISTRY, engine_cls.id, engine_cls)
    monkeypatch.setenv("OMNIVOICE_TTS_BACKEND", engine_cls.id)
    monkeypatch.setattr(ab, "asr_model_missing_error", lambda **kw: None)
    monkeypatch.setattr(ab, "load_active_asr_backend", lambda **kw: asr)


def _post_convert(client, pid, **extra):
    data = {"profile_id": pid}
    data.update(extra)
    return client.post(
        "/convert",
        data=data,
        files={"audio": ("source.wav", b"RIFF-fake-wav-bytes", "audio/wav")},
    )


# ── The route ───────────────────────────────────────────────────────────────


def test_convert_happy_path(client, monkeypatch, clone_profile):
    """ASR text → TTS with the profile's reference clip → saved take with a
    'convert' history row, answered as {audio_url, text, duration_s}."""
    from core.config import VOICES_DIR
    from core.db import db_conn

    fake = _make_fake_engine(f"fake-conv-{uuid.uuid4().hex[:6]}")
    asr = _FakeASR({"text": "hello there world", "segments": [
        {"start": 0.0, "end": 1.5, "text": "hello there world"},
    ]})
    _wire_stubs(monkeypatch, engine_cls=fake, asr=asr)

    res = _post_convert(client, clone_profile, match_duration="0")
    assert res.status_code == 200, res.text
    body = res.json()

    assert re.fullmatch(r"/audio/[0-9a-f-]{8}\.wav", body["audio_url"])
    assert "hello there world" in body["text"].lower()
    assert body["duration_s"] == pytest.approx(1.0, abs=0.05)

    # ASR ran on the upload without word timestamps (the text is all we need).
    assert asr.calls and asr.calls[0]["word_timestamps"] is False

    # TTS was conditioned on the PROFILE's reference clip + stored transcript.
    assert len(fake.calls) == 1
    gen_text, gen_kwargs = fake.calls[0]
    assert "hello there world" in gen_text.lower()
    assert gen_kwargs["ref_audio"] == os.path.join(VOICES_DIR, "convert-ref.wav")
    assert gen_kwargs["ref_text"] == "reference words"

    # The take exists on disk and its history row is a 'convert'.
    from core.config import OUTPUTS_DIR
    take = body["audio_url"].rsplit("/", 1)[-1]
    assert os.path.isfile(os.path.join(OUTPUTS_DIR, take))
    with db_conn() as conn:
        row = conn.execute(
            "SELECT mode, profile_id FROM generation_history WHERE id=?",
            (body["id"],),
        ).fetchone()
    assert row["mode"] == "convert"
    assert row["profile_id"] == clone_profile


def test_convert_missing_profile_is_404(client, monkeypatch):
    """No target voice, no convert — strict 404, never a profileless render."""
    fake = _make_fake_engine(f"fake-conv-{uuid.uuid4().hex[:6]}")
    _wire_stubs(monkeypatch, engine_cls=fake, asr=_FakeASR({"text": "hi"}))

    res = _post_convert(client, "vp-does-not-exist")
    assert res.status_code == 404
    assert "doesn't exist" in res.json()["detail"]
    assert fake.calls == []


def test_convert_empty_transcript_is_422(client, monkeypatch, clone_profile):
    """Silence/music in, nothing recognized → 422 with guidance, no TTS run."""
    fake = _make_fake_engine(f"fake-conv-{uuid.uuid4().hex[:6]}")
    asr = _FakeASR({"text": "", "segments": []})
    _wire_stubs(monkeypatch, engine_cls=fake, asr=asr)

    res = _post_convert(client, clone_profile)
    assert res.status_code == 422
    assert "No speech was recognized" in res.json()["detail"]
    assert fake.calls == []


def test_convert_refuses_clone_less_engine(client, monkeypatch, clone_profile):
    """The shared require_cloning gate answers 400 with the switch-engine CTA
    before any ASR/TTS work happens."""
    fake = _make_fake_engine(f"fake-noclone-{uuid.uuid4().hex[:6]}", cloning=False)
    asr = _FakeASR({"text": "hello"})
    _wire_stubs(monkeypatch, engine_cls=fake, asr=asr)

    res = _post_convert(client, clone_profile)
    assert res.status_code == 400
    assert "doesn't support voice cloning" in res.json()["detail"]
    assert asr.calls == []
    assert fake.calls == []


def test_convert_asr_missing_is_typed_409(client, monkeypatch, clone_profile):
    """TTS-only install: the same typed asr_model_missing 409 (+ download CTA
    payload) every other ASR consumer answers — never a silent download."""
    import services.asr_backend as ab

    fake = _make_fake_engine(f"fake-conv-{uuid.uuid4().hex[:6]}")
    _wire_stubs(monkeypatch, engine_cls=fake, asr=_FakeASR({"text": "hi"}))
    payload = {
        "error": "asr_model_missing",
        "missing_repo_id": "org/some-whisper",
        "recommended": {"repo_id": "org/some-whisper", "label": "Whisper", "size_gb": 1.5},
    }
    monkeypatch.setattr(ab, "asr_model_missing_error", lambda **kw: payload)

    res = _post_convert(client, clone_profile)
    assert res.status_code == 409
    detail = res.json()["detail"]
    assert detail["error"] == "asr_model_missing"
    assert detail["recommended"]["repo_id"] == "org/some-whisper"
    assert fake.calls == []


def test_convert_match_duration_toggle(client, monkeypatch, clone_profile):
    """match_duration defaults ON (stretch invoked with the source duration);
    '0' skips the stretch entirely."""
    fake = _make_fake_engine(f"fake-conv-{uuid.uuid4().hex[:6]}")
    asr = _FakeASR({"text": "hello", "segments": [{"start": 0.0, "end": 2.5, "text": "hello"}]})
    _wire_stubs(monkeypatch, engine_cls=fake, asr=asr)

    import services.ffmpeg_utils as ff
    async def _no_probe(path, *, allowed_root):
        return None  # force the ASR-segment fallback for the source duration
    monkeypatch.setattr(ff, "probe_duration", _no_probe)

    vc = _vc_mod()
    stretch_calls = []

    async def _fake_match(audio_tensor, sample_rate, source_duration_s):
        stretch_calls.append(source_duration_s)
        return audio_tensor

    monkeypatch.setattr(vc, "_match_source_duration", _fake_match)

    assert _post_convert(client, clone_profile).status_code == 200  # default on
    assert stretch_calls == [2.5]

    assert _post_convert(client, clone_profile, match_duration="0").status_code == 200
    assert stretch_calls == [2.5]  # unchanged — no second stretch


# ── Duration match internals (the atempo clamp + argv) ─────────────────────


def test_clamped_tempo_ratio():
    vc = _vc_mod()
    assert vc._clamped_tempo_ratio(6.0, 5.0) == pytest.approx(1.2)   # speed up
    assert vc._clamped_tempo_ratio(4.0, 5.0) == pytest.approx(0.8)   # slow down
    assert vc._clamped_tempo_ratio(10.0, 2.0) == 2.0                 # clamp high
    assert vc._clamped_tempo_ratio(1.0, 10.0) == 0.5                 # clamp low
    assert vc._clamped_tempo_ratio(5.0, 5.0) is None                 # already matched
    assert vc._clamped_tempo_ratio(5.03, 5.0) is None                # within tolerance
    assert vc._clamped_tempo_ratio(5.0, 0.0) is None                 # unusable source
    assert vc._clamped_tempo_ratio(0.0, 5.0) is None                 # unusable take


def test_match_duration_atempo_argv(monkeypatch):
    """The stretch pipes through `ffmpeg -af atempo=<clamped ratio>` — a 10 s
    take against a 2 s source clamps at 2.0, never a chained 5× chipmunk."""
    import numpy as np
    import services.ffmpeg_utils as ff

    vc = _vc_mod()
    argv_seen = []

    class _FakeProc:
        returncode = 0

        async def communicate(self, input=None):
            # 240000 samples in / clamped 2.0 → 120000 float32 samples out.
            return np.zeros(120000, dtype=np.float32).tobytes(), b""

    async def _fake_spawn(*args, **kwargs):
        argv_seen.append(list(args))
        return _FakeProc()

    monkeypatch.setattr(ff, "find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(ff, "spawn_subprocess", _fake_spawn)

    out = asyncio.run(
        vc._match_source_duration(torch.zeros(1, 240000), 24000, 2.0)
    )
    assert out.shape[-1] == 120000

    (argv,) = argv_seen
    af = argv[argv.index("-af") + 1]
    assert af == "atempo=2.000000"  # ONE clamped stage — no chained atempo
    assert argv[0] == "ffmpeg"


def test_match_duration_survives_ffmpeg_failure(monkeypatch):
    """A broken ffmpeg degrades to the unstretched take, never a 500."""
    import services.ffmpeg_utils as ff

    vc = _vc_mod()

    async def _boom(*args, **kwargs):
        raise RuntimeError("no ffmpeg here")

    monkeypatch.setattr(ff, "find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(ff, "spawn_subprocess", _boom)

    wav = torch.zeros(1, 240000)
    out = asyncio.run(vc._match_source_duration(wav, 24000, 2.0))
    assert out is wav


# ── Registration ────────────────────────────────────────────────────────────


def test_convert_router_is_registered():
    """POST /convert is on the app and pinned in the committed route snapshot
    (tests/test_api_route_inventory.py diffs the live app against it)."""
    from main import app

    routes = {
        (m, r.path)
        for r in app.routes
        if hasattr(r, "methods") and r.methods
        for m in r.methods
    }
    assert ("POST", "/convert") in routes

    snapshot = os.path.join(os.path.dirname(__file__), "fixtures", "api_routes.txt")
    with open(snapshot, encoding="utf-8") as f:
        assert "POST /convert\n" in f.read()
