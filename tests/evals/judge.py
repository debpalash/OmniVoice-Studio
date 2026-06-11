"""LLM-as-judge scoring for eval cases.

Adapted from Patter (https://github.com/PatterAI/Patter), MIT License,
Copyright (c) 2026 Patter Contributors. Two hardening details are ported
verbatim by design:

  * the verdict is recomputed LOCALLY (``passed = score >= threshold``) —
    trusting the model's self-reported ``passed`` once let a hallucinated
    ``passed: true`` with ``score: 0.2`` record a pass;
  * JSON parsing is tolerant (code fences stripped; invalid JSON becomes a
    fail-with-reasoning, never a crash).

The OpenAI-specific client is replaced by OmniVoice's local-first LLM
adapter (``services.llm_backend``) — the judge runs against whatever
Ollama/LM Studio/OpenAI-compat endpoint the user configured, keeping the
no-required-cloud guarantee. Any object exposing ``judge(prompt) -> str``
(async) can be injected via ``backend=`` for tests.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

from .case import EvalCase, JudgeResult

logger = logging.getLogger("omnivoice.evals")


_JUDGE_SYSTEM = (
    "You are a strict but fair evaluator of a local voice studio's text "
    "outputs (translations, cleaned-up transcripts). You will be given: "
    "(1) the expected behavior, (2) a rubric, (3) a transcript of inputs "
    "and the system's output. "
    "Return a JSON object with exactly three keys:\n"
    '  - "score": float between 0.0 and 1.0\n'
    '  - "passed": boolean (true when score >= threshold)\n'
    '  - "reasoning": short string explaining the score\n'
    "Do not return any text outside the JSON object."
)


class _LLMBackendJudge:
    """Default judge transport: OmniVoice's active LLM backend."""

    def __init__(self, timeout: float = 120.0) -> None:
        self._timeout = timeout
        self._backend: Any = None

    def _resolve(self):
        if self._backend is None:
            from services.llm_backend import get_active_llm_backend

            self._backend = get_active_llm_backend()
        return self._backend

    async def judge(self, prompt: str) -> str:
        backend = self._resolve()
        # LLMBackend.chat is sync; keep the judge loop responsive.
        return await asyncio.to_thread(
            backend.chat, system=_JUDGE_SYSTEM, user=prompt, timeout=self._timeout
        )


class LLMJudge:
    """Scores case transcripts against a rubric via the configured LLM."""

    def __init__(
        self,
        pass_threshold: float = 0.7,
        backend: Any = None,
    ) -> None:
        self.pass_threshold = pass_threshold
        self._backend = backend or _LLMBackendJudge()

    async def judge_case(
        self, case: EvalCase, transcript: list[dict[str, str]]
    ) -> JudgeResult:
        prompt = self._build_prompt(case, transcript)
        raw = await self._backend.judge(prompt)
        return self._parse(raw)

    def _build_prompt(self, case: EvalCase, transcript: list[dict[str, str]]) -> str:
        lines = [
            f"EXPECTED BEHAVIOR: {case.expected_behavior}",
            f"RUBRIC: {case.rubric}",
            f"PASS THRESHOLD: {self.pass_threshold}",
            "TRANSCRIPT:",
        ]
        for turn in transcript:
            lines.append(f"  {turn.get('role', '?')}: {turn.get('text', '')}")
        return "\n".join(lines)

    def _parse(self, raw: str) -> JudgeResult:
        text = (raw or "").strip()
        if text.startswith("```"):
            text = re.sub(r"^```(?:json)?\s*", "", text)
            text = re.sub(r"\s*```$", "", text)
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            logger.warning("LLMJudge: invalid JSON, defaulting to fail: %r", raw)
            return JudgeResult(
                score=0.0,
                passed=False,
                reasoning=f"Judge returned invalid JSON: {(raw or '')[:200]}",
            )
        try:
            score = float(data.get("score", 0.0))
        except (TypeError, ValueError):
            score = 0.0
        score = max(0.0, min(1.0, score))
        # Verdict computed locally — never trust the model's own `passed`.
        passed = score >= self.pass_threshold
        return JudgeResult(score=score, passed=passed, reasoning=str(data.get("reasoning", "")))
