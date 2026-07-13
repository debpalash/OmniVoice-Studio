"""Voice-clone prompt cache (#427) — the bounded-LRU reference-encode cache.

Pure cache logic: the model is a stub whose create_voice_clone_prompt counts
calls, so we assert the reference is encoded ONCE per (path, mtime, ref_text)
and that misses/errors fall back cleanly. (No real model / torch math here.)
"""
from __future__ import annotations

import pytest

from services import tts_backend as tb


class _StubModel:
    def __init__(self, *, fail=False):
        self.calls = 0
        self.fail = fail

    def create_voice_clone_prompt(self, ref_audio, ref_text=None, preprocess_prompt=True):
        self.calls += 1
        if self.fail:
            raise RuntimeError("encode boom")
        return f"PROMPT::{ref_audio}::{ref_text}::{preprocess_prompt}"


@pytest.fixture(autouse=True)
def _clear_cache():
    tb.clear_clone_prompt_cache()
    yield
    tb.clear_clone_prompt_cache()


def _wav(tmp_path, name="ref.wav", data=b"\x00" * 100):
    p = tmp_path / name
    p.write_bytes(data)
    return str(p)


def test_encodes_once_then_hits_cache(tmp_path):
    m = _StubModel()
    ref = _wav(tmp_path)
    first = tb._get_clone_prompt(m, ref, "hello")
    second = tb._get_clone_prompt(m, ref, "hello")
    assert first == second
    assert m.calls == 1   # second call was a cache hit — no re-encode


def test_different_ref_text_re_encodes(tmp_path):
    m = _StubModel()
    ref = _wav(tmp_path)
    tb._get_clone_prompt(m, ref, "hello")
    tb._get_clone_prompt(m, ref, "different")
    assert m.calls == 2


def test_mtime_change_invalidates(tmp_path):
    m = _StubModel()
    ref = _wav(tmp_path)
    tb._get_clone_prompt(m, ref, "hi")
    # Rewrite with a different mtime → key changes → re-encode.
    import os
    os.utime(ref, (1, 1))
    tb._get_clone_prompt(m, ref, "hi")
    assert m.calls == 2


def test_lru_eviction_bounds_cache(tmp_path):
    m = _StubModel()
    # Fill past the cap with distinct refs.
    for i in range(tb._PROMPT_CACHE_MAX + 3):
        tb._get_clone_prompt(m, _wav(tmp_path, f"r{i}.wav"), "t")
    assert len(tb._prompt_cache) == tb._PROMPT_CACHE_MAX
    assert m.calls == tb._PROMPT_CACHE_MAX + 3


def test_encode_failure_returns_none_and_does_not_cache(tmp_path):
    m = _StubModel(fail=True)
    ref = _wav(tmp_path)
    assert tb._get_clone_prompt(m, ref, "x") is None   # caller falls back to inline ref
    assert len(tb._prompt_cache) == 0


def test_preprocess_prompt_is_part_of_the_key(tmp_path):
    """preprocess_prompt changes the encoded prompt (silence trim + ref-text
    punctuation), so it must key the cache. It didn't — and /v1/audio/speech
    exposes the flag, so a preprocess_prompt=False request could be served a
    True-encoded prompt (and poison the entry for everyone else)."""
    m = _StubModel()
    ref = _wav(tmp_path)
    a = tb._get_clone_prompt(m, ref, "hi", True)
    b = tb._get_clone_prompt(m, ref, "hi", False)
    assert m.calls == 2, "preprocess_prompt=False was served the True-encoded prompt"
    assert a != b
    # And each variant is independently cached.
    tb._get_clone_prompt(m, ref, "hi", True)
    tb._get_clone_prompt(m, ref, "hi", False)
    assert m.calls == 2


def test_preprocess_prompt_reaches_the_encoder(tmp_path):
    """It was accepted by the API and dropped on the floor before reaching here."""
    m = _StubModel()
    prompt = tb._get_clone_prompt(m, _wav(tmp_path), "hi", False)
    assert prompt.endswith("::False")


def test_clear_empties_cache(tmp_path):
    m = _StubModel()
    tb._get_clone_prompt(m, _wav(tmp_path), "x")
    assert len(tb._prompt_cache) == 1
    tb.clear_clone_prompt_cache()
    assert len(tb._prompt_cache) == 0
