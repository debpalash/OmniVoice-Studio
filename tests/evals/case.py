"""Eval case data model.

Adapted from Patter (https://github.com/PatterAI/Patter), MIT License,
Copyright (c) 2026 Patter Contributors.

An :class:`EvalCase` is either a scripted conversation (``turns``) or — the
OmniVoice extension — a structured ``input`` mapping handed verbatim to the
system under test (e.g. a dub segment with source/literal/langs). Both shapes
produce a role-tagged transcript that the judge LLM scores against
``expected_behavior`` + ``rubric``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class EvalTurn:
    """A single user utterance in a scripted conversation."""

    user: str
    # Optional substrings the reply should contain — a cheap pre-filter
    # logged before the judge runs (the judge still decides).
    expected_contains: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class EvalCase:
    """A complete evaluation scenario."""

    name: str
    expected_behavior: str
    rubric: str
    turns: tuple[EvalTurn, ...] = field(default_factory=tuple)
    # OmniVoice extension: structured input for non-conversational systems
    # under test (translator, refiner). When set, ``turns`` is ignored and
    # the agent callable receives this mapping.
    input: dict[str, Any] = field(default_factory=dict)
    tags: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class JudgeResult:
    """The judge's verdict on one case."""

    score: float  # 0.0-1.0
    passed: bool
    reasoning: str


@dataclass(frozen=True)
class EvalResult:
    """The result of running a single :class:`EvalCase`."""

    case_name: str
    transcript: tuple[dict[str, str], ...]  # [{"role": "user"|"agent", "text": ...}]
    judge: JudgeResult
    duration_s: float
    error: str | None = None

    def to_dict(self) -> dict:
        return {
            "case": self.case_name,
            "score": self.judge.score,
            "passed": self.judge.passed,
            "reasoning": self.judge.reasoning,
            "transcript": list(self.transcript),
            "duration_s": round(self.duration_s, 3),
            "error": self.error,
        }
