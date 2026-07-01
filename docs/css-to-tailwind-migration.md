# Migration — Per-Component `.css` → Tailwind v4 Utilities

**Status:** Plan (not yet executed) · **Drafted:** 2026-06-30 · **Type:** Incremental styling migration, no intended visual change
**Owner stance:** leans toward a full migration but values not breaking the UI · **This plan's recommendation:** *bounded* migration (utilities for layout/spacing/typography everywhere; keep CSS for the hard stuff). See §8.

## Why

`frontend/src` carries **74 `.css` files / 16,615 lines** of global, BEM-ish CSS
(`dub-col`, `models-row__role`, `readiness-checklist__title`, …). Tailwind v4 is
**already wired** — `src/index.css` imports `tailwindcss/theme.css` +
`tailwindcss/utilities.css`, has an `@theme` block, and `vite.config.js` runs
`@tailwindcss/vite`. So the runtime cost of utilities is already paid; we are just
not using them. Editing a layout today means hunting a class across a 989-line
file and a JSX `className`. Utilities put the layout where it's read — in the JSX —
and shrink the per-component CSS to only what utilities can't express.

This is **not** a redesign. Every step must render pixel-identical. The honest
blocker is that **there are zero visual-regression tests** — the prior page
refactors (see `docs/maintenance-pages-modularization.md`) verified "no change"
by diffing `className` strings, and *that trick is useless here because the whole
point is that class names change*. Closing that gap is the first real task (§4),
not an afterthought.

## Current state (measured 2026-06-30)

| Metric | Value |
|--------|------:|
| `.css` files | 74 |
| Total CSS lines | 16,615 |
| `var(--…)` token references across CSS | ~3,200 |
| Files using `display:flex` | 64 |
| Files using `display:grid` / `grid-template` | 27 |
| Files using `transition:` | 46 |
| Files using `box-shadow` | 43 |
| Files using `@media` | 25 |
| Files using `linear/radial-gradient` | 22 |
| Files using `@keyframes` (73 blocks total) | 30 |
| Files using `animation:` | 34 |
| Files using `backdrop-filter`/glass blur | 11 |
| Files using `::before`/`::after` | 11 |
| Files using `:has()` | 3 |
| Files using `!important` | 14 |

Biggest files (conversion ROI ranked by layout density, not raw size):
`index.css` 2532 · `FirstRunSetup.css` 1020 · `DubTab.css` 989 ·
`VoiceGallery.css` 541 · `StoriesEditor.css` 525 · `LogsFooter.css` 507 ·
`Settings.css` 469 · `CloneDesignTab.css` 458 · `settings/primitives/primitives.css` 368.

The token system (do **not** redesign it):

- `src/ui/tokens.css` (157 lines, ~82 custom props): the declared "single source of
  truth" — colors, a 4px spacing scale (`--space-0..9`), radius, fonts, type scale,
  weights, shadows, motion, z-index, focus ring, glass blur. Imported via `src/ui/index.js`.
- `src/ui/themes.css` (188 lines): per-theme overrides of the semantic color tokens,
  keyed on `[data-theme="midnight|nord|solarized|…"]` on `<html>`. Default (no attribute)
  = Gruvbox Dark.
- `src/index.css` `@theme { … }`: maps a subset of tokens into Tailwind's theme
  namespace (`--color-*`, `--radius-*`, `--font-*`) so utilities like `bg-bg`,
  `text-fg`, `rounded-lg`, `font-mono` exist. **It hardcodes hex literals that
  duplicate `tokens.css`** — the known drift bug (see §2).

Load order today: `index.css` (`@theme` → `theme` layer, lowest priority) is
imported in `App.jsx`; `tokens.css` + `themes.css` are **unlayered** `:root` /
`[data-theme]` rules imported via `ui/index.js`. Because unlayered CSS outranks
`@layer theme`, **`tokens.css` already wins for the default values and theming
already works** — the `@theme` hex literals are effectively a *losing duplicate*
that exists only so Tailwind knows the utility names. That is precisely why they
drift silently: nothing at runtime reads them, so a stale value never shows up.

## Strategy (the shape of the whole thing)

1. **Incremental, component-by-component — never big-bang.** One component (or one
   small cluster) per PR. Each PR is independently shippable and CI-green. A
   half-migrated component is fine; a half-migrated *codebase* is the steady state
   for months and that's acceptable.
