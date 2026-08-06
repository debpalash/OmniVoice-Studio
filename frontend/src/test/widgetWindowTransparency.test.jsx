/**
 * The dictation widget window must not paint the app's opaque chrome.
 *
 * The `widget` window is declared `transparent: true` + `decorations: false`
 * in tauri.conf.json so the pill floats as a rounded capsule over whatever the
 * user is dictating into. But it loads the SAME index.html as the main window,
 * so `body { background-color: var(--chrome-bg) }` applied to it too and
 * painted an opaque, square-cornered rectangle across the whole 300x64 window.
 * With the pill idle (which renders null) the result was a bare dark square
 * sitting on the desktop.
 *
 * The fix is a `data-window="widget"` marker on <html>, set from the window
 * label before the first render, that index.css scopes the opt-out to. This
 * pins the marker (the part logic can regress) and the CSS contract that
 * consumes it — window transparency only shows through if EVERY ancestor box
 * is transparent, so html, body and #root all have to be covered.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../App.jsx', () => ({ default: () => null }));

const setLabel = (label) =>
  vi.doMock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ label }),
  }));

describe('the widget window marks itself on <html>', () => {
  beforeEach(() => {
    vi.resetModules();
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
    delete document.documentElement.dataset.window;
  });

  afterEach(() => {
    document.getElementById('root')?.remove();
    delete document.documentElement.dataset.window;
    vi.doUnmock('@tauri-apps/api/window');
    vi.restoreAllMocks();
  });

  it('sets data-window="widget" when rendering in the widget window', async () => {
    setLabel('widget');
    const { bootstrapApp } = await import('../main-app.jsx');
    await bootstrapApp();
    expect(document.documentElement.dataset.window).toBe('widget');
  });

  it('leaves the main window unmarked, so it keeps the opaque chrome', async () => {
    setLabel('main');
    const { bootstrapApp } = await import('../main-app.jsx');
    await bootstrapApp();
    expect(document.documentElement.dataset.window).toBeUndefined();
  });
});

describe('index.css honours the marker', () => {
  const css = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'index.css'),
    'utf8',
  );

  it('clears the background on html, body AND #root', () => {
    // Any one of the three left opaque defeats the window transparency, so
    // the selector list is the contract — not just "the file mentions it".
    const marker = "html[data-window='widget']";
    const start = css.indexOf(`${marker},`);
    expect(start).toBeGreaterThan(-1);
    const rule = css.slice(start, css.indexOf('}', start));
    for (const sel of [marker, `${marker} body`, `${marker} #root`]) {
      expect(rule).toContain(sel);
    }
    expect(rule).toContain('background: transparent');
  });

  it('does not disturb the main window background', () => {
    expect(css).toContain('background-color: var(--chrome-bg)');
  });
});
