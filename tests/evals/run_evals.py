#!/usr/bin/env python3
"""Run the LLM-judge eval suites and write a JSON report artifact.

NEVER a CI gate (parity program Wave 0.3 hard rule): exits 0 whether cases
pass or fail — the report is the deliverable. Exits 0 with a skip notice
when no LLM backend is configured (the scheduled CI runner has none; the
suites are meant for machines with a local Ollama/LM Studio endpoint).

Usage:
    uv run python tests/evals/run_evals.py --output eval-report.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))  # tests/ -> import evals.*
sys.path.insert(0, str(_HERE.parents[1] / "backend"))  # services.*

SUITES_DIR = _HERE / "suites"


def _llm_ready() -> tuple[bool, str]:
    from services.llm_backend import get_active_llm_backend

    backend = get_active_llm_backend()
    # OffBackend reports available=True (it is a valid no-op choice) but its
    # chat() raises — for evals "ready" means a real endpoint is configured.
    if backend.id == "off":
        return False, "active LLM backend is 'off'"
    ok, msg = type(backend).is_available()
    return ok, f"{backend.display_name}: {msg}"


async def _translator_agent(case_input: dict) -> str:
    """System under test for the dub-naturalness suite."""
    from services.translator import cinematic_refine_sync

    result = await asyncio.to_thread(
        cinematic_refine_sync,
        case_input["source"],
        case_input["literal"],
        source_lang=case_input.get("source_lang", "en"),
        target_lang=case_input["target_lang"],
    )
    if result.get("error"):
        raise RuntimeError(f"translator error: {result['error']}")
    return result["text"]


_AGENTS = {
    "dub_translation_naturalness": lambda: _translator_agent,
}


async def _main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", default="all", help="suite stem or 'all'")
    parser.add_argument("--output", type=Path, default=Path("eval-report.json"))
    parser.add_argument("--pass-threshold", type=float, default=0.7)
    args = parser.parse_args()

    ok, detail = _llm_ready()
    if not ok:
        print(f"evals: SKIPPED — no LLM backend configured ({detail}).")
        print("Configure TRANSLATE_BASE_URL (Ollama/LM Studio/OpenAI-compat) to run.")
        args.output.write_text(
            json.dumps({"skipped": True, "reason": detail}, indent=2), encoding="utf-8"
        )
        return 0

    from evals.judge import LLMJudge
    from evals.runner import EvalRunner, load_suite

    stems = (
        sorted(p.stem for p in SUITES_DIR.glob("*.yaml"))
        if args.suite == "all"
        else [args.suite]
    )
    reports = []
    for stem in stems:
        factory = _AGENTS.get(stem)
        if factory is None:
            print(f"evals: no agent registered for suite {stem!r}, skipping.")
            continue
        suite = load_suite(SUITES_DIR / f"{stem}.yaml")
        runner = EvalRunner(judge=LLMJudge(pass_threshold=args.pass_threshold))
        results = await runner.run(suite, factory)
        report = json.loads(runner.report(suite, results))
        reports.append(report)
        print(
            f"evals: {suite.name} — {report['passed']}/{report['total']} passed "
            f"(rate {report['pass_rate']:.2f})"
        )

    args.output.write_text(json.dumps({"suites": reports}, indent=2), encoding="utf-8")
    print(f"evals: report written to {args.output}")
    return 0  # informational by design — failures live in the report


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
