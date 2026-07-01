# Migration — OmniVoice `ui/` Primitives → shadcn/ui (Tailwind v4)

**Status:** Foundation landed · P1 form primitives landed (Input/Select/Textarea/Slider backed by shadcn; Table foundation added) · **Drafted:** 2026-06-30 · **Type:** Incremental component-library adoption, no intended visual change
**Owner stance:** wants a clean, conventional component base (shadcn) without re-skinning the app · **This plan's recommendation:** adopt shadcn *primitives* behind the existing prop APIs, themed by the OmniVoice palette via a token bridge; migrate in waves; never big-bang. See §6.

## Why

OmniVoice's `src/ui/` primitives (`Button.jsx`, `Input.jsx`, `Badge`, `Panel`, `Tabs`, …) are hand-rolled and token-faithful, but each one re-encodes variant logic, focus rings, and disabled states as long arbitrary-property Tailwind strings (see the `[transition:…]`/`[box-shadow:…]` blocks in `ui/Button.jsx`). shadcn/ui is the de-facto React primitive convention: `cva` variant maps, a `cn()` merge helper, Radix behavioural primitives (already a dependency), and a flat `components/ui/*` layout that `npx shadcn add` extends. Adopting it gives us a maintained, well-documented base and lets contributors paste canonical shadcn snippets that "just work."

The risk in adopting shadcn is that it ships its own **grayscale (`neutral`) palette**. Dropping stock shadcn in would repaint the app gray and break theme switching. This foundation solves that with a **token bridge** (§2) so shadcn components inherit the *existing* OmniVoice look — Gruvbox-pink default plus every `[data-theme]` — with zero per-component restyling.

This is **not** a redesign. The contract is the same as the CSS→Tailwind migration (`docs/css-to-tailwind-migration.md`): every step renders coherent with today's palette, and the visual-regression harness (`src/test/visual/`) is the gate that proves it.

## What landed in this foundation PR

- **shadcn init for Tailwind v4 + Vite + React 19.** `frontend/components.json` (style `new-york`, `rsc:false`, `tsx:true`, base color `neutral`, css-vars on), `src/lib/utils.ts` (`cn()` = `clsx` + `tailwind-merge`), and a `@/*` → `src/*` path alias in `vite.config.js` + `tsconfig.json` so `@/lib/utils` and future `npx shadcn add` resolve.
- **The token bridge** in `src/index.css` (§2).
- **Two proof components** — `src/components/ui/button.tsx`, `src/components/ui/input.tsx` (verbatim shadcn new-york, unmodified class strings) — rendered across the default / midnight / catppuccin themes in the visual harness with committed baselines.
- **New deps:** `class-variance-authority`, `clsx`, `tailwind-merge`, `tw-animate-css`, `@radix-ui/react-slot` (root `bun.lock` regenerated; `bun install --frozen-lockfile` confirmed in sync for the Docker build).

No existing component was modified or replaced. The shadcn primitives are **not yet wired into the app** — they exist as the proven base for the waves below.

## 2. The token bridge (P0 — gates everything)

shadcn components reference a fixed semantic vocabulary (`bg-background`, `bg-primary`, `bg-card`, `text-muted-foreground`, `border-input`, `ring-ring`, `bg-destructive`, …). Those utilities only exist if Tailwind's theme defines `--color-background`, `--color-primary`, etc. OmniVoice's `@theme` block instead defines `--color-bg`, `--color-brand`, `--color-danger`, …. The bridge maps the former onto the latter.

It lives in `index.css` as a single `@theme inline` block. `inline` is load-bearing: it makes each generated utility emit `… { background-color: var(--color-bg) }` (a *live* reference) rather than baking in a static value, so runtime `[data-theme]` overrides flow through.

### Mapping table

