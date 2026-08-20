"""PocketTTS sidecar unit tests (#1306 / #1328).

The sidecar is stdlib-only at import time (torch + pocket_tts load lazily on the
first synthesize), so everything below runs without the optional `pocket-tts`
wheel installed and without spawning a child process — the model is mocked.

These pin the four review findings that were fixed on the PR, each of which is
silent-by-construction and would regress without a test:

* an unsupported language used to fall back to English and mispronounce
  (greptile P1) — it now raises;
* the defensive downmix assumed channels-first and destroyed a channels-last
  waveform (CodeRabbit) — it now raises;
* the cold-load heartbeat thread and the main loop both write frames, so a
  heartbeat firing mid-write interleaved the length and body segments and
  corrupted the wire (greptile P1) — writes are now serialized;
* a reference clip replaced at the same path served the previous voice from
  cache (greptile P1) — the cache key carries an mtime+size fingerprint.
"""
from __future__ import annotations

import base64
import builtins
import importlib.util
import io
import os
import struct
import sys
import threading
from pathlib import Path

import numpy as np
import pytest

_SIDECAR = (
    Path(__file__).resolve().parent.parent
    / "backend" / "engines" / "pockettts" / "main.py"
)


def _load_sidecar():
    spec = importlib.util.spec_from_file_location("pockettts_sidecar_main", _SIDECAR)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def sc():
    """Fresh module per test — the caches are module-level globals."""
    return _load_sidecar()


# ── Language selection ────────────────────────────────────────────────────

@pytest.mark.parametrize("raw,expected", [
    ("en", "english"), ("EN", "english"), ("eng", "english"), ("english", "english"),
    ("fr", "french"), ("French", "french"),
    ("de", "german"), ("pt", "portuguese"), ("it", "italian"), ("es", "spanish"),
    ("  it  ", "italian"),
])
def test_language_mapping(sc, raw, expected):
    assert sc._pocket_language(raw) == expected


@pytest.mark.parametrize("raw", ["", None, "auto", "AUTO", "multi", "na"])
def test_absent_or_sentinel_language_defaults_to_english(sc, raw):
    """"auto" means the caller expressed no preference, which is not the same as
    asking for a language this engine cannot speak."""
    assert sc._pocket_language(raw) == "english"


@pytest.mark.parametrize("raw", ["ja", "zh", "hi", "ru", "korean"])
def test_an_unsupported_language_raises_instead_of_speaking_english(sc, raw):
    """PocketTTS ships six models. Quietly handing a Japanese request to the
    English model returns confident, fluent, wrong audio — the user hears their
    text mispronounced by an English speaker and nothing reports a problem
    (greptile P1)."""
    with pytest.raises(ValueError) as e:
        sc._pocket_language(raw)
    assert "does not support" in str(e.value)
    assert raw in str(e.value), "the error must name the language that was asked for"
    # ...and say which ones do work, or the user cannot act on it.
    for code in ("en", "fr", "de", "pt", "it", "es"):
        assert code in str(e.value)


# ── Waveform → PCM ────────────────────────────────────────────────────────

def test_pcm_roundtrip_mono(sc):
    arr = np.array([0.0, 0.5, -0.5, 1.0, -1.0], dtype=np.float32)
    b64, sr, n = sc._tensor_to_pcm_b64(arr, 24000)
    assert (sr, n) == (24000, 5)
    back = np.frombuffer(base64.b64decode(b64), dtype=np.int16)
    assert back.tolist() == [0, 16383, -16383, 32767, -32767]


def test_pcm_clips_out_of_range(sc):
    """Anything beyond [-1, 1] would wrap to the opposite sign as int16 — a loud
    click in the output rather than a clipped peak."""
    arr = np.array([2.0, -2.0], dtype=np.float32)
    b64, _, _ = sc._tensor_to_pcm_b64(arr, 24000)
    assert np.frombuffer(base64.b64decode(b64), dtype=np.int16).tolist() == [32767, -32767]


def test_pcm_squeezes_a_leading_batch_axis(sc):
    """(1, N) is the ordinary shape a batch-1 model returns; it must not trip the
    multi-channel guard below."""
    b64, _, n = sc._tensor_to_pcm_b64(np.zeros((1, 8), dtype=np.float32), 24000)
    assert n == 8


def test_multichannel_audio_raises_rather_than_being_downmixed_wrongly(sc):
    """The original `arr.mean(axis=0)` assumed channels-first. For a
    channels-last (N, 2) array it averages across TIME, not across channels —
    every output sample becomes the mean of two neighbouring samples, which is
    not a downmix but a destroyed waveform played back as noise.

    PocketTTS returns mono, so this is unreachable today; the point is that if
    that ever changes it surfaces as an error frame instead of as garbage audio
    nobody can trace (CodeRabbit)."""
    for shape in [(100, 2), (2, 100)]:
        with pytest.raises(ValueError) as e:
            sc._tensor_to_pcm_b64(np.zeros(shape, dtype=np.float32), 24000)
        assert "mono" in str(e.value)
        assert str(shape[0]) in str(e.value), "the error must report the shape it got"


