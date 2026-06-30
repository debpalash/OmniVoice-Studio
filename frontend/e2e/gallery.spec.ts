import { test, expect } from '@playwright/test';
import { collectErrors, gotoMode } from './_helpers';

test.describe('OmniVoice Gallery', () => {
  test('heading is "OmniVoice Gallery"', async ({ page }) => {
    await gotoMode(page, 'gallery');
    await expect(page.getByRole('heading', { name: /OmniVoice Gallery/i })).toBeVisible();
  });

  test('facet dropdowns use the dark theme, not the OS-default light surface', async ({ page }) => {
    await gotoMode(page, 'gallery');
    const select = page.locator('select.facet-select').first();
    await expect(select).toBeVisible();
    // Regression guard for the undefined-var fallback: the fixed style resolves
    // --chrome-hover-bg → rgba(255,255,255,0.04), NOT an opaque UA light surface
    // and NOT transparent (rgba(0,0,0,0), the broken undefined-var state).
    const bg = await select.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgba(255, 255, 255, 0.04)');
  });

  test('opening an archetype in the Designer mounts the design view (no chunk-load failure)', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await gotoMode(page, 'gallery');

    // Cards load from the backend; wait for the first one.
    const designerBtn = page.locator('.archetype-card .designer-btn').first();
    await expect(designerBtn).toBeVisible({ timeout: 20_000 });
    await designerBtn.click();

    // The design view (CloneDesignTab — the lazy chunk that failed when Vite
    // was down) must mount. Its prompt/personality UI is the tell.
    await expect(page.getByText(/personality|prompt|steps/i).first()).toBeVisible({
      timeout: 15_000,
    });

    await expect(page.getByText(/this tab hit a snag/i)).toHaveCount(0);
    expect(errors.fatal, errors.fatal.join('\n')).toEqual([]);
  });
});
