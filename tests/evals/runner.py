"""Eval runner — executes an :class:`EvalSuite` and produces a JSON report.

Adapted from Patter (https://github.com/PatterAI/Patter), MIT License,
Copyright (c) 2026 Patter Contributors. The real-pipeline ``EvalSession``
path (telephony-specific) was not ported; OmniVoice cases either script
``turns`` against an async ``reply(text) -> str`` callable, or carry a
structured ``input`` mapping handed to an async ``run(input) -> str``
callable (the system under test: translator, refiner, ...).

Per-case error containment is preserved verbatim: a mid-case exception keeps
the partial transcript and still judges it; a judge failure records
``score 0 + reasoning`` instead of aborting the whole suite.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from .case import EvalCase, EvalResult, EvalTurn, JudgeResult
from .judge import LLMJudge

logger = logging.getLogger("omnivoice.evals")

# ``turns`` cases: factory returns an async ``reply(text) -> str``.
# ``input`` cases: factory returns an async ``run(input: dict) -> str``.
AgentCallable = Callable[[Any], Awaitable[str]]
AgentFactory = Callable[[], AgentCallable]


@dataclass(frozen=True)
class EvalSuite:
    """A named collection of :class:`EvalCase` to run together."""

    name: str
    cases: tuple[EvalCase, ...]
    metadata: dict[str, Any] = field(default_factory=dict)


class EvalRunner:
    def __init__(self, judge: LLMJudge | None = None) -> None:
        self.judge = judge or LLMJudge()

    async def run(self, suite: EvalSuite, agent_factory: AgentFactory) -> list[EvalResult]:
        return [await self.run_case(case, agent_factory) for case in suite.cases]

    async def run_case(self, case: EvalCase, agent_factory: AgentFactory) -> EvalResult:
        start = time.monotonic()
        transcript: list[dict[str, str]] = []
        error: str | None = None

        try:
            agent = agent_factory()
            if case.input:
                # Structured-input path: render the input for the judge,
                # then hand the mapping to the system under test.
                rendered = "\n".join(f"{k}: {v}" for k, v in case.input.items())
                transcript.append({"role": "user", "text": rendered})
                reply = await agent(dict(case.input))
                transcript.append({"role": "agent", "text": reply or ""})
            else:
                for turn in case.turns:
                    transcript.append({"role": "user", "text": turn.user})
                    reply = await agent(turn.user)
                    transcript.append({"role": "agent", "text": reply or ""})
                    self._log_missing_expected(case, turn, reply or "")
        except Exception as exc:  # noqa: BLE001 — containment is the point
            error = f"{type(exc).__name__}: {exc}"
            logger.exception("case=%r raised", case.name)

        if error and not transcript:
            return EvalResult(
                case_name=case.name,
                transcript=tuple(transcript),
                judge=JudgeResult(score=0.0, passed=False, reasoning=error),
                duration_s=time.monotonic() - start,
                error=error,
            )

        try:
            judge_result = await self.judge.judge_case(case, transcript)
        except Exception as exc:  # noqa: BLE001 — judge 429/timeout/missing key
            # One transient judge failure must not abort the whole suite.
            return EvalResult(
                case_name=case.name,
                transcript=tuple(transcript),
                judge=JudgeResult(score=0.0, passed=False, reasoning=f"judge error: {exc}"),
                duration_s=time.monotonic() - start,
                error=f"judge error: {exc}",
            )
        return EvalResult(
            case_name=case.name,
            transcript=tuple(transcript),
            judge=judge_result,
            duration_s=time.monotonic() - start,
            error=error,
        )

    @staticmethod
    def _log_missing_expected(case: EvalCase, turn: EvalTurn, reply: str) -> None:
        for needle in turn.expected_contains:
            if needle.lower() not in reply.lower():
                logger.info("case=%r expected_contains=%r missing in reply", case.name, needle)

    def report(self, suite: EvalSuite, results: list[EvalResult]) -> str:
        """Render a JSON report suitable for CI artifacts. Never a gate."""
        total = len(results)
        passed = sum(1 for r in results if r.judge.passed)
        payload = {
            "suite": suite.name,
            "total": total,
            "passed": passed,
            "failed": total - passed,
            "pass_rate": (passed / total) if total else 0.0,
            "cases": [r.to_dict() for r in results],
        }
        return json.dumps(payload, indent=2)


def load_suite(path: Path) -> EvalSuite:
    """Load a suite from YAML or JSON.

    Schema (YAML)::

        name: "dub translation naturalness v1"
        cases:
          - name: "idiom is adapted, not translated"
            expected_behavior: "The adapted line replaces the idiom ..."
            rubric: "Pass if ..."
            input:
              source: "It's raining cats and dogs."
              literal: "..."
    """
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() in {".yaml", ".yml"}:
        import yaml

        data = yaml.safe_load(text)
    else:
        data = json.loads(text)

    if not isinstance(data, dict):
        raise ValueError(f"Eval suite {path} must be a mapping, got {type(data).__name__}")
    cases_raw = data.get("cases", [])
    if not isinstance(cases_raw, list):
        raise ValueError(f"Eval suite {path}: 'cases' must be a list")

    cases: list[EvalCase] = []
    for i, c in enumerate(cases_raw):
        if not isinstance(c, dict):
            raise ValueError(f"Eval suite {path}: case {i} must be a mapping")
        turns = tuple(
            EvalTurn(
                user=str(t.get("user", "")),
                expected_contains=tuple(t.get("expected_contains", []) or []),
            )
            for t in c.get("turns", []) or []
            if isinstance(t, dict)
        )
        cases.append(
            EvalCase(
                name=str(c.get("name", f"case_{i}")),
                turns=turns,
                input=dict(c.get("input", {}) or {}),
                expected_behavior=str(c.get("expected_behavior", "")),
                rubric=str(c.get("rubric", "")),
                tags=tuple(c.get("tags", []) or []),
            )
        )

    return EvalSuite(
        name=str(data.get("name", path.stem)),
        cases=tuple(cases),
        metadata=dict(data.get("metadata", {}) or {}),
    )
