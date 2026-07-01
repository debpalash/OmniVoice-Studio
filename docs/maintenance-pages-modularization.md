# Maintenance Refactor — `frontend/src/pages` Modularization

**Status:** Plan (not yet executed) · **Drafted:** 2026-06-30 · **Type:** Pure mechanical refactor, no behavior change

## Why

`frontend/src/pages/` has grown a few files large enough that any edit reloads the
whole thing into context and risks unrelated breakage. Editing one Settings panel
should touch a ~150-line file, not a 1969-line one. This both improves
maintainability and cuts token cost per edit.

The fix is **not** a new architecture — `components/settings/` already proves the
target pattern (13 extracted `*Panel.jsx`, each with co-located `.css`/`.test.jsx`,
plus a shared `primitives/` folder). This refactor **finishes a migration that
stalled**, then locks it in so files can't silently regrow.

## Current state (measured 2026-06-30)

| File | Lines | Notes |
|------|------:|-------|
| `pages/Settings.jsx` | 1969 | Still inline: `ModelStoreTab` (~790L), `Settings` orchestrator (~600L), `GeneralTab`, `EnginesTab`, `HotkeyTab`, `CredentialsTab`, plus `Row`/`fmtBytes`/`orgColor` helpers |
| `pages/DubTab.jsx` | 1592 | One mega-component + inline `DubFailureNotice`, `DubPipelineStepper`, `PrepOverlay`, `TranscribeOverlay`, `FooterBtn` |
| `pages/CloneDesignTab.jsx` | 837 | |
| `pages/VoiceGallery.jsx` | 768 | |
| `pages/VoiceProfile.jsx` | 515 | |
| `pages/AudiobookTab.jsx` | 402 | within target after Phase 3 sweep |
| everything else | <340 | within target |

Already-extracted, do **not** touch (reference pattern): `components/settings/*Panel.jsx`,
`components/settings/primitives/`.

## The gold standard (proposed)

1. **Size caps:** soft **300 lines**, hard **500 lines** per `.jsx`/`.css`. Over 500 must split.
2. **Pages are thin orchestrators:** a page = layout + routing + state wiring that
   composes feature components. No inline sub-component over ~50 lines.
3. **One component per file**, co-located `Foo.jsx` + `Foo.css` + `Foo.test.jsx`,
   grouped in a per-page feature folder:
   - `components/settings/` (exists)
   - `components/dub/` (new)
   - `components/clone/` (new)
   - `components/gallery/` (new)
4. **Shared bits → `primitives/`** in the feature folder (settings already has this).
5. **Enforce with ESLint `max-lines`** — **warn-only first** so it never breaks CI
   (respects the "keep main green" rule), upgrade to error after the backlog clears.

## Phases (each = one mergeable, CI-green PR)

### Phase 0 — Standard + guardrail
- Add the size/structure rule to `CONTRIBUTING.md` (required by the docs-sync rule anyway).
- Add ESLint `max-lines: ['warn', { max: 500, skipBlankLines: true, skipComments: true }]`.
- No code moves. Smallest possible PR; establishes the contract.

### Phase 1 — `Settings.jsx` (biggest win: 1969 → ~300L)
Extract into `components/settings/`, mirroring existing panel naming:
| Extract | Current lines (approx) | New file |
|---------|------------------------|----------|
| `ModelStoreTab` (+ `Row`, `fmtBytes`, `orgColor`, `MODEL_ROLE_*`) | 229–1021 | `ModelStoreTab.jsx` (likely split further: table vs. matrix vs. row) |
| `GeneralTab` | 80–201 | `GeneralTab.jsx` |
| `EnginesTab` | 1022–1072 | `EnginesTab.jsx` |
| `HotkeyTab` (+ `CREDENTIAL_FIELDS`, `keyEventToAccelerator`) | 1693–1870 | `HotkeyTab.jsx` |
| `CredentialsTab` | 1871–1969 | `CredentialsTab.jsx` |
`Settings.jsx` keeps only: imports, `TAB_DEFS`/`LOG_SOURCE_DEFS`, the `Settings`
default export (tab router + shared state), and `askConfirm`.

### Phase 2 — `DubTab.jsx` (1592 → orchestrator + `components/dub/`)
Extract `DubFailureNotice`, `DubPipelineStepper`, `PrepOverlay`,
`TranscribeOverlay`, `FooterBtn`, and the large render sub-sections into
`components/dub/`. `DubTab.jsx` retains the pipeline state machine + composition.

### Phase 3 — `CloneDesignTab`, `VoiceGallery`, `VoiceProfile`, `AudiobookTab`
Same treatment into `components/clone/` and `components/gallery/`. Smaller, lower risk.

## Constraints honored
- **No behavior change** — pure moves; diff is verifiable by "app renders
  identically + existing tests pass." Each panel that has a test keeps it.
- **Keep main green** — ESLint rule is warn-only; each phase is independently CI-green.
- **Docs-sync** — Phase 0 lands the `CONTRIBUTING.md` change in the same PR as the rule.
- **No versioning impact** — frontend-only refactor; no `package.json` version bump,
  no lockfile/dep change, no Docker/Tauri/Python surface touched.

## Verification per phase
1. `bun run build` (or the project's typecheck/lint) passes.
2. Existing `components/settings/*.test.jsx` (and any new co-located tests) pass.
3. Manual smoke: open Settings → every tab renders; open Dub → pipeline renders.
4. `git diff --stat` shows only moves (line counts shift between files, net ~0 logic change).

## Out of scope (explicitly)
- No redesign of the Settings *UI* itself (the "unorganised" look) — that's a separate
  visual-polish task; this refactor only restructures the *code*. Flag if you want
  that bundled.
- No conversion of `.jsx` → `.tsx` (pages are currently JS; TS migration is a
  different decision).
