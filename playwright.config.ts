/// <reference types="node" />
import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.PLAYWRIGHT_PORT || 4173)
const BASE_URL = `http://127.0.0.1:${PORT}`
// Allow environments without managed Playwright Chromium to use a local browser.
// Example: PLAYWRIGHT_CHANNEL=chrome npx playwright test
const BROWSER_CHANNEL = process.env.PLAYWRIGHT_CHANNEL as 'chrome' | 'msedge' | undefined
const DEV_SERVER = process.env.PLAYWRIGHT_DEV_SERVER === '1'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  // Finish gracefully before the Actions 25-minute hard kill so reporters flush.
  globalTimeout: process.env.CI ? 23 * 60 * 1000 : undefined,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['list'], ['blob']] : [['list']],
  use: {
    baseURL: BASE_URL,
    locale: 'en-US',
    // CI retries keep a diagnostic trace; passing tests avoid DOM snapshots on
    // every action. Local investigations can use --trace retain-on-failure.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Failure screenshots and retry traces cover routine debugging without
    // encoding video for every passing case. Opt in when investigating motion.
    // System browser channels may not have managed ffmpeg available.
    video: !BROWSER_CHANNEL && process.env.PLAYWRIGHT_VIDEO === '1' ? 'retain-on-failure' : 'off',
  },
  webServer: {
    env: { NODE_ENV: DEV_SERVER ? 'development' : 'production', HERMES_WEB_UI_VITE_CACHE_DIR: `node_modules/.vite/playwright-${PORT}` },
    command: DEV_SERVER ? `npx vite --host 127.0.0.1 --port ${PORT}` : `node scripts/serve-playwright.mjs ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: DEV_SERVER && !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(BROWSER_CHANNEL ? { channel: BROWSER_CHANNEL } : {}),
      },
    },
  ],
})
