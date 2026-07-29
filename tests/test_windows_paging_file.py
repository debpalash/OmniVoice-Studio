"""#1251: "The paging file is too small for this operation to complete."

The reporter's toast was the raw OS string and nothing else:

    500 Internal Server Error: The paging file is too small for this operation
    to complete. (os error 1455)

`classify()` had no class for it, so `build_failure` attached no hint. The
generate path *did* already count the phrase as an out-of-memory condition
(`_OOM_MSG_SIGNATURES` in api/routers/generation.py), but that lumps it in with
"your RAM is full" — and the resulting advice, close other apps and pick a
lighter engine, is the wrong remedy on a 32 GB machine. Windows is not short of
RAM here; it is refusing to back a large memory mapping because the paging file
is capped too low. The fix is a Windows setting, and the hint now says which.

Note the spelling: `os error 1455`, not `[WinError 1455]`. It reaches Python
through the Rust safetensors mmap, so matching only Python's wording missed it.
"""
from __future__ import annotations

import pytest

from core.failure import build_failure, classify


@pytest.mark.parametrize(
    "reason",
    [
        # Exactly as reported — Rust/safetensors spelling.
        "The paging file is too small for this operation to complete. (os error 1455)",
        # Python's spelling of the same condition.
        "[WinError 1455] The paging file is too small for this operation to complete",
        # Localised Windows: the code survives, the sentence does not.
        "OSError: [WinError 1455] Le fichier de pagination est insuffisant",
    ],
)
def test_the_paging_file_failure_is_classified(reason):
    assert classify(reason) == "WINDOWS_PAGING_FILE_TOO_SMALL"


def test_the_hint_gives_the_windows_setting_that_actually_fixes_it():
    failure = build_failure(
        OSError("The paging file is too small for this operation to complete. (os error 1455)"),
        stage="generate",
    )
    hint = failure["hint"]
    assert hint, "an unclassified 500 with no next step is the bug"
    assert "Virtual memory" in hint
    # The wrong remedy must not be the headline: this is not a RAM shortage.
    assert "paging file" in hint.lower()


def test_a_genuine_out_of_memory_is_not_relabelled():
    """The two conditions want different remedies — don't collapse them."""
    assert classify("CUDA out of memory. Tried to allocate 2.00 GiB") != (
        "WINDOWS_PAGING_FILE_TOO_SMALL"
    )
    assert classify("DefaultCPUAllocator: not enough memory") != (
        "WINDOWS_PAGING_FILE_TOO_SMALL"
    )


def test_an_unrelated_number_1455_does_not_match():
    """The numeric match is deliberately paired with an OS-error marker so a
    model dimension, a sample offset or a byte count can't trip it."""
    assert classify("Expected 1455 tokens, got 1200") == ""
    assert classify("wrote 1455 bytes") == ""


def test_the_generate_path_still_treats_it_as_resource_exhaustion():
    """It IS a resource failure — the retry/queue behaviour keyed off
    `_is_oom_failure` must keep working; only the user-facing advice changed."""
    from api.routers.generation import _is_oom_failure

    assert _is_oom_failure(
        OSError("The paging file is too small for this operation to complete. (os error 1455)")
    )
