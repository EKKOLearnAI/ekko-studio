/// <reference types="node" />
import { existsSync } from 'node:fs'
import { defineConfig, devices, chromium } from '@playwright/test'

const PORT = Number(process.env.PLAYWRIGHT_PORT || 4173)
const BASE_URL = `http://127.0.0.1:${PORT}`
// Allow environments without managed Playwright Chromium to use a local browser.
// Example: PLAYWRIGHT_CHANNEL=chrome npx playwright test
// Example: PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium npx playwright test
const BROWSER_CHANNEL = process.env.PLAYWRIGHT_CHANNEL as 'chrome' | 'msedge' | undefined
const BROWSER_EXECUTABLE_PATH = process.env.PLAYWRIGHT_EXECUTABLE_PATH?.trim() || undefined

// Images without the managed download fall back to a system Chromium so the
// browser suite stays runnable offline instead of failing before the first test.
const SYSTEM_BROWSER_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/microsoft-edge',
]

function managedBrowserAvailable(): boolean {
  try {
    return existsSync(chromium.executablePath())
  } catch {
    return false
  }
}

const DETECTED_EXECUTABLE_PATH = BROWSER_EXECUTABLE_PATH
  ?? (!BROWSER_CHANNEL && !managedBrowserAvailable()
    ? SYSTEM_BROWSER_CANDIDATES.find(candidate => existsSync(candidate))
    : undefined)

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['dot'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Managed ffmpeg is not always available when using a system browser channel.
    video: BROWSER_CHANNEL || DETECTED_EXECUTABLE_PATH ? 'off' : 'retain-on-failure',
  },
  webServer: {
    env: { HERMES_WEB_UI_VITE_CACHE_DIR: `node_modules/.vite/playwright-${PORT}` },
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
        ...(DETECTED_EXECUTABLE_PATH ? { launchOptions: { executablePath: DETECTED_EXECUTABLE_PATH } } : {}),
      },
    },
  ],
})
