import { defineConfig, devices } from '@playwright/test';

// E2E runs against the Vite dev server (UI on :3901, backend on :3900). It
// drives the SYSTEM chromium (no `playwright install` browser download) — set
// PLAYWRIGHT_CHROMIUM to override the path. reuseExistingServer keeps a dev
// session you already have running; CI starts its own `bun run dev`.
const PORT = Number(process.env.E2E_PORT || 3901);

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    trace: 'retain-on-failure',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM || '/usr/bin/chromium',
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'bun run dev',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
