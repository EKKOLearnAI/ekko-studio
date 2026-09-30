import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const sessionId = 'session-file-tree-collapse'
const sessionWorkspace = '/tmp/file-tree-collapse'

const session = {
  id: sessionId,
  profile: 'research',
  source: 'webui',
  model: 'test-model',
  provider: 'test-provider',
  title: 'File tree collapse',
  preview: 'File tree collapse',
  started_at: 1_790_000_000,
  ended_at: null,
  last_active: 1_790_000_100,
  message_count: 0,
  tool_call_count: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
  billing_provider: null,
  estimated_cost_usd: 0,
  actual_cost_usd: null,
  cost_status: '',
  workspace: sessionWorkspace,
}

const entries = [
  { name: 'src', path: 'src', isDir: true, size: 0, modTime: '2026-09-08T00:00:00.000Z' },
  { name: 'README.md', path: 'README.md', isDir: false, size: 88, modTime: '2026-09-08T00:00:00.000Z' },
  { name: 'package.json', path: 'package.json', isDir: false, size: 120, modTime: '2026-09-08T00:00:00.000Z' },
]

async function captureEvidence(page: Page, name: string) {
  const evidenceDir = process.env.HERMES_VISUAL_EVIDENCE_DIR
  if (evidenceDir) {
    await page.screenshot({ path: `${evidenceDir}/${name}.png`, animations: 'disabled' })
  }
}

test('collapses and restores the workspace file tree without closing the file view', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(() => window.localStorage.setItem('hermes_locale', 'en'))
  await page.addInitScript(id => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = {
      [id]: { session_id: id, messages: [], isWorking: false, events: [] },
    }
  }, sessionId)
  const api = await mockHermesApi(page, { sessions: [session] })

  await page.route(`**/api/studio/sessions/${sessionId}/workspace-files/list**`, async route => {
    const url = new URL(route.request().url())
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ entries, path: url.searchParams.get('path') || '', absolutePath: sessionWorkspace }),
    })
  })
  await page.route(`**/api/studio/sessions/${sessionId}/workspace-file/diff**`, async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ patch: '', additions: 0, deletions: 0, binary: false, truncated: false }),
    })
  })
  await page.route(`**/api/studio/sessions/${sessionId}/workspace-file/read**`, async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        path: 'README.md',
        size: 88,
        content: '# File tree collapse demo\n\nThe file preview stays available while the file tree changes.\n',
      }),
    })
  })
  await mockChatSocket(page)

  await page.goto(`/#/hermes/session/${sessionId}`)
  await page.locator('.header-tool-toggle').click()

  const panel = page.locator('.chat-tool-panel')
  const tree = panel.locator('.files-tree-panel')
  await expect(tree).toBeVisible()
  await expect(panel.locator('.explorer-resize-handle .file-tree-toggle')).toHaveCount(0)
  await expect(panel.getByText('README.md', { exact: true })).toBeVisible()
  await captureEvidence(page, '01-expanded-tree')

  await panel.getByText('README.md', { exact: true }).click()
  await expect(panel.locator('.workspace-file-diff')).toBeVisible()
  await expect(panel.locator('.diff-file-name')).toHaveText('README.md')
  await expect(panel.locator('.workspace-markdown-preview')).toContainText('The file preview stays available')
  await expect(panel.locator('.workspace-file-diff .file-tree-toggle')).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Collapse file tree', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await captureEvidence(page, '02-file-open-tree-visible')

  await panel.getByRole('button', { name: 'Collapse file tree', exact: true }).click()
  await expect(tree).toHaveClass(/tree-collapsed/)
  await expect(tree).toHaveAttribute('style', /width: 0px/)
  await expect(panel.locator('.explorer-resize-handle')).toBeHidden()
  await expect(panel.locator('.file-tree')).toBeHidden()
  await expect(panel.locator('.workspace-file-diff')).toBeVisible()
  await expect(panel.locator('.workspace-markdown-preview')).toContainText('The file preview stays available')
  await expect(panel.locator('.workspace-file-diff .file-tree-toggle')).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Expand file tree', exact: true })).toHaveAttribute('aria-expanded', 'false')
  await captureEvidence(page, '03-tree-collapsed-file-open')

  await panel.getByRole('button', { name: 'Expand file tree', exact: true }).click()
  await expect(tree).not.toHaveClass(/tree-collapsed/)
  await expect(panel.locator('.file-tree')).toBeVisible()
  await expect(panel.locator('.workspace-file-diff')).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Collapse file tree', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await captureEvidence(page, '04-tree-restored-file-open')

  await panel.getByRole('button', { name: 'Collapse file tree', exact: true }).click()
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(panel.locator('.workspace-file-diff')).toBeHidden()
  await expect(panel.locator('.collapsed-tree-fallback .file-tree-toggle')).toBeVisible()
  await expect(tree).toHaveAttribute('style', /width: 0px/)
  await expect(panel.locator('.explorer-resize-handle')).toBeHidden()
  await expect(panel.getByRole('button', { name: 'Expand file tree', exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Expand file tree', exact: true }).click()
  await expect(tree).not.toHaveClass(/tree-collapsed/)
  await expect(panel.locator('.file-tree')).toBeVisible()

  expect(api.unexpectedRequests).toEqual([])
})
