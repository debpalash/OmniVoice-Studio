# Tasks: Voice Design Instruct Validator (plan-05)

**Branch**: `005-voice-design-validator` | Closes #114, #115. Addresses #132.
**Decision**: Option A (frontend guard). **TDD (vitest).**

## Phase 1: Validator-safe instruct builder (RED→GREEN)
- [x] T001 `frontend/src/utils/voiceInstruct.test.js`: one-per-category, prose
  dropped (#115), category-duplicate dropped (#114), valid free-text accepted,
  casing/full-width-comma, Auto/empty. RED.
- [x] T002 `frontend/src/utils/voiceInstruct.js` `buildDesignInstruct()` —
  TAG_TO_CATEGORY from CATEGORIES; dropdowns win; drop unknown/duplicate. GREEN (6/6).

## Phase 2: Wire it in
- [x] T003 `useTTS.js` design mode uses `buildDesignInstruct`; toasts dropped items.

## Phase 3: Verify
- [x] T004 Full frontend vitest 72 passed; typecheck:ci + build green.

## Out of scope
- Engine validator `_resolve_instruct` untouched (whitelist contract preserved).
- Non-English-language free-text injection: not reproduced (language is a
  separate param); revisit if a repro surfaces.
