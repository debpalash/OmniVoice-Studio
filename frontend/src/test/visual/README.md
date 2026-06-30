# Visual-regression baseline

This is the **safety net for the CSS → Tailwind v4 migration**. Before a CSS
rule is converted to utility classes, these baseline screenshots capture how a
component renders today; after the conversion, `bun run test:visual` proves it
still renders pixel-for-pixel the same. If a conversion changes a pixel that
wasn't supposed to change, the diff fails the run.

## How it works

There is **no Python backend** involved. A tiny Vite-served harness
(`harness.html` → `harness.jsx`) renders ONE presentational leaf component in
isolation, wrapped in a theme, and Playwright snapshots just that element
(`#visual-root`). It runs through the project's real Vite 8 + Tailwind v4 +
token pipeline, so the snapshots reflect the actual build output.

- `harness.html` / `harness.jsx` — the isolated render target. Reads
  `?component=<Name>&theme=<theme>` from the URL, applies the theme via the
  `[data-theme]` selector (default = bare `:root` Gruvbox Dark), and renders
  the component from the registry. Loads the same fonts + token layers as the
  real app (`ui/tokens.css`, `ui/themes.css`, `index.css`).
- `specs.jsx` — the registry: each component → a small spread of its
  variants/states. Keep entries **pure** (no backend hooks, no i18n, no app
  context).
- `manifest.ts` — the list of `COMPONENTS` × `THEMES` the Playwright test
  iterates. Read by `baseline.visual.spec.ts`.
- `__screenshots__/` — committed baseline PNGs (`<Component>-<theme>.png`).
- `../../../playwright.visual.config.ts` — dedicated Playwright config
  (separate from the e2e config). Starts its own Vite dev server on
  `VISUAL_PORT` (default 3902), disables animations, hides the caret.

## Commands

```bash
bun run test:visual          # run snapshots against the committed baselines
bun run test:visual:update   # regenerate baselines (after an INTENTIONAL change)
```

## Adding a component to the suite

1. Add an entry to `SPECS` in `specs.jsx` keyed by the component name, rendering
   a representative spread of its variants/states. Keep it pure.
2. Add that same name to `COMPONENTS` in `manifest.ts` (a name present in the
   manifest but missing from `specs.jsx` renders an error state, which itself
   fails the snapshot — so drift is caught, not silent).
3. Run `bun run test:visual:update` to generate the new baselines, eyeball the
   PNGs, and commit them.

## Updating baselines after an intentional change

When you deliberately change a component's appearance (including a CSS →
Tailwind conversion that is *meant* to look identical but the diff flags
sub-pixel noise):

1. Run `bun run test:visual:update`.
2. **Review the regenerated PNGs in the diff** — confirm only the intended
   pixels moved. This review is the whole point; don't blind-accept.
3. Commit the updated `__screenshots__/*.png` alongside the code change.

## Why this is local/manual, not a CI gate (yet)

Screenshots are sensitive to font rendering and sub-pixel anti-aliasing, which
differ between macOS and the Linux CI runners. Committed baselines are correct
for the machine that generated them; running them unchanged on a different OS
would produce spurious diffs. So this suite is run **locally/manually** during
the migration as a developer safety net.

CI-gating can come later once the baselines are stabilized for the CI platform
— e.g. by generating them inside the same Linux container CI uses (pin
`PLAYWRIGHT_CHROMIUM` / the Playwright image), or by committing per-platform
baselines. Until then, do **not** wire `test:visual` into a blocking workflow.
