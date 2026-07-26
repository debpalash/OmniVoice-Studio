"""#1254: `download: ERROR: [youtube] DZpjig7qxM8: This video is DRM protected`

The reporter's own words:

    Importing a YouTube URL intermittently failed with a DRM protection error,
    even though the same URL had previously worked and succeeded when retried
    shortly afterwards. The failure appears to be transient rather than
    consistently reproducible.

A genuinely DRM-protected video does not become downloadable thirty seconds
later. What varies is the **player client**: YouTube serves a DRM-only format
set to some clients for videos that are not actually protected. OmniVoice
already had machinery for exactly this shape — `_is_forbidden_download_error`
escalates through `_YT_PLAYER_CLIENTS` on a 403, because "extraction worked but
this client can't have the media" is the same situation. DRM simply wasn't
routed into it, so the user's only recovery was to retry by hand and hope the
next attempt drew a different client.

If every client still reports DRM, the video really is unfetchable — and that
now arrives classified, instead of as a raw yt-dlp line.
"""
from __future__ import annotations

import pytest

from core.failure import build_failure, classify
from services.dub_pipeline import (
    _is_forbidden_download_error,
    _is_transient_download_error,
)


REPORTED = "ERROR: [youtube] DZpjig7qxM8: This video is DRM protected"


# ── it escalates the player client ───────────────────────────────────────


def test_the_reported_error_triggers_client_escalation():
    assert _is_forbidden_download_error(RuntimeError(REPORTED))


@pytest.mark.parametrize(
    "reason",
    [
        "This video is DRM protected",
        "Requested format is DRM-protected",
        "ERROR: [youtube] abc: This video is DRM protected",
    ],
)
def test_every_drm_wording_escalates(reason):
    assert _is_forbidden_download_error(RuntimeError(reason))


def test_the_403_case_it_shares_the_path_with_still_works():
    """#625's behaviour must survive the widening."""
    assert _is_forbidden_download_error(RuntimeError("HTTP Error 403: Forbidden"))


def test_drm_does_not_burn_the_transient_retry_budget():
    """Escalation and blind retry are different budgets. Counting DRM as
    transient would spend the retries on the same client that just refused —
    which is what the reporter was doing by hand."""
    assert not _is_transient_download_error(RuntimeError(REPORTED))


def test_a_real_network_drop_is_still_transient_and_not_escalated():
    """The two paths must not bleed into each other."""
    broken = RuntimeError("Unable to download video: Broken pipe")
    assert _is_transient_download_error(broken)
    assert not _is_forbidden_download_error(broken)


# ── and if every client fails, the user is told why ──────────────────────


def test_an_exhausted_drm_failure_is_classified():
    assert classify(REPORTED) == "VIDEO_DRM_PROTECTED"


def test_the_hint_gives_a_way_forward_rather_than_another_retry():
    failure = build_failure(RuntimeError(REPORTED), stage="download")
    hint = failure["hint"]
    assert hint, "a raw yt-dlp line with no next step is the bug"
    # The two things the user can actually do.
    assert "drop the file" in hint.lower()
    assert "retried" in hint.lower(), "say that retrying was already tried"


def test_an_unrelated_download_failure_keeps_its_own_class():
    assert classify("Unable to download video: Broken pipe") == "VIDEO_DOWNLOAD_NETWORK"
    assert classify("ERROR: Unsupported URL: https://example.com/profile") == (
        "UNSUPPORTED_VIDEO_URL"
    )
