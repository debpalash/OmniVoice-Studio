# Implementation Plan: Windows Runtime Integrity (plan-02)

**Branch**: `003-windows-runtime-integrity` | **Date**: 2026-05-29 | **Spec**: [spec.md](./spec.md)

## Summary

Stop the two Windows inference-time failures: the `torch.compile`/Triton "fake
OOM" (#65) and the `pkg_resources`/ctranslate2 mid-transcription crash (#116).
`setuptools>=75.0` is already pinned (step 1, shipped via #58). This PR adds the
Triton gate (step 3) and the ASR critical-path install smoke (step 2/4).

## Constitution Check

| Principle | Status |
|-----------|--------|
| I. Local-First | ✅ no network/telemetry |
| II. First-Run Works | ✅ (implements) — removes a Windows inference crash |
| III. Cross-Platform Parity | ✅ gate is `find_spec("triton")`-driven; Linux/CUDA+Triton unchanged, Windows falls back to eager (same *result*: working inference) |
| IV. Backward-Compatible | ✅ no schema/data change; reuses existing setting |
| V. Root-Cause + Regression Tests | ✅ cluster master; fail-before/pass-after tests for the gate |

## Change sites

1. `backend/services/engine_env.py` — new `should_torch_compile(device)`:
   requires `device=="cuda"` + `importlib.util.find_spec("triton")` + the
   `perf.torch_compile_disabled` setting being off; logs the skip reason.
2. `backend/services/model_manager.py` (~L298) — replace the bare
   `if device == "cuda":` guard around `torch.compile(...)` with
   `if should_torch_compile(device):`.
3. `scripts/smoke-test.sh` — add **INST-02**: import `torch; ctranslate2;
   whisperx` (the full ASR path) so a missing dep fails the build (the
   `smoke-matrix` CI job already runs this on Windows/macOS/Linux).

## Tests

`tests/test_torch_compile_gate.py` (4): skip on non-CUDA, skip when Triton
missing, compile when Triton present + not disabled, skip when disabled. Plus
the INST-02 smoke import (CI matrix).

## Out of scope / follow-up

A post-bootstrap *in-app* integrity check with a user-facing "setup incomplete"
banner (richer than the smoke gate) — deferred; the smoke gate + the existing
ASR `is_available()` message cover the build-time and runtime surfaces for now.
