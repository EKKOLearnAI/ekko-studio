/// <reference types="node" />
import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.PLAYWRIGHT_PORT || 4173)
const BASE_URL = `http://127.0.0.1:${PORT}`
// Allow environments without managed Playwright Chromium to use a local browser.
// Example: PLAYWRIGHT_CHANNEL=chrome npx playwright test
const BROWSER_CHANNEL = process.env.PLAYWRIGHT_CHANNEL as 'chrome' | 'msedge' | undefined
const coreSuite = process.env.EKKO_E2E_SUITE === 'core'
// The core suite keeps theme editing, ZIP round trips, animated uploads and
// message surfaces. Repeated color/opacity combinations run for theme changes
// and in the nightly/full suite. New specs stay in core unless listed here.
const extendedThemeSpecs = [
  'theme-borders', 'theme-downloads', 'theme-logs-loading', 'theme-native-tables',
  'theme-overlays', 'theme-petdex', 'theme-surfaces', 'theme-switches',
  'theme-tables', 'theme-tags', 'theme-workflow-runs',
]

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: coreSuite ? extendedThemeSpecs.map(name => `**/${name}.spec.ts`) : [],
  grepInvert: coreSuite ? /@extended/ : undefined,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
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
