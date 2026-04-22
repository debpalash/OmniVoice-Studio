"""Phase 3 — TTS / ASR / LLM adapter registries."""
import os
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

import pytest
from services import tts_backend, asr_backend, llm_backend


# ── TTS ─────────────────────────────────────────────────────────────────────


def test_tts_registry_lists_all_backends():
    rows = tts_backend.list_backends()
    ids = {r["id"] for r in rows}
    # Core set must exist; optional engines (kittentts, mlx-audio) may be
    # added as platform support lands — only assert the baseline.
    assert {"omnivoice", "voxcpm2", "moss-tts-nano"}.issubset(ids)
    for r in rows:
        assert set(r) >= {"id", "display_name", "available", "reason"}


def test_tts_voxcpm2_unavailable_message_is_actionable():
    ok, msg = tts_backend.VoxCPM2Backend.is_available()
    # On most CI boxes voxcpm isn't installed; message must tell the user how.
    if not ok:
        assert "pip install voxcpm" in msg or "CUDA" in msg


def test_tts_moss_nano_unavailable_message_points_to_install():
    ok, msg = tts_backend.MossTTSNanoBackend.is_available()
    if not ok:
        # Either transformers is missing or the moss_tts_nano package itself.
        assert "moss_tts_nano" in msg or "transformers" in msg


def test_tts_moss_nano_language_count():
    # Non-redundant niche: 20 langs including Arabic/Hebrew/Persian/Korean.
    langs = tts_backend.MossTTSNanoBackend().supported_languages
    assert len(langs) == 20
    assert {"ar", "he", "fa", "ko", "tr"}.issubset(set(langs))


def test_tts_active_backend_env_override(monkeypatch):
    monkeypatch.setenv("OMNIVOICE_TTS_BACKEND", "voxcpm2")
    assert tts_backend.active_backend_id() == "voxcpm2"
    monkeypatch.delenv("OMNIVOICE_TTS_BACKEND", raising=False)
    # Reset prefs in case an earlier test persisted a choice.
    from core import prefs as _prefs
    _prefs.set_("tts_backend", "omnivoice")
    assert tts_backend.active_backend_id() == "omnivoice"


def test_tts_active_backend_prefs_fallback(monkeypatch, tmp_path):
    from core import prefs as _prefs
    monkeypatch.setattr(_prefs, "_PREFS_PATH", str(tmp_path / "prefs.json"))
    monkeypatch.delenv("OMNIVOICE_TTS_BACKEND", raising=False)
    _prefs.set_("tts_backend", "moss-tts-nano")
    assert tts_backend.active_backend_id() == "moss-tts-nano"
    # Env var must beat prefs.
    monkeypatch.setenv("OMNIVOICE_TTS_BACKEND", "voxcpm2")
    assert tts_backend.active_backend_id() == "voxcpm2"


def test_tts_sample_rate_per_backend():
    assert tts_backend.OmniVoiceBackend().sample_rate == 24000
    assert tts_backend.VoxCPM2Backend().sample_rate == 48000
    assert tts_backend.MossTTSNanoBackend().sample_rate == 48000


def test_tts_unknown_backend_raises():
    with pytest.raises(ValueError):
        tts_backend.get_backend_class("not-a-real-one")


# ── ASR ─────────────────────────────────────────────────────────────────────


def test_asr_registry_lists_backends():
    rows = asr_backend.list_backends()
    ids = {r["id"] for r in rows}
    assert {"mlx-whisper", "pytorch-whisper"}.issubset(ids)


def test_asr_auto_detects():
    bid = asr_backend.active_backend_id()
    # WhisperX is now the default cross-platform pick (better wav2vec2 word
    # alignment for lip-sync); mlx / pytorch / faster-whisper are fallbacks.
    assert bid in {"whisperx", "faster-whisper", "mlx-whisper", "pytorch-whisper"}


def test_asr_env_override(monkeypatch):
    monkeypatch.setenv("OMNIVOICE_ASR_BACKEND", "pytorch-whisper")
    assert asr_backend.active_backend_id() == "pytorch-whisper"


# ── LLM ─────────────────────────────────────────────────────────────────────


def test_llm_registry_includes_off():
    rows = llm_backend.list_backends()
    ids = {r["id"] for r in rows}
    assert ids == {"openai-compat", "off"}


def test_llm_off_chat_raises_actionable(monkeypatch):
    # Force selection to Off regardless of env.
    monkeypatch.setenv("OMNIVOICE_LLM_BACKEND", "off")
    be = llm_backend.get_active_llm_backend()
    assert isinstance(be, llm_backend.OffBackend)
    with pytest.raises(RuntimeError) as ei:
        be.chat(system="x", user="y")
    # Error message tells the user what env vars unlock Cinematic translate.
    assert "TRANSLATE_BASE_URL" in str(ei.value)


def test_llm_auto_selects_off_when_nothing_configured(monkeypatch):
    for var in ("OMNIVOICE_LLM_BACKEND", "TRANSLATE_BASE_URL",
                "TRANSLATE_API_KEY", "OPENAI_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    assert llm_backend.active_backend_id() == "off"


def test_llm_auto_selects_openai_compat_when_configured(monkeypatch):
    monkeypatch.delenv("OMNIVOICE_LLM_BACKEND", raising=False)
    monkeypatch.setenv("TRANSLATE_BASE_URL", "http://localhost:11434/v1")
    monkeypatch.setenv("TRANSLATE_API_KEY", "local")
    # is_available itself also needs the openai pkg to import — that's fine;
    # translator.py already depends on it in this repo.
    try:
        import openai  # noqa: F401
    except ImportError:
        pytest.skip("openai package not available in this environment")
    assert llm_backend.active_backend_id() == "openai-compat"
