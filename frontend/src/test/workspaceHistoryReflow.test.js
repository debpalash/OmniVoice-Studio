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
 * future change reintroduces a `@media (max-width)` for this reflow or drops the
 * shell-class reflow / sticky action bar.
 *
 * The WorkspaceHistory reflow rules were consolidated from the former
 * components/WorkspaceHistory.css into styles/residual.css (CSS one-file-floor
 * pass). residual.css legitimately holds unrelated `@media (max-width)` blocks
 * from other folded components, so the max-width guard is scoped to the
 * `.studio-with-history` reflow specifically rather than the whole file.
 */
// Strip /* … */ comments so the guard checks real declarations, not the
// warning comments that quote the forbidden `@media (max-width)` pattern.
const raw = readFileSync(resolve(process.cwd(), 'src/styles/residual.css'), 'utf8');
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');

// Collect every top-level @media block body (brace-balanced) so we can assert
// that the workspace reflow never rides inside a max-width viewport query.
function mediaBlocks(src) {
  const blocks = [];
  const re = /@media[^{]*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1; // index of the opening '{'
    let depth = 0;
    let k = open;
    for (; k < src.length; k++) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    blocks.push({ prelude: m[0], body: src.slice(open + 1, k) });
    re.lastIndex = k + 1;
  }
  return blocks;
}

describe('workspace narrow-shell reflow (#476 CTA-clipping guard)', () => {
  it('does NOT drive the workspace reflow from a raw viewport @media (max-width)', () => {
    const offending = mediaBlocks(css).filter(
      (b) => /max-width/.test(b.prelude) && /\.studio-with-history/.test(b.body),
    );
    expect(offending).toHaveLength(0);
  });

  it('stacks the workspace via the shell-width classes', () => {
    expect(css).toMatch(/\.shell-narrow\s+\.studio-with-history/);
    expect(css).toMatch(/\.shell-mini\s+\.studio-with-history/);
  });

  it('pins the action bar (Synthesize CTA) sticky so it stays on-screen', () => {
    expect(css).toMatch(/\.studio-action-bar\s*\{[^}]*position:\s*sticky/s);
  });
});
