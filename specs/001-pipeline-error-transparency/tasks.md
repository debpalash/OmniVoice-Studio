# Tasks: Pipeline Error Transparency

**Feature**: plan-04 (#131) | **Branch**: `001-pipeline-error-transparency`
**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**TDD**: strict red-green — every test task is written and confirmed FAILING before its implementation task.

## Phase 1: Setup

- [ ] T001 Confirm no new dependencies are required (psutil, torch, platform already pinned); add the new test module path `tests/test_dub_error_transparency.py` to the pytest collection by creating an empty stub so CI discovers it.

## Phase 2: Foundational — shared failure helper (BLOCKS all stories)

- [ ] T002 [P] Write failing unit tests for the failure helper in `tests/test_failure_helper.py`: (a) `build_failure_event` produces a non-empty `reason` when `str(exc)` is empty (e.g. a custom `Exception()` with no message) — falls back to `repr` then type name; (b) event always contains `type`, `reason`, `error_class`, `stage`, and a compat `error` key equal to `reason`; (c) `sanitize()` redacts `hf_…` tokens, values of env vars matching `*TOKEN*|*KEY*|*SECRET*`, and rewrites the home dir to `~`; (d) `diagnostic()` output contains stage + error_class + an env summary and NONE of the redacted material. Run and confirm RED (module does not exist yet).
- [ ] T003 Implement `backend/core/failure.py`: `build_failure_event(exc_or_msg, *, stage, context=None)`, `sanitize(text)` (reuse `_HF_TOKEN_RE` from `backend/core/logging_filter.py`), `classify(reason) -> (docs_topic, hint)` (mirror the 5 `errorDocsMap` keys), and `diagnostic(event)` (reuse the opt-in bug-reporter env capture). Make T002 GREEN.

## Phase 3: User Story 1 — See why a job actually failed (P1) 🎯 MVP

**Goal**: UI shows a specific, non-empty cause (never "unknown error") + actionable hint + docs deeplink.
**Independent test**: induce any pipeline failure → UI shows specific cause, not "unknown error".

- [ ] T004 [P] [US1] Write failing test in `tests/test_dub_error_transparency.py`: extract-fails-on-bad-input → the SSE/event payload emitted by the worker is `type:"error"` with non-empty `reason` + `error_class` + `stage="extract"`. Confirm RED on current `str(e)`-only behavior.
- [ ] T005 [P] [US1] Write failing test (same file): remote/url ingest failure → structured non-empty `reason` + `stage`. Confirm RED.
- [ ] T006 [US1] Harden `backend/core/tasks.py` worker `except` (L127-138): keep `logger.exception`, replace the bare `{'type':'error','error':str(e)}` push with `build_failure_event(e, stage="task", context={"task_id": task_id})` (preserve the `error` key). 
- [ ] T007 [US1] Route the `download`/`extract` `except` yields in `backend/services/dub_pipeline.py` (L418, L461) through `build_failure_event` so they carry `error_class` + `hint` and a non-empty `reason`.
- [ ] T008 [US1] Guard pre-task work in `backend/api/routers/dub_core.py` (upload + ingest-url handlers) and `backend/api/routers/batch.py` (L82) so a failure before the task starts emits a structured reason (the #122 path), not a bare 500 / truncated `str(e)`. Make T004/T005 GREEN.
- [ ] T009 [P] [US1] Frontend: parse the new fields in `frontend/src/api/dub.ts`; store structured failure in `frontend/src/store/dubSlice.ts` (`dubError` = `reason`, never empty; add optional `dubFailure`).
- [ ] T010 [US1] Frontend: render `reason` + `hint` + the `errorDocsMap.classifyError` deeplink in the dub failure UI component (consumer of `dubError`). Extend `errorDocsMap` taxonomy ONLY if a needed class is missing.

## Phase 4: User Story 2 — Full failure detail in the logs (P2)

**Goal**: every failure path logs the real exception with full traceback + stage/context, including failures before the ingest stage and non-fatal degradations.
**Independent test**: force a failure → backend log has a traceback + stage for that job.

- [ ] T011 [P] [US2] Write failing test in `tests/test_dub_error_transparency.py` using `caplog`: each of the 3 triggers logs a full traceback (via `logger.exception`) including the `stage`. Confirm RED where logging is currently silent/absent.
- [ ] T012 [US2] Ensure every emit site calls `logger.exception(...)` (or `logger.error(..., exc_info=True)`) with stage + context before/at the structured event — audit tasks.py, dub_pipeline.py, dub_core.py, batch.py for any `except` that logs nothing or `except: pass`; fix each. Make T011 GREEN.
- [ ] T013 [US2] Convert the silent demucs/scene/thumbnail fallbacks in `backend/services/dub_pipeline.py` (L554/571/585) to ALSO yield a non-fatal `prep_event("warning", stage=…, reason=…)` (job still continues) so degradations are visible. Add a test asserting `type:"warning"` does not set the terminal job error.

## Phase 5: User Story 3 — Copyable diagnostic block (P3)

**Goal**: one-action copyable, sanitized diagnostic for a failed job.
**Independent test**: trigger a failure → copy diagnostic → contains cause+stage+env, no secrets/home paths.

- [ ] T014 [P] [US3] Write failing test (`tests/test_dub_error_transparency.py`): the `diagnostic` field on an error event contains stage + error_class + env summary and NONE of: `hf_…` tokens, `*TOKEN*/*KEY*/*SECRET*` values, absolute home path. Confirm RED.
- [ ] T015 [US3] Populate the `diagnostic` field in `build_failure_event` for fatal errors (via `failure.diagnostic`). Make T014 GREEN.
- [ ] T016 [US3] Frontend: add a "Copy diagnostic" button in the failure UI bound to `dubFailure.diagnostic` (clipboard copy). Add a node:test for the parse→store path producing a non-empty diagnostic.

## Phase 6: Polish & Cross-Cutting

- [ ] T017 [P] Extend `tests/backend/test_dub_pipeline_wav.py` with the WAV-only failure transparency case (no ffmpeg path) — the 3rd Test-matrix trigger. Confirm it asserts SC-001 + SC-002.
- [ ] T018 [P] Update `docs/` troubleshooting: note that failures now show a specific cause + copyable diagnostic (ties error→docs deeplink).
- [ ] T019 Run full suite (`uv run pytest tests/ backend/tests/ -q` + frontend `bun test`) and the `quickstart.md` manual triggers; confirm all green and 0 "unknown error" outputs across the 3 triggers.
- [ ] T020 Self-review against Constitution I/III/IV/V (no outbound calls, identical cross-platform default, no data/schema change, regression tests fail-before/pass-after) before opening the PR.

## Dependencies & order

- **Phase 2 (T002-T003) blocks everything** — the helper is the keystone.
- US1 (P1) is the MVP and can ship alone. US2 builds on US1's emit sites. US3 builds on the helper's `diagnostic()`.
- Within a story: test task(s) first (RED), then implementation (GREEN).

## Parallel opportunities

- T002 (helper tests) ∥ nothing (foundational, first).
- T004, T005 (US1 backend tests) ∥ T009 (frontend parse) once T003 lands.
- T011 (US2 log test) ∥ T014 (US3 diagnostic test) — different assertions, same file (coordinate edits).
- T017, T018 polish ∥ each other.

## MVP scope

**User Story 1 only** (T001-T010): replaces "unknown error" with a specific cause in the UI + logs the real exception at the worker boundary. Delivers the core of #131/#122 on its own.