2. **Utilities-first for the mechanical 80%:** flexbox, grid, gap, padding/margin,
   width/height, `text-*`/`font-*`, `rounded-*`, `border`, simple `bg-*`/`text-*`
   color, `hidden`, `truncate`, basic `hover:`/`focus:` color states. These map 1:1
   to utilities and are where the line-count win lives.
3. **Keep `.css` for the hard 20%:** glassmorphism (layered gradients +
   `backdrop-filter`), `::before`/`::after`, `@keyframes`, `:has()` and other complex
   combinators, `[data-theme]`-specific rules, and anything with `!important`
   fighting specificity. Utilities don't express these cleanly and forcing them
   (arbitrary-value soup, `[&::before]:…`) trades readable CSS for unreadable JSX.
4. **One source of truth via the token bridge (§2):** utilities reference the same
   CSS vars the remaining `.css` reads, so a value lives in exactly one place and
   `data-theme` switching keeps working for both.
5. **No file is "done" until it's deleted or demonstrably minimal.** Success is
   measured in CSS LOC removed and `.css` files deleted, not files "touched."

## 2. Token-bridge prerequisite (P0 — gates everything)

The migration is only safe if a utility and the leftover CSS in the same component
resolve a token to the *same* value, including after a theme switch. Today the
`@theme` literals duplicate `tokens.css`; once components start mixing `bg-bg`
(utility) with `background: var(--color-bg)` (CSS), any drift becomes a visible,
theme-dependent bug. Fix the source-of-truth **before** converting anything.

**Recommended fix — Solution A (lowest churn, no rename):** Make `@theme` the
single declared home for the **already-overlapping** groups only — colors, radius,
fonts — and **delete those default declarations from `tokens.css`** (leave a
one-line pointer comment). Everything else in `tokens.css` (spacing, type scale,
weights, shadows, motion, z-index, focus ring, glass blur) stays put.

Why this is correct and safe:

- Tailwind needs the keys present in `@theme` to generate the utility names
  (`--color-fg` → `text-fg`/`bg-fg`; `--radius-lg` → `rounded-lg`; `--font-mono` →
  `font-mono`). Keeping the keys there is non-negotiable.
- `@theme` emits `:root { --color-fg: … }` into the low-priority `theme` layer.
  `themes.css` `[data-theme]` rules are unlayered and still outrank it, so
  **theme switching is unchanged** — verify with a quick manual cycle through all
  themes after the edit.
- Removing the duplicate `:root` color/radius/font lines from `tokens.css` leaves
  exactly one literal per value. All ~3,200 existing `var(--…)` references keep
  resolving (the var still exists on `:root`, now sourced from `@theme`).

**Guard against recurrence (required, per the "fix the class" rule):** add
`frontend/src/__tests__/theme-token-parity.test.js` (vitest, no browser) that
parses `index.css` `@theme` + `tokens.css` + `themes.css` and asserts:
(a) no token key is declared with a literal in **both** `@theme` and `tokens.css`
(catches re-introduced duplication), and (b) every `@theme` color key is overridden
by every `[data-theme]` block in `themes.css` (catches a theme that forgot a color).
This test is the thing that makes the de-dup *stay* de-duped.

**Rejected alternative — Solution B (purist):** rename source tokens to a private
namespace (`--ov-color-fg`) and bridge with `@theme inline { --color-fg:
var(--ov-color-fg) }`. This honors "`tokens.css` is the source" literally and is
the textbook Tailwind pattern, **but** it forces renaming all ~3,200 `var(--color-*)`
references across 74 files in one shot — a massive, high-risk diff that violates
"low-risk, incremental." Not worth it. (`@theme inline` referencing the *same* name
is circular and is not an option.)

**Optionally, later:** add `--spacing` to `@theme` so `p-*`/`gap-*`/`m-*` map onto
the existing 4px scale (`--space-1 = 2px` … `--space-9 = 44px`). Tailwind's default
spacing is a 0.25rem multiplier; OmniVoice's scale is custom, so without this,
`gap-3` ≠ `var(--space-3)`. Two choices, decide in P0:
  - **Map to the scale:** set `--spacing: 2px` won't reproduce the non-linear steps;
    instead define explicit `--spacing-1..9` in `@theme` mirroring `--space-1..9`,
    and use `gap-2`/`p-5` etc. Cleanest for readers, but utility numbers won't match
    Tailwind defaults — document it.
  - **Use arbitrary values bridged to the var:** `gap-[var(--space-3)]`,
    `p-[var(--space-5)]`. Zero ambiguity, slightly noisier JSX, guarantees identical
    pixels. **Recommended for P1–P2** (safest for "no visual change"); revisit named
    spacing once confidence is high.

