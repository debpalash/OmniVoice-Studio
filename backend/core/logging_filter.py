"""HuggingFace token redaction filter for Python's logging system.

Mitigates threat T-01-02 (information disclosure via logs). The filter is
attached to the root logger so every emit — backend Python, uvicorn,
fastapi, pyannote, transformers, faster-whisper, etc. — sees the
substitution before any handler formats the record.

The regex `hf_[A-Za-z0-9]{30,}` is conservative on purpose:
  - Real HF tokens are at least 36 characters total (`hf_` + 33+ chars)
  - We keep the 30-char minimum so legitimate non-token strings like
    `hf_hub`, `hf_pipeline_load`, `hf_token_file_path` are NOT clobbered
  - Returning True from `filter()` always lets the record through — we
    only rewrite, never drop
"""
from __future__ import annotations

import logging
import re

REDACTED = "hf_***REDACTED***"

# At least 30 alphanumerics following `hf_` — covers all real HF tokens
# (typically 36-40 chars total) while leaving short matches like `hf_hub`
# alone so the log stays useful for debugging.
_HF_TOKEN_RE = re.compile(r"hf_[A-Za-z0-9]{30,}")


class HFTokenRedactor(logging.Filter):
    """logging.Filter that rewrites HF token substrings in `record.msg`
    and `record.args` before the formatter sees them."""

    def filter(self, record: logging.LogRecord) -> bool:
        # Rewrite the format string itself if it's a str.
        try:
            if isinstance(record.msg, str):
                record.msg = _HF_TOKEN_RE.sub(REDACTED, record.msg)

            # Rewrite per-argument so the formatted final message also
            # comes out clean. logger.info("token=%s", tok).
            if record.args:
                if isinstance(record.args, tuple):
                    new_args = tuple(
                        _HF_TOKEN_RE.sub(REDACTED, a) if isinstance(a, str) else a
                        for a in record.args
                    )
                    record.args = new_args
                elif isinstance(record.args, dict):
                    record.args = {
                        k: (_HF_TOKEN_RE.sub(REDACTED, v) if isinstance(v, str) else v)
                        for k, v in record.args.items()
                    }
        except Exception:
            # Never let the filter break the log pipeline. If anything
            # unexpected happens, just let the record pass through —
            # erring on the side of the log being noisy, not silent.
            pass
        return True


def install_redaction_filter(root_logger: logging.Logger | None = None) -> None:
    """Attach a single HFTokenRedactor to the root logger and to every
    existing handler. Idempotent — repeated calls do not stack up duplicate
    filters."""
    target = root_logger or logging.getLogger()
    if not any(isinstance(f, HFTokenRedactor) for f in target.filters):
        target.addFilter(HFTokenRedactor())
    # Handlers each have their own filter list. Attach the same redactor
    # to every existing handler so even handler-formatted output is clean.
    for handler in list(target.handlers):
        if not any(isinstance(f, HFTokenRedactor) for f in handler.filters):
            handler.addFilter(HFTokenRedactor())
