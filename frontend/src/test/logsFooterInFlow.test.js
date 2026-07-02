// LogsFooter in-flow guard — "buttons hidden under the footer on small
// windows" (owner report, 2026-07-02; same clipping class as #476/#504).
//
// The footer must be a real grid row of .app-container (rows: auto 1fr auto),
// NOT a fixed overlay compensated by padding-bottom on .main-content. A fixed
// overlay + padding reservation lets any nested page scroller that misses the
// padding (or any absolutely-positioned bottom bar) slide underneath the
// footer at small window heights. As a grid row, row-2 content physically
// ends at the footer's top edge — clipping is impossible by construction.
//
// Static CSS-string assertions, same style as appShellScale.test.js (jsdom
// does no layout; the real 900x600 geometry check lives in
// e2e/footer-clipping.spec.ts).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8');

const appContainerBlock = css.match(/\.app-container\s*\{[^}]*\}/s)?.[0] ?? '';
const footerInShellBlock = css.match(/\.app-container \.logs-footer\s*\{[^}]*\}/s)?.[0] ?? '';

describe('LogsFooter is in the shell grid flow (not a fixed overlay)', () => {
  it('shell grid reserves a third row for the footer', () => {
    expect(appContainerBlock).toMatch(/grid-template-rows:\s*auto\s+1fr\s+auto/);
  });

  it('footer inside .app-container is a static grid item in row 3', () => {
    expect(footerInShellBlock).toMatch(/position:\s*static/);
    expect(footerInShellBlock).toMatch(/grid-row:\s*3/);
  });

  it('the padding-bottom footer reservation on .main-content is gone', () => {
    // The old mechanism this fix retires — its return would reintroduce the
    // overlay-clipping class.
    expect(css).not.toMatch(
      /\.app-container\s*>\s*\.main-content[^{]*\{[^}]*padding-bottom:\s*var\(--logs-footer-height/s,
    );
  });

  it('shell-mini gives the footer the full grid width (rail hidden)', () => {
    expect(css).toMatch(
      /\.app-container\.shell-mini \.logs-footer[^{]*\{[^}]*grid-column:\s*1\s*\/\s*-1/s,
    );
  });

  it('base .logs-footer stays fixed for splash/wizard (outside the shell)', () => {
    const base = css.match(/(^|\n)\.logs-footer\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(base).toMatch(/position:\s*fixed/);
  });
});