## 3. What converts cleanly vs. what stays CSS

**Converts cleanly → utilities** (concrete, from real files):

- `ReadinessChecklist.css` `.readiness-checklist { display:flex; flex-direction:column;
  gap:var(--space-3); padding:var(--space-5); border:1px solid var(--color-border);
  border-radius:var(--radius-lg); font-size:var(--text-sm); }`
  → `className="flex flex-col gap-[var(--space-3)] p-[var(--space-5)] border
  border-border rounded-lg text-sm"` (or mapped `text-sm` if the type scale is
  bridged). The `backdrop-filter` line on the same selector **stays in CSS** (see below).
- `.readiness-checklist__title { font-weight:var(--weight-semibold);
  color:var(--color-fg); display:flex; align-items:center; gap:var(--space-3); }`
  → `font-semibold text-fg flex items-center gap-[var(--space-3)]`.
- Generic layout rows/cols (`dub-col`, `models-row`) — flex/grid/gap/padding → utilities.

**Stays in `.css`** (criteria + real examples):

- **Glassmorphism / layered backgrounds.** `Panel.css` `.ui-panel--glass` stacks two
  `radial-gradient`s + a `linear-gradient` + `backdrop-filter: var(--glass-blur-md)`.
  Leave entirely in CSS. (11 files use glass blur.)
- **Pseudo-elements.** `Panel.css` `.ui-panel--glass::before` (top hairline gradient);
  `DubTab.css` `.dub-stepper__step::before` (connector line). 11 files. Stay.
- **Keyframes + animations.** 73 `@keyframes` blocks across 30 files
  (`@keyframes mesh/spin/pulse/shimmer` in `index.css`; `dub-pulse`,
  `dub-stepper-spin`, `dub-skel-shimmer` in `DubTab.css`). Keep the `@keyframes` and
  the `animation:` shorthand in CSS; a `className="animate-…"` only helps if you
  register the animation in `@theme`, which isn't worth it for one-off effects.
- **`:has()` and complex combinators** (3 files), **`[data-theme]`-specific rules**
  (all of `themes.css` + scattered overrides), **`!important` blocks** (14 files,
  e.g. `DubTab.css` `.dub-footer-panel::before { display:none !important; }`).
- **Media queries** (25 files): convertible to `sm:`/`md:`/`lg:` **only** if the
  breakpoints match Tailwind's; OmniVoice's are custom, so leave responsive blocks in
  CSS unless a component's breakpoints are first added to `@theme`. Low priority.

Rule of thumb for a reviewer: *if a declaration reads a single token and sets one
box/text/flex property, it's a utility; if it composes multiple values, targets a
pseudo-element/state combinator, or animates, it stays.*

## 4. Risk mitigation — the no-visual-test gap (the gating risk)

This is the make-or-break item. Be honest: **without a visual baseline, "no change"
is unverifiable**, and `className`-diffing (what the page refactors relied on) cannot
work when class names are the thing changing. Two layers, do both:

**(a) Establish a screenshot baseline before touching components (part of P0).**
Add Playwright component/page screenshots for the surfaces being migrated. The repo
already references Playwright tooling in its docs stack; wire a minimal
`tests/visual/` that boots the Vite app (or Storybook-less direct route renders) and
captures per-component PNGs at a fixed viewport for **the default theme + one dark +
one light theme** (catches token-bridge regressions specifically). Commit baselines.
Each migration PR runs `playwright test --update-snapshots=none` and **fails on any
pixel diff above a tiny threshold**. This converts "did it change?" from a human
guess into a CI gate. Capture baselines *first*, on `main`, so they reflect
pre-migration truth.

- Scope realistically: snapshotting all 74 surfaces up front is its own project.
  Snapshot **per phase, just-in-time** — before P1 leaf work, baseline the leaf
  components; before P3, baseline the big pages. Baselines for a component land in
  the same PR that prepares to migrate it (separate from the conversion PR so the
  baseline diff is reviewable on its own).

