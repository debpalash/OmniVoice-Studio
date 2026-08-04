"""#1344 — terminal colour codes must never reach the user, or the classifier.

yt-dlp colourizes its stderr whenever it believes a terminal is attached, and
the frozen backend's pipes are enough for it to believe that. A restricted-video
failure arrived in the UI as::

    download: ^[[0;31mERROR:^[[0m [youtube] jsWTu0rJcmE: Video unavailable…

The visible defect is that the escapes render as literal mojibake in the middle
of the sentence, which reads as a bug in OmniVoice rather than a message from
YouTube.

The less visible one is that the same text is the input to the pattern matching
that picks the docs topic, the hint, and the ffmpeg-banner strip. Most of those
patterns match on substrings well past the escape and survive it; the anchored
one does not — ``strip_ffmpeg_banner`` requires "ffmpeg version " at the start
of a line, and a leading colour code pushes it out of reach, quietly
reinstating #1309 for any ffmpeg build that colours its output. So the strip
has to happen BEFORE that matcher, not merely before display.

The fix lives in ``build_failure`` — the choke point every surfaced failure
passes through — so it covers the whole class (yt-dlp, ffmpeg, uv, pip, cargo,
anything else that colours stderr), not just the reported command.
"""
import importlib
import os
import sys

import pytest

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))


@pytest.fixture
def failure():
    """Resolve ``core.failure`` at call time, never at import time.

    A module-level ``from core import failure`` binds whichever object exists
    during collection, and sibling suites reload/purge ``core.*`` between
    tests — so the alias can outlive the module the app is actually using and
    this file would then assert against a stale copy while looking green. That
    is #1269 exactly, and it is a repo-wide rule for ``tests/**`` rather than a
    quirk of this file (CodeRabbit).
    """
    return importlib.import_module("core.failure")

RED = "\x1b[0;31m"
RESET = "\x1b[0m"

# The reported string, verbatim apart from the escapes being real here.
_YTDLP = (
    f"{RED}ERROR:{RESET} [youtube] jsWTu0rJcmE: Video unavailable. This video "
    "is restricted. Please check the Google Workspace administrator and/or the "
    "network administrator restrictions."
)


def test_strip_ansi_removes_colour_codes(failure):
    assert failure.strip_ansi(_YTDLP) == (
        "ERROR: [youtube] jsWTu0rJcmE: Video unavailable. This video is "
        "restricted. Please check the Google Workspace administrator and/or "
        "the network administrator restrictions."
    )


def test_strip_ansi_handles_cursor_and_osc_sequences(failure):
    """Not only SGR colour: progress output moves the cursor, and OSC sequences
    (window title / hyperlinks) carry their own terminator, so a naive
    ``\\x1b\\[...m`` pattern leaves half of one behind."""
    assert failure.strip_ansi("a\x1b[2K\x1b[1Gb") == "ab"
    assert failure.strip_ansi("x\x1b]0;some title\x07y") == "xy"
    assert failure.strip_ansi("x\x1b]8;;https://example.com\x1b\\y") == "xy"


def test_strip_ansi_passes_clean_text_through(failure):
    assert failure.strip_ansi("plain text") == "plain text"
    assert failure.strip_ansi("") == ""
    assert failure.strip_ansi(None) == ""


def test_escape_only_input_becomes_empty(failure):
    """A message made only of escapes is not a message, so it must not survive
    into the UI as a run of escape bytes."""
    assert failure.strip_ansi(RED + RESET) == ""


def test_escape_only_failure_falls_back_to_the_error_class(failure):
    """...and ``build_failure`` still honours its non-empty ``reason``
    guarantee, by naming the exception class instead. A class name is a real
    answer; escape bytes copied into reason/error/detail are not."""
    fields = failure.build_failure(ValueError(RED + RESET), stage="download")
    assert fields["reason"] == "ValueError"
    assert fields["error"] == "ValueError"
    for key in ("reason", "error", "detail"):
        assert "\x1b" not in fields[key], key


def test_build_failure_reason_is_free_of_escapes(failure):
    fields = failure.build_failure(_YTDLP, stage="download")
    for key in ("reason", "error", "detail"):
        assert "\x1b" not in fields[key], f"{key} still carries terminal escapes"
    assert fields["reason"].startswith("ERROR: [youtube]")


def test_classification_survives_colourized_output(failure):
    """Invariance guard, not a repair: today's ``classify`` patterns all match
    on substrings past the escape, so this passes with or without the strip.
    It is here so that stays true — a future pattern anchored at the start of
    the message would otherwise give a user whose tool emits colour different
    guidance from one whose tool does not, with nothing to catch it."""
    plain = "ERROR: [youtube] abc: Unable to download webpage: <urlopen error timed out>"
    coloured = f"{RED}ERROR:{RESET} [youtube] abc: Unable to download webpage: <urlopen error timed out>"
    assert failure.classify(coloured) == failure.classify(plain)

    plain_fields = failure.build_failure(plain, stage="download")
    coloured_fields = failure.build_failure(coloured, stage="download")
    for key in ("docs_topic", "hint", "docs_url"):
        assert coloured_fields[key] == plain_fields[key], (
            f"colourized stderr changed {key}: a user with a colour-emitting "
            f"tool gets different guidance than one without"
        )


def test_ffmpeg_banner_is_still_stripped_when_colourized(failure):
    """Order matters: ``strip_ffmpeg_banner`` anchors on 'ffmpeg version ' at
    the start of a line, so a leading colour code would push it out of reach and
    quietly reinstate #1309 for any colour-emitting ffmpeg build."""
    raw = (
        f"{RED}ffmpeg version N-125781-gacf6b520c1-20260727{RESET} Copyright (c) 2000-2026\n"
        "  built with gcc 14\n"
        "  configuration: --enable-gpl\n"
        "Output file does not contain any stream\n"
    )
    fields = failure.build_failure(raw, stage="export")
    assert fields["reason"] == "Output file does not contain any stream"
