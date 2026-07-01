import type { Page } from '@playwright/test';

/** Every routable view (the `mode` values in App.jsx). */
export const MODES = [
  'launchpad',
  'clone',
  'design',
  'gallery',
  'dub',
  'stories',
  'projects',
  'queue',
  'tools',
  'transcriptions',
  'settings',
  'donate',
] as const;

/**
 * Fatal client errors that mean a view failed to LOAD — code-split chunk /
 * dynamic-import failures (the "Use design → Importing a module script failed"
 * regression) and uncaught exceptions. Deliberately NOT matching network/API
 * noise (5xx, fetch failures) — backend health is covered elsewhere, and a
 * flaky API shouldn't fail a UI-mount test.
 */
const FATAL = [
  /Importing a module script failed/i,
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /ChunkLoadError/i,
];

export type ErrorSink = { fatal: string[]; all: string[] };

/** Attach console/pageerror listeners; returns a sink you assert on later. */
export function collectErrors(page: Page): ErrorSink {
  const sink: ErrorSink = { fatal: [], all: [] };
  const record = (text: string) => {
    sink.all.push(text);
    if (FATAL.some((re) => re.test(text))) sink.fatal.push(text);
  };
  page.on('pageerror', (err) => record(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') record(`console.error: ${msg.text()}`);
  });
  return sink;
}

/**
 * Land directly on a view by seeding the zustand-persist store (key
 * `omnivoice.app`) before the app boots. A shallow merge over slice defaults,
 * so only `mode` is forced.
 */
export async function gotoMode(page: Page, mode: string): Promise<void> {
  await page.addInitScript((m) => {
    localStorage.setItem('omnivoice.app', JSON.stringify({ state: { mode: m }, version: 4 }));
  }, mode);
  await page.goto('/');
}
