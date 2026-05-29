# Feature Specification: Voice Design Instruct Validator

**Feature Branch**: `005-voice-design-validator` | **Created**: 2026-05-29
**Status**: Investigation — fix approach pending decision | **Input**: plan-05 (#132); children #114, #115

## Investigation findings

- The server validator `omnivoice/models/omnivoice.py::_resolve_instruct` is
  **whitelist-strict by design**: it splits the instruct on commas, validates
  each item against `_INSTRUCT_ALL_VALID` (from `omnivoice/utils/voice_design.py`),
  unifies EN/ZH, enforces one-item-per-category, and returns a canonical tag
  string the engine consumes. Free-text prose cannot be "passed through" — the
  engine uses the resolved tags, not arbitrary text.
- The presets DO emit valid tags: `backend/core/personalities.py` (post-#89) and
  `frontend/src/utils/constants.js` `PRESETS[].attrs` are all valid category
  values.
- **Root cause of #114/#115 is the assembly, not the presets.** In
  `frontend/src/hooks/useTTS.js` (~L105-110) the design payload is built as:
  `parts = Object.values(vdStates).filter(v => v !== 'Auto'); if (instruct.trim())
  parts.push(instruct.trim()); finalInstruct = parts.join(', ')`. So:
  - typing prose in the free-text **instruct** field → "Unsupported instruct
    items" (#115);
  - typing/selecting a tag whose category a dropdown already set → two items in
    one category → "conflicting instruct items within the same category" (#114).
- Could not fully reproduce the "presets generate free-text on non-English" claim
  in #115: language is sent as a **separate** param, not injected into instruct.
  The reproducible failure is the free-text-field-mixed-with-dropdowns path.

## Decision required (product call, possibly vendored-engine-touching)

| Option | What | Risk |
|--------|------|------|
| **A. Frontend guard** | In `useTTS.js`, don't merge the free-text instruct field with the category dropdowns when in design mode; or pre-validate/convert it; ensure one-per-category before sending. No engine change. | Low — UI-only; preserves the engine's whitelist contract. |
| **B. Tolerant validator** | In `_resolve_instruct`, dedupe a category to the last item (instead of hard-failing) and drop unknown items with a warning. | Med — silently alters user input; touches vendored engine; backward-compat review needed. |
| **C. Per-engine free-text** | Capability flag; engines that accept natural-language instruct skip the whitelist. | High — needs an engine capability matrix + per-engine handling; biggest change. |

## Out of scope
General pipeline error transparency (→ plan-04, shipped).
