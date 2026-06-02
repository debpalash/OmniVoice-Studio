"""L2 web Driver — the Actor for browser-driven UI tests.

This is the one place an AI agent is allowed at *runtime*, and only in the
Actor role: locating elements and self-healing when a selector drifts. The
verdict still comes from the deterministic judges in ``judges/web.py`` — the
Driver never decides pass/fail.

Self-heal is layered:
  1. Try the author's primary selector.
  2. Try deterministic fallback candidates derived from it (id → test-id →
     text, loosened CSS). This catches the common "class got renamed" drift
     without any LLM and is fully unit-testable offline.
  3. Only if those miss, ask the pluggable :class:`Healer` (the agent slot —
     an LLM that looks at the page and proposes a locator). Default is a no-op,
     so the harness is deterministic unless an agent healer is explicitly wired.

The live browser (Playwright) is imported lazily so the deterministic pieces
above run without it; :func:`launch` skips cleanly when Playwright or the
frontend isn't available.
"""

from __future__ import annotations

import re
from typing import Any, Callable, Protocol


def selfheal_candidates(primary: str) -> list[str]:
    """Derive deterministic fallback locators from a primary selector.

    Covers the most common drift: a renamed/extra class, a CSS id that moved to
    a ``data-testid``, or a brittle compound selector that can fall back to its
    last meaningful token. Pure string logic — no browser, no LLM.
    """
    out: list[str] = []
    s = primary.strip()

    # #foo  →  [data-testid="foo"], [id="foo"], text=foo
    m = re.fullmatch(r"#([\w-]+)", s)
    if m:
        name = m.group(1)
        out += [f'[data-testid="{name}"]', f'[id="{name}"]', f"text={name.replace('-', ' ')}"]

    # .a.b.c  →  loosen to the last single class (drift usually adds/renames the
    # leading utility classes, not the semantic trailing one).
    if s.startswith(".") and "." in s[1:]:
        last = s.rsplit(".", 1)[-1]
        out.append(f".{last}")

    # tag.cls  →  bare tag as a last resort
    m = re.fullmatch(r"([a-zA-Z][\w-]*)\.[\w.-]+", s)
    if m:
        out.append(m.group(1))

    # data-testid="x"  ↔  the human text "x" (best-effort)
    m = re.search(r'data-testid="([\w-]+)"', s)
    if m:
        out.append(f"text={m.group(1).replace('-', ' ')}")

    # de-dup, preserve order, never echo the primary
    seen, deduped = {primary}, []
    for c in out:
        if c not in seen:
            seen.add(c)
            deduped.append(c)
    return deduped


class Healer(Protocol):
    """The agent slot. Given the primary selector that missed and a snapshot of
    what's on the page, propose a working selector (or None to give up)."""

    def heal(self, primary: str, page: Any) -> str | None: ...


class NoopHealer:
    """Default healer — keeps the Driver deterministic. Swap in an LLM-backed
    healer to enable agentic self-heal."""

    def heal(self, primary: str, page: Any) -> str | None:  # noqa: D401
        return None


def describe_page(page: Any, max_chars: int = 4000) -> str:
    """A compact textual view of the page for an LLM healer. Prefers the live
    HTML (Playwright ``page.content()``), falls back to the URL."""
    try:
        html = page.content()
    except Exception:  # noqa: BLE001
        html = ""
    if html:
        return html[:max_chars]
    return f"URL: {getattr(page, 'url', '')}"


_HEAL_PROMPT = (
    "A UI test's selector {primary!r} no longer matches any visible element on "
    "the page. Using the page HTML below, reply with EXACTLY ONE selector (a CSS "
    "selector, or a Playwright `text=` / `role=` selector) that targets the same "
    "element the broken selector intended. Output only the selector — no prose, "
    "no quotes, no backticks, no explanation.\n\nPAGE:\n{page}"
)


