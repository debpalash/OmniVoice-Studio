"""L2 web Driver — offline tests of the deterministic pieces (self-heal locator
logic + judges via a FakePage), plus a live launch that skips without Playwright
or a running frontend.
"""

from __future__ import annotations

import os

import pytest

from . import spec as probe_spec
from . import web as probe_web
from .judges import web as web_judges

_SPEC = os.path.join(os.path.dirname(__file__), "specs", "launchpad.probe.yaml")


class FakePage:
    """Minimal stand-in for a Playwright sync Page — enough for the judges +
    the Driver's locate logic to run with no browser."""

    def __init__(self, visible=(), texts=None, url="", content=None):
        self._visible = set(visible)
        self._texts = texts or {}
        self.url = url
        self._content = content if content is not None else "<html><body>" + "".join(
            f"<div>{s}</div>" for s in visible
        ) + "</body></html>"

    def is_visible(self, selector):
        return selector in self._visible

    def inner_text(self, selector):
        if selector not in self._texts:
            raise ValueError(f"no element for {selector!r}")
        return self._texts[selector]

    def content(self):
        return self._content

    def goto(self, url):
        self.url = url


# ── self-heal candidate generation (pure) ───────────────────────────────────────


def test_selfheal_id_to_testid_and_text():
    cands = probe_web.selfheal_candidates("#submit-btn")
    assert '[data-testid="submit-btn"]' in cands
    assert '[id="submit-btn"]' in cands
    assert "text=submit btn" in cands
    assert "#submit-btn" not in cands  # never echoes the primary


def test_selfheal_loosens_class_chain():
    assert ".primary" in probe_web.selfheal_candidates(".btn.utility.primary")
    assert "button" in probe_web.selfheal_candidates("button.foo.bar")


# ── judges via FakePage ──────────────────────────────────────────────────────────


def test_web_visible_judge():
    page = FakePage(visible={"#root"})
    assert web_judges.web_visible(page, "#root").passed is True
    assert web_judges.web_visible(page, "#missing").passed is False


def test_web_text_equals_judge():
    page = FakePage(texts={"h1": "  OmniVoice  "})
    assert web_judges.web_text_equals(page, "h1", "OmniVoice").passed is True
    assert web_judges.web_text_equals(page, "h1", "Nope").passed is False
    assert web_judges.web_text_equals(page, "missing", "x").passed is False  # lookup error → FAIL


def test_web_url_matches_judge():
    page = FakePage(url="http://localhost:3901/launchpad")
    assert web_judges.web_url_matches(page, "localhost:3901").passed is True
    assert web_judges.web_url_matches(page, "example\\.com").passed is False


# ── Driver self-heal behaviour ───────────────────────────────────────────────────


def test_driver_returns_primary_when_visible():
    d = probe_web.WebDriver(FakePage(visible={"#root"}))
    assert d.locate("#root") == "#root"
    assert d.heal_log == []


def test_driver_selfheals_to_candidate():
    # Primary missing, but the test-id fallback exists → heal without an agent.
    page = FakePage(visible={'[data-testid="submit-btn"]'})
    d = probe_web.WebDriver(page)
    assert d.locate("#submit-btn") == '[data-testid="submit-btn"]'
    assert d.heal_log == [("#submit-btn", '[data-testid="submit-btn"]')]


def test_driver_uses_healer_as_last_resort():
    class FixedHealer:
        def heal(self, primary, page):
            return "#actually-here"

    page = FakePage(visible={"#actually-here"})
    d = probe_web.WebDriver(page, healer=FixedHealer())
    assert d.locate("#nope") == "#actually-here"


# ── LLM-backed agentic healer (offline, injected completion) ─────────────────────


def test_llm_healer_parse_strips_noise():
    assert probe_web.LLMHealer._parse("`#foo`\nextra line") == "#foo"
    assert probe_web.LLMHealer._parse("selector: .bar") == ".bar"
    assert probe_web.LLMHealer._parse("") is None


def test_llm_healer_heals_via_model():
    calls = {}

    def fake_complete(prompt):
        calls["prompt"] = prompt
        return "#actually-here"

    page = FakePage(visible={"#actually-here"})
    d = probe_web.WebDriver(page, healer=probe_web.LLMHealer(fake_complete))
    # Primary + deterministic candidates all miss → escalate to the model.
    assert d.locate("#nope") == "#actually-here"
    assert "#nope" in calls["prompt"] and "PAGE:" in calls["prompt"]  # prompt was built from the page


def test_llm_healer_swallows_model_errors():
    def boom(prompt):
        raise RuntimeError("model down")

    d = probe_web.WebDriver(FakePage(visible=set()), healer=probe_web.LLMHealer(boom))
    assert d.locate("#nope") is None  # never crashes the run


def test_anthropic_complete_requires_sdk():
    import importlib.util

    if importlib.util.find_spec("anthropic") is not None:
        pytest.skip("anthropic installed — live path")
    with pytest.raises(ImportError):
        probe_web.anthropic_complete()


def test_driver_gives_up_cleanly():
    d = probe_web.WebDriver(FakePage(visible=set()))
    assert d.locate("#nothing") is None


# ── spec wiring (offline, FakePage as the live page) + report record ─────────────


def test_launchpad_spec_against_fakepage(probe_report):
    spec = probe_spec.load_spec(_SPEC)
    page = FakePage(visible={"#root"}, url="http://localhost:3901/")
    results = probe_spec.run_judges(spec, context={"page": page})
    probe_report.record(spec, results)
    assert probe_spec.blocking_failures(results) == []


# ── live launch (skips without Playwright / frontend) ────────────────────────────


def test_live_launch_skips_cleanly():
    pytest.importorskip("playwright", reason="L2 live browser: `uv add playwright && playwright install chromium`")
    if not probe_web.frontend_reachable("http://localhost:3901"):
        pytest.skip("frontend not running on :3901 (`bun run dev`)")
    with probe_web.launch("http://localhost:3901") as driver:
        assert web_judges.web_visible(driver.page, "#root").passed is True
