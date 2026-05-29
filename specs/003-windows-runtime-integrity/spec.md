# Feature Specification: Windows Runtime Integrity

**Feature Branch**: `003-windows-runtime-integrity` | **Created**: 2026-05-29
**Status**: Draft | **Input**: plan-02 (#129); children #116, #65

## User Scenarios & Testing *(mandatory)*

### User Story 1 — torch.compile doesn't crash on Windows+CUDA (Priority: P1)

A Windows user with an NVIDIA GPU runs TTS. Today the app calls
`torch.compile(mode="reduce-overhead")` whenever the device is CUDA — but that
needs **Triton**, which has no Windows build, so it fails and surfaces as a
confusing "OOM" (#65). After this change the app checks Triton is actually
available (and the user's Performance setting) before compiling; if not, it runs
in eager mode and logs why — inference succeeds either way.

**Why this priority**: A masked-OOM crash blocks TTS for every Windows+CUDA
user. It's the highest-impact, most self-contained fix in the cluster.

**Independent Test**: With Triton absent, the compile decision returns "skip"
(eager); with Triton present and the setting off, it returns "compile".

**Acceptance Scenarios**:
1. **Given** device=CUDA and Triton not importable, **When** the model loads,
   **Then** torch.compile is skipped (eager) with an INFO log — no crash.
2. **Given** device=CUDA, Triton present, setting off, **When** loading, **Then**
   torch.compile is applied (unchanged on Linux/CUDA+Triton).
3. **Given** device is cpu/mps, **When** loading, **Then** compile is skipped.
4. **Given** the user set `perf.torch_compile_disabled`, **When** loading on
   CUDA, **Then** compile is skipped regardless of Triton.

### User Story 2 — ASR import failures are caught before shipping (Priority: P2)

A user transcribes and hits `ModuleNotFoundError: No module named
'pkg_resources'` mid-transcription (ctranslate2→whisperx) (#116). The install
smoke test must exercise the full ASR critical path (`torch`, `ctranslate2`,
`whisperx`) so a missing transitive dep fails the build, not the user's run.

**Independent Test**: smoke test imports `torch; ctranslate2; whisperx` and fails
if any is missing.

**Acceptance Scenarios**:
1. **Given** a packaged venv missing `pkg_resources`/`ctranslate2`, **When** the
   install smoke test runs, **Then** it fails with a clear message.

### Edge Cases
- Triton present but broken at import → the existing `try/except` around the
  `torch.compile` call still catches it (eager fallback). The gate is the
  primary guard; the except is the backstop.
- `settings_store` unreadable when checking the setting → proceed (don't block
  compile on a settings read error); logged.

## Requirements *(mandatory)*

- **FR-001**: `torch.compile` MUST only be applied when device==CUDA **and**
  Triton is importable **and** the user has not disabled it.
- **FR-002**: When compile is skipped, the model MUST run in eager mode and the
  reason MUST be logged at INFO.
- **FR-003**: Behaviour on Linux/CUDA with Triton present MUST be unchanged.
- **FR-004**: The install smoke test MUST import the full ASR critical path
  (`torch`, `ctranslate2`, `whisperx`) and fail the build if any is missing.
- **FR-005**: `setuptools` (providing `pkg_resources`) MUST remain an explicit
  runtime dependency (already pinned `>=75.0`).

## Success Criteria *(mandatory)*

- **SC-001**: 0 torch.compile-induced failures on Windows+CUDA (Triton-absent
  path returns "skip", regression-tested).
- **SC-002**: ASR critical-path import is verified at build time on all 3 OSes.
- **SC-003**: No regression on Linux/CUDA+Triton (compile still applied).

## Assumptions

- `setuptools>=75.0` pin (fix-sequence step 1) already shipped (#58) — this spec
  covers steps 2-4 (integrity check via smoke, the Triton gate, install smoke).
- The existing `perf.torch_compile_disabled` setting + `engine_env` are reused;
  the new gate lives alongside it in `engine_env.should_torch_compile()`.
- HF cache traversal (#128/plan-01) and error transparency (#131/plan-04) are
  out of scope (already shipped).
