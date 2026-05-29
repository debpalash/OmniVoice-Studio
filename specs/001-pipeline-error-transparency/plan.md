# Implementation Plan: Pipeline Error Transparency

**Branch**: `001-pipeline-error-transparency` | **Date**: 2026-05-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-pipeline-error-transparency/spec.md` (plan-04 / #131; children #122, #63)

## Summary

Make every pipeline failure (dub/extract/ingest) self-describing: a non-empty,
specific reason in the UI (error class + actionable hint + docs deeplink when
known), a full traceback with stage/context in the backend log for every
failure path (including failures before the ingest stage), and a copyable,
sanitized diagnostic block. Achieved with one shared failure-event builder on
the backend, hardening of the three known emit/swallow sites, and a richer
frontend error renderer. Additive SSE payload — no data/schema change.

## Technical Context

**Language/Version**: Python 3.11 (backend), TypeScript/React (frontend, Vite + bun)

**Primary Dependencies**: FastAPI + SSE (`backend/core/tasks.py` TaskManager), Zustand store (frontend); existing `errorDocsMap.ts` classifier and `backend/core/logging_filter.py` redactor — both reused, not rebuilt.

**Storage**: N/A — no persisted state changes. SSE payload gains additive fields only.

**Testing**: pytest (`tests/`, `backend/tests/`), node:test (frontend). Regression tests required per Constitution V (fail before, pass after).

**Target Platform**: macOS (AS+Intel), Windows x64, Linux (AppImage + deb) — identical default behavior.

**Project Type**: Web application (FastAPI backend + React/Tauri desktop frontend).

**Performance Goals**: No hot-path impact — code runs only on the failure path.

**Constraints**: Local-first (diagnostic shown to user, never transmitted); no secrets / home paths in logs or diagnostic; backward-compatible additive payload.

**Scale/Scope**: ~3 backend change sites + 1 new helper module + 1 frontend renderer + regression tests. Closes #131, #122, #63.

## Constitution Check

*GATE: passes — this feature is the direct implementation of Principles II and V.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Local-First Sovereignty | ✅ | Diagnostic block is rendered locally for the user to copy; nothing is transmitted. Redaction reuses `logging_filter` + adds `*TOKEN*/*KEY*/*SECRET*` env-value and home-path stripping. No new outbound calls. |
| II. First-Run That Actually Works | ✅ (implements) | Replaces "unknown error" with a real cause + docs deeplink; this principle defines the feature. |
| III. Cross-Platform Default Parity | ✅ | Failure handling is pure Python/JS with no OS branch; behavior identical on all three platforms. WAV-only path (no ffmpeg) covered by test matrix. |
| IV. Backward-Compatible Evolution | ✅ | SSE error payload gains fields (`error_class`, `reason`, `hint`, `stage`, `diagnostic`) but keeps the existing `error`/`detail` keys, so older frontends still work. No DB/schema/engine change. |
| V. Root-Cause Architecture & Regression Tests | ✅ (implements) | plan-04 cluster master; ships regression tests for the 3 Test-matrix triggers (fail before fix, pass after); enforces "visible errors" globally via the shared builder. |

No violations → Complexity Tracking omitted.

## Project Structure

### Documentation (this feature)

```text
specs/001-pipeline-error-transparency/
├── plan.md              # This file
├── spec.md              # Feature spec
├── research.md          # Phase 0 — decisions
├── data-model.md        # Phase 1 — FailureEvent + DiagnosticBlock shapes
├── contracts/
│   └── sse-error-event.md   # SSE "error" event contract (additive)
├── quickstart.md        # How to verify the 3 Test-matrix triggers
└── checklists/
    └── requirements.md  # Spec quality checklist (done)
```

### Source Code (repository root)

```text
backend/
├── core/
│   ├── failure.py          # NEW — build_failure_event() + sanitize() + diagnostic()
│   ├── tasks.py            # CHANGE — worker except (L127-138) uses build_failure_event
│   └── logging_filter.py   # REUSE/EXTEND — redaction helpers
├── services/
│   └── dub_pipeline.py     # CHANGE — enrich download/extract error yields; surface
│                           #          demucs/scene/thumbnail degradations as visible
│                           #          "warning" events instead of silent logger.warning
└── api/routers/
    ├── dub_core.py         # CHANGE — guard upload/ingest-url handlers so pre-task
    │                       #          failures emit a structured reason (not a bare 500)
    └── batch.py            # CHANGE — batch error uses the shared builder

