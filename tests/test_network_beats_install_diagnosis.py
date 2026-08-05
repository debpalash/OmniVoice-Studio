"""A failed download must not be diagnosed as a broken install (#1347, #1335).

Two reports, one shape: the error text carried BOTH a network cause and a
downstream symptom, the taxonomy matched the symptom first, and the user was
sent to fix something that was never broken.

**#1347** — transcription failed with:

    transformers ASR pipeline failed to import (AutoFeatureExtractor) — your
    transformers install is incomplete; reinstall with `uv pip install
    --reinstall transformers` … Underlying: Cannot send a request, as the
    client has been closed.

The install is fine. The pipeline was *downloading* the feature extractor when
the shared HTTP client closed underneath it (#880). Reinstalling transformers
cannot fix a dropped connection, so the advice was not merely unhelpful — it
was work the user could do forever without succeeding.

**#1335** — a cut TLS connection reached /generate as a bare 500 carrying
`_ssl.c:1016`. `core/failure.py` has classified that since #1301, but /generate
keeps its own taxonomy and never learned it, so it fell to the
"an error OmniVoice doesn't recognize" catch-all.

Both fixes are orderings, not new detections: the cause is checked before the
symptom.
"""
from __future__ import annotations

import importlib
import os
import sys

import pytest

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from core import failure  # noqa: E402


@pytest.fixture
def gen():
    return importlib.import_module("api.routers.generation")


# ── #1347: the download died, the install is fine ─────────────────────────

#: The reporter's message, trimmed but structurally intact.
_1347 = (
    "transformers ASR pipeline failed to import (AutoFeatureExtractor) — your "
    "transformers install is incomplete; reinstall with `uv pip install "
    "--reinstall transformers`. Underlying: Cannot send a request, as the "
    "client has been closed."
)


def test_the_reported_message_is_not_called_a_broken_install():
    assert failure.classify(_1347) == "MODEL_DOWNLOAD_INTERRUPTED"


def test_the_hint_does_not_tell_them_to_reinstall():
    """The specific harm: reinstalling transformers cannot fix a dropped
    connection, so the old advice was work that could never succeed."""
    hint = failure._HINTS["MODEL_DOWNLOAD_INTERRUPTED"]
    assert "reinstall" in hint.lower(), "the hint should address the old advice"
    assert "won't help" in hint.lower() or "nothing is wrong" in hint.lower()
    assert "retry" in hint.lower()


def test_the_hint_says_the_partial_download_is_kept():
    """Otherwise a user on a slow link assumes retrying restarts a multi-GB
    download and gives up instead."""
    assert "resumed" in failure._HINTS["MODEL_DOWNLOAD_INTERRUPTED"].lower()


def test_a_genuinely_broken_install_still_says_so():
    """The ordering must not swallow the case TRANSFORMERS_IMPORT exists for —
    no network signature here, so the install really is the problem."""
    assert failure.classify(
        "Could not import module 'AutoFeatureExtractor'"
    ) == "TRANSFORMERS_IMPORT"
    assert failure.classify(
        "[Errno 2] No such file or directory: "
        "'/x/site-packages/transformers/models/qwen3/modeling_qwen3.py'"
    ) == "TRANSFORMERS_IMPORT"


def test_a_closed_client_without_an_import_is_left_alone():
    """The rule requires BOTH halves. A bare closed-client error elsewhere must
    not be given a transformers-flavoured explanation."""
    assert failure.classify("Cannot send a request, as the client has been closed") != (
        "MODEL_DOWNLOAD_INTERRUPTED"
    )


def test_the_class_carries_a_hint_and_is_safe_context_free():
    evt = failure.build_failure(_1347, stage="transcribe", include_diagnostic=False)
    assert evt["docs_topic"] == "MODEL_DOWNLOAD_INTERRUPTED"
    assert evt["hint"]
    # Its trigger needs two co-occurring strings, so it is safe on raw-string
    # surfaces (the global 500 handler) where there is no stage.
    assert "MODEL_DOWNLOAD_INTERRUPTED" in failure._CONTEXT_FREE_HINT_CLASSES
    appended = failure.append_hint(_1347)
    assert appended != _1347, "the raw-500 surface got no hint appended"
    assert failure._HINTS["MODEL_DOWNLOAD_INTERRUPTED"] in appended


# ── #1335: a cut TLS connection on the generate path ──────────────────────

_1335 = (
    "[SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol "
    "(_ssl.c:1016)"
)


def test_a_cut_tls_connection_is_a_network_failure_on_generate(gen):
    """It was falling through to the unrecognized-error catch-all, so the user
    saw `_ssl.c:1016` and a suggestion to report it."""
    assert gen._is_network_failure(RuntimeError(_1335)) is True


def test_the_generate_message_says_retry_not_flush(gen):
    with pytest.raises(RuntimeError) as caught:
        gen._oom_friendly_reraise(RuntimeError(_1335))
    msg = str(caught.value)
    assert "network" in msg.lower()
    assert "doesn't recognize" not in msg
    assert "ran out of memory" not in msg


def test_the_shared_taxonomy_still_names_it_precisely():
    """core/failure.py distinguishes a CUT connection from a failed handshake —
    the certifi/proxy advice would send the user to fix working trust."""
    assert failure.classify(_1335) == "TLS_CONNECTION_DROPPED"
    assert failure.classify(
        "SSLCertVerificationError: certificate verify failed"
    ) == "SSL_HANDSHAKE_FAILURE"


def test_an_ordinary_generate_failure_is_still_unrecognized(gen):
    with pytest.raises(RuntimeError) as caught:
        gen._oom_friendly_reraise(RuntimeError("tensor shape mismatch"))
    assert "doesn't recognize" in str(caught.value)