**(b) A per-component manual checklist** (belt-and-suspenders, and the fallback for
surfaces that are hard to screenshot deterministically — anything with animation,
canvas/waveform, or live backend data):
  1. Default theme: side-by-side before/after at the same viewport.
  2. Cycle every `[data-theme]` — confirm colors still swap (token-bridge check).
  3. Hover/focus/active/disabled states on interactive elements.
  4. The component's `@keyframes`/animation still runs.
  5. `prefers-reduced-motion` path unaffected (e.g. `#root` launch animation).
  6. No console warnings; `bun run build` + `bun run lint` clean.

If neither (a) nor (b) is in place for a surface, **do not migrate it** — defer it to
the "leave as CSS" bucket rather than fly blind.

## 5. Phasing

Each phase = one or more independently shippable, CI-green PRs. Ordered
leaf-inward so blast radius grows only as confidence does.

### P0 — Token bridge + tooling + visual baseline (no component conversions)
- De-dup `@theme` ↔ `tokens.css` (§2 Solution A) + the parity test.
- Decide + document the spacing approach (arbitrary-value bridge recommended).
- Add `prettier-plugin-tailwindcss` (or confirm oxlint/oxfmt class-sort) and wire
  class sorting (§6).
- Update `CONTRIBUTING.md` (§6 — currently says *"Vanilla CSS … no Tailwind"*, which
  now contradicts reality and **must** change in this same PR per the docs-sync rule).
- Stand up `tests/visual/` Playwright harness (no per-component baselines yet — just
  the runner + theme matrix).
- **Effort:** ~1–2 days. **Success:** parity test green; theme switch verified across
  all themes; CI gains a class-sort check; zero pixels changed (this PR ships no
  component edits).

### P1 — Leaf / presentational components (lowest risk)
Targets: small `ui/` primitives and stateless components where CSS is mostly
flex/grid/spacing/type — e.g. `Badge`, `UpdateStatusChip`, `NetworkToggle`,
`ReadinessChecklist`, `ReadinessChecklist`, `DemoPresetGrid`, `KeyboardCheatsheet`,
`MultiLangPicker`. Skip glass-heavy ones for now.
- Per component: baseline screenshot PR → conversion PR. Convert layout/spacing/type
  to utilities; keep any glass/`::before`/animation lines in a now-tiny `.css`; delete
  the `.css` entirely if nothing remains and remove its import.
- **Effort:** ~3–5 days across ~10–15 components. **Success:** ~10 `.css` files deleted
  or reduced >70%; visual diffs clean; a repeatable per-component recipe proven.

### P2 — Panels & mid-size components
Targets: `settings/*Panel.css`, `Sidebar`, `NotificationPanel`, `CastingView`,
`ExportModal`, `EngineCompatibilityMatrix`, `donate/Postcard`, etc. More state,
some glass — convert the layout skeleton, leave glass/pseudo/animation.
- **Effort:** ~1–1.5 weeks. **Success:** settings panels are thin utility JSX + a
  shared `primitives.css` for the glass/control look; CSS LOC down materially.

### P3 — Big pages
Targets in ROI order: `DubTab` (989), `VoiceGallery` (541), `StoriesEditor` (525),
`LogsFooter` (507), `Settings` (469), `CloneDesignTab` (458), `FirstRunSetup` (1020).
These pair naturally with the already-planned page modularization
(`docs/maintenance-pages-modularization.md`) — **sequence the modularization first**,
then migrate the smaller extracted components (P3 becomes "P1 again" on the pieces).
Convert layout/spacing; the pipeline steppers, overlays, gradients, and keyframes
stay as CSS.
- **Effort:** ~2–3 weeks. **Success:** each page's `.css` drops to the
  glass/animation/pseudo residue; biggest single LOC reductions land here.

### P4 — Retire `index.css` globals last
`index.css` (2532 lines) is foundation: `@theme`, `@keyframes`, `::selection`, root
rendering, base resets, and shared global classes. Convert only the **global utility
classes** that components reuse into real utilities or component-scoped CSS; **keep**
the `@theme`, keyframes, resets, and `::selection`. Do this last because everything
depends on it.
- **Effort:** ~1 week. **Success:** `index.css` shrinks to foundation only; no
  orphaned global classes.

## 6. Tooling

- **Class sorting / formatting.** The repo lints with **oxlint** (`bun run lint`,
  gate) and an advisory ESLint for hooks. For Tailwind class ordering, add
  **`prettier-plugin-tailwindcss`** (canonical, understands `@theme`) wired to run on
  `*.jsx`, *or* adopt oxfmt's Tailwind class-sorting if the team prefers a single
  formatter. Either way the goal is deterministic class order so diffs stay readable
  and merge-clean.
