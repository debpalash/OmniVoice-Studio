"""Phase 3 — TTS / ASR / LLM adapter registries."""
import os
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

import sys
import types

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


# ── #919: sherpa-onnx gates on OMNIVOICE_SHERPA_MODEL ────────────────────────
# sherpa-onnx ships no bundled model, so with the package installed but no model
# dir configured it must report unavailable-with-a-reason — not "ready" and then
# a generate-time config error the OOM catch-all mislabeled. A fake module makes
# these deterministic whether or not sherpa-onnx is installed on CI.


def test_tts_sherpa_unavailable_without_model_env(monkeypatch):
    monkeypatch.setitem(sys.modules, "sherpa_onnx", types.ModuleType("sherpa_onnx"))
    monkeypatch.delenv("OMNIVOICE_SHERPA_MODEL", raising=False)
    ok, msg = tts_backend.SherpaOnnxBackend.is_available()
    assert ok is False
    assert "OMNIVOICE_SHERPA_MODEL" in msg   # names the exact env var
    assert "model.onnx" in msg               # says what to point it at


def test_tts_sherpa_unavailable_when_model_dir_lacks_onnx(monkeypatch, tmp_path):
    monkeypatch.setitem(sys.modules, "sherpa_onnx", types.ModuleType("sherpa_onnx"))
    monkeypatch.setenv("OMNIVOICE_SHERPA_MODEL", str(tmp_path))  # empty dir
    ok, msg = tts_backend.SherpaOnnxBackend.is_available()
    assert ok is False
    assert "model.onnx" in msg


def test_tts_sherpa_available_when_model_env_points_at_model(monkeypatch, tmp_path):
    monkeypatch.setitem(sys.modules, "sherpa_onnx", types.ModuleType("sherpa_onnx"))
    (tmp_path / "model.onnx").write_bytes(b"")
    monkeypatch.setenv("OMNIVOICE_SHERPA_MODEL", str(tmp_path))
    ok, _msg = tts_backend.SherpaOnnxBackend.is_available()
    assert ok is True


def test_tts_sherpa_setup_snippet_registered():
    # The Compat Matrix's copy-paste setup line must exist for the now
    # path-gated engine (parity with Confucius4/dots/MOSS).
    assert "OMNIVOICE_SHERPA_MODEL" in tts_backend._SETUP_SNIPPETS["sherpa-onnx"]


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


def test_llm_auto_selects_off_when_nothing_configured(clean_llm_env):
    # clean_llm_env (conftest) clears the FULL provider env surface — a
    # hand-picked 4-var list left e.g. LLM_DEFAULT_PROVIDER / GROQ_API_KEY
    # standing when an earlier test imported `main` (which dotenv-loads the
    # developer's .env into os.environ), reading as 'configured' (#878).
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


# ── HF Hub closed-client recovery (#880) ────────────────────────────────────
#
# huggingface_hub ≥1.x shares one global httpx client; if it gets closed
# mid-lifecycle, an engine's first-use model download inside the generate
# path dies with "Cannot send a request, as the client has been closed".
# The load must retry exactly once with a fresh client — and must NOT retry
# unrelated failures.


def test_hf_retry_recovers_from_closed_client_once():
    calls = []

    def loader():
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("Cannot send a request, as the client has been closed.")
        return "model"

    assert tts_backend._retry_once_with_fresh_hf_client(loader, what="test") == "model"
    assert len(calls) == 2


def test_hf_retry_matches_wrapped_closed_client_error():
    # An engine can wrap the httpx error — detection walks the chain.
    calls = []

    def loader():
        calls.append(1)
        if len(calls) == 1:
            try:
                raise RuntimeError("Cannot send a request, as the client has been closed.")
            except RuntimeError as inner:
                raise RuntimeError("KittenTTS init failed") from inner
        return "model"

    assert tts_backend._retry_once_with_fresh_hf_client(loader, what="test") == "model"
    assert len(calls) == 2


def test_hf_retry_does_not_retry_unrelated_errors():
    calls = []

    def loader():
        calls.append(1)
        raise ValueError("bad checkpoint id")

    with pytest.raises(ValueError):
        tts_backend._retry_once_with_fresh_hf_client(loader, what="test")
    assert len(calls) == 1


def test_hf_retry_is_single_shot():
    # A second closed-client failure propagates (the generation classifier
    # then labels it a network problem) — no infinite retry loop.
    calls = []

    def loader():
        calls.append(1)
        raise RuntimeError("Cannot send a request, as the client has been closed.")

    with pytest.raises(RuntimeError):
        tts_backend._retry_once_with_fresh_hf_client(loader, what="test")
    assert len(calls) == 2


