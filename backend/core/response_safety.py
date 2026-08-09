"""Response-boundary helpers for failures produced by untrusted code.

Exceptions and subprocess/engine diagnostics belong in the local crash journal,
not in routine logs or HTTP responses. Keeping this mapping deliberately
data-independent prevents new credential or path shapes bypassing a scrubber.
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
    """Log fixed failure metadata and return a fixed public failure message.

    ``response`` must be authored by VoiceStudio, never derived from ``error``.
    The helper intentionally does not attempt to redact exception text: a
    deny-list cannot cover arbitrary secrets, paths, source lines or nested
    tracebacks.
    """
    del traceback
    error_class = type(error).__name__ if isinstance(error, BaseException) else "Failure"
    logger.error("%s (class=%s; details withheld)", log_message, error_class)
    return response


def public_engine_health(ok: bool, diagnostic: Any) -> str:
    """Map an engine-owned health diagnostic to a stable response message."""
    del diagnostic
    return "Healthy" if ok else "Engine unavailable; check the backend log for details."


def public_exception_response(error: BaseException, *, fallback: str) -> dict[str, str]:
    """Return fixed remediation selected by a stable failure taxonomy.

    Classification may inspect the private diagnostic locally, but response
    values come exclusively from VoiceStudio-owned constants. No substring of
    ``error`` is copied into the payload.
    """
    from core.failure import classify, public_hint_for_topic

    try:
        topic = classify(str(error))
        hint = public_hint_for_topic(topic)
    except Exception:
        topic = ""
        hint = ""
    payload = {"detail": f"{fallback} {hint}".strip()}
    if topic and hint:
        payload.update({"docs_topic": topic, "hint": hint})
    return payload
