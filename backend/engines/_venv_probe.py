"""Bounded "can this interpreter import the engine?" probe (#1414).

Every subprocess engine resolves its sidecar interpreter the same way: try the
venv the user pointed at, then the one we bootstrapped, and confirm each
candidate by spawning it and importing the engine package. The confirmation
matters — a candidate that exists but cannot import is worse than no candidate,
because the failure would otherwise surface 30 s later as an opaque sidecar
handshake timeout.

The bug this module exists to fix is what the probe did with *slowness*.

``import indextts.infer_v2`` (and every peer) pulls in torch and transformers:
seconds when the OS page cache is warm, but tens of seconds on a cold first
run, a spinning disk, a network share, or Windows with real-time AV scanning
every DLL it touches. The per-engine bounds were 10 s (IndexTTS) and 15 s (the
rest), and a bound that elapsed was treated as a **negative**: the candidate
was dropped exactly as if importing had raised. So on the machines where the
import is slowest, a perfectly good ``OMNIVOICE_INDEXTTS_DIR`` install was
silently discarded and the user got "IndexTTS-2 is not installed" or a 500 on
the first generation after launch — reported with a precise root cause in
#1414. A negative result is also not memoised, so every retry paid the whole
probe again and failed the same way.

A timeout is not evidence of breakage. It is the absence of evidence, so this
returns three answers rather than two:

``"yes"``
    The interpreter imported the engine. Use it.
``"no"``
    It ran and failed — a real, proven breakage (missing package, bad ABI, an
    OS-level refusal to execute). Move on to the next candidate.
``"unproven"``
    It did not finish in time. Nothing was learned. The caller keeps it as a
    fallback and prefers any candidate that proves itself, but uses it rather
    than declaring the engine missing: a genuinely broken venv then fails at
    the sidecar handshake with a real error, which is a far better outcome
    than a confident lie about the user's install.

The bound is also generous now and tunable, because the only thing it still
buys is how long we are willing to wait for a *negative*.
"""
from __future__ import annotations

import math
import os
import subprocess
from pathlib import Path
from typing import Literal

#: "yes" = imported, "no" = proven broken, "unproven" = did not finish in time.
ProbeResult = Literal["yes", "no", "unproven"]

#: Seconds to wait for the probe. Sized for a cold torch import on a slow
#: disk rather than for a warm one — overshooting only delays the fall-through
#: to the next candidate, while undershooting discards a working install.
DEFAULT_PROBE_TIMEOUT_S = 60.0

#: Applies to every engine.
_GLOBAL_ENV = "OMNIVOICE_ENGINE_IMPORT_PROBE_TIMEOUT_S"


def probe_timeout_s(engine: str) -> float:
    """Resolve the probe bound: per-engine env → global env → default.

    ``engine`` is the short slug used in the env var, e.g. ``"indextts"`` →
    ``OMNIVOICE_INDEXTTS_IMPORT_PROBE_TIMEOUT_S``. A malformed, non-positive
    or non-finite value is ignored rather than honoured: disabling the bound
    would let one wedged candidate hang engine resolution forever, and
    ``inf`` in particular parses cleanly but makes ``subprocess.run`` raise
    ``OverflowError``, breaking this module's never-raises contract from the
    one place a user could reach it (CodeRabbit).
    """
    for name in (
        f"OMNIVOICE_{engine.upper()}_IMPORT_PROBE_TIMEOUT_S",
        _GLOBAL_ENV,
    ):
        raw = (os.environ.get(name) or "").strip()
        if not raw:
            continue
        try:
            value = float(raw)
        except ValueError:
            continue
        if value > 0 and math.isfinite(value):
            return value
    return DEFAULT_PROBE_TIMEOUT_S


def log_safe(path: "Path | str") -> str:
    """A candidate interpreter path, safe to log.

    Every one of these paths runs through the user's home directory, so it
    carries their account name — and these lines land in backend.log, which
    goes into diagnostic bundles and prefilled bug reports (CWE-532;
    CodeRabbit). ``core.failure.sanitize`` is the same redaction every other
    surfaced string in the app gets.

    Falls back to the basename rather than the full path if sanitizing is
    unavailable: a probe must not fail because logging could not redact.
    """
    try:
        from core.failure import sanitize

        return sanitize(str(path))
    except Exception:  # noqa: BLE001 — never fail a probe over a log line
        return os.path.basename(str(path)) or "<path>"


def venv_can_import(
    python_path: "Path | str",
    import_stmt: str,
    *,
    engine: str,
    logger,
) -> ProbeResult:
    """Spawn ``python_path`` and run ``import_stmt``; see module docstring.

    Never raises: engine resolution must not die because a candidate
    interpreter misbehaved.
    """
    timeout = probe_timeout_s(engine)
    try:
        proc = subprocess.run(
            [str(python_path), "-c", import_stmt],
            capture_output=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        # Deliberately NOT "no" — see the module docstring. Warning, not debug:
        # this is the branch that used to silently discard a working install,
        # and a user hitting it needs the env var named where they will find it.
        logger.warning(
            "%s import probe for %s did not finish within %.0fs — keeping it "
            "as a fallback rather than treating slow as broken (#1414). Raise "
            "OMNIVOICE_%s_IMPORT_PROBE_TIMEOUT_S if this host is simply slow.",
            engine, log_safe(python_path), timeout, engine.upper(),
        )
        return "unproven"
    except OSError as exc:
        # The OS refused to execute it at all: not a slow import, a bad path
        # or a binary this machine cannot run. Proven negative.
        logger.debug(
            "%s import probe could not run %s: %s",
            engine, log_safe(python_path), exc,
        )
        return "no"
    if proc.returncode != 0:
        logger.debug(
            "%s import probe non-zero for %s: %s",
            engine,
            log_safe(python_path),
            proc.stderr.decode("utf-8", errors="replace")[:200],
        )
        return "no"
    return "yes"