# ── #977: MLX-Audio Kokoro language-code resolution ─────────────────────────
# Kokoro's own vendored pipeline (mlx_audio.tts.models.kokoro.pipeline)
# hard-asserts `lang_code` against a fixed single-letter table. The old code
# blindly truncated a full language name — "Dutch"[:2].lower() == "du" — into
# that assert, crashing with an unreadable `(lang_code, LANG_CODES)` repr
# instead of a clean error. The resolution tests need the real mlx-audio
# package (Apple-Silicon-only) since they validate against ITS installed
# table, never a hardcoded guess; they skip cleanly where mlx-audio isn't
# installed (every non-macOS-ARM CI runner).


def test_mlx_audio_kokoro_resolves_supported_language_names():
    pytest.importorskip("mlx_audio", reason="mlx-audio is Apple-Silicon-only")
    resolve = tts_backend.resolve_kokoro_lang_code
    assert resolve("English") == "a"
    assert resolve("Spanish") == "e"
    assert resolve("French") == "f"
    assert resolve("Hindi") == "h"
    assert resolve("Italian") == "i"
    assert resolve("Portuguese") == "p"
    assert resolve("Japanese") == "j"
    assert resolve("Chinese") == "z"
    # Some callers may already pass an ISO code — those resolve unchanged
    # through Kokoro's own ALIASES table, not just our full-name map.
    assert resolve("es") == "e"
    assert resolve("en-gb") == "b"


@pytest.mark.parametrize("language", ["Dutch", "German"])
def test_mlx_audio_kokoro_rejects_unsupported_language_cleanly(language):
    # The literal #977 report case ("Dutch") plus one more Kokoro doesn't
    # support ("German") — neither's first two letters happen to alias to a
    # valid Kokoro code, so both used to crash.
    pytest.importorskip("mlx_audio", reason="mlx-audio is Apple-Silicon-only")
    with pytest.raises(ValueError) as ei:
        tts_backend.resolve_kokoro_lang_code(language)
    msg = str(ei.value)
    assert language in msg
    assert "Kokoro" in msg
    assert "English" in msg  # names what Kokoro DOES support


def test_mlx_audio_generate_rejects_unsupported_kokoro_language_before_calling_model():
    pytest.importorskip("mlx_audio", reason="mlx-audio is Apple-Silicon-only")
    backend = tts_backend.MLXAudioBackend()
    backend._model_id = backend.CURATED_MODELS["kokoro"]
    backend._ensure_loaded = lambda: None  # never actually load the model

    def _boom_generate(**kw):
        raise AssertionError("model.generate() must not run for a rejected language")

    backend._model = types.SimpleNamespace(generate=_boom_generate)

    with pytest.raises(ValueError, match="Dutch"):
        backend.generate("hello", language="Dutch")


def test_mlx_audio_generate_auto_language_skips_lang_code_entirely():
    # Matches the "Auto" convention other engines in this file use
    # (OmniVoiceBackend.generate(), _run_backend_inference) — never resolved,
    # never forwarded as lang_code.
    backend = tts_backend.MLXAudioBackend()
    backend._model_id = backend.CURATED_MODELS["kokoro"]
    backend._ensure_loaded = lambda: None
    seen_kwargs = {}

    def _fake_generate(**kw):
        seen_kwargs.update(kw)
        return iter([types.SimpleNamespace(audio=[0.0, 0.0, 0.0, 0.0])])

    backend._model = types.SimpleNamespace(generate=_fake_generate)
    backend.generate("hello", language="Auto")
    assert "lang_code" not in seen_kwargs


def test_mlx_audio_generate_non_kokoro_model_ignores_kokoro_validation():
    # Qwen3-TTS (and CSM/Dia/Chatterbox/MeloTTS/OuteTTS) don't use Kokoro's
    # lang_code convention — a language Kokoro would reject must NOT be
    # rejected when a different curated model is active (#977 nuance).
    backend = tts_backend.MLXAudioBackend()
    backend._model_id = backend.CURATED_MODELS["qwen3-tts"]
    backend._ensure_loaded = lambda: None
    seen_kwargs = {}

    def _fake_generate(**kw):
        seen_kwargs.update(kw)
        return iter([types.SimpleNamespace(audio=[0.0, 0.0, 0.0, 0.0])])

    backend._model = types.SimpleNamespace(generate=_fake_generate)
    backend.generate("hello", language="Dutch")  # must not raise
    assert seen_kwargs.get("lang_code") == "du"
