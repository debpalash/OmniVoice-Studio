# [plan-05] Voice Design Instruct Validator — reconcile preset builder with the whitelist

## Defect
The Voice Design prompt builder (personality presets, and any non-English language path) emits natural-language / free-text instruct items like "Speak as a calm, authoritative documentary narrator with measured pacing", but the server-side validator only accepts a fixed whitelist of tags (male, young adult, moderate pitch, whisper, japanese accent, …). Builder and validator are out of sync, so Synthesize fails with "Unsupported instruct items" or "conflicting instruct items within the same category". Same family as the recently-fixed personality-preset crash (#89).

## Children
- #115 — "Validation failed: Unsupported instruct items found"; presets (Narrator/Storyteller/Corporate) generate free-text prompts; also fires on any non-English language (Windows + macOS Apple Silicon)
- #114 — "Bad request - conflicting instruct items within the same category" on Design → personality settings → Synthesize (Windows, from source)

## Fix sequence
1. Audit the preset/prompt-builder output against the validator whitelist; enumerate which tokens are rejected and why ("conflicting within category" vs "unsupported").
2. Either map preset free-text to valid whitelist tags, or relax the validator to pass through free-text instruct for engines that accept it — pick per engine capability.
3. Fix the "conflicting within same category" logic so selecting one preset doesn't register as multiple mutually-exclusive selections.
4. Ensure language selection doesn't inject an instruct token the validator rejects.

## Test matrix
| Path | Engine | Required behavior |
|---|---|---|
| Each personality preset | OmniVoice/VoxCPM | Synthesize succeeds |
| Non-English language selected | each | no spurious validation failure |
| Manual single tag | each | unchanged |

## Out of scope
General pipeline error transparency (→ plan-04).
