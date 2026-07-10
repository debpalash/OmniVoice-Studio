"""Pre-TTS text normalization (services/text_normalization.py).

Covers the conservative per-language pre-pass: table-driven change /
leave-unchanged cases, idempotency (f(f(x)) == f(x)), digit preservation for
unsupported languages, bracket-grammar safety, the pref/env toggle, the
normalization-BEFORE-pronunciation-dictionary ordering, and the /generate
integration (applied exactly once, at the text→engine choke point).

The engine layer is stubbed (no real model loads), matching
test_generate_engine.py.
"""
import os

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

import importlib

import pytest
import torch

from services import text_normalization
from services.text_normalization import (
    normalization_enabled,
    normalize_for_tts,
    normalize_text,
)


# ── Table-driven: text that SHOULD change ────────────────────────────────────

_CHANGE_CASES = [
    # (language, input, expected)
    # EN numbers / times / ordinals / currency / percent
    ("English", "I have 2 cats", "I have two cats"),
    ("English", "It is 3:30 now", "It is three thirty now"),
    ("English", "At 3:00 sharp", "At three o'clock sharp"),
    ("English", "At 12:05 sharp", "At twelve oh five sharp"),
    ("English", "the 21st of May", "the twenty-first of May"),
    ("English", "It costs $5", "It costs five dollars"),
    ("English", "Just $1 more", "Just one dollar more"),
    ("English", "It costs $5.99 now", "It costs five dollars, ninety-nine cents now"),
    ("English", "rated 3.5 stars", "rated three point five stars"),
    ("English", "battery at 50%", "battery at fifty percent"),
    ("English", "back in 1984", "back in nineteen eighty-four"),
    ("English", "I have 3.", "I have three."),
    # EN abbreviations (guards: titles need a following capitalized word)
    ("English", "Dr. Smith is here", "Doctor Smith is here"),
    ("English", "Mr. Jones and Mrs. Jones", "Mister Jones and Missus Jones"),
    ("English", "St. Louis is far", "Saint Louis is far"),
    ("English", "cats, dogs, etc. are pets", "cats, dogs, et cetera are pets"),
    ("English", "fruit, e.g. apples", "fruit, for example apples"),
    ("English", "good vs. evil", "good versus evil"),
    ("English", "exhibit No. 5", "exhibit number five"),
    # ISO-ish codes resolve like display names
    ("en", "I have 2 cats", "I have two cats"),
    ("en-US", "I have 2 cats", "I have two cats"),
    # Other languages
    ("German", "Er hat 42 Katzen", "Er hat zweiundvierzig Katzen"),
    ("German", "z.B. Dr. Meier", "zum Beispiel Doktor Meier"),
    ("German", "Nr. 5 gewinnt", "Nummer fünf gewinnt"),
    ("German", "etwa 50%", "etwa fünfzig Prozent"),
    ("Spanish", "tengo 42 gatos", "tengo cuarenta y dos gatos"),
    ("Spanish", "el Sr. García", "el Señor García"),
    ("French", "il a 42 chats", "il a quarante-deux chats"),
    ("French", "Mme Dupont arrive", "Madame Dupont arrive"),
    ("Russian", "у меня 42 кота", "у меня сорок два кота"),
    # Universal safety filters (language-independent)
    (None, "hello​ ‍world", "hello world"),
    (None, "too   many\t spaces", "too many spaces"),
    (None, "wow!!!!!!!!", "wow!!!"),
    (None, "wait.........", "wait..."),
    (None, "a�b", "ab"),
    (None, "Tom &amp; Jerry", "Tom & Jerry"),
    (None, "one&nbsp;space", "one space"),
]


@pytest.mark.parametrize("language,raw,expected", _CHANGE_CASES)
def test_normalizes(language, raw, expected):
    assert normalize_text(raw, language) == expected


# ── Table-driven: conservatism — text that must NOT change ───────────────────

_UNCHANGED_CASES = [
    # (language, input) — ambiguous constructs keep their digits/shape
    ("English", "version v2 shipped"),          # digit glued to a letter
    ("English", "order 1,000 units"),           # thousands separator: ambiguous
    ("English", "pages 3-5 tonight"),           # range
    ("English", "agent 007 reporting"),         # leading-zero code
    ("English", "see 3.5.1 in the docs"),       # version string
    ("English", "call 5551234567 now"),         # 7+ digits: an ID, not a number
    ("English", "12:34:56 elapsed"),            # H:MM:SS duration, not a time
    ("English", "the ratio is 1/2 there"),      # fraction: ambiguous
    ("English", "MP3 files and A4 paper"),      # alphanumeric tokens
    ("English", "I met her. I agree."),         # "I" is a pronoun, not a numeral
    ("English", "Chapter II and III stand"),    # roman numerals out of scope
    ("English", "on Elm St. tonight"),          # street suffix: no name follows
    ("English", "I said no. Fine."),            # the word "no.", not "number"
    ("English", "down main st. Anyway"),        # lowercase "st." is not Saint
    ("German", "es kostet 3,5 Euro"),           # decimal comma: ambiguous
    # Unsupported languages keep every digit (num2words unmapped)
    ("Japanese", "42 cats and 3.5 stars at 3:30"),
    ("Thai", "42 cats"),
    ("Chinese", "42 cats"),
    ("Korean", "42 cats"),
    (None, "42 cats"),                          # no language pin → no digits pass
    ("Auto", "42 cats"),
    # Bracket grammar is never rewritten
    ("English", "[pause 300ms] then [rate 0.9] speech [voice:Alice]"),
    ("English", "[[term|5]] stays bracket-managed"),
    # Plain text is byte-identical
    ("English", "The quick brown fox jumps."),
    (None, "already clean text"),
]


