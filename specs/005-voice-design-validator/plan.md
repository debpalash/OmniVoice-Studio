# Implementation Plan: Voice Design Instruct Validator (plan-05)

**Branch**: `005-voice-design-validator` | **Date**: 2026-05-29 | **Spec**: [spec.md](./spec.md)
**Decision**: Option **A — frontend guard** (preserve the engine's whitelist contract; no vendored-engine change).

## Summary

The engine validator is whitelist-strict by design. The #114/#115 failures came
from the Voice Design payload merging the free-text instruct field with the
category dropdowns (`useTTS.js`), producing unsupported items (#115) or two
items in one category (#114). Fix: build a validator-safe instruct on the
frontend — one valid tag per category, drop unsupported free-text (with a
warning) — before sending.

## Constitution Check

| Principle | Status |
|-----------|--------|
| I. Local-First | ✅ no network/telemetry |
| II. First-Run Works | ✅ Synthesize stops failing on presets/free-text |
| III. Cross-Platform Parity | ✅ pure JS, identical on all platforms |
| IV. Backward-Compatible | ✅ no engine/model change; whitelist contract preserved |
| V. Root-Cause + Regression Tests | ✅ vitest unit tests for the builder (fail-before/pass-after) |

## Change sites

1. `frontend/src/utils/voiceInstruct.js` (new) — `buildDesignInstruct(vdStates,
   freeText)`: dropdowns win their category; free-text accepted only as a known
   tag in an open category; unknown/duplicate items returned in `dropped`.
   `TAG_TO_CATEGORY` is derived from `CATEGORIES` (single source of truth).
2. `frontend/src/hooks/useTTS.js` — design mode uses `buildDesignInstruct`
   instead of the raw `Object.values(vdStates) + instruct` merge; toasts the
   dropped items so the user knows what was ignored.

## Tests

`frontend/src/utils/voiceInstruct.test.js` (6, vitest): one-per-category from
dropdowns, prose dropped (#115), category-duplicate dropped (#114), valid
free-text accepted, casing/full-width-comma normalisation, Auto/empty. Full
frontend suite 72 passed; typecheck + build green.

## Out of scope / notes

- Did not touch `_resolve_instruct` (vendored engine) — option B/C declined to
  preserve the whitelist contract and avoid silently altering user input.
- Could not reproduce #115's "non-English language injects free-text" claim
  (language is a separate param); the reproducible path — free-text field mixed
  with dropdowns — is fixed. If a non-English repro surfaces, revisit.
- The accent-vs-dialect cross-category rule (a separate validator check) is left
  to the engine's existing clear message; the builder enforces ≤1 per category.
