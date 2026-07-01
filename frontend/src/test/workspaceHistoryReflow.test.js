import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Regression guard for the design-mode "Synthesize Audio" CTA clipping (#476).
 *
 * The studio workspace stacks vertically on narrow shells. That reflow MUST be
 * driven by the shell-width classes (`.shell-narrow` / `.shell-mini`, set in
 * App.jsx from `app-container.clientWidth`), NOT a raw `@media (max-width)`:
 * the shell scales via `zoom`, so a viewport media query fires at the wrong
 * threshold whenever `--ui-scale ≠ 1` and dropped the action bar below the fold
 * (the same anti-pattern documented in index.css:294). This test fails CI if a
 * future change reintroduces a `@media (max-width)` in this file or drops the
 * shell-class reflow / sticky action bar.
 */
// The former per-component WorkspaceHistory.css was folded into the single
// index.css foundation; slice out its verbatim block (delimited by the
// `folded from …` provenance headers) so this guard still checks only those
// rules and not the rest of index.css (which legitimately uses max-width
// elsewhere). Then strip /* … */ comments so the guard checks real
// declarations, not the warning comment that quotes the forbidden pattern.
const index = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
const block = index.match(
  /\/\* === folded from src\/components\/WorkspaceHistory\.css === \*\/([\s\S]*?)(?=\/\* === folded from |$)/,
);
if (!block) throw new Error('WorkspaceHistory block not found in index.css');
const css = block[1].replace(/\/\*[\s\S]*?\*\//g, '');

describe('workspace narrow-shell reflow (#476 CTA-clipping guard)', () => {
  it('does NOT use a raw viewport @media (max-width) query', () => {
    expect(css).not.toMatch(/@media[^{]*max-width/);
  });

  it('stacks the workspace via the shell-width classes', () => {
    expect(css).toMatch(/\.shell-narrow\s+\.studio-with-history/);
    expect(css).toMatch(/\.shell-mini\s+\.studio-with-history/);
  });

  it('pins the action bar (Synthesize CTA) sticky so it stays on-screen', () => {
    expect(css).toMatch(/\.studio-action-bar\s*\{[^}]*position:\s*sticky/s);
  });
});
