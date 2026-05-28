# [plan-04] Pipeline Error Transparency — no more silent "unknown error"

## Defect
Pipeline failures surface in the UI as a generic string ("extract: unknown error") with **nothing written to the backend logs**, and in #122's case the instrumented code path is never even reached — meaning the exception is swallowed before/around the ingest stage. This is the single highest-leverage defect: until errors are visible, every other bug is un-triageable for both the user and the maintainer. Fixing it makes future reports self-describing and shrinks low-information reports like #63.

## Children
- #122 — "extract: unknown error" on dub of any media; backend terminal shows no related lines; debug prints in `ingest_pipeline` never fire; exhaustive repro (Win11, RTX 4080, ffmpeg verified working manually)

## Fix sequence
1. Find where the extract/ingest entrypoint swallows or short-circuits exceptions before reaching `ingest_pipeline`; ensure every failure path logs the real exception with stack + context.
2. Replace the generic UI "unknown error" with the underlying error class + a one-line "what to do" (ties into the error→docs deeplink work).
3. Add a structured failure event so the frontend always receives a non-empty reason.
4. Prevention net: low-info reports (#63-style) should be answerable because the app now emits a copyable diagnostic block.

## Test matrix
| Trigger | Required behavior |
|---|---|
| Extract fails (bad input) | UI shows specific cause; backend logs full traceback |
| YouTube ingest fails | same |
| WAV-only input fails | same (no ffmpeg path involved) |

## Out of scope
The actual root cause of any *specific* extract failure once it's visible may route to plan-01/02/03.