| shadcn token (Tailwind key) | ← OmniVoice token | Notes |
|---|---|---|
| `--color-background` | `--color-bg` | app chrome bg |
| `--color-foreground` | `--color-fg` | primary text |
| `--color-card` / `--color-popover` | `--color-bg-elev-1` | raised surfaces |
| `--color-card-foreground` / `--color-popover-foreground` | `--color-fg` | text on surfaces |
| `--color-primary` | `--color-brand` | brand pink (theme-dependent) |
| `--color-primary-foreground` | `--color-fg-inverse` | dark text on the brand fill (matches existing primary Button) |
| `--color-secondary` / `--color-muted` | `--color-bg-elev-2` | subtle fills |
| `--color-secondary-foreground` | `--color-fg` | — |
| `--color-muted-foreground` | `--color-fg-muted` | muted/placeholder text |
| `--color-accent` | *(reuses existing `--color-accent`)* | already in base `@theme` (amber) — `bg-accent` works as-is, not re-emitted |
| `--color-accent-foreground` | `--color-fg-inverse` | dark text on the accent fill |
| `--color-destructive` | `--color-danger` | error/destructive red |
| `--color-destructive-foreground` | `--color-fg-inverse` | — |
| `--color-border` | *(reuses existing `--color-border`)* | already in base `@theme` — `border-border` works as-is, not re-emitted |
| `--color-input` | `--color-border` | input outline |
| `--color-ring` | `--color-brand` | focus ring |
| `--radius` | `--radius-lg` (6px) | shadcn base radius; the `--radius-*` scale itself is left untouched, so `rounded-md` keeps OmniVoice's 4px |

**Why theme switching keeps working with no themes.css changes.** Each bridged utility resolves to an OmniVoice `--color-*` token, and `ui/themes.css` already re-declares those tokens per `[data-theme]`. So switching to midnight changes `--color-brand` → purple and every shadcn `bg-primary` follows automatically. Verified in the harness: the same `button.tsx` renders brand-pink (default), purple (midnight), and lavender (catppuccin) with correct themed backgrounds and destructive reds. There is **no** separate shadcn token block to maintain per theme — a documented comment in `themes.css` records this.

**Why the existing tokens are safe.** `accent` and `border` already exist in the base `@theme`; re-emitting them in the bridge would be self-referential (`--color-accent: var(--color-accent)`) — a no-op at best, circular at worst — so they're intentionally omitted and reused as-is. The `--radius-*` scale is not touched, so every existing `rounded-sm/md/lg/xl` consumer is unchanged.

## 3. Where shadcn components live + aliases

| Concern | Decision |
|---|---|
| Location | `src/components/ui/*.tsx` (shadcn convention) — **distinct** from the existing `src/ui/*.jsx` primitives, so the two coexist during migration with no name clash |
| `components` alias | `@/components` |
| `ui` alias | `@/components/ui` |
| `utils` alias | `@/lib/utils` |
| `lib` / `hooks` | `@/lib` / `@/hooks` |
| Path resolution | `@/*` → `src/*` in both `vite.config.js` (`resolve.alias`) and `tsconfig.json` (`paths`) |
| Language | `.tsx` (the repo is mixed JS/JSX; new shadcn files are TS to match shadcn output and get prop typing) |

## 4. Primitive → shadcn mapping + prop-compatibility strategy

The existing `ui/*` primitives have call sites all over the app. The migration must **not** churn those call sites. Strategy: **keep the existing prop API; swap the implementation.** Each `ui/*.jsx` becomes a thin wrapper that maps its current props onto the shadcn component, so consumers (`<Button variant="subtle" size="sm">`, `<Input size="md">`) keep working unchanged.