frontend/
├── src/
│   ├── api/dub.ts          # CHANGE — parse structured error fields from SSE
│   ├── store/dubSlice.ts   # CHANGE — store structured failure (reason never empty)
│   ├── utils/errorDocsMap.ts  # REUSE (+extend taxonomy only if a new class is needed)
│   └── components/         # CHANGE — render reason + hint + docs link + "Copy diagnostic"
└── ...

tests/
├── test_dub_error_transparency.py   # NEW — 3 Test-matrix triggers + builder + sanitize
└── backend/test_dub_pipeline_wav.py # EXTEND — WAV-only failure transparency
```

**Structure Decision**: Existing web-app layout (backend/ + frontend/). The only
new file is `backend/core/failure.py` — a single, well-bounded helper so the
"non-empty reason + redaction + diagnostic" logic lives in one place and every
emit site calls it, rather than duplicating fallback logic across tasks.py,
dub_pipeline.py, dub_core.py, and batch.py.

## Approach (the three change points + the helper)

1. **`backend/core/failure.py` (new, the keystone).**
   - `build_failure_event(exc_or_msg, *, stage, context=None) -> dict` returns
     `{"type":"error","stage":stage,"error_class":<ExcType name or "Error">,
       "reason":<non-empty>,"hint":<one-liner or "">,"docs_topic":<key or "">,
       "detail":<sanitized full str>,"diagnostic":<sanitized block>}`.
   - **Non-empty guarantee**: `reason = str(exc).strip() or repr(exc).strip() or
     type(exc).__name__`. This is the core fix for empty/cryptic `str(e)`.
   - `classify(reason) -> (docs_topic, hint)`: small backend mirror of the
     frontend taxonomy keys so the server log + diagnostic name the class too;
     frontend remains the source of truth for the actual docs URL.
   - `sanitize(text)`: applies the existing HF-token regex from
     `logging_filter`, plus env-value redaction for names matching
     `*TOKEN*|*KEY*|*SECRET*`, plus home-dir → `~`.
   - `diagnostic(event)`: composes the failure + a sanitized env summary
     (reuse the bug-reporter capture: OS/CPU/GPU/versions; never audio/secrets).

2. **`backend/core/tasks.py` worker except (L127-138).** Keep
   `logger.exception(...)` (full traceback). Replace the bare
   `{'type':'error','error':str(e)}` push with
   `build_failure_event(e, stage="task", context={"task_id":task_id})`. Keep the
   legacy `error` key populated (= `reason`) for backward compat.

3. **`backend/services/dub_pipeline.py`.** Route the download/extract `except`
   yields through `build_failure_event` (adds `error_class`/`hint`). Convert the
   silent demucs/scene/thumbnail `logger.warning`-only fallbacks (L554/571/585)
   to *also* yield a non-fatal `prep_event("warning", stage=..., reason=...)` so
   the degradation is visible without failing the job. No bare `except: pass`.

4. **`backend/api/routers/dub_core.py` (and `batch.py`).** Wrap the pre-task
   work (file write, URL/preflight, arg build) so a failure there emits the same
   structured reason via SSE / job error instead of an opaque 500 or a truncated
   `str(e)` — this is the #122 "exception before ingest_pipeline" path.

5. **Frontend.** `api/dub.ts` parses the new fields; `dubSlice` stores a
   structured failure (reason guaranteed non-empty, falling back to a generic
   "Something failed — see logs" only if the backend somehow sent nothing). The
   error UI shows reason + hint, the `errorDocsMap.classifyError` deeplink, and a
   "Copy diagnostic" button bound to the `diagnostic` field.

## Phase 0 / Phase 1 artifacts

research.md, data-model.md, contracts/sse-error-event.md, quickstart.md generated
alongside this plan (decisions are settled; few unknowns). See those files.
