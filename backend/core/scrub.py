"""Privacy scrubber for diagnostic text that may leave the machine.

Everything OmniVoice renders into a bug report or diagnostic dump goes
through ``scrub_text()`` before it can reach a prefilled GitHub Issues URL
(the only outbound path — see CLAUDE.md Capability 2). The scrubber is the
backend twin of ``frontend/src/utils/bugReport.js``'s ``scrubText`` and
must stay at least as strict:

  - home directories → ``~`` (macOS ``/Users/<name>``, Linux ``/home/<name>``,
    Windows ``C:\\Users\\<name>``, plus the *actual* ``$HOME`` of this process)
  - credential-shaped substrings → ``***REDACTED***`` (HF tokens, GitHub
    PATs, OpenAI-style ``sk-`` keys)
  - values of env vars whose NAME matches ``*TOKEN*|*KEY*|*SECRET*|
    *PASSWORD*|*CREDENTIAL*`` — so a stack trace that interpolated a real
    secret still comes out clean

Unlike ``core.logging_filter`` (which rewrites log records in-flight and
must stay cheap), this module runs on report-sized strings at report time,
so it can afford the env-var sweep.
"""
from __future__ import annotations

import os
import re

REDACTED = "***REDACTED***"

# Env-var NAMES whose values must never appear in scrubbed output.
_SECRET_NAME_RE = re.compile(r"TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL", re.IGNORECASE)

# Credential-shaped substrings, independent of where they came from.
# Thresholds mirror core.logging_filter: long enough that identifiers like
# `hf_hub` or `sk-learn` survive, short enough that real tokens never do.
_TOKEN_PATTERNS = (
    re.compile(r"hf_[A-Za-z0-9]{30,}"),            # HuggingFace
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),   # GitHub fine-grained PAT
    re.compile(r"gh[pousr]_[A-Za-z0-9]{30,}"),     # GitHub classic tokens
    re.compile(r"sk-[A-Za-z0-9_\-]{20,}"),         # OpenAI-style API keys
)

# Home-directory shapes for all three supported platforms. Matched
# pattern-wise (not just this machine's $HOME) so paths quoted from a
# user's pasted log on another OS get cleaned too.
_HOME_PATTERNS = (
    # Windows-with-forward-slashes must run BEFORE the bare macOS shape, or
    # `/Users/<name>` inside `C:/Users/<name>` gets eaten first, leaving `C:~`.
    re.compile(r"[A-Za-z]:/Users/[^/\s\"']+"),       # Windows, forward slashes (file URLs, normalized traces)
    re.compile(r"/Users/[^/\s\"']+"),                # macOS
    re.compile(r"/home/[^/\s\"']+"),                 # Linux
    re.compile(r"[A-Za-z]:\\Users\\[^\\\s\"']+"),    # Windows, backslashes
)

# Values shorter than this are too entropy-poor to be real secrets and too
# likely to shred unrelated text (e.g. PASSWORD_MIN_LENGTH=8 would otherwise
# turn every "8" in the report into ***REDACTED***).
_MIN_SECRET_LEN = 8


def _env_secret_values() -> list[str]:
    """Values of secret-named env vars, longest first so overlapping
    values (e.g. a token and its prefix) redact cleanly."""
    vals = [
        v
        for k, v in os.environ.items()
        if _SECRET_NAME_RE.search(k) and v and len(v) >= _MIN_SECRET_LEN
    ]
    return sorted(vals, key=len, reverse=True)


def scrub_text(text: str | None) -> str:
    """Return ``text`` with secrets and home paths redacted.

    Never raises — scrubbing failure must not block a bug report, and a
    partially-scrubbed string is still better than an unscrubbed one, so
    each pass is independent.
    """
    if not text:
        return "" if text is None else str(text)
    s = str(text)

    # 1. Exact env-var secret values (most specific — run first).
    try:
        for val in _env_secret_values():
            s = s.replace(val, REDACTED)
    except Exception:
        pass

    # 2. Credential-shaped substrings.
    for pat in _TOKEN_PATTERNS:
        try:
            s = pat.sub(REDACTED, s)
        except Exception:
            pass

    # 3. This process's real home dir (covers symlinked/nonstandard homes
    #    the generic patterns miss), then the per-OS shapes.
    try:
        home = os.path.expanduser("~")
        if home and home not in ("/", "~"):
            s = s.replace(home, "~")
    except Exception:
        pass
    for pat in _HOME_PATTERNS:
        try:
            s = pat.sub("~", s)
        except Exception:
            pass

    return s
