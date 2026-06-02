"""L1/L5 HTTP + filesystem judges — deterministic verdicts on responses and
on-disk state. No audio, no LLM; just status codes, JSON shape, latency, and
file existence.

These judges take their inputs explicitly from the run context (resolved via
``$.``) rather than from an audio ``subject``, so they compose into env / API
specs without colliding with the L4 ``subject`` injection.
"""

from __future__ import annotations

import os
from typing import Any

from ..spec import JudgeResult


def status_eq(actual: int, expected: int = 200) -> JudgeResult:
    ok = int(actual) == int(expected)
    return JudgeResult(
        name="status_eq",
        passed=ok,
        measured=actual,
        detail=f"HTTP {actual} (expected {expected})",
    )


def json_has(obj: Any, key: str) -> JudgeResult:
    present = isinstance(obj, dict) and key in obj
    return JudgeResult(
        name="json_has",
        passed=present,
        measured=key,
        detail=f"key {key!r} present" if present else f"key {key!r} missing from response body",
    )


def json_field_eq(obj: Any, key: str, value: Any) -> JudgeResult:
    got = obj.get(key) if isinstance(obj, dict) else None
    ok = got == value
    return JudgeResult(
        name="json_field_eq",
        passed=ok,
        measured=got,
        detail=f"{key}={got!r} (expected {value!r})",
    )


def responds_within_ms(elapsed_ms: float, max: float) -> JudgeResult:
    ok = float(elapsed_ms) <= float(max)
    return JudgeResult(
        name="responds_within_ms",
        passed=ok,
        measured=round(float(elapsed_ms), 1),
        detail=f"{elapsed_ms:.1f} ms (budget {max} ms)",
    )


def path_exists(target: str) -> JudgeResult:
    """Filesystem existence (file or directory). Named ``target`` (not ``path``)
    so the L4 audio-subject auto-injection never binds to it."""
    ok = bool(target) and os.path.exists(target)
    return JudgeResult(
        name="path_exists",
        passed=ok,
        measured=target,
        detail=f"{target!r} exists" if ok else f"{target!r} does not exist",
    )
