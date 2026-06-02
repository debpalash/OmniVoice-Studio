import { test, expect } from '@playwright/test';
import { MODES, collectErrors, gotoMode } from './_helpers';

// Every view must mount without a code-split/import failure or an uncaught
// exception, and without tripping the ErrorBoundary fallback. This is the
// regression guard for "Use design → Importing a module script failed" (a dead
// Vite/module server) and any lazy() page that fails to load.
for (const mode of MODES) {
  test(`view "${mode}" mounts without fatal client errors`, async ({ page }) => {
    const errors = collectErrors(page);
    await gotoMode(page, mode);

    // Give the lazy chunk time to fetch + the Suspense boundary to resolve.
    // (No networkidle wait — views with a live WS/SSE log stream, e.g. Settings,
    // never reach it.)
    await page.waitForTimeout(2000);

    // The ErrorBoundary fallback copy ("This tab hit a snag.") must not show.
    const snag = page.getByText(/this tab hit a snag/i);
    await expect(snag).toHaveCount(0);

    expect(errors.fatal, `fatal errors in "${mode}":\n${errors.fatal.join('\n')}`).toEqual([]);
  });
}
