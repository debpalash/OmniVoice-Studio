import { test, expect } from '@playwright/test';
import { gotoMode } from './_helpers';

/**
 * Footer-clipping guard — "buttons hidden under the footer on small windows"
 * (owner report 2026-07-02; same class as #476/#504).
 *
 * The LogsFooter is a grid row of .app-container (see index.css), so page
 * content must physically end at the footer's top edge — no card, button, or
 * action bar may render underneath it. Verified at the app's minimum window
 * size (tauri.conf.json minWidth 900 × minHeight 600), where the old fixed
 * overlay + padding reservation clipped the bottom card row.
 */

const MIN_WINDOW = { width: 900, height: 600 };

async function footerTop(page): Promise<number> {
  const footer = page.locator('.app-container .logs-footer');
  await expect(footer).toBeVisible();
  const box = await footer.boundingBox();
  expect(box).not.toBeNull();
  return box!.y;
}

test.describe('LogsFooter never covers page content @ 900x600', () => {
  test.use({ viewport: MIN_WINDOW });

  test('gallery: bottom-most voice card stays above the collapsed footer', async ({ page }) => {
    await gotoMode(page, 'gallery');
    const cards = page.locator('.archetype-card');
    await expect(cards.first()).toBeVisible({ timeout: 20_000 });

    const top = await footerTop(page);
    // Scroll the last card into view — with the footer in the grid flow the
    // scroll container ends at the footer's top, so the card must fit fully
    // above it once scrolled.
    const last = cards.last();
    await last.scrollIntoViewIfNeeded();
    const box = await last.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(top + 1); // 1px AA tolerance
  });

  test('expanded footer still cannot cover content — scroll container shrinks instead', async ({
    page,
  }) => {
    await gotoMode(page, 'gallery');
    const cards = page.locator('.archetype-card');
    await expect(cards.first()).toBeVisible({ timeout: 20_000 });

    // Expand the logs panel (chevron toggle in the collapsed bar).
    const toggle = page.locator('.logs-footer [title], .logs-footer button').first();
    await toggle.click();
    await expect(page.locator('.logs-footer--open')).toBeVisible();

    const top = await footerTop(page);
    const last = cards.last();
    await last.scrollIntoViewIfNeeded();
    const box = await last.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(top + 1);
  });
});
