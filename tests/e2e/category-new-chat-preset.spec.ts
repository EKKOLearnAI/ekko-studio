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

// Provider without its own base URL: the panel asks for one.
const GATEWAY_GROUP = {
  provider: 'gateway',
  label: 'Gateway',
  base_url: '',
  models: ['gw-model'],
  available_models: ['gw-model'],
  api_key: '',
}

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

// Same shape as TEST_ACCESS_KEY, but a profile-bound "admin" (not a super admin).
const PROFILE_ADMIN_ACCESS_KEY = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  Buffer.from(JSON.stringify({
    sub: '2', username: 'member', role: 'admin', type: 'access', aud: 'hermes-web-ui', iat: 1760000000, exp: 4102444800,
  })).toString('base64url'),
  'playwright-signature',
].join('.')

async function setupPage(
  page: Page,
  sessionCategories: any[] = [],
  sessions: any[] = [],
  installedCodingAgents: string[] = ['claude-code'],
  options: { accessKey?: string; modelGroups?: any[] } = {},
) {
  await authenticate(page, options.accessKey ?? TEST_ACCESS_KEY, 'research')
  await page.addInitScript(() => {
    if (localStorage.getItem('hermes_chat_collapsed_categories') === null) {
      localStorage.setItem('hermes_chat_collapsed_categories', '[]')
    }
  })
  const api = await mockHermesApi(page, { sessionCategories, sessions, modelGroups: options.modelGroups ?? MODEL_GROUPS })
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

test('warns when the server dropped a stored Base URL (and its API mode) that failed the credential filter', async ({ page }) => {
  const api = await setupPage(page, [{
    id: 1,
    name: 'Dropped',
    preset: { model: 'claude-opus-5-5' },
    preset_status: { base_url_dropped: true },
  }])
  await page.goto('/#/hermes/chat')

  await page.getByTestId('category-new-chat-row').first().click()
  await expect(drawer(page).getByTestId('new-chat-base-url-warning'))
    .toHaveText('Base URL “…” in the preset is not used with this provider; using the provider\'s own settings.')
  await expect(drawerField(page, /^Models/)).toContainText('claude-opus-5-5')
  await snap(page, '11-drawer-dropped-base-url')
  await page.keyboard.press('Escape')

  await categoryHeader(page, 'Dropped').getByRole('button', { name: 'More' }).click()
  await page.locator('.n-dropdown-menu:visible').getByText('Set preset', { exact: true }).click()
  const modal = page.getByTestId('category-preset-modal')
  await expect(modal.getByTestId('category-preset-base-url-warning'))
    .toHaveText('Base URL “…” in the preset is not used with this provider; using the provider\'s own settings.')
  await page.keyboard.press('Escape')
  expect(api.requests.some(request => request.method === 'PATCH')).toBe(false)
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

test('a Cursor preset is set from the form and pre-fills the drawer like a manual Cursor pick (#3110)', async ({ page }) => {
  const api = await setupPage(page, [
    { id: 1, name: 'Cursor Work', preset: { agent: 'claude-code', agentMode: 'scoped', provider: 'anthropic', model: 'claude-opus-5-5', workspace: '/workspace/cursor-app' } },
  ], [], ['cursor'])
  await page.goto('/#/hermes/chat')

  // Set preset: the agent picker follows the drawer order (#3199) and Cursor hides the
  // launch-mode, provider and model fields, exactly like the drawer.
  const header = categoryHeader(page, 'Cursor Work')
  await header.getByRole('button', { name: 'More' }).click()
  await page.locator('.n-dropdown-menu:visible').getByText('Set preset', { exact: true }).click()
  const modal = page.getByTestId('category-preset-modal')
  await expect(modal.locator('.category-preset-field').filter({ hasText: /^Launch mode/ })).toHaveCount(1)
  const agentField = modal.locator('.category-preset-field').filter({ hasText: /^Agent/ })
  await agentField.locator('.n-base-selection').first().click()
  await expect(page.locator('.n-base-select-option:visible')).toHaveText([
    'Default', 'Hermes', 'Ekko', 'Claude', 'Codex', 'Pi', 'Grok', 'OpenCode', 'DeepSeek Harness', 'Cursor',
  ])
  const cursorOption = page.locator('.n-base-select-option:visible').filter({ hasText: /^Cursor$/ })
  await cursorOption.scrollIntoViewIfNeeded()
  await snap(page, '12-set-preset-agent-cursor-option')
  await cursorOption.click()
  await expect(modal.locator('.category-preset-field').filter({ hasText: /^Launch mode/ })).toHaveCount(0)
  await expect(modal.locator('.category-preset-field').filter({ hasText: /^Provider/ })).toHaveCount(0)
  await expect(modal.locator('.category-preset-field').filter({ hasText: /^Models/ })).toHaveCount(0)
  await expect(modal.locator('.category-preset-warning')).toHaveCount(0)
  await snap(page, '13-set-preset-cursor')
  await modal.getByTestId('category-preset-save').click()
  await expect(modal).toBeHidden()
  const patch = api.requests.find(request => request.method === 'PATCH')!
  expect(JSON.parse(patch.postData || '{}')).toEqual({ preset: { agent: 'cursor', workspace: '/workspace/cursor-app' } })

  // [New Chat] pre-fills Cursor: no launch mode, provider or model; Cursor always runs global.
  await page.getByTestId('category-new-chat-row').and(page.getByRole('button', { name: 'New Chat in Cursor Work' })).click()
  await expect(drawerField(page, /^Agent/)).toContainText('Cursor')
  await expect(drawerField(page, /^Category/)).toContainText('Cursor Work')
  await expect(drawerField(page, /^Launch mode/)).toHaveCount(0)
  await expect(drawerField(page, /^Models/)).toHaveCount(0)
  await expect(drawer(page).locator('.new-chat-preset-warning')).toHaveCount(0)
  await expect(drawer(page).locator('.folder-path-input input')).toHaveValue('/workspace/cursor-app')
  await snap(page, '14-drawer-prefilled-cursor')
  await drawer(page).getByRole('button', { name: 'Create', exact: true }).click()
  const run = await sendFirstMessage(page, 'Refactor the parser')
  expect(run).toMatchObject({ category_id: 1, coding_agent_id: 'cursor', mode: 'global', workspace: '/workspace/cursor-app' })
  expect(run.model).toBeUndefined()
  expect(run.provider).toBeUndefined()
  expect(run.apiKey).toBeUndefined()
  expect(api.unexpectedRequests).toEqual([])
})

test('a Cursor preset keeps today\'s install flow when Cursor is not installed', async ({ page }) => {
  await setupPage(page, [{ id: 1, name: 'Cursor Work', preset: { agent: 'cursor' } }], [], [])
  await page.goto('/#/hermes/chat')

  await page.getByTestId('category-new-chat-row').first().click()
  await expect(drawerField(page, /^Agent/)).toContainText('Cursor')
  await drawer(page).getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByText('Cursor is not installed', { exact: false })).toBeVisible()
  await expect(page).not.toHaveURL(/#\/hermes\/session\//)
})

test('every drawer open starts from the same defaults, so a preset never leaks into the next category (F2)', async ({ page }) => {
  await setupPage(page, [
    { id: 1, name: 'Agent Preset', preset: { agent: 'claude-code', provider: 'anthropic', model: 'claude-opus-5-5', workspace: '/w/a' } },
    { id: 2, name: 'No Preset' },
    { id: 3, name: 'Model Only', preset: { model: 'claude-sonnet-5' } },
  ])
  await page.goto('/#/hermes/chat')

  await page.getByRole('button', { name: 'New Chat in Agent Preset' }).first().click()
  await expect(drawerField(page, /^Agent/)).toContainText('Claude')
  await drawer(page).getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(drawer(page)).toBeHidden()

  // B has no preset: today's default agent, not A's.
  await page.getByRole('button', { name: 'New Chat in No Preset' }).first().click()
  await expect(drawerField(page, /^Category/)).toContainText('No Preset')
  await expect(drawerField(page, /^Agent/)).toContainText('Hermes')
  await expect(drawer(page).locator('.folder-path-input input')).not.toHaveValue('/w/a')
  await drawer(page).getByRole('button', { name: 'Cancel', exact: true }).click()

  // A again, then B' whose preset has no agent: still today's default agent.
  await page.getByRole('button', { name: 'New Chat in Agent Preset' }).first().click()
  await expect(drawerField(page, /^Agent/)).toContainText('Claude')
  await drawer(page).getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'New Chat in Model Only' }).first().click()
  await expect(drawerField(page, /^Category/)).toContainText('Model Only')
  await expect(drawerField(page, /^Agent/)).toContainText('Hermes')
  await expect(drawerField(page, /^Models/)).toContainText('claude-sonnet-5')
})

test('a slow preset apply for an earlier open never overwrites the drawer opened for another category (F3)', async ({ page }) => {
  await setupPage(page, [
    { id: 1, name: 'Slow DSH', preset: { agent: 'dsh', agentPreset: 'minimal' } },
    { id: 2, name: 'Plain' },
  ], [], ['claude-code', 'dsh'])
  let releaseDsh: () => void = () => {}
  const dshHeld = new Promise<void>(resolve => { releaseDsh = resolve })
  let dshRequested = false
  await page.route('**/api/coding-agents/dsh/session-presets', async (route) => {
    dshRequested = true
    await dshHeld
    await route.fulfill({ json: { presets: [{ id: 'minimal', name: 'Minimal mode', isDefault: false }] } })
  })
  await page.goto('/#/hermes/chat')

  await page.getByRole('button', { name: 'New Chat in Slow DSH' }).first().click()
  await expect.poll(() => dshRequested).toBe(true)
  await page.keyboard.press('Escape')
  await expect(drawer(page)).toBeHidden()
  await page.getByRole('button', { name: 'New Chat in Plain' }).first().click()
  await expect(drawerField(page, /^Category/)).toContainText('Plain')

  releaseDsh()
  // Give the stale apply every chance to run, then check it did nothing.
  await page.waitForTimeout(500)
  await expect(drawerField(page, /^Agent/)).toContainText('Hermes')
  await expect(drawerField(page, /^Category/)).toContainText('Plain')
  // "Plain" has no preset, so there is no "Using the … preset" notice either.
  await expect(drawer(page).getByTestId('new-chat-preset-notice')).toHaveCount(0)
})

test('a preset Base URL never receives the provider\'s stored API key (D2)', async ({ page }) => {
  const groups = [{
    provider: 'gateway',
    label: 'Gateway',
    base_url: '',
    models: ['gw-model'],
    available_models: ['gw-model'],
    api_key: 'stored-provider-key',
  }]
  await setupPage(page, [{
    id: 1,
    name: 'Foreign URL',
    preset: { agent: 'claude-code', agentMode: 'scoped', provider: 'gateway', model: 'gw-model', baseUrl: 'https://other.example.test/anthropic' },
  }], [], ['claude-code'], { modelGroups: groups })
  await page.goto('/#/hermes/chat')

  // Without a preset, today's behavior: the stored key is used and no key field is shown.
  await page.locator('.page-sidebar-top').getByRole('button', { name: 'New Chat', exact: true }).click()
  await chooseOption(page, drawerField(page, /^Agent/), /^Claude$/)
  await expect(drawerField(page, /^API Key/)).toHaveCount(0)
  await drawer(page).getByRole('button', { name: 'Cancel', exact: true }).click()

  await page.getByRole('button', { name: 'New Chat in Foreign URL' }).first().click()
  await expect(drawerField(page, /^Base URL/).locator('input')).toHaveValue('https://other.example.test/anthropic')
  const keyField = drawerField(page, /^API Key/)
  await expect(keyField).toBeVisible()
  await expect(drawer(page).getByTestId('new-chat-preset-key-required')).toBeVisible()
  await snap(page, '07-drawer-preset-base-url-key')
  const create = drawer(page).getByRole('button', { name: 'Create', exact: true })
  await expect(create).toBeDisabled()
  await keyField.locator('input').fill('user-entered-key')
  await expect(create).toBeEnabled()
  await create.click()
  const run = await sendFirstMessage(page, 'hello gateway')
  // Base URL set before API mode: inferred from the preset URL like manual entry (F7).
  expect(run).toMatchObject({
    category_id: 1,
    coding_agent_id: 'claude-code',
    baseUrl: 'https://other.example.test/anthropic',
    apiKey: 'user-entered-key',
    apiMode: 'anthropic_messages',
  })
  expect(JSON.stringify(run)).not.toContain('stored-provider-key')
})

test('profile-bound admins use presets but cannot edit them (D1)', async ({ page }) => {
  const api = await setupPage(page, [
    { id: 1, name: 'Shared', preset: { provider: 'anthropic', model: 'claude-opus-5-5' } },
  ], [], ['claude-code'], { accessKey: PROFILE_ADMIN_ACCESS_KEY })
  await page.goto('/#/hermes/chat')

  // Set preset is hidden; Rename and Delete stay.
  await categoryHeader(page, 'Shared').getByRole('button', { name: 'More' }).click()
  await expect(page.locator('.n-dropdown-menu:visible .n-dropdown-option')).toHaveText(['Rename category', 'Delete category'])
  await page.keyboard.press('Escape')

  // The preset still pre-fills their New Chat panel.
  await page.getByRole('button', { name: 'New Chat in Shared' }).first().click()
  await expect(drawerField(page, /^Models/)).toContainText('claude-opus-5-5')
  await drawer(page).getByRole('button', { name: 'Cancel', exact: true }).click()

  // "+ New Category" shows only the Name field and creates a category without a preset.
  await page.getByTestId('session-new-category').click()
  const modal = page.getByTestId('category-preset-modal')
  await expect(modal.getByTestId('category-preset-name')).toBeVisible()
  await expect(modal.locator('.category-preset-field')).toHaveCount(1)
  await expect(modal.getByTestId('category-preset-clear')).toHaveCount(0)
  await snap(page, '08-new-category-name-only')
  await modal.getByTestId('category-preset-name').locator('input').fill('Mine')
  await modal.getByTestId('category-preset-save').click()
  await expect(modal).toBeHidden()
  const create = api.requests.find(request => request.method === 'POST' && request.pathname === '/api/studio/session-categories')!
  expect(JSON.parse(create.postData || '{}')).toEqual({ name: 'Mine', preset: null, unique: true })
  await expect(categoryHeader(page, 'Mine')).toBeVisible()
})

test('relative preset workspaces are saved as entered, like the New Chat panel', async ({ page }) => {
  const api = await setupPage(page)
  await page.goto('/#/hermes/chat')
  await page.getByTestId('session-new-category').click()
  const modal = page.getByTestId('category-preset-modal')
  await modal.getByTestId('category-preset-name').locator('input').fill('Relative')
  await modal.locator('.folder-path-input input').fill('projects/app')
  await modal.getByTestId('category-preset-save').click()
  await expect(modal).toBeHidden()
  const create = api.requests.find(request => request.method === 'POST' && request.pathname === '/api/studio/session-categories')!
  expect(JSON.parse(create.postData || '{}')).toEqual({ name: 'Relative', preset: { workspace: 'projects/app' }, unique: true })

  await page.getByTestId('category-new-chat-row').first().click()
  await expect(drawer(page).locator('.folder-path-input input')).toHaveValue('projects/app')
  await expect(drawer(page).getByTestId('new-chat-workspace-warning')).toHaveCount(0)
})

test('a preset Base URL with credentials gets a translated error and is never sent', async ({ page }) => {
  const api = await setupPage(page, [], [], ['claude-code'], { modelGroups: [...MODEL_GROUPS, GATEWAY_GROUP] })
  await page.goto('/#/hermes/chat')
  await page.getByTestId('session-new-category').click()
  const modal = page.getByTestId('category-preset-modal')
  await modal.getByTestId('category-preset-name').locator('input').fill('Gateway')
  await chooseOption(page, modal.getByTestId('category-preset-agent'), /^Claude$/)
  await chooseOption(page, modal.getByTestId('category-preset-provider'), /^Gateway$/)
  const baseUrl = modal.getByTestId('category-preset-base-url').locator('input')
  await baseUrl.fill('https://user:secret@gateway.example.test/v1')
  await modal.getByTestId('category-preset-save').click()
  await expect(modal.getByTestId('category-preset-base-url-error'))
    .toHaveText('Remove the user name, password, key or #fragment from the Base URL. Presets are shared and never store credentials.')
  await baseUrl.fill('https://gateway.example.test/v1?api_key=sk-live')
  await modal.getByTestId('category-preset-save').click()
  await expect(modal.getByTestId('category-preset-base-url-error')).toBeVisible()
  await snap(page, '09-set-preset-base-url-credentials')
  expect(api.requests.some(request => request.method === 'POST' && request.pathname === '/api/studio/session-categories')).toBe(false)

  await baseUrl.fill('https://gateway.example.test/v1')
  await expect(modal.getByTestId('category-preset-base-url-error')).toHaveCount(0)
  await modal.getByTestId('category-preset-save').click()
  await expect(modal).toBeHidden()
  const create = api.requests.find(request => request.method === 'POST' && request.pathname === '/api/studio/session-categories')!
  expect(JSON.parse(create.postData || '{}').preset).toMatchObject({ agent: 'claude-code', provider: 'gateway', baseUrl: 'https://gateway.example.test/v1' })
})

test('a preset Base URL is never applied to another provider: stale provider or provider with its own base URL', async ({ page }) => {
  await setupPage(page, [
    {
      id: 1,
      name: 'Stale Gateway',
      preset: {
        agent: 'claude-code', agentMode: 'scoped', provider: 'removed-gateway', model: 'gw-model',
        apiMode: 'chat_completions', baseUrl: 'https://old-gateway.example.test/v1',
      },
    },
    {
      id: 2,
      name: 'Own URL',
      preset: {
        agent: 'claude-code', agentMode: 'scoped', provider: 'anthropic', model: 'claude-opus-5-5',
        baseUrl: 'https://proxy.example.test/anthropic',
      },
    },
  ], [], ['claude-code'], { modelGroups: [...MODEL_GROUPS, GATEWAY_GROUP] })
  await page.goto('/#/hermes/chat')

  // Stale provider: the drawer falls back to the default provider and does not carry the URL over.
  await page.getByRole('button', { name: 'New Chat in Stale Gateway' }).first().click()
  await expect(drawer(page)).toContainText('Provider “removed-gateway” in the preset is no longer available; using the default.')
  await expect(drawer(page).getByTestId('new-chat-base-url-warning'))
    .toHaveText('Base URL “https://old-gateway.example.test/v1” in the preset is not used with this provider; using the provider\'s own settings.')
  await expect(drawer(page).getByTestId('new-chat-api-mode-warning'))
    .toHaveText('API mode “chat_completions” in the preset is not used with this provider; using the default.')
  await snap(page, '10-drawer-stale-provider-base-url')
  const baseUrlField = drawerField(page, /^Base URL/)
  if (await baseUrlField.count()) await expect(baseUrlField.locator('input')).toHaveValue('')
  await drawer(page).getByRole('button', { name: 'Cancel', exact: true }).click()

  // The preset provider now has its own base URL: warn instead of silently skipping.
  await page.getByRole('button', { name: 'New Chat in Own URL' }).first().click()
  await expect(drawerField(page, /^Models/)).toContainText('claude-opus-5-5')
  await expect(drawer(page).getByTestId('new-chat-base-url-warning'))
    .toHaveText('Base URL “https://proxy.example.test/anthropic” in the preset is not used with this provider; using the provider\'s own settings.')
  await expect(drawerField(page, /^Base URL/)).toHaveCount(0)
  await drawer(page).getByRole('button', { name: 'Create', exact: true }).click()
  const run = await sendFirstMessage(page, 'hello own url')
  expect(run).toMatchObject({ category_id: 2, coding_agent_id: 'claude-code', baseUrl: 'https://api.anthropic.test' })
  expect(JSON.stringify(run)).not.toContain('proxy.example.test')
})

test('Cmd/Ctrl+N keeps today\'s behavior and never uses a preset (AC 8)', async ({ page }) => {
  await setupPage(page, [
    { id: 1, name: 'Preset', preset: { agent: 'claude-code', provider: 'anthropic', model: 'claude-opus-5-5', workspace: '/w/preset' } },
  ])
  await page.goto('/#/hermes/chat')

  // Use the preset once so its values are the most recent drawer state.
  await page.getByRole('button', { name: 'New Chat in Preset' }).first().click()
  await drawer(page).getByRole('button', { name: 'Create', exact: true }).click()
  const presetRun = await sendFirstMessage(page, 'first')
  expect(presetRun).toMatchObject({ category_id: 1, coding_agent_id: 'claude-code', workspace: '/w/preset' })

  // The shortcut creates a chat directly (no drawer) with today's defaults.
  await page.keyboard.press('ControlOrMeta+n')
  await expect(drawer(page)).toBeHidden()
  const shortcutRun = await sendFirstMessage(page, 'second')
  expect(shortcutRun.category_id ?? null).toBeNull()
  expect(shortcutRun.coding_agent_id).toBeUndefined()
  expect(shortcutRun.workspace ?? null).toBeNull()
  expect(shortcutRun.session_id).not.toBe(presetRun.session_id)
})

test('moving a chat into a category does not apply its preset to that chat', async ({ page }) => {
  const api = await setupPage(page, [
    { id: 1, name: 'Work', preset: { agent: 'claude-code', provider: 'anthropic', model: 'claude-opus-5-5', workspace: '/w/work' } },
  ], [sessionSummary('general-session', 'General Notes', null, 100)])
  await page.goto('/#/hermes/chat')

  await page.getByRole('link', { name: /General Notes/ }).last().click({ button: 'right' })
  await page.locator('.n-dropdown-option').filter({ hasText: 'Move to category' }).hover()
  const workOption = page.locator('.n-dropdown-option:visible')
    .filter({ hasText: /^Work$/ })
    .locator(':scope > .n-dropdown-option-body')
  await expect(workOption).toBeVisible()
  await workOption.evaluate((element: HTMLElement) => element.click())
  await expect(page.getByText('Category updated')).toBeVisible()

  const sessionWrites = api.requests.filter(request =>
    request.method !== 'GET' && request.pathname.startsWith('/api/studio/sessions/general-session/'),
  )
  expect(sessionWrites.map(request => [request.pathname, JSON.parse(request.postData || '{}')])).toEqual([
    ['/api/studio/sessions/general-session/category', { categoryId: 1 }],
  ])
  expect(api.requests.some(request => request.method === 'PATCH')).toBe(false)
})

/** Header order is Name … [...][+]: [+] is rightmost, right after [...], and Tab follows that order. */
async function expectMenuThenPlus(page: Page, name: string) {
  const header = categoryHeader(page, name)
  const menu = header.getByRole('button', { name: 'More' })
  const plus = header.getByTestId('category-new-chat-plus')
  const [menuBox, plusBox, headerBox] = await Promise.all([menu.boundingBox(), plus.boundingBox(), header.boundingBox()])
  expect(menuBox && plusBox && headerBox).toBeTruthy()
  expect(plusBox!.x).toBeGreaterThan(menuBox!.x + menuBox!.width - 1)
  expect(headerBox!.x + headerBox!.width - (plusBox!.x + plusBox!.width)).toBeLessThan(menuBox!.width)
  await menu.focus()
  await page.keyboard.press('Tab')
  await expect(plus).toBeFocused()
}

test.describe('on a touch device', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 1280, height: 900 } })

  test('always shows the category [+] button without hover', async ({ page }) => {
    await setupPage(page, [{ id: 1, name: 'Touch' }])
    await page.goto('/#/hermes/chat')
    const plus = categoryHeader(page, 'Touch').getByTestId('category-new-chat-plus')
    await expect(plus).toBeVisible()
    await expect(plus).toHaveCSS('opacity', '1')
    await expectMenuThenPlus(page, 'Touch')
    await plus.tap()
    await expect(drawerField(page, /^Category/)).toContainText('Touch')
  })
})

test('reveals the category [+] button on hover for a pointer device', async ({ page }) => {
  await setupPage(page, [{ id: 1, name: 'Pointer' }])
  await page.goto('/#/hermes/chat')
  const plus = categoryHeader(page, 'Pointer').getByTestId('category-new-chat-plus')
  await page.mouse.move(0, 0)
  await expect(plus).toHaveCSS('opacity', '0')
  await categoryHeader(page, 'Pointer').hover()
  await expect(plus).toHaveCSS('opacity', '1')
  await expectMenuThenPlus(page, 'Pointer')
})