@pytest.mark.parametrize("language,raw", _UNCHANGED_CASES)
def test_leaves_unchanged(language, raw):
    assert normalize_text(raw, language) == raw


def test_cjk_passthrough_untouched():
    # CJK sentences (incl. CJK punctuation and full-width forms) pass through
    # the safety filters untouched — no punctuation stripped, no words injected.
    # Functional CJK test fixture: tests/ is allowlisted in
    # tests/test_no_hardcoded_cjk.py.
    cases = [
        "今日は3時30分に会いましょう。よろしく！",
        "我有42只猫，真的！？……",
        "안녕하세요. 42마리의 고양이가 있어요!",
    ]
    for s in cases:
        assert normalize_text(s, "Japanese") == s
        assert normalize_text(s, None) == s


# ── Idempotency: f(f(x)) == f(x) for every table case ───────────────────────

@pytest.mark.parametrize(
    "language,raw",
    [(lang, raw) for lang, raw, _ in _CHANGE_CASES]
    + [(lang, raw) for lang, raw in _UNCHANGED_CASES],
)
def test_idempotent(language, raw):
    once = normalize_text(raw, language)
    assert normalize_text(once, language) == once


def test_idempotent_double_encoded_entity():
    # "&amp;nbsp;" must not decode one layer per pass.
    once = normalize_text("bad &amp;nbsp; soup", None)
    assert normalize_text(once, None) == once


# ── Toggle: pref (default ON) + env override ─────────────────────────────────

def test_enabled_by_default(monkeypatch):
    monkeypatch.delenv(text_normalization.ENV_VAR, raising=False)
    assert normalization_enabled() is True
    assert normalize_for_tts("I have 2 cats", "English") == "I have two cats"


def test_pref_off_bypasses(monkeypatch):
    monkeypatch.delenv(text_normalization.ENV_VAR, raising=False)
    import core.prefs as prefs_mod
    monkeypatch.setattr(
        prefs_mod, "get",
        lambda key, default=None: False if key == text_normalization.PREF_KEY else default,
    )
    raw = "I have 2 cats!!!!!!"
    assert normalize_for_tts(raw, "English") == raw  # byte-identical bypass


def test_env_off_bypasses(monkeypatch):
    monkeypatch.setenv(text_normalization.ENV_VAR, "0")
    raw = "I have 2 cats"
    assert normalize_for_tts(raw, "English") == raw


def test_env_on_beats_pref_off(monkeypatch):
    monkeypatch.setenv(text_normalization.ENV_VAR, "1")
    import core.prefs as prefs_mod
    monkeypatch.setattr(prefs_mod, "get", lambda key, default=None: False)
    assert normalize_for_tts("I have 2 cats", "English") == "I have two cats"


def test_never_raises(monkeypatch):
    # A crash inside the normalizer must degrade to raw text, never break synth.
    monkeypatch.delenv(text_normalization.ENV_VAR, raising=False)
    monkeypatch.setattr(
        text_normalization, "normalize_text",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")),
    )
    assert normalize_for_tts("I have 2 cats", "English") == "I have 2 cats"


def test_empty_and_none_text():
    assert normalize_for_tts("", "English") == ""
    assert normalize_for_tts(None, "English") == ""
    assert normalize_text("", "English") == ""


# ── Ordering vs. the pronunciation dictionary ────────────────────────────────

def test_dictionary_operates_on_normalized_text():
    """Normalization runs FIRST: dictionary entries keyed on normalized words
    fire, and respellings are the final say (never re-normalized)."""
    from services.pronunciation import apply_pronunciation

    entries = [
        # Fires only if "2" was already normalized to "two".
        {"term": "two", "replacement": "TWO-OH", "type": "respelling",
         "language": "*", "enabled": 1},
        # A respelling that deliberately contains a digit must reach the
        # engine verbatim (normalization must NOT run after the dictionary).
        {"term": "cats", "replacement": "c4ts", "type": "respelling",
         "language": "*", "enabled": 1},
    ]
    normalized = normalize_text("I have 2 cats", "English")
    assert normalized == "I have two cats"
    out = apply_pronunciation(normalized, entries, "English")
    assert out == "I have TWO-OH c4ts"  # entry fired + digit respelling intact


# ── /generate integration: applied exactly once, before the dictionary ──────