class LLMHealer:
    """Agentic self-heal: asks a model to propose a replacement selector from the
    live page. The model is injected as a ``complete(prompt) -> str`` callable so
    the logic is unit-testable offline and provider-agnostic.

    This is the one runtime LLM in the harness, and it sits firmly in the Actor
    role — it only *proposes* a locator; the Driver still validates visibility
    and the deterministic judges still render the verdict.
    """

    def __init__(self, complete: Callable[[str], str], max_chars: int = 4000):
        self.complete = complete
        self.max_chars = max_chars

    @staticmethod
    def _parse(resp: str | None) -> str | None:
        if not resp:
            return None
        line = resp.strip().splitlines()[0].strip().strip("`").strip()
        if line.lower().startswith("selector:"):
            line = line.split(":", 1)[1].strip()
        return line or None

    def heal(self, primary: str, page: Any) -> str | None:
        prompt = _HEAL_PROMPT.format(primary=primary, page=describe_page(page, self.max_chars))
        try:
            return self._parse(self.complete(prompt))
        except Exception:  # noqa: BLE001 — a healer failure must never crash the run
            return None


def anthropic_complete(model: str = "claude-sonnet-4-6", max_tokens: int = 64) -> Callable[[str], str]:
    """A ``complete`` callable backed by the Anthropic SDK. Enable-on-demand:
    ``uv add anthropic`` and set ANTHROPIC_API_KEY. Sonnet is the sensible
    default tier for cheap, fast locator proposals."""
    import anthropic  # raises ImportError until installed

    client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY

    def _complete(prompt: str) -> str:
        msg = client.messages.create(
            model=model, max_tokens=max_tokens, messages=[{"role": "user", "content": prompt}]
        )
        return "".join(b.text for b in msg.content if getattr(b, "type", None) == "text")

    return _complete


def anthropic_healer(model: str = "claude-sonnet-4-6") -> LLMHealer:
    """Convenience: an LLMHealer wired to Anthropic. Pass to ``launch(healer=...)``."""
    return LLMHealer(anthropic_complete(model=model))


class WebDriver:
    """Thin wrapper over a page that locates with self-heal but judges nothing.

    ``page`` only needs ``is_visible(selector) -> bool`` (Playwright's sync Page
    and the test FakePage both satisfy this), so the locate logic is testable
    without a real browser.
    """

    def __init__(self, page: Any, healer: Healer | None = None):
        self.page = page
        self.healer = healer or NoopHealer()
        self.heal_log: list[tuple[str, str]] = []  # (primary, resolved) for reporting

    def locate(self, selector: str) -> str | None:
        """Return a selector that is currently visible, self-healing if needed."""
        try:
            if self.page.is_visible(selector):
                return selector
        except Exception:  # noqa: BLE001 — treat lookup errors as "not found"
            pass
        for cand in selfheal_candidates(selector):
            try:
                if self.page.is_visible(cand):
                    self.heal_log.append((selector, cand))
                    return cand
            except Exception:  # noqa: BLE001
                continue
        healed = self.healer.heal(selector, self.page)
        if healed:
            try:
                if self.page.is_visible(healed):
                    self.heal_log.append((selector, healed))
                    return healed
            except Exception:  # noqa: BLE001
                return None
        return None

    def goto(self, url: str) -> None:
        self.page.goto(url)


# ── live launch (skips cleanly without Playwright / a running frontend) ─────────


def playwright_available() -> bool:
    import importlib.util

    return importlib.util.find_spec("playwright") is not None


def frontend_reachable(base_url: str, timeout: float = 1.5) -> bool:
    import urllib.error
    import urllib.request

    try:
        with urllib.request.urlopen(base_url, timeout=timeout) as r:  # noqa: S310 (local URL)
            return 200 <= r.status < 500
    except Exception:  # noqa: BLE001
        return False


def launch(base_url: str = "http://localhost:3901", *, healer: Healer | None = None, headless: bool = True):
    """Context manager yielding a :class:`WebDriver` at ``base_url``.

    Raises RuntimeError if Playwright or the frontend isn't available — callers
    in tests guard with ``pytest.importorskip('playwright')`` + a reachability
    check so L2 skips on hosts without a browser/frontend.
    """
    import contextlib

    if not playwright_available():
        raise RuntimeError("playwright not installed: `uv add playwright && playwright install chromium`")
    if not frontend_reachable(base_url):
        raise RuntimeError(f"frontend not reachable at {base_url} (start `bun run dev`)")

    from playwright.sync_api import sync_playwright

    @contextlib.contextmanager
    def _cm():
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=headless)
            try:
                page = browser.new_page()
                page.goto(base_url)
                yield WebDriver(page, healer=healer)
            finally:
                browser.close()

    return _cm()
