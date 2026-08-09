"""Response-boundary helpers for failures produced by untrusted code.

Exceptions and subprocess/engine diagnostics belong in the local backend log,
not in an HTTP response.  Keeping this mapping deliberately data-independent
also prevents a new credential or path shape from bypassing a regex scrubber.
"""
from __future__ import annotations

import logging
from typing import Any


def public_failure(
    logger: logging.Logger,
    log_message: str,
    error: BaseException | object,
    *,
    response: str,
    traceback: bool = False,
) -> str:
    """Log the private diagnostic and return a fixed public failure message.

    ``response`` must be authored by VoiceStudio, never derived from ``error``.
    The helper intentionally does not attempt to redact exception text: a
    deny-list cannot cover arbitrary secrets, paths, source lines or nested
    tracebacks.
    """
    if traceback and isinstance(error, BaseException):
        logger.exception(log_message)
    else:
        logger.error("%s: %s", log_message, error)
    return response


def public_engine_health(ok: bool, diagnostic: Any) -> str:
    """Map an engine-owned health diagnostic to a stable response message."""
    del diagnostic
    return "Healthy" if ok else "Engine unavailable; check the backend log for details."
