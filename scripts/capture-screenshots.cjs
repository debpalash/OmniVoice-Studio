const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  });
  const page = await ctx.newPage();
  const dir = 'docs';

  await page.goto('http://localhost:3901', { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(2000);

  // Helper: click a sidebar icon by index (0-based, top to bottom)
  async function clickSidebarIcon(index) {
    const icons = page.locator('nav button, nav a, aside button, aside a, [class*="sidebar"] button, [class*="sidebar"] a, [class*="Sidebar"] button');
    const count = await icons.count();
    if (index < count) {
      await icons.nth(index).click();
      await page.waitForTimeout(1500);
    }
  }

  // 1. Gallery / Voice Library — click the icon that looks like a folder/library
  // Try to find gallery-related navigation
  try {
    // Look for gallery/library nav item
    const galleryBtn = page.locator('button:has-text("Gallery"), a:has-text("Gallery"), [data-tab="gallery"], [title*="allery"], [title*="ibrary"]').first();
    if (await galleryBtn.isVisible({ timeout: 1000 })) {
      await galleryBtn.click();
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `${dir}/screenshot-gallery.png`, fullPage: false });
      console.log('✅ screenshot-gallery.png');
    }
  } catch(e) { console.log('Gallery not found via text, trying sidebar icons'); }

  // 2. Settings page
  try {
    const settingsBtn = page.locator('button:has-text("Settings"), a:has-text("Settings"), [data-tab="settings"], [title*="etting"]').first();
    if (await settingsBtn.isVisible({ timeout: 1000 })) {
      await settingsBtn.click();
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `${dir}/screenshot-settings.png`, fullPage: false });
      console.log('✅ screenshot-settings.png');
    }
  } catch(e) { console.log('Settings not found via text'); }

  // 3. Try clicking each sidebar icon to discover hidden views
  // The sidebar icons are the vertical strip on the left
  const sideIcons = page.locator('aside > div > button, aside > button, nav[class*="side"] button, [class*="sidebar"] > button, [class*="Sidebar"] > button');
  const iconCount = await sideIcons.count();
  console.log(`Found ${iconCount} sidebar icons`);

  // Click each icon and screenshot if it reveals a new view
  const captured = new Set();
  for (let i = 0; i < Math.min(iconCount, 10); i++) {
    try {
      await sideIcons.nth(i).click();
      await page.waitForTimeout(1500);
      
      // Get the page title/header to name the screenshot
      const header = await page.locator('h1, h2, [class*="title"], [class*="header"] span').first().textContent().catch(() => '');
      const name = (header || `view-${i}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
      
      if (!captured.has(name)) {
        captured.add(name);
        await page.screenshot({ path: `${dir}/screenshot-${name}.png`, fullPage: false });
        console.log(`✅ screenshot-${name}.png (icon ${i})`);
      }
    } catch(e) {}
  }

  // 4. Also try bottom-bar items (LOGS, Backend, Frontend, Tauri)
  try {
    const logsBtn = page.locator('button:has-text("LOGS"), [class*="log"] button').first();
    if (await logsBtn.isVisible({ timeout: 1000 })) {
      await logsBtn.click();
      await page.waitForTimeout(1500);
      // Expand log panel if collapsed
      await page.screenshot({ path: `${dir}/screenshot-logs.png`, fullPage: false });
      console.log('✅ screenshot-logs.png');
    }
  } catch(e) {}

  // 5. A/B Compare button
  try {
    // First go to launchpad
    await page.goto('http://localhost:3901', { waitUntil: 'networkidle', timeout: 10000 });
    await page.waitForTimeout(1500);
    const abBtn = page.locator('button:has-text("A/B"), button:has-text("Compare")').first();
    if (await abBtn.isVisible({ timeout: 1000 })) {
      await abBtn.click();
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `${dir}/screenshot-ab-compare.png`, fullPage: false });
      console.log('✅ screenshot-ab-compare.png');
    }
  } catch(e) { console.log('A/B Compare not found'); }

  await browser.close();
  console.log('All done!');
})();
