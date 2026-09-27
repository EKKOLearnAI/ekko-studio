import { expect, test, type Locator, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const SCREENSHOT_DIR = process.env.CATEGORY_PRESET_SCREENSHOT_DIR
// Taller viewport only for optional documentation screenshots.
if (SCREENSHOT_DIR) test.use({ viewport: { width: 1280, height: 1100 } })

const MODEL_GROUPS = [
  {
    provider: 'anthropic',
    label: 'Anthropic',
    base_url: 'https://api.anthropic.test',
    models: ['claude-opus-5-5', 'claude-sonnet-5'],
    available_models: ['claude-opus-5-5', 'claude-sonnet-5'],
    api_key: 'list-response-credential',
    api_mode: 'anthropic_messages',
  },
]

const MESSAGE_PLACEHOLDER = 'Type a message... (Enter to send, Shift+Enter for new line)'

function sessionSummary(id: string, title: string, categoryId: number | null, lastActive: number) {
  return {
    id,
    profile: 'research',
    source: 'cli',
    model: 'claude-sonnet-5',
    provider: 'anthropic',
    title,
    preview: title,
    started_at: lastActive - 10,
    ended_at: null,
    last_active: lastActive,
    message_count: 1,
    tool_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    billing_provider: null,
    estimated_cost_usd: 0,
    actual_cost_usd: null,
    cost_status: 'estimated',
    category_id: categoryId,
  }
}

async function snap(page: Page, name: string) {
  if (!SCREENSHOT_DIR) return
  // Let drawer/modal transitions finish so the capture shows the settled UI.
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, fullPage: true })
}

async function chooseOption(page: Page, field: Locator, label: string | RegExp) {
  await field.locator('.n-base-selection').first().click()
  await page.locator('.n-base-select-option:visible').filter({ hasText: label }).first().click()
}

function categoryHeader(page: Page, name: string) {
  return page.locator('.session-group-header').filter({ hasText: name })
}

function drawer(page: Page) {
  return page.locator('.new-chat-drawer')
}

function drawerField(page: Page, label: string | RegExp) {
  return drawer(page).locator('.new-chat-field').filter({ hasText: label })
}

async function runs(page: Page) {
  return page.evaluate(() => ((window as any).__PW_CHAT_SOCKET__?.emitted || [])
    .filter((item: any) => item.event === 'run')
    .map((item: any) => item.payload))
}