# ── Wire framing ──────────────────────────────────────────────────────────

def test_send_recv_roundtrip(sc):
    buf = io.BytesIO()
    sc._send(buf, {"op": "audio", "n_samples": 5})
    buf.seek(0)
    assert sc._recv(buf) == {"op": "audio", "n_samples": 5}


def test_recv_returns_none_at_eof(sc):
    """A closed pipe is an orderly parent shutdown, not an error."""
    assert sc._recv(io.BytesIO(b"")) is None


def test_recv_rejects_an_oversized_frame(sc):
    """Without the cap a corrupt length header allocates unbounded memory."""
    with pytest.raises(IOError, match="frame too large"):
        sc._recv(io.BytesIO(struct.pack("!I", sc.MAX_FRAME_BYTES + 1)))


def test_recv_raises_on_a_truncated_body(sc):
    """A body shorter than its header means the child died mid-write; looping on
    a stream that will never yield more would hang the parent instead."""
    with pytest.raises(IOError, match="short read"):
        sc._recv(io.BytesIO(struct.pack("!I", 100) + b"{}"))


def test_concurrent_sends_do_not_interleave_frames(sc):
    """The cold-load heartbeat thread emits progress frames while the main loop
    may emit the audio frame. `_send` writes the length and the body as two
    separate calls, so without serialization one thread's header can land
    between another's header and body — the parent then reads a length that
    belongs to a different frame and the pipe is desynchronized for good
    (greptile P1).

    This fails without the lock: the writer sleeps between the two writes, which
    is exactly the window the real code has.
    """
    chunks: list[bytes] = []

    class _SlowStream:
        """Records writes in arrival order and yields between them."""

        def write(self, b):
            chunks.append(bytes(b))
            # Force a thread switch in the gap the lock exists to close.
            threading.Event().wait(0.001)

        def flush(self):
            pass

    threads = [
        threading.Thread(target=sc._send, args=(_SlowStream(), {"op": "progress", "i": i}))
        for i in range(8)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # Every frame must decode back out cleanly and in one piece.
    stream = io.BytesIO(b"".join(chunks))
    seen = []
    while (msg := sc._recv(stream)) is not None:
        seen.append(msg)
    assert sorted(m["i"] for m in seen) == list(range(8)), (
        f"frames interleaved on the wire; decoded {len(seen)} of 8"
    )


# ── Voice state cache ─────────────────────────────────────────────────────

class _FakeModel:
    """Counts encodes so cache hits are observable."""

    def __init__(self):
        self.calls = []

    def get_state_for_audio_prompt(self, voice):
        self.calls.append(voice)
        return f"state:{voice}:{len(self.calls)}"


def test_a_url_reference_is_refused(sc):
    """The sidecar is local-first; handing a URL to the model would make it
    fetch on the user's behalf (SSRF, and a silent network call from an app that
    promises not to make them)."""
    for url in ["http://x/a.wav", "HTTPS://x/a.wav", "file:///etc/passwd", "ftp://x/a.wav"]:
        with pytest.raises(ValueError, match="local file path"):
            sc._voice_state(_FakeModel(), "english", url)


def test_no_reference_uses_the_languages_default_voice(sc):
    """Falling back to the English preset for an Italian request would clone an
    English speaker onto Italian text."""
    for lang, voice in [("italian", "giovanni"), ("spanish", "lola"),
                        ("german", "juergen"), ("french", "estelle"),
                        ("portuguese", "rafael"), ("english", "alba")]:
        model = _FakeModel()
        sc._voice_state(model, lang, None)
        assert model.calls == [voice]


def test_the_same_reference_is_encoded_once(sc, tmp_path):
    ref = tmp_path / "ref.wav"
    ref.write_bytes(b"RIFF")
    model = _FakeModel()
    a = sc._voice_state(model, "english", str(ref))
    b = sc._voice_state(model, "english", str(ref))
    assert a == b and len(model.calls) == 1


def test_a_replaced_reference_file_is_re_encoded(sc, tmp_path):
    """Re-recording a clip and saving over the same filename is the ordinary way
    a user iterates on a voice. Keyed on the path alone, the cache kept serving
    the old recording and no amount of re-recording changed the output
    (greptile P1)."""
    ref = tmp_path / "ref.wav"
    ref.write_bytes(b"first recording")
    model = _FakeModel()
    sc._voice_state(model, "english", str(ref))

    ref.write_bytes(b"second recording, different length")
    os.utime(ref, (1_000_000, 1_000_000))
    sc._voice_state(model, "english", str(ref))
    assert len(model.calls) == 2, "the replaced clip was served from cache"


def test_a_same_size_replacement_is_caught_by_nanosecond_mtime(sc, tmp_path):
    """Size alone misses a re-record of identical length, and whole-second mtime
    misses one written within the same second — which is precisely what a script
    or a fast save does."""
    ref = tmp_path / "ref.wav"
    ref.write_bytes(b"AAAA")
    model = _FakeModel()
    sc._voice_state(model, "english", str(ref))

    st = os.stat(ref)
    ref.write_bytes(b"BBBB")  # same size
    if os.stat(ref).st_mtime_ns == st.st_mtime_ns:
        pytest.skip("filesystem mtime resolution too coarse to distinguish")
    sc._voice_state(model, "english", str(ref))
    assert len(model.calls) == 2


def test_a_missing_reference_still_reaches_the_model(sc, tmp_path):
    """stat() failing is not this function's call to make — the model owns what
    it can resolve, and a path inside the sidecar's own namespace may be valid
    even when it cannot be stat'd from here."""
    model = _FakeModel()
    sc._voice_state(model, "english", str(tmp_path / "gone.wav"))
    assert len(model.calls) == 1


def test_the_voice_cache_is_bounded(sc, tmp_path):
    """A 50-speaker dub would otherwise hold every encoded voice state for the
    life of the process."""
    model = _FakeModel()
    for i in range(sc._VOICE_CACHE_MAX + 5):
        p = tmp_path / f"r{i}.wav"
        p.write_bytes(b"x")
        sc._voice_state(model, "english", str(p))
    assert len(sc._voice_cache) <= sc._VOICE_CACHE_MAX


def test_the_cache_evicts_least_recently_used(sc, tmp_path):
    """LRU, not FIFO: the voice being used on every line is the one that must
    survive a burst of one-off speakers."""
    model = _FakeModel()
    refs = []
    for i in range(sc._VOICE_CACHE_MAX):
        p = tmp_path / f"r{i}.wav"
        p.write_bytes(b"x")
        refs.append(str(p))
        sc._voice_state(model, "english", p and str(p))

    sc._voice_state(model, "english", refs[0])          # touch the oldest
    n_before = len(model.calls)
    newcomer = tmp_path / "new.wav"
    newcomer.write_bytes(b"x")
    sc._voice_state(model, "english", str(newcomer))    # forces one eviction

    sc._voice_state(model, "english", refs[0])
    assert len(model.calls) == n_before + 1, "the recently-used voice was evicted"


def test_languages_do_not_share_cache_entries(sc, tmp_path):
    """The same clip encoded for the Italian model is not the Italian model's
    state — the key has to carry the language."""
    ref = tmp_path / "ref.wav"
    ref.write_bytes(b"x")
    model = _FakeModel()
    sc._voice_state(model, "english", str(ref))
    sc._voice_state(model, "italian", str(ref))
    assert len(model.calls) == 2


# ── Backend surface ───────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def backend():
    import sys as _sys
    _sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
    from engines.pockettts import PocketTTSBackend

    class AcceptedPocketTTSBackend(PocketTTSBackend):
        @classmethod
        def _license_accepted(cls):
            return True

    return AcceptedPocketTTSBackend


def test_recv_timeout_rejects_non_finite_values(backend, monkeypatch):
    """inf would disable the deadline entirely, so a wedged sidecar would never
    be reaped — the watchdog is the whole reason this engine is a subprocess."""
    for raw in ("inf", "-inf", "nan", "NaN"):
        monkeypatch.setenv("OMNIVOICE_POCKETTTS_RECV_TIMEOUT_S", raw)
        assert backend().recv_timeout_s == 600.0


def test_recv_timeout_rejects_garbage(backend, monkeypatch):
    monkeypatch.setenv("OMNIVOICE_POCKETTTS_RECV_TIMEOUT_S", "soon")
    assert backend().recv_timeout_s == 600.0


def test_recv_timeout_has_a_floor(backend, monkeypatch):
    """A 1s deadline kills every cold load before it can finish."""
    monkeypatch.setenv("OMNIVOICE_POCKETTTS_RECV_TIMEOUT_S", "1")
    assert backend().recv_timeout_s == 30.0


def test_recv_timeout_honours_a_sane_override(backend, monkeypatch):
    monkeypatch.setenv("OMNIVOICE_POCKETTTS_RECV_TIMEOUT_S", "900")
    assert backend().recv_timeout_s == 900.0


def test_is_available_reports_why_the_import_failed(backend, monkeypatch):
    """"not installed" sends a user with a torch ABI mismatch or a half-written
    wheel to reinstall a package they already have (CodeRabbit)."""
    monkeypatch.setattr("engines.pockettts.sys.platform", "linux")
    real_import = builtins.__import__

    def fail_pocket_import(name, *args, **kwargs):
        if name == "pocket_tts" or name.startswith("pocket_tts."):
            raise ImportError("simulated broken pocket_tts install")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fail_pocket_import)
    ok, msg = backend.is_available()
    assert ok is False
    assert "pocket_tts" in msg
    # The bare message would end after the install hint; the cause has to be in it.
    assert "(" in msg and ")" in msg