| Existing `ui/` primitive | shadcn target | Prop bridge (existing → shadcn) |
|---|---|---|
| `Button.jsx` (`primary`/`subtle`/`ghost`/`danger`/`chip`/`preset`/`icon`, `size sm/md`, `loading`, `block`, `leading/trailing`) | `components/ui/button.tsx` | `primary→default`, `subtle→outline`, `ghost→ghost`, `danger→destructive`; `chip`/`preset`/`icon` stay as OmniVoice-only variants added to the `cva` map; `size md→default`; `loading` (spinner + disable), `block` (`w-full`), `leading/trailing` (slot children) wrapped in the JS layer |
| `Input.jsx` `Input` | `components/ui/input.tsx` | `size sm/md/lg` → extend the shadcn `cva` (shadcn ships one size) or map to padding classes; `aria-invalid` already shared |
| `Input.jsx` `Textarea` | `npx shadcn add textarea` | same `size` bridge |
| `Input.jsx` `Select` | **Decided: kept NATIVE** + `ui-select` caret, wearing the shadcn shell (`inputBaseClass`). The Radix `select.tsx` was added to `components/ui/` for *new* call sites, but the primitive stays native because DubSegmentTable/CompareModal/GeneralTab depend on `onChange={(e) => …e.target.value}`, which Radix's value-only `onValueChange` would break |
| `Input.jsx` `Field` | keep as a composition wrapper around `shadcn label` + control |
| `Badge.jsx` | `npx shadcn add badge` | `tone` → `variant` map |
| `Tabs.jsx` | `npx shadcn add tabs` (Radix; already a dep) | `items`/`value`/`onChange` → controlled `Tabs` |
| `Progress.jsx` | `npx shadcn add progress` (Radix; already a dep) | `tone`/`size`/`shimmer` props preserved |
| `Slider.jsx` | `npx shadcn add slider` (Radix; already a dep) | `value`/`onChange`/`label`/`showValue` preserved |
| `Panel.jsx` | `npx shadcn add card` | glass variant keeps its `.css` residue (per the CSS→Tailwind plan) |
| `Segmented.jsx` | `npx shadcn add toggle-group` (Radix; already a dep) | `items`/`value` preserved |

Anything shadcn doesn't cover 1:1 (the `chip`/`preset`/`icon` Button variants, the value-bubble Slider, the glass Panel) is added to the shadcn component's `cva`/markup rather than left behind — the wrapper is where OmniVoice-specific behaviour lives.

## 5. Phasing (staged waves)

Each wave = one or more independently shippable, CI-green PRs. Ordered so blast radius grows only as confidence does.

### P0 — Foundation (this PR)
Init + token bridge + `cn()` + 2 proof components + baselines + this doc. No app component touched. **Done.**

### P1 — Primitives (swap implementation behind existing APIs)
Convert `ui/Button.jsx` and `ui/Input.jsx` into thin wrappers over `components/ui/button.tsx` / `input.tsx`, porting the OmniVoice-only variants into the shadcn `cva`. Add a baseline-PR → conversion-PR pair per primitive (same recipe as the CSS→Tailwind plan §4). Then `Badge`, `Tabs`, `Progress`, `Slider`, `Segmented`, `Panel` one at a time.
- **Success:** the visual harness shows the existing component specs (`Button`, `Input`, …) unchanged within tolerance after each swap; call sites untouched.

**Landed (form/data primitives).** `ui/Input.jsx` (`Input`/`Textarea`/`Select`/`Field`) and `ui/Slider.jsx` now wrap the shadcn components, exports + prop APIs unchanged:
- `input.tsx` exports `inputBaseClass` (the shell, no behaviour change — `ShadcnInput` baseline byte-identical); new `textarea.tsx`, `select.tsx` (+`@radix-ui/react-select`), `slider.tsx`, `table.tsx` added to `components/ui/`.
- `Input`/`Textarea` render the shadcn components; a small `fieldSizeVariants` `cva` (named palette utilities, tailwind-merge-clean) restores the OmniVoice padding-based `sm/md/lg` scale + filled `bg-bg-elev-2` over the shell.
- `Select` stays native (see §4); `Slider` keeps its number-based `onChange` + label/value-bubble chrome around the shadcn `Slider`, tuned via the `data-slot` track/thumb selectors.
- **`Table` deliberately NOT rerouted.** `ui/Table.jsx` is a flex-`<div>` chrome wrapper whose `.ui-table*`/`.segment-table` global classes (Table.css) are a SHARED CONTRACT used directly by ModelsTable / DubSegmentTable / EngineCompatibilityMatrix (virtualised react-window lists needing the div/flex layout, not a semantic `<table>`). The shadcn `table.tsx` is provided for new tabular data only; `Table.jsx` and its global classes are untouched. Its toolbar inherits the shadcn-backed `Input`/`Button` for free.
- **Verified:** only the 3 `Input-*` baselines moved (palette-coherent across default/midnight/catppuccin); `Slider`/`Table` stayed within tolerance. `vitest` 641 green; `oxlint` 0 errors; `oxfmt --check` clean; `vite build` green; `bun install --frozen-lockfile` in sync.

