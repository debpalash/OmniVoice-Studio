"""A chunk that renders to nothing must not vanish quietly (#1330).

Reported from Discord:

    "also when i make voices this app dosent generate me the last few
     sentences. for rest this app is a banger"

The audio that comes back is clean — it is just missing the end of the input.
That shape is the worst one available: nothing errors, nothing looks wrong, and
the only way to notice is to read along while listening.

Ruled out first, by direct probe rather than by reading:

* ``split_text_into_chunks`` preserves every non-whitespace character across a
  range of inputs, including text with no terminal punctuation;
* ``concatenate_audio_chunks`` joins everything it is given;
* ``trim_trailing_silence`` cuts only from the last *voiced* sample, so it
  cannot remove speech.

What was left is the line that filtered the chunk list before joining it:
``[c for c in chunks if c is not None and c.shape[-1] > 0]``. When an engine
returns nothing for one slice of text, skipping it is still the right joining
behaviour — the alternative is a crash or a gap. Doing it in silence is not.
These tests pin that the drop is now reported, that the report names the text,
and that skipping still happens so the join never regresses into a crash.
"""
import importlib
import logging
import os
import sys

import pytest

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

torch = pytest.importorskip("torch")


@pytest.fixture
def ct():
    """Resolve at call time — sibling suites reload/purge ``services.*``."""
    return importlib.import_module("services.chunked_tts")


def _tone(n=1000):
    return torch.ones(n, dtype=torch.float32) * 0.5


def _empty():
    return torch.zeros(0, dtype=torch.float32)


def test_a_dropped_chunk_is_logged(ct, caplog):
    with caplog.at_level(logging.WARNING, logger="omnivoice.chunked_tts"):
        out = ct.concatenate_audio_chunks([_tone(), _empty(), _tone()], 24000, 0)
    assert out.shape[-1] == 2000, "the non-empty chunks must still be joined"
    assert "Dropped 1 of 3" in caplog.text, (
        "a rendered chunk produced no audio and nothing was logged — the user "
        f"gets clean-sounding output that is simply short:\n{caplog.text}"
    )


def test_the_log_names_the_text_that_was_lost(ct, caplog):
    """A count alone tells a maintainer that something went missing. The text
    tells them which sentence to try to reproduce with."""
    texts = ["First sentence.", "The one that failed.", "Third sentence."]
    with caplog.at_level(logging.WARNING, logger="omnivoice.chunked_tts"):
        ct.concatenate_audio_chunks([_tone(), _empty(), _tone()], 24000, 0, texts=texts)
    assert "The one that failed." in caplog.text, caplog.text
    # ...and not the ones that rendered fine.
    assert "First sentence." not in caplog.text


def test_the_tail_case_specifically(ct, caplog):
    """The reported shape: it is the LAST chunk that comes back empty, so the
    output ends early and everything before it sounds perfect."""
    texts = ["Body of the text.", "and the last few sentences"]
    with caplog.at_level(logging.WARNING, logger="omnivoice.chunked_tts"):
        out = ct.concatenate_audio_chunks([_tone(), _empty()], 24000, 0, texts=texts)
    assert out.shape[-1] == 1000
    assert "and the last few sentences" in caplog.text


def test_nothing_is_logged_when_every_chunk_rendered(ct, caplog):
    """The overwhelmingly common case. A warning on every healthy render would
    train everyone to ignore the one that matters."""
    with caplog.at_level(logging.WARNING, logger="omnivoice.chunked_tts"):
        ct.concatenate_audio_chunks([_tone(), _tone()], 24000, 0)
    assert "Dropped" not in caplog.text


def test_none_entries_count_as_dropped(ct, caplog):
    """An engine that returns None rather than an empty tensor loses the same
    text, so it must not be treated as a different, quieter case."""
    with caplog.at_level(logging.WARNING, logger="omnivoice.chunked_tts"):
        out = ct.concatenate_audio_chunks([_tone(), None], 24000, 0)
    assert out.shape[-1] == 1000
    assert "Dropped 1 of 2" in caplog.text


def test_all_chunks_empty_still_returns_a_tensor(ct, caplog):
    """The total-failure path is owned by the downstream dead-render guards;
    this must keep handing them something rather than raising here."""
    with caplog.at_level(logging.WARNING, logger="omnivoice.chunked_tts"):
        out = ct.concatenate_audio_chunks([_empty(), _empty()], 24000, 0)
    assert out.numel() >= 1
    assert "Dropped 2 of 2" in caplog.text


