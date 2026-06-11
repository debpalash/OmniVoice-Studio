"""Deterministic unit tests for the eval harness (no LLM required).

These DO run in gating CI — they test the harness mechanics, not semantic
quality. The semantic suites themselves run only in the non-gating
scheduled workflow (.github/workflows/evals.yml).
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from evals.case import EvalCase, EvalTurn
from evals.judge import LLMJudge
from evals.runner import EvalRunner, EvalSuite, load_suite

SUITES_DIR = Path(__file__).resolve().parent / "suites"


class FakeJudgeBackend:
    """Canned judge transport: returns queued raw strings."""

    def __init__(self, *responses: str):
        self._responses = list(responses)

    async def judge(self, prompt: str) -> str:
        return self._responses.pop(0)


def _run(coro):
    return asyncio.run(coro)


def _echo_factory():
    async def reply(payload):
        return f"echo: {payload}"
    return reply


# ── Judge hardening (ported from Patter verbatim — keep these honest) ──────

def test_verdict_recomputed_locally_ignores_hallucinated_passed():
    judge = LLMJudge(pass_threshold=0.7,
                     backend=FakeJudgeBackend('{"score": 0.2, "passed": true, "reasoning": "nope"}'))
    case = EvalCase(name="c", expected_behavior="x", rubric="y",
                    turns=(EvalTurn(user="hi"),))
    result = _run(judge.judge_case(case, [{"role": "user", "text": "hi"}]))
    assert result.passed is False  # 0.2 < 0.7 regardless of the model's claim
    assert result.score == 0.2


def test_judge_strips_code_fences():
    judge = LLMJudge(backend=FakeJudgeBackend('```json\n{"score": 0.9, "reasoning": "ok"}\n```'))
    case = EvalCase(name="c", expected_behavior="x", rubric="y")
    result = _run(judge.judge_case(case, []))
    assert result.passed is True and result.score == 0.9


def test_invalid_judge_json_fails_with_reasoning_not_crash():
    judge = LLMJudge(backend=FakeJudgeBackend("I think it passes!"))
    case = EvalCase(name="c", expected_behavior="x", rubric="y")
    result = _run(judge.judge_case(case, []))
    assert result.passed is False
    assert "invalid JSON" in result.reasoning


def test_score_clamped_to_unit_interval():
    judge = LLMJudge(backend=FakeJudgeBackend('{"score": 7, "reasoning": ""}'))
    result = _run(judge.judge_case(EvalCase(name="c", expected_behavior="", rubric=""), []))
    assert result.score == 1.0


# ── Runner containment ──────────────────────────────────────────────────────

def test_agent_exception_keeps_partial_transcript_and_still_judges():
    calls = []

    class SpyJudge(LLMJudge):
        async def judge_case(self, case, transcript):
            calls.append(list(transcript))
            return await super().judge_case(case, transcript)

    judge = SpyJudge(backend=FakeJudgeBackend('{"score": 0.0, "reasoning": "partial"}'))

    def factory():
        state = {"n": 0}

        async def reply(text):
            state["n"] += 1
            if state["n"] == 2:
                raise RuntimeError("boom")
            return "ok"
        return reply

    case = EvalCase(name="c", expected_behavior="x", rubric="y",
                    turns=(EvalTurn(user="one"), EvalTurn(user="two")))
    result = _run(EvalRunner(judge=judge).run_case(case, factory))
    assert result.error == "RuntimeError: boom"
    # Partial transcript (turn one + its reply + turn two) was judged.
    assert calls and len(calls[0]) == 3


def test_judge_failure_records_zero_not_suite_abort():
    class ExplodingBackend:
        async def judge(self, prompt):
            raise TimeoutError("judge LLM timed out")

    suite = EvalSuite(name="s", cases=(
        EvalCase(name="a", expected_behavior="x", rubric="y", turns=(EvalTurn(user="hi"),)),
        EvalCase(name="b", expected_behavior="x", rubric="y", turns=(EvalTurn(user="hi"),)),
    ))
    runner = EvalRunner(judge=LLMJudge(backend=ExplodingBackend()))
    results = _run(runner.run(suite, _echo_factory))
    assert len(results) == 2  # second case still ran
    assert all("judge error" in r.judge.reasoning for r in results)
    assert all(r.judge.passed is False for r in results)


def test_structured_input_case_renders_transcript():
    judge = LLMJudge(backend=FakeJudgeBackend('{"score": 1.0, "reasoning": "ok"}'))
    case = EvalCase(name="c", expected_behavior="x", rubric="y",
                    input={"source": "hello", "target_lang": "es"})
    result = _run(EvalRunner(judge=judge).run_case(case, _echo_factory))
    assert result.judge.passed is True
    assert "source: hello" in result.transcript[0]["text"]
    assert result.transcript[1]["text"].startswith("echo: ")


def test_report_shape():
    judge = LLMJudge(backend=FakeJudgeBackend(
        '{"score": 1.0, "reasoning": "ok"}', '{"score": 0.1, "reasoning": "bad"}'))
    suite = EvalSuite(name="s", cases=(
        EvalCase(name="a", expected_behavior="x", rubric="y", turns=(EvalTurn(user="hi"),)),
        EvalCase(name="b", expected_behavior="x", rubric="y", turns=(EvalTurn(user="hi"),)),
    ))
    runner = EvalRunner(judge=judge)
    results = _run(runner.run(suite, _echo_factory))
    report = json.loads(runner.report(suite, results))
    assert report == {
        "suite": "s", "total": 2, "passed": 1, "failed": 1, "pass_rate": 0.5,
        "cases": report["cases"],
    }
    assert report["cases"][0]["case"] == "a"


# ── Suite loading ────────────────────────────────────────────────────────────

def test_load_shipped_dub_suite():
    suite = load_suite(SUITES_DIR / "dub_translation_naturalness.yaml")
    assert suite.cases, "shipped suite must not be empty"
    for case in suite.cases:
        assert case.input.get("source") and case.input.get("target_lang")
        assert case.expected_behavior and case.rubric


def test_load_suite_rejects_non_mapping(tmp_path):
    bad = tmp_path / "bad.yaml"
    bad.write_text("- just\n- a list\n", encoding="utf-8")
    with pytest.raises(ValueError, match="must be a mapping"):
        load_suite(bad)
