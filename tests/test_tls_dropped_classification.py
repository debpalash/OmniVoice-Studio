"""#1301: a cut TLS connection surfaced as a raw OpenSSL string in a 500.

    500 Internal Server Error: [SSL: UNEXPECTED_EOF_WHILE_READING]
    EOF occurred in violation of protocol (_ssl.c:1016)

Two things wrong with that. It means nothing to a user, and it was
unclassified — the existing SSL branch requires "handshake" / "certificate
verify failed", so this fell through with no hint at all.

It also must NOT be classified as SSL_HANDSHAKE_FAILURE. That class means a
proxy re-signed the certificate with a CA certifi doesn't trust, and its advice
is to set SSL_CERT_FILE or add an antivirus exclusion. Here the handshake never
failed on trust — the socket was cut mid-exchange, usually by flaky Wi-Fi, a
reconnecting VPN, or a server dropping a long transfer. Sending that user to
fix their certificate store is sending them to fix something that isn't broken.
"""
from __future__ import annotations

import pytest

RAW = (
    "[SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of "
    "protocol (_ssl.c:1016)"
)


def _classify(text):
    from core.failure import classify

    return classify(text)


def test_dropped_tls_is_classified():
    assert _classify(RAW) == "TLS_CONNECTION_DROPPED"


def test_not_mistaken_for_a_cert_trust_problem():
    """The whole point of the separate class."""
    assert _classify(RAW) != "SSL_HANDSHAKE_FAILURE"


@pytest.mark.parametrize(
    "text",
    [
        "SSLError: certificate verify failed: unable to get local issuer certificate",
        "ssl.SSLError: [SSL: SSLV3_ALERT_HANDSHAKE_FAILURE] sslv3 alert handshake failure",
    ],
)
def test_real_handshake_failures_still_classify_as_such(text):
    """The new branch runs first, so guard that it didn't steal these."""
    assert _classify(text) == "SSL_HANDSHAKE_FAILURE"


def test_user_facing_hint_is_about_retrying_not_certificates():
    from core.failure import build_failure

    fields = build_failure(RuntimeError(RAW), stage="download")
    assert fields["docs_topic"] == "TLS_CONNECTION_DROPPED"
    hint = fields["hint"].lower()
    assert "retry" in hint
    assert "ssl_cert_file" not in hint
    assert "certifi" not in hint


def test_hint_attaches_on_context_free_surfaces():
    """The 500 handler has only a raw string — the class has to be safe there,
    which is exactly where #1301's reporter met it."""
    from core.failure import append_hint

    out = append_hint(RAW)
    assert out != RAW, "no hint was attached on the raw-string surface"
    assert "cut off" in out.lower() or "transient" in out.lower()


def test_unrelated_errors_are_untouched():
    assert _classify("ValueError: bad input") != "TLS_CONNECTION_DROPPED"
    assert _classify("") != "TLS_CONNECTION_DROPPED"
