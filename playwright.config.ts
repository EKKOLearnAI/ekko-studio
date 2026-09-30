/// <reference types="node" />
import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.PLAYWRIGHT_PORT || 4173)
const BASE_URL = `http://127.0.0.1:${PORT}`
// Allow environments without managed Playwright Chromium to use a local browser.
// Example: PLAYWRIGHT_CHANNEL=chrome npx playwright test
const BROWSER_CHANNEL = process.env.PLAYWRIGHT_CHANNEL as 'chrome' | 'msedge' | undefined

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['dot'], ['blob']] : [['list']],
  use: {
    baseURL: BASE_URL,
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Managed ffmpeg is not always available when using a system browser channel.
    video: BROWSER_CHANNEL ? 'off' : 'retain-on-failure',
  },
  webServer: {
    env: { NODE_ENV: 'development', HERMES_WEB_UI_VITE_CACHE_DIR: `node_modules/.vite/playwright-${PORT}` },
    command: `npx vite --host 127.0.0.1 --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
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
