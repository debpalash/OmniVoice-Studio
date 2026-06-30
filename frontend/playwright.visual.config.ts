import { defineConfig, devices } from '@playwright/test';

// Visual-regression config — SEPARATE from playwright.config.ts (e2e).
//
// The e2e suite drives the full app against a Python backend; this one renders
// individual presentational components in isolation via the Vite harness
// (src/test/visual/harness.html), so NO backend is required. It runs its own
// Vite dev server on a dedicated port and snapshots leaf components across
// themes. Local/manual only (`bun run test:visual`) — see
// src/test/visual/README.md for why it is not yet a CI gate.
const PORT = Number(process.env.VISUAL_PORT || 3902);

export default defineConfig({
  testDir: './src/test/visual',
  testMatch: /.*\.visual\.spec\.ts$/,
  timeout: 30_000,
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  // Flat, platform-agnostic baseline filenames (Badge-midnight.png …). These
  // are committed; they are correct for the machine that generated them.
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      // Small tolerance absorbs sub-pixel font anti-aliasing jitter on the
      // same OS without masking real layout/color regressions.
      maxDiffPixelRatio: 0.01,
    },
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    deviceScaleFactor: 1,
    // Default to Playwright's managed chromium; set PLAYWRIGHT_CHROMIUM to
    // pin a specific binary (e.g. the system chromium used by e2e in CI).
    ...(process.env.PLAYWRIGHT_CHROMIUM
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM } }
      : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], deviceScaleFactor: 1 } }],
  webServer: {
    command: 'bun run dev',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { OMNIVOICE_UI_PORT: String(PORT) },
  },
});
