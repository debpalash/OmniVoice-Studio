"""Data-independent error metadata safe for API and streaming responses."""
from __future__ import annotations

_PROVIDER_DETAILS = {
    "auth": "Authentication failed. Check the provider API key.",
    "not_found": "Provider or model not found. Check the model and Base URL.",
    "rate_limit": "The provider rate limit was reached. Try again later.",
    "network": "The provider could not be reached. Check the connection and Base URL.",
    "config": "Configure the provider before using it.",
    "error": "The provider request failed. Try again.",
}


def provider_failure(kind: str) -> dict[str, str]:
    """Return a stable provider error class and remediation message."""
    safe_kind = kind if kind in _PROVIDER_DETAILS else "error"
    return {"kind": safe_kind, "detail": _PROVIDER_DETAILS[safe_kind]}


def stream_failure(code: str) -> dict[str, object]:
    """Return stable stream metadata selected only from an internal code."""
    failures: dict[str, dict[str, object]] = {
        "generation_busy": {
            "code": "generation_busy",
            "detail": "Generation capacity is busy. Try again shortly.",
            "retryable": True,
        },
        "invalid_request": {
            "code": "invalid_request",
            "detail": "The generation request could not be processed.",
            "retryable": False,
        },
        "generation_failed": {
            "code": "generation_failed",
            "detail": "Generation failed. Check the selected engine and try again.",
            "retryable": True,
        },
        "transcription_failed": {
            "code": "transcription_failed",
            "detail": "Transcription failed. Check the selected ASR engine and try again.",
            "retryable": True,
        },
        "transcription_timeout": {
            "code": "transcription_timeout",
            "detail": (
                "Transcription timed out while the backend is running. Increase "
                "OMNIVOICE_TRANSCRIBE_CHUNK_TIMEOUT_S or select the "
                "faster-whisper-isolated engine, then try again."
            ),
            "retryable": True,
        },
    }
    return dict(failures.get(code, failures["generation_failed"]))