- **Regression prevention.** Add an oxlint/convention guard so new components don't
  reintroduce sprawling CSS: a soft rule (warn-only first, per "keep main green") that
  flags new `.css` files over a small line budget for components that should be
  utility-first, and the §2 parity test as a hard gate on token drift.
- **CONTRIBUTING update (required).** `CONTRIBUTING.md` currently states *"CSS:
  Vanilla CSS in component-level files — no Tailwind."* That is now false. Replace it
  with the utilities-first standard: *layout/spacing/typography/simple color via
  Tailwind utilities; component `.css` only for glass, pseudo-elements, keyframes,
  `:has()`, `[data-theme]` rules, and `!important` overrides; tokens live in
  `tokens.css`/`@theme`, never hardcoded.* Per the docs-sync hard rule this lands in
  the **same PR** as P0.
- **No new build infra** — `@tailwindcss/vite` already does everything; no PostCSS
  config, no Tailwind config file (v4 is CSS-first via `@theme`).

## 7. Non-goals / when to stop

- **No 100% conversion target.** ~20% of the CSS (the 11 glass files, 30 keyframe
  files, 11 pseudo-element files, 3 `:has()` files, 14 `!important` files, custom-
  breakpoint media queries) is **genuinely better as CSS** and should stay. Forcing it
  into arbitrary-value utilities makes JSX unreadable for zero benefit.
- **No token-system redesign.** `tokens.css`/`themes.css` and the `data-theme` model
  stay as-is (only the §2 de-dup).
- **No visual redesign.** Pixel-identical is the contract; restyling is a separate task.
- **No `.jsx` → `.tsx`**, no engine/backend/Tauri/Python surface, no version bump,
  no dependency change beyond the dev-only formatter plugin + Playwright (frontend-only).
- **Stop conditions for an individual file:** if after pulling out layout/spacing the
  remaining CSS is all glass/animation/pseudo, it's *done* — don't chase the last 10%.
- **Hands off** `BootstrapSplash.css`, `WaveformPlayer.css`/`SegmentTrack.css`
  (canvas-adjacent), and other animation/`::before`-dominated files unless a clear
  layout win exists.

## 8. Effort + recommendation

**Total rough effort:** ~5–7 focused weeks for P0–P4 at the *bounded* scope below,
spread across many small PRs (it parallelizes and pauses cleanly — it never has to be
one big push).

**Recommendation — bounded migration, not 100%.** The owner leans full-migration and
prizes not breaking things; those two goals partly conflict, and the honest call is:

- **Do** convert layout/spacing/typography/simple color **everywhere** — that's the
  real maintainability win, it's where ~80% of the 16.6k lines live, and it's the
  low-risk part.
- **Keep ~15–25% as CSS** (glass, keyframes, pseudo-elements, `:has()`,
  `[data-theme]`, `!important`, custom-breakpoint media). Converting these buys
  unreadable JSX and *raises* visual-regression risk on exactly the components where
  diffs are hardest to verify.
- **Gate on the visual baseline (§4).** This is the single most important decision: if
  the Playwright screenshot harness doesn't ship in P0, do **not** start P1 — without
  it the "won't break the UI" requirement is unmet by construction. The token-bridge
  de-dup (§2) is the other hard prerequisite; both are cheap and both are P0.

A realistic end state: ~60 `.css` files deleted or reduced >70%, perhaps ~10–12k of
the 16.6k CSS lines removed, the rest a deliberate, documented residue of effects
utilities can't express. That delivers nearly all the maintainability benefit of a
"full" migration at a fraction of the regression risk.

## Constraints honored

- **Keep main green** — every phase is an independently CI-green PR; lint/format and
  parity-test guards are warn-first where they'd otherwise churn.
- **Docs-sync** — the `CONTRIBUTING.md` rewrite lands in the same PR as P0.
- **No versioning/Docker/Tauri/Python impact** — frontend-only; dev-dependency-only
  tooling additions; no `package.json` *version* bump (a devDependency add still
  requires regenerating root `bun.lock` and confirming `bun install --frozen-lockfile`
  per the Docker-green rule).
- **Local-first / cross-platform parity** — pure styling; no behavior, no platform
  divergence.