def test_engine_is_cpu_only_and_advertises_it(backend):
    """Kyutai reports no GPU speedup for this 100M batch-1 model, so claiming
    CUDA would send the scheduler looking for a device it cannot use."""
    assert backend.gpu_compat == ("cpu",)
    assert backend.supports_cloning is True


def test_sample_rate_is_in_lockstep_with_the_sidecar(sc, backend):
    """The parent sizes buffers from its own constant and the sidecar stamps the
    frame with its; a drift between them resamples every render."""
    assert backend().sample_rate == sc.POCKETTTS_SAMPLE_RATE


def test_the_engine_is_registered_lazily(backend):
    """Registered eagerly, the optional pocket-tts import would run for every
    user on every startup."""
    import sys as _sys
    _sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
    from services.tts_backend import _LAZY_REGISTRY
    assert _LAZY_REGISTRY["pockettts"] == ("engines.pockettts", "PocketTTSBackend")


def test_the_sidecar_script_path_resolves(backend):
    assert backend.sidecar_script().is_file()


# ── 24-layer opt-in (OMNIVOICE_POCKETTTS_24L) ────────────────────────────

class _NullStdout:
    """Absorbs the sidecar's length-prefixed frames (bytes, not str)."""

    def write(self, data):
        return len(data)

    def flush(self):
        pass


