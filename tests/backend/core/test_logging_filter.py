"""Tests for backend/core/logging_filter.py — AUTH-05 + T-01-02 (info-disclosure
via logs). The HFTokenRedactor strips `hf_[A-Za-z0-9]{30,}` substrings from
both `record.msg` (string format strings) and `record.args` (per-element)
so no real HF token can land in a runtime log, error toast, or traceback.
"""
import logging

import pytest


VALID_TOKEN = "hf_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF"  # 43-char token
ANOTHER_TOKEN = "hf_QWERTYUIOPasdfghjklZXCVBNM0123456789xyzAB"


@pytest.fixture
def redactor_logger():
    """A logger with HFTokenRedactor installed, isolated from the rest of
    the logging tree so other tests don't see the filter."""
    from core.logging_filter import HFTokenRedactor

    logger = logging.getLogger("omnivoice.test_redactor")
    logger.setLevel(logging.DEBUG)
    # Strip any leftover filters from a prior test run.
    for f in list(logger.filters):
        logger.removeFilter(f)
    logger.addFilter(HFTokenRedactor())
    return logger


def test_redacts_msg_substring(redactor_logger, caplog):
    with caplog.at_level(logging.INFO, logger=redactor_logger.name):
        redactor_logger.info("download failed for %s while reading model", VALID_TOKEN)
    text = caplog.records[0].getMessage()
    assert VALID_TOKEN not in text
    assert "hf_***REDACTED***" in text


def test_redacts_args_tuple(redactor_logger, caplog):
    with caplog.at_level(logging.INFO, logger=redactor_logger.name):
        redactor_logger.info("token=%s, source=%s", VALID_TOKEN, "env")
    msg = caplog.records[0].getMessage()
    assert VALID_TOKEN not in msg
    assert "hf_***REDACTED***" in msg
    assert "source=env" in msg


def test_passes_non_string_args(redactor_logger, caplog):
    """Numeric args must pass through unchanged — the filter must not raise
    on non-string types."""
    with caplog.at_level(logging.INFO, logger=redactor_logger.name):
        redactor_logger.info("value=%d count=%d", 42, 7)
    msg = caplog.records[0].getMessage()
    assert "value=42 count=7" == msg


def test_short_hf_string_not_redacted(redactor_logger, caplog):
    """Literal strings shorter than the 30-char tail (e.g. 'hf_short')
    are NOT real tokens and must NOT be redacted — that would clobber
    error messages, file paths, and arbitrary log content like `hf_hub` or
    `hf_pipeline_load`."""
    with caplog.at_level(logging.INFO, logger=redactor_logger.name):
        redactor_logger.info("using hf_hub for downloads, set hf_token please")
    msg = caplog.records[0].getMessage()
    assert "hf_hub" in msg
    assert "hf_token" in msg


def test_redacts_multiple_tokens(redactor_logger, caplog):
    with caplog.at_level(logging.INFO, logger=redactor_logger.name):
        redactor_logger.info("old=%s new=%s", VALID_TOKEN, ANOTHER_TOKEN)
    msg = caplog.records[0].getMessage()
    assert VALID_TOKEN not in msg
    assert ANOTHER_TOKEN not in msg
    assert msg.count("hf_***REDACTED***") == 2


def test_install_filter_is_idempotent():
    """Calling install_redaction_filter() twice must not double-attach the
    same filter to the root logger."""
    from core.logging_filter import HFTokenRedactor, install_redaction_filter

    root = logging.getLogger()
    # Clean up any from prior tests.
    for f in list(root.filters):
        if isinstance(f, HFTokenRedactor):
            root.removeFilter(f)
    install_redaction_filter(root)
    install_redaction_filter(root)
    redactors = [f for f in root.filters if isinstance(f, HFTokenRedactor)]
    assert len(redactors) == 1