def test_reporting_never_breaks_the_join(ct, monkeypatch):
    """The diagnostic runs inside the join. One that throws would turn missing
    audio into a failed render — strictly worse than the bug.

    Asserts the report was *attempted*, not merely that nothing blew up:
    without that, this would pass on a build where the reporting does not
    exist at all (CodeRabbit).
    """
    attempted = []

    class _Exploding:
        def warning(self, *a, **k):
            attempted.append(a)
            raise RuntimeError("logging is broken")

        def exception(self, *a, **k):
            raise RuntimeError("still broken")

    monkeypatch.setattr(ct, "logger", _Exploding())
    out = ct.concatenate_audio_chunks([_tone(), _empty()], 24000, 0)
    assert out.shape[-1] == 1000, "a broken logger cost us the audio"
    assert attempted, "the drop was never reported, so there was nothing to survive"


def test_mismatched_texts_do_not_break_the_report(ct, caplog):
    """A caller that passes a shorter list than it rendered must still get the
    count — an IndexError here would lose the whole diagnostic."""
    with caplog.at_level(logging.WARNING, logger="omnivoice.chunked_tts"):
        ct.concatenate_audio_chunks([_tone(), _empty(), _empty()], 24000, 0,
                                    texts=["only one"])
    assert "Dropped 2 of 3" in caplog.text


def test_chunking_itself_loses_no_text(ct):
    """Pins an eliminated hypothesis rather than a fixed defect.

    Kept deliberately, and it does NOT fail before this change — the splitter
    was already correct. The value is that "the chunker drops the tail" was the
    first and most plausible explanation for #1330, ruling it out took a probe,
    and without this the next person to read the issue has to redo that work.
    A future splitter change that did start losing the tail would produce
    exactly the reported symptom again, and this is what would catch it.
    """
    import re

    cases = [
        "One. Two. Three.",
        "A sentence without a terminator at the end",
        "Long text. " * 60 + "The final sentence has no period",
        "x" * 500 + " end",
        "First para.\n\nSecond para.\n\nTrailing line without punctuation",
        ("word " * 300) + "FINALWORD",
    ]
    for text in cases:
        chunks = ct.split_text_into_chunks(text)
        assert chunks, text[:40]
        joined = re.sub(r"\s+", "", "".join(chunks))
        assert joined == re.sub(r"\s+", "", text), (
            f"chunking lost text for input starting {text[:40]!r}"
        )


# ── join_rendered_chunks: the decision the audiobook path used to inline ────
# Both reviewers caught the same hole in the inline version: a span split into
# several chunks where only ONE renders returned that chunk directly, skipping
# the join and therefore skipping the reporting the join does. It lives in one
# testable function now.

def test_one_survivor_of_several_is_reported(ct, caplog):
    """The branch that shipped broken."""
    texts = ["kept", "lost one", "lost two"]
    with caplog.at_level(logging.WARNING, logger="omnivoice.chunked_tts"):
        out = ct.join_rendered_chunks([_tone(), _empty(), _empty()], 24000, texts=texts)
    assert out is not None and out.shape[-1] == 1000, "the survivor must still be used"
    assert "Dropped 2 of 3" in caplog.text, caplog.text
    assert "lost one" in caplog.text


def test_nothing_rendered_returns_none_and_reports(ct, caplog):
    """None rather than a silence buffer: the caller's dead-render handling
    owns that case, and handing back silence would hide it from them."""
    with caplog.at_level(logging.WARNING, logger="omnivoice.chunked_tts"):
        out = ct.join_rendered_chunks([_empty(), _empty()], 24000, texts=["a", "b"])
    assert out is None
    assert "Dropped 2 of 2" in caplog.text


def test_a_clean_multi_chunk_join_says_nothing(ct, caplog):
    with caplog.at_level(logging.WARNING, logger="omnivoice.chunked_tts"):
        out = ct.join_rendered_chunks([_tone(), _tone()], 24000, crossfade_ms=0)
    assert out.shape[-1] == 2000
    assert "Dropped" not in caplog.text


def test_a_single_chunk_that_rendered_says_nothing(ct, caplog):
    with caplog.at_level(logging.WARNING, logger="omnivoice.chunked_tts"):
        out = ct.join_rendered_chunks([_tone()], 24000)
    assert out.shape[-1] == 1000
    assert "Dropped" not in caplog.text


def test_audiobook_uses_the_shared_helper(ct):
    """A second inline copy of this decision is how the hole appeared the first
    time, so pin that the audiobook path routes through the one function."""
    import inspect

    ab = importlib.import_module("services.audiobook")
    src = inspect.getsource(ab)
    assert "join_rendered_chunks(" in src, (
        "audiobook no longer uses the shared join — check it has not grown its "
        "own branch that skips the dropped-chunk reporting again"
    )