### P2 — Usages (adopt shadcn directly where it's cleaner)
New UI uses `@/components/ui/*` directly. High-traffic surfaces (Settings tabs, dialogs) migrate off the wrappers to native shadcn where the prop bridge adds no value. `npx shadcn add dialog/dropdown-menu/tooltip` to replace the hand-wrapped Radix usages (these need `tw-animate-css`, already imported).

### P3 — Delete CSS + shrink index.css
As primitives move to shadcn, retire `Button.css`/`Input.css` residue and fold any remaining shadcn-shared tokens. Trim `index.css` globals that the shadcn components now own. Pairs naturally with the CSS→Tailwind P4.

## 6. Risk + effort (honest)

- **Biggest risk — variant fidelity.** OmniVoice's Button has 7 variants and bespoke focus/disabled treatments; shadcn ships 6 with different sizing. The wrapper approach contains this (map what maps, port the rest into `cva`), but P1 Button is the hardest single step and should ship behind a baseline diff that a human eyeballs. **Mitigation:** the visual harness already snapshots `Button`/`Input` across 3 themes; a swap that drifts fails the gate.
- **`tw-animate-css` is unused today.** It's imported for the future Dialog/Dropdown waves; Button/Input don't need it. Low risk (additive utilities + keyframes), but it's a dep we carry before we use it. Acceptable for a foundation PR; revisit if P2 slips.
- **knip flags the 3 new files as unused.** Expected — they're proof components only referenced by the visual harness, which knip doesn't treat as a production entry. knip is **not** a CI gate here, so this is informational; it resolves the moment P1 wires the wrappers.
- **`@/*` alias is global.** Additive and standard; existing relative imports are unaffected. Confirmed clean against `typecheck:ci`, the Vite build, and the Docker frozen-lockfile install.
- **Effort:** P1 ~1 day per primitive (baseline + swap + verify); ~1–1.5 weeks for the full primitive set. P2/P3 fold into the CSS→Tailwind timeline.

**Recommendation.** Adopt shadcn as the primitive base via wrappers, theme it through the bridge, and migrate in the wave order above — never replace en masse. The single most important guardrail is the visual baseline: do not swap a primitive's implementation without a before/after snapshot in all three harness themes.

## Constraints honored

- **Keep main green** — every wave is an independently CI-green PR. This foundation passes `vite build`, `typecheck:ci`, `oxlint` (0 errors), `oxfmt --check`, `vitest` (641), the full `test:visual` suite (48), and `bun install --frozen-lockfile`.
- **Docs-sync** — this doc lands in the same PR as the foundation; `CONTRIBUTING.md`'s component-authoring guidance is updated when P1 makes shadcn the default primitive (no doc OmniVoice currently ships describes a *required* primitive source, so no stale doc results from P0).
- **No versioning / Docker / Tauri / Python impact** — frontend-only; runtime deps added with the root `bun.lock` regenerated and the frozen-lockfile Docker path verified; no app-version bump (`package.json` version untouched).
- **Local-first / cross-platform parity** — pure styling + presentational components; no behaviour, no platform divergence, no network.
