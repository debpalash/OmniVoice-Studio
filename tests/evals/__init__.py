"""LLM-judge eval tier (parity program Wave 0.3, Spec 9b).

Semantic evaluation of outputs that deterministic probe judges can't score
(dub translation naturalness, dictation-refinement quality). HARD RULE:
these evals NEVER gate CI — they run as a separate non-blocking scheduled
job (.github/workflows/evals.yml) whose report lands as an artifact.
Deterministic probe judges (tests/probe/judges/) remain the only gates.

Harness adapted from Patter (https://github.com/PatterAI/Patter),
MIT License, Copyright (c) 2026 Patter Contributors. The telephony-specific
session/assertions layers were intentionally not ported; the judge backend
is swapped to OmniVoice's local-first LLM adapter (services.llm_backend).
"""

from .case import EvalCase, EvalResult, EvalTurn, JudgeResult  # noqa: F401
from .judge import LLMJudge  # noqa: F401
from .runner import EvalRunner, EvalSuite, load_suite  # noqa: F401
