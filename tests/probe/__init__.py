"""probe — a spec-driven test harness for OmniVoice Studio (and reusable beyond it).

Design spine: **separate the Actor from the Judge.**

  - The *Actor* (an AI agent, an HTTP call, a browser session) drives the app.
    It is allowed to be flexible, self-healing, non-deterministic.
  - The *Judge* renders the verdict. It is deterministic code + objective
    metrics only. **No LLM ever sits on the verdict path** (except an explicitly
    labelled, non-blocking ``advisory`` lane).

This package currently ships the deterministic Judge side first — the part that
is trustworthy — across these layers:

  L1  api_fuzz.py        Schemathesis property fuzzing of the FastAPI app.
  L4  judges/            Media verification (audio correctness, not quality).
  --  spec.py            The hybrid YAML spec engine that wires judges together.

The honest ceiling (read tests/probe/README.md): this harness verifies that
output is *correct and not broken*. It does NOT verify that output is *good*
(natural, well-prosodied, accurate accent). Those stay human-judgment-only;
the naturalness metrics live in the non-blocking ``advisory`` lane.
"""

from .spec import JudgeResult, Spec, load_spec, run_judges, JUDGE_REGISTRY

__all__ = ["JudgeResult", "Spec", "load_spec", "run_judges", "JUDGE_REGISTRY"]
