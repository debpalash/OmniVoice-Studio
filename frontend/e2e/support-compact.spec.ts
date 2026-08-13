import { test, expect } from '@playwright/test';
import { gotoMode } from './_helpers';

const MIN_WINDOW = { width: 900, height: 600 };

test.describe('Support page stays on one screen @ 900x600', () => {
  test.use({ viewport: MIN_WINDOW });

  test('support, commercial licence and contact panels do not overflow', async ({ page }) => {
    await gotoMode(page, 'donate');
    await expect(page.getByRole('heading', { name: 'Support VoiceStudio' })).toBeVisible({
      timeout: 20_000,
    });

    for (const tabName of ['Support', 'Commercial License', 'Contact']) {
      const tab = page.getByRole('tab', { name: tabName });
      if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click({ force: true });

      await expect(tab).toHaveAttribute('aria-selected', 'true');
      const panel = page.getByRole('tabpanel');
      await expect(panel).toBeVisible();
      const { clientHeight, scrollHeight } = await panel.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      }));
      expect(
        scrollHeight,
        `${tabName} panel should not need vertical scrolling`,
      ).toBeLessThanOrEqual(clientHeight + 1);
    }
  });
});
