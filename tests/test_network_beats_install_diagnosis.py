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

**#1334** — a Windows paging-file limit (`os error 1455`) matched the OOM branch
and told the user to press Flush, which cannot help: the hint we already had for
that class says outright that closing other apps usually will not fix it. The
reporter also reasonably wondered whether OmniVoice needs the internet, because
it correlated with going offline. It does not — the correlation is a coincidence,
and the answer now says so.

All three fixes are orderings and routing, not new detections: the cause is
checked before the symptom, and hints we had already written are made to reach
the surface the user actually sees.
"""
from __future__ import annotations

import importlib
import os
import sys

import pytest

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

@pytest.fixture
def failure():
    """Resolve at call time — sibling suites reload/purge these modules, so a
    module-level import would go stale and make these order-dependent."""
    return importlib.import_module("core.failure")


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


def test_the_reported_message_is_not_called_a_broken_install(failure):
    assert failure.classify(_1347) == "MODEL_DOWNLOAD_INTERRUPTED"


def test_the_hint_does_not_tell_them_to_reinstall(failure):
    """The specific harm: reinstalling transformers cannot fix a dropped
    connection, so the old advice was work that could never succeed."""
    hint = failure._HINTS["MODEL_DOWNLOAD_INTERRUPTED"]
    assert "reinstall" in hint.lower(), "the hint should address the old advice"
    assert "won't help" in hint.lower() or "nothing is wrong" in hint.lower()
    assert "retry" in hint.lower()


def test_the_hint_says_the_partial_download_is_kept(failure):
    """Otherwise a user on a slow link assumes retrying restarts a multi-GB
    download and gives up instead."""
    assert "resumed" in failure._HINTS["MODEL_DOWNLOAD_INTERRUPTED"].lower()


def test_a_genuinely_broken_install_still_says_so(failure):
    """The ordering must not swallow the case TRANSFORMERS_IMPORT exists for —
    no network signature here, so the install really is the problem."""
    assert failure.classify(
        "Could not import module 'AutoFeatureExtractor'"
    ) == "TRANSFORMERS_IMPORT"
    assert failure.classify(
        "[Errno 2] No such file or directory: "
        "'/x/site-packages/transformers/models/qwen3/modeling_qwen3.py'"
    ) == "TRANSFORMERS_IMPORT"


def test_a_closed_client_without_an_import_is_left_alone(failure):
    """The rule requires BOTH halves. A bare closed-client error elsewhere must
    not be given a transformers-flavoured explanation."""
    assert failure.classify("Cannot send a request, as the client has been closed") != (
        "MODEL_DOWNLOAD_INTERRUPTED"
    )


def test_the_class_carries_a_hint_and_is_safe_context_free(failure):
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


def test_the_shared_taxonomy_still_names_it_precisely(failure):
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


# ── #1334: a Windows paging-file limit is not "out of memory" ──────────────

_1334 = "The paging file is too small for this operation to complete. (os error 1455)"


def test_the_paging_file_error_does_not_send_the_user_to_flush(gen):
    """The reporter saw a bare 500 and reasonably wondered whether OmniVoice
    needs the internet. It does not — this is a Windows virtual-memory setting.

    The old path matched the OOM branch and said "Try the Flush button", which
    cannot work: the hint we already had for this class says outright that
    closing other apps usually will not fix it.
    """
    with pytest.raises(RuntimeError) as caught:
        gen._oom_friendly_reraise(RuntimeError(_1334))
    msg = str(caught.value)
    assert "paging file" in msg.lower()
    assert "Flush cannot help" in msg
    assert "Try the Flush button" not in msg


def test_the_paging_file_message_says_it_is_not_a_network_problem(gen):
    """Directly answering what #1334 asked: it correlated with being offline,
    and the correlation is a coincidence."""
    with pytest.raises(RuntimeError) as caught:
        gen._oom_friendly_reraise(RuntimeError(_1334))
    assert "not a network problem" in str(caught.value).lower()


def test_the_paging_file_message_carries_the_actual_instructions(gen):
    """Naming the cause without the remedy would still leave them stuck."""
    with pytest.raises(RuntimeError) as caught:
        gen._oom_friendly_reraise(RuntimeError(_1334))
    assert "Virtual memory" in str(caught.value)


@pytest.mark.parametrize("text", [
    _1334,
    "[WinError 1455] The paging file is too small for this operation to complete",
    "os error 1455",
])
def test_both_spellings_are_recognised(gen, text):
    """Python (`WinError 1455`) and Rust (`os error 1455`, from the safetensors
    mmap) word this differently."""
    with pytest.raises(RuntimeError) as caught:
        gen._oom_friendly_reraise(RuntimeError(text))
    assert "Flush cannot help" in str(caught.value)


def test_a_real_oom_still_gets_the_flush_hint(gen):
    """The new branch runs first, so pin it did not swallow genuine OOM."""
    with pytest.raises(RuntimeError) as caught:
        gen._oom_friendly_reraise(RuntimeError("CUDA out of memory. Tried to allocate 2 GiB"))
    assert "Try the Flush button" in str(caught.value)


def test_the_raw_500_surface_now_carries_the_paging_file_hint(failure):
    """The reporter's message arrived as a bare 500 with only the OS sentence:
    the class was classified correctly but its hint was never attached, because
    it was absent from the context-free set."""
    assert failure.classify(_1334) == "WINDOWS_PAGING_FILE_TOO_SMALL"
    appended = failure.append_hint(_1334)
    assert appended != _1334, "the raw-500 surface still gives the user nothing"
    assert "Virtual memory" in appended


# ── the over-broad-match guards (CodeRabbit on #1374) ─────────────────────

def test_a_non_tls_eof_is_not_called_a_network_failure(gen):
    """The EOF wording is OpenSSL's, but nothing stops an unrelated component
    from saying something similar. Mislabelling a local fault as a network
    problem sends the user to check a connection that was never involved, so
    the match is gated on an `ssl` marker."""
    assert gen._is_network_failure(
        RuntimeError("parser: EOF occurred in violation of protocol frame 3")
    ) is False
    assert gen._is_network_failure(
        RuntimeError("codec reported unexpected_eof_while_reading the container")
    ) is False


def test_the_real_openssl_message_still_matches(gen):
    """...and the gate must not cost us the case it exists for."""
    assert gen._is_network_failure(RuntimeError(
        "[SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of "
        "protocol (_ssl.c:1016)"
    )) is True


@pytest.mark.parametrize("text", [
    # "cannot send a request" without the closed-client half: too generic to
    # override the reinstall advice, which would then never succeed either.
    "Cannot send a request during import of transformers.models.whisper",
    "import failed: cannot send a request to the local server",
])
def test_a_partial_closed_client_phrase_does_not_override_the_install_advice(
    failure, text
):
    assert failure.classify(text) != "MODEL_DOWNLOAD_INTERRUPTED"


def test_the_full_closed_client_signature_still_wins(failure):
    assert failure.classify(
        "AutoFeatureExtractor import failed. Cannot send a request, as the "
        "client has been closed."
    ) == "MODEL_DOWNLOAD_INTERRUPTED"
