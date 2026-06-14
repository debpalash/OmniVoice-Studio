import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * PERMANENT regression guard for the app-shell black-band bug (#21).
 *
 * The shell must scale via `zoom` and ALWAYS occupy the full viewport. The old
 * `width: calc(100vw / var(--ui-scale))` + `transform: scale(var(--ui-scale))`
 * approach left ~⅓ of the window black on WebKitGTK (the default scale is 1.3,
 * and the transform wasn't magnifying the shrunk shell). This test fails CI if
 * either foot-gun pattern is reintroduced, so a future change can't silently
 * bring the black band back.
 */
// vitest runs from the frontend/ package dir. Strip /* … */ comments so the
// guard checks real declarations, not the warning comment that quotes the
// forbidden patterns.
const raw = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');

describe('app shell scale (black-band regression guard)', () => {
  it('does NOT shrink the shell with calc(100vw / --ui-scale)', () => {
    expect(css).not.toMatch(/calc\(\s*100vw\s*\/\s*var\(--ui-scale/);
    expect(css).not.toMatch(/calc\(\s*100vh\s*\/\s*var\(--ui-scale/);
  });

  it('does NOT scale the shell via transform: scale(--ui-scale)', () => {
    expect(css).not.toMatch(/transform:\s*scale\(\s*var\(--ui-scale/);
  });

  it('scales the shell via zoom and fills the viewport (100vw/100vh)', () => {
    // .app-container block must use zoom + full-viewport sizing.
    const block = css.slice(css.indexOf('.app-container {'));
    expect(block).toMatch(/zoom:\s*var\(--ui-scale/);
    expect(block).toMatch(/width:\s*100vw/);
    expect(block).toMatch(/height:\s*100vh/);
  });
});