async function sendFirstMessage(page: Page, text: string) {
  await expect(page).toHaveURL(/#\/hermes\/session\//)
  const before = (await runs(page)).length
  await page.getByPlaceholder(MESSAGE_PLACEHOLDER).fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect.poll(async () => (await runs(page)).length).toBeGreaterThan(before)
  return (await runs(page)).at(-1)
}

async function setupPage(
  page: Page,
  sessionCategories: any[] = [],
  sessions: any[] = [],
  installedCodingAgents: string[] = ['claude-code'],
) {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(() => {
    if (localStorage.getItem('hermes_chat_collapsed_categories') === null) {
      localStorage.setItem('hermes_chat_collapsed_categories', '[]')
    }
  })
  const api = await mockHermesApi(page, { sessionCategories, sessions, modelGroups: MODEL_GROUPS })
  await page.route('**/api/coding-agents', route => route.fulfill({
    json: { tools: installedCodingAgents.map(id => ({ id, name: id === 'claude-code' ? 'Claude' : id, installed: true })) },
  }))
  await mockChatSocket(page)
  return api
}

test('creates a category with a preset and starts pre-filled chats from it (AC 1-4, 7, 8)', async ({ page }) => {
  const api = await setupPage(page, [{ id: 1, name: 'Empty' }], [sessionSummary('general', 'General Notes', null, 100)])
  await page.goto('/#/hermes/chat')

  // Every category is visible, including an empty one; Uncategorized has no [+] or [New Chat].
  const emptyHeader = categoryHeader(page, 'Empty')
  await expect(emptyHeader).toBeVisible()
  await expect(emptyHeader.locator('.session-group-count')).toHaveText('0')
  await expect(page.getByRole('button', { name: 'New Chat in Empty' })).toHaveCount(2)
  await expect(categoryHeader(page, 'Uncategorized').getByTestId('category-new-chat-plus')).toHaveCount(0)

  // "+ New Category" sits after the last category and before Uncategorized.
  const newCategoryButton = page.getByTestId('session-new-category')
  await expect(newCategoryButton).toHaveCount(1)
  const order = await page.locator('.session-items').evaluate((root) => {
    const newCategory = root.querySelector('[data-testid="session-new-category"]')!
    const headers = [...root.querySelectorAll('.session-group-header')]
    const empty = headers.find(item => item.textContent?.includes('Empty'))!
    const uncategorized = headers.find(item => item.textContent?.includes('Uncategorized'))!
    return [
      Boolean(empty.compareDocumentPosition(newCategory) & Node.DOCUMENT_POSITION_FOLLOWING),
      Boolean(newCategory.compareDocumentPosition(uncategorized) & Node.DOCUMENT_POSITION_FOLLOWING),
    ]
  })
  expect(order).toEqual([true, true])

  // AC 1: + New Category -> name + preset -> Save.
  await newCategoryButton.click()
  const modal = page.getByTestId('category-preset-modal')
  await expect(modal).toBeVisible()
  await modal.getByTestId('category-preset-name').locator('input').fill('empty')
  await modal.getByTestId('category-preset-save').click()
  await expect(modal.getByRole('alert')).toHaveText('A category with this name already exists')

  await modal.getByTestId('category-preset-name').locator('input').fill('AI Passport')
  await chooseOption(page, modal.locator('.category-preset-field').filter({ hasText: /^Agent/ }), /^Claude$/)
  await chooseOption(page, modal.locator('.category-preset-field').filter({ hasText: /^Provider/ }), 'Anthropic')
  await chooseOption(page, modal.locator('.category-preset-field').filter({ hasText: /^Models/ }), 'claude-opus-5-5')
  await modal.locator('.folder-path-input input').fill('/workspace/ai-passport')
  await snap(page, '02-new-category-form')
  await modal.getByTestId('category-preset-save').click()
  await expect(modal).toBeHidden()

  const createRequest = api.requests.find(request =>
    request.method === 'POST' && request.pathname === '/api/studio/session-categories',
  )!
  const createBody = JSON.parse(createRequest.postData || '{}')
  expect(createBody).toEqual({
    name: 'AI Passport',
    unique: true,
    preset: {
      agent: 'claude-code',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      workspace: '/workspace/ai-passport',
    },
  })
  expect(createRequest.postData).not.toMatch(/api_?key/i)

  const header = categoryHeader(page, 'AI Passport')
  await expect(header).toBeVisible()
  const newChatRow = page.getByTestId('category-new-chat-row').and(page.getByRole('button', { name: 'New Chat in AI Passport' }))
  await expect(newChatRow).toBeVisible()
  await header.hover()
  await snap(page, '01-sidebar-category-new-chat')

  // AC 2: [New Chat] opens the existing panel pre-filled, Category = AI Passport.
  await newChatRow.click()
  await expect(drawer(page).getByTestId('new-chat-preset-notice')).toContainText('AI Passport')
  await expect(drawerField(page, /^Agent/)).toContainText('Claude')
  await expect(drawerField(page, /^Category/)).toContainText('AI Passport')
  await expect(drawerField(page, /^Models/)).toContainText('claude-opus-5-5')
  await expect(drawer(page).locator('.folder-path-input input')).toHaveValue('/workspace/ai-passport')
  await snap(page, '03-drawer-prefilled')
  await drawer(page).getByRole('button', { name: 'Create', exact: true }).click()
  const firstRun = await sendFirstMessage(page, 'Plan the release')
  expect(firstRun).toMatchObject({
    category_id: 2,
    model: 'claude-opus-5-5',
    provider: 'anthropic',
    workspace: '/workspace/ai-passport',
    coding_agent_id: 'claude-code',
  })

  // AC 4: a per-chat change does not touch the preset.
  await page.getByTestId('category-new-chat-row').and(page.getByRole('button', { name: 'New Chat in AI Passport' })).click()
  await expect(drawerField(page, /^Models/)).toContainText('claude-opus-5-5')
  await chooseOption(page, drawerField(page, /^Models/), 'claude-sonnet-5')
  await drawer(page).getByRole('button', { name: 'Create', exact: true }).click()
  const changedRun = await sendFirstMessage(page, 'Use a lighter model')
  expect(changedRun).toMatchObject({ category_id: 2, model: 'claude-sonnet-5' })
  expect(api.requests.some(request => request.method === 'PATCH')).toBe(false)

  // AC 3: collapsed category hides the row; [+] on the header gives the same result.
  await header.click()
  await expect(page.getByTestId('category-new-chat-row').and(page.getByRole('button', { name: 'New Chat in AI Passport' }))).toHaveCount(0)
  await header.hover()
  await header.getByTestId('category-new-chat-plus').click()
  await expect(drawerField(page, /^Models/)).toContainText('claude-opus-5-5')
  await expect(drawerField(page, /^Category/)).toContainText('AI Passport')

  // AC 7: /plan as the first message keeps the category and preset workspace in the run payload.
  await drawer(page).getByRole('button', { name: 'Create', exact: true }).click()
  const planRun = await sendFirstMessage(page, '/plan outline the next step')
  expect(planRun).toMatchObject({ category_id: 2, workspace: '/workspace/ai-passport' })

  // AC 8: the top New Chat button opens with no category and no preset values.
  await page.locator('.page-sidebar-top').getByRole('button', { name: 'New Chat', exact: true }).click()
  await expect(drawer(page).getByTestId('new-chat-preset-notice')).toHaveCount(0)
  await expect(drawerField(page, /^Category/)).toContainText('Uncategorized')
  await expect(drawerField(page, /^Agent/)).toContainText('Hermes')
  await expect(drawer(page).locator('.folder-path-input input')).toHaveValue('')
  await drawer(page).getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(api.unexpectedRequests).toEqual([])
})

test('edits, clears and deletes a category preset from its menu (AC 5)', async ({ page }) => {
  const api = await setupPage(page, [
    { id: 1, name: 'Work', preset: { agent: 'hermes', provider: 'anthropic', model: 'claude-opus-5-5' } },
  ], [sessionSummary('existing', 'Existing Chat', 1, 100)])
  await page.goto('/#/hermes/chat')

  const header = categoryHeader(page, 'Work')
  await header.getByRole('button', { name: 'More' }).click()
  const menu = page.locator('.n-dropdown-menu:visible')
  await expect(menu.locator('.n-dropdown-option')).toHaveText(['Rename category', 'Set preset', 'Delete category'])
  await expect(menu).not.toContainText('New Chat')
  await menu.getByText('Set preset', { exact: true }).click()

  const modal = page.getByTestId('category-preset-modal')
  await expect(modal).toContainText('Preset for “Work”')
  await expect(modal.getByTestId('category-preset-name')).toHaveCount(0)
  await expect(modal.locator('.category-preset-field').filter({ hasText: /^Models/ })).toContainText('claude-opus-5-5')
  await chooseOption(page, modal.locator('.category-preset-field').filter({ hasText: /^Models/ }), 'claude-sonnet-5')
  await snap(page, '04-set-preset-form')
  await modal.getByTestId('category-preset-save').click()
  await expect(modal).toBeHidden()

  const patch = api.requests.find(request => request.method === 'PATCH')!
  expect(patch.pathname).toBe('/api/studio/session-categories/1')
  expect(JSON.parse(patch.postData || '{}')).toEqual({
    preset: { agent: 'hermes', provider: 'anthropic', model: 'claude-sonnet-5' },
  })
  // Existing chats keep their own settings: no session was rewritten.
  expect(api.requests.some(request => /\/api\/studio\/sessions\/existing\//.test(request.pathname))).toBe(false)

  await page.getByTestId('category-new-chat-row').first().click()
  await expect(drawerField(page, /^Models/)).toContainText('claude-sonnet-5')
  await drawer(page).getByRole('button', { name: 'Cancel', exact: true }).click()

  await header.getByRole('button', { name: 'More' }).click()
  await page.locator('.n-dropdown-menu:visible').getByText('Set preset', { exact: true }).click()
  await modal.getByTestId('category-preset-clear').click()
  await expect(modal).toBeHidden()
  expect(JSON.parse(api.requests.filter(request => request.method === 'PATCH').at(-1)!.postData || '{}')).toEqual({ preset: null })

  // Delete confirmation mentions the preset only when one exists.
  await header.getByRole('button', { name: 'More' }).click()
  await page.locator('.n-dropdown-menu:visible').getByText('Delete category', { exact: true }).click()
  const deleteDialog = page.getByRole('dialog').filter({ hasText: 'Delete category' })
  await expect(deleteDialog).toContainText('Its sessions will move to Uncategorized.')
  await expect(deleteDialog).not.toContainText('preset')
  await deleteDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
})

test('warns about stale preset values and uses defaults without changing the preset (AC 6)', async ({ page }) => {
  const api = await setupPage(page, [{
    id: 1,
    name: 'Legacy',
    preset: { provider: 'anthropic', model: 'claude-opus-4-8', profile: 'finance', workspace: '/workspace/deleted' },
    preset_status: { workspace_exists: false },
  }])
  await page.goto('/#/hermes/chat')

  await page.getByTestId('category-new-chat-row').first().click()
  await expect(drawerField(page, /^Models/)).toContainText('claude-opus-5-5')
  await expect(drawer(page)).toContainText('Model “claude-opus-4-8” in the preset is no longer available; using the default.')
  await expect(drawer(page)).toContainText('Profile “finance” in the preset is not available to you; using your default profile.')
  await expect(drawer(page).getByTestId('new-chat-workspace-warning'))
    .toHaveText('Workspace folder “/workspace/deleted” in the preset no longer exists; using the default workspace.')
  await expect(drawer(page).locator('.folder-path-input input')).toHaveValue('')
  await expect(drawerField(page, /^Category/)).toContainText('Legacy')
  await snap(page, '05-drawer-stale-warnings')
  await drawer(page).getByRole('button', { name: 'Create', exact: true }).click()
  const run = await sendFirstMessage(page, 'hello')
  expect(run).toMatchObject({ category_id: 1, model: 'claude-opus-5-5' })
  expect(run.workspace ?? null).toBeNull()

  await categoryHeader(page, 'Legacy').getByRole('button', { name: 'More' }).click()
  await page.locator('.n-dropdown-menu:visible').getByText('Set preset', { exact: true }).click()
  const modal = page.getByTestId('category-preset-modal')
  await expect(modal).toContainText('Model “claude-opus-4-8” in the preset is no longer available; using the default.')
  await expect(modal).toContainText('Workspace folder “/workspace/deleted” in the preset no longer exists; using the default workspace.')
  await snap(page, '06-set-preset-stale-warnings')
  await page.keyboard.press('Escape')

  // The stored preset was never modified automatically.
  expect(api.requests.some(request => request.method === 'PATCH')).toBe(false)

  await categoryHeader(page, 'Legacy').getByRole('button', { name: 'More' }).click()
  await page.locator('.n-dropdown-menu:visible').getByText('Delete category', { exact: true }).click()
  await expect(page.getByRole('dialog').filter({ hasText: 'Delete category' }))
    .toContainText('Its New Chat preset will be removed')
})

test('keeps today\'s install flow when the preset agent is not installed', async ({ page }) => {
  await setupPage(page, [{ id: 1, name: 'Agents', preset: { agent: 'claude-code', provider: 'anthropic', model: 'claude-opus-5-5' } }], [], [])
  await page.goto('/#/hermes/chat')

  await page.getByTestId('category-new-chat-row').first().click()
  await expect(drawerField(page, /^Agent/)).toContainText('Claude')
  await drawer(page).getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByText('Claude is not installed', { exact: false })).toBeVisible()
  await expect(page).not.toHaveURL(/#\/hermes\/session\//)
})