def test_24l_opt_in_is_off_by_default(sc, monkeypatch):
    monkeypatch.delenv("OMNIVOICE_POCKETTTS_24L", raising=False)
    monkeypatch.setattr(sc, "_has_24l_config", lambda lang: True)
    assert sc._model_config_name("italian") == "italian"


def test_24l_opt_in_selects_the_24_layer_config_when_available(sc, monkeypatch):
    monkeypatch.setenv("OMNIVOICE_POCKETTTS_24L", "1")
    monkeypatch.setattr(sc, "_has_24l_config", lambda lang: lang == "italian")
    assert sc._model_config_name("italian") == "italian_24l"
    # No 24-layer checkpoint for this language (e.g. english): unchanged.
    assert sc._model_config_name("english") == "english"


def test_24l_opt_in_accepts_the_usual_truthy_spellings(sc, monkeypatch):
    monkeypatch.setattr(sc, "_has_24l_config", lambda lang: True)
    for val in ("true", "YES", " on ", "1"):
        monkeypatch.setenv("OMNIVOICE_POCKETTTS_24L", val)
        assert sc._model_config_name("german") == "german_24l", val
    monkeypatch.setenv("OMNIVOICE_POCKETTTS_24L", "0")
    assert sc._model_config_name("german") == "german"


def test_load_model_applies_the_24l_suffix_to_load_model(sc, monkeypatch):
    """The load path must honour the opt-in, not just the name helper."""
    monkeypatch.setenv("OMNIVOICE_POCKETTTS_24L", "1")
    monkeypatch.setattr(sc, "_has_24l_config", lambda lang: True)

    calls = {}

    class _FakeTTSModel:
        @staticmethod
        def load_model(language=None):
            calls["language"] = language
            return object()

    import types
    fake_pkg = types.ModuleType("pocket_tts")
    fake_pkg.TTSModel = _FakeTTSModel
    monkeypatch.setitem(sys.modules, "pocket_tts", fake_pkg)

    sc._load_model(_NullStdout(), "italian")
    assert calls["language"] == "italian_24l"


def test_french_always_maps_to_french_24l(sc, monkeypatch):
    """pocket-tts 2.1.0 rejects language="french" outright (only a 24-layer
    French model exists), so French must resolve to french_24l regardless of
    the env var IN EITHER STATE and regardless of — indeed without calling —
    the config probe. A regression that gates French on a truthy env value,
    or that consults the probe, must fail here."""
    def _probe_must_not_run(lang):
        raise AssertionError("french resolution must not consult _has_24l_config")

    monkeypatch.setattr(sc, "_has_24l_config", _probe_must_not_run)
    # Env unset, falsy, and truthy — all identical for French.
    monkeypatch.delenv("OMNIVOICE_POCKETTTS_24L", raising=False)
    assert sc._model_config_name("french") == "french_24l"
    for env in ("0", "off", "1", "true"):
        monkeypatch.setenv("OMNIVOICE_POCKETTTS_24L", env)
        assert sc._model_config_name("french") == "french_24l", env
