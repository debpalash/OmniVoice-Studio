"""L2 web judges — deterministic verdicts on a live page.

The Actor (a Playwright-driven browser, possibly self-healed by an agent) does
the navigating; these judges render the verdict from observable page state
(visibility, text, URL). They operate on any object implementing the small
page protocol used here (Playwright's sync ``Page`` does; so does the test
``FakePage``), so the judge logic is unit-testable offline without a browser.
"""

from __future__ import annotations

import re
from typing import Any

from ..spec import JudgeResult


def web_visible(page: Any, selector: str) -> JudgeResult:
    try:
        ok = bool(page.is_visible(selector))
        detail = f"{selector!r} {'visible' if ok else 'not visible'}"
    except Exception as exc:  # noqa: BLE001 — a lookup error is a FAIL, not a crash
        ok, detail = False, f"{selector!r} lookup failed: {exc}"
    return JudgeResult(name="web_visible", passed=ok, measured=selector, detail=detail)


def web_text_equals(page: Any, selector: str, expected: str, *, strip: bool = True) -> JudgeResult:
    try:
        got = page.inner_text(selector)
        cmp_got, cmp_exp = (got.strip(), expected.strip()) if strip else (got, expected)
        ok = cmp_got == cmp_exp
        detail = f"{selector!r} text={got!r} (expected {expected!r})"
    except Exception as exc:  # noqa: BLE001
        ok, got, detail = False, None, f"{selector!r} read failed: {exc}"
    return JudgeResult(name="web_text_equals", passed=ok, measured=got, detail=detail)


def web_url_matches(page: Any, pattern: str) -> JudgeResult:
    url = getattr(page, "url", "")
    ok = re.search(pattern, url) is not None
    return JudgeResult(
        name="web_url_matches",
        passed=ok,
        measured=url,
        detail=f"url={url!r} {'matches' if ok else 'does not match'} /{pattern}/",
    )