def _tts_mod():
    """Resolve services.tts_backend at RUN time (same rationale as
    test_generate_engine.py — collection-time bindings can go stale)."""
    return importlib.import_module("services.tts_backend")


def _norm_mod():
    """Resolve services.text_normalization at RUN time so monkeypatches land
    on the same module object the routes import per-request."""
    return importlib.import_module("services.text_normalization")


def _make_fake_engine():
    class _FakeEngine(_tts_mod().TTSBackend):
        id = "fake-norm-engine"
        display_name = "Fake Norm Engine (test)"
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


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient
    from main import app
    return TestClient(app, client=("127.0.0.1", 50000))


@pytest.fixture()
def fake_engine(monkeypatch):
    fake = _make_fake_engine()
    monkeypatch.setitem(_tts_mod()._REGISTRY, "fake-norm-engine", fake)
    monkeypatch.delenv("OMNIVOICE_TTS_BACKEND", raising=False)
    return fake


def test_generate_applies_normalization_exactly_once(client, monkeypatch, fake_engine):
    monkeypatch.delenv(text_normalization.ENV_VAR, raising=False)
    norm_mod = _norm_mod()
    calls = []
    real = norm_mod.normalize_for_tts

    def spy(text, language=None):
        calls.append(text)
        return real(text, language)

    monkeypatch.setattr(norm_mod, "normalize_for_tts", spy)

    res = client.post("/generate", data={
        "text": "Dr. Smith has 2 cats", "language": "English",
        "engine": "fake-norm-engine", "seed": "42",
    })

    assert res.status_code == 200, res.text
    assert len(calls) == 1  # exactly once, at the choke point
    assert len(fake_engine.calls) == 1
    assert fake_engine.calls[0][0] == "Doctor Smith has two cats"


def test_generate_normalizes_before_dictionary(client, monkeypatch, fake_engine):
    """Route-level pin of the ordering: the DB dictionary sees normalized
    text, and its respellings are not re-normalized."""
    monkeypatch.delenv(text_normalization.ENV_VAR, raising=False)
    monkeypatch.delenv("OMNIVOICE_PRONUNCIATION", raising=False)
    pron_mod = importlib.import_module("services.pronunciation")
    monkeypatch.setattr(pron_mod, "load_entries_from_db", lambda: [
        {"term": "two", "replacement": "TWO-OH", "type": "respelling",
         "language": "*", "enabled": 1},
        {"term": "cats", "replacement": "c4ts", "type": "respelling",
         "language": "*", "enabled": 1},
    ])

    res = client.post("/generate", data={
        "text": "I have 2 cats", "language": "English",
        "engine": "fake-norm-engine", "seed": "42",
    })

    assert res.status_code == 200, res.text
    assert fake_engine.calls[-1][0] == "I have TWO-OH c4ts"


def test_generate_toggle_off_sends_raw_text(client, monkeypatch, fake_engine):
    monkeypatch.setenv(text_normalization.ENV_VAR, "0")
    res = client.post("/generate", data={
        "text": "Dr. Smith has 2 cats", "language": "English",
        "engine": "fake-norm-engine", "seed": "42",
    })
    assert res.status_code == 200, res.text
    assert fake_engine.calls[-1][0] == "Dr. Smith has 2 cats"


# ── Longform: chapter render normalizes spans (and keys the cache on it) ────

def _render_chapter(tmp_path, text, language, monkeypatch, env=None):
    if env is None:
        monkeypatch.delenv(text_normalization.ENV_VAR, raising=False)
    else:
        monkeypatch.setenv(text_normalization.ENV_VAR, env)
    from api.routers.audiobook import _render_chapter_cached
    from services.audiobook import Chapter, Span

    seen = []

    def synth(t, voice_id, speed=None):
        seen.append(t)
        return torch.zeros(1, 2400)

    chapter = Chapter(title="One", spans=[Span(voice_id=None, text=text)])
    wav_path, dur, was_cached, _seg_stats = _render_chapter_cached(
        chapter, synth, 24000, "stub-engine",
        lambda vid: {"ref_audio": None, "ref_text": None, "instruct": None, "seed": None},
        str(tmp_path), None, language,
    )
    return seen, wav_path, was_cached


def test_longform_chapter_normalizes_spans(tmp_path, monkeypatch):
    seen, _, was_cached = _render_chapter(
        tmp_path, "Dr. Smith has 2 cats", "English", monkeypatch)
    assert not was_cached
    assert seen == ["Doctor Smith has two cats"]


def test_longform_cache_key_tracks_normalization_toggle(tmp_path, monkeypatch):
    # Normalization ON and OFF must not share a cached WAV: the key is built
    # over the normalized span text, so toggling re-renders.
    _, path_on, _ = _render_chapter(
        tmp_path, "Dr. Smith has 2 cats", "English", monkeypatch)
    seen_off, path_off, was_cached_off = _render_chapter(
        tmp_path, "Dr. Smith has 2 cats", "English", monkeypatch, env="0")
    assert path_on != path_off
    assert not was_cached_off
    assert seen_off == ["Dr. Smith has 2 cats"]  # raw text with the toggle off
