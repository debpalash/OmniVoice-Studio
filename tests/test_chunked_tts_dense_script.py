"""Dense-script chunk sizing (#505).

Long-form (5+ min) generation degrades (repeated/skipped/mispronounced) when a
single chunk's acoustic sequence runs too long. CJK/kana/Hangul pack ~1 char =
1 syllable, so an 800-char chunk is minutes of audio in one shot. The chunker
caps dense-script chunks smaller. CJK is built from code points so the test
file carries no literal CJK.
"""
from services.chunked_tts import (
    _dense_char_count,
    _effective_max_chars,
    split_text_into_chunks,
    DEFAULT_MAX_CHUNK_CHARS,
)

_CJK = "".join(chr(0x4E00 + i) for i in range(50))   # 50 CJK ideographs
_KANA = "".join(chr(0x3042 + i) for i in range(20))  # hiragana
_HANGUL = chr(0xAC00)


def test_dense_char_count():
    assert _dense_char_count(_CJK) == 50
    assert _dense_char_count(_KANA) == 20
    assert _dense_char_count("hi " + _HANGUL) == 1
    assert _dense_char_count("plain english, no dense script.") == 0


def test_effective_max_chars_shrinks_only_for_dense_text():
    # Predominantly CJK → scaled down by the speech factor (2.5).
    assert _effective_max_chars(_CJK, 800) == round(800 / 2.5)  # 320
    # Mostly Latin → unchanged.
    assert _effective_max_chars("a normal english sentence. " * 40, 800) == 800
    # Chunking disabled (0) is left untouched.
    assert _effective_max_chars(_CJK, 0) == 0
    # Never collapses below the floor.
    assert _effective_max_chars(_CJK, 100) >= 120 or _effective_max_chars(_CJK, 100) == 100


def test_dense_text_is_split_below_the_raw_limit():
    # 400 CJK chars: by raw count that's under the 800 default (one chunk), but
    # the effective limit (320) forces a split — the #505 fix.
    dense = "".join(chr(0x4E00 + (i % 100)) for i in range(400))
    chunks = split_text_into_chunks(dense, DEFAULT_MAX_CHUNK_CHARS)
    assert len(chunks) >= 2, "dense 400-char text must split below the raw 800 limit"
    assert all(len(c) <= round(800 / 2.5) for c in chunks)


def test_latin_chunking_is_unchanged():
    # A 400-char English paragraph stays a single chunk under the 800 default.
    latin = "This is a normal English sentence that carries on. " * 8  # ~408 chars
    assert len(split_text_into_chunks(latin, DEFAULT_MAX_CHUNK_CHARS)) == 1
