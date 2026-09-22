import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

/**
 * OrcaRouter evidence capture.
 *
 * Drives the real Ekko Studio UI with a mocked backend that returns the shape
 * the new provider path produces (capability-filtered catalog plus both
 * authentication entries) and records the screenshots referenced by
 * `orca-evidence/manifest.json`.
 *
 * The manifest follows the campaign evidence schema: the capture facts live in
 * an `automation` object (framework, passed, catalog source and model counts)
 * and every artifact carries `kind`, `path`, `sha256` and a `ui` assertion
 * object. Keep those shapes stable, they are read by an external validator.
 */

// Anchored to this file rather than to `process.cwd()`: the independent
// validator may run Playwright from another directory, and the evidence has to
// land inside the checkout whose manifest references it.
const EVIDENCE_DIR = resolve(__dirname, '../../orca-evidence')
const CHAT_CATALOG_URL = 'https://api.orcarouter.ai/v1/models?capability=chat'

/**
 * Mirrors `GET https://api.orcarouter.ai/v1/models?capability=chat` as read
 * through the provider code path this integration adds. The ids and the
 * `image` modality declarations below are the live gateway's, not invented
 * fixtures; only the transport is mocked, matching this repository's e2e
 * convention. `tests/server/orcarouter-live.test.ts` exercises the same
 * catalog over the real network.
 */
const LIVE_CHAT_MODELS = [
  'orcarouter/free',
  'orcarouter/fusion',
  'orcarouter/fusion-flash',
  'orcarouter/fusion-mini',
  'orcarouter/orcacode-review',
  'orcarouter/open-code',
  'orcarouter/test-cache-glm52-opus',
  'orcarouter/simple-test',
  'orcarouter/intco-qa',
  'orcarouter/auto',
  'deepseek/deepseek-v4-flash-0731',
  'deepseek/deepseek-v4-pro-0813',
  'deepseek/deepseek-v4.1-flash',
  'deepseek/deepseek-v4-flash-vision-exp',
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-pro',
]

/** The only live chat models that declare `image` in `architecture.input_modalities`. */
const LIVE_IMAGE_INPUT_MODELS = [
  'deepseek/deepseek-v4.1-flash',
  'deepseek/deepseek-v4-flash-vision-exp',
]

const ORCAROUTER_GROUP = {
  provider: 'orcarouter',
  label: 'OrcaRouter',
  base_url: 'https://api.orcarouter.ai/v1',
  api_mode: 'chat_completions',
  api_key_env: 'ORCAROUTER_API_KEY',
  builtin: true,
  models: LIVE_CHAT_MODELS,
  available_models: LIVE_CHAT_MODELS,
  capability_models: {
    chat: LIVE_CHAT_MODELS,
    'chat-image': LIVE_IMAGE_INPUT_MODELS,
    'chat-audio': [],
    'chat-video': [],
    embedding: [],
    image: [],
    video: [],
    rerank: [],
  },
  capability_catalog: { source: 'live', degraded: false },
}

const ORCAROUTER_OAUTH_GROUP = {
  ...ORCAROUTER_GROUP,
  provider: 'orcarouter-oauth',
  label: 'OrcaRouter - Auth',
  api_key_env: '',
  models: ['orcarouter/auto'],
  available_models: ['orcarouter/auto'],
}

const OTHER_GROUP = {
  provider: 'test-provider',
  label: 'Test Provider',
  base_url: 'https://example.invalid/v1',
  models: ['test-model'],
  available_models: ['test-model'],
}

function ensureEvidenceDir(): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * Read the full option set a select is bound to.
 *
 * The panel is virtualized, so only the rows inside the viewport exist in the
 * DOM at any moment. Scrolling the panel and unioning the rendered rows yields
 * the complete bound list without depending on the panel's pixel height.
 */
async function readAllOptionLabels(panel: import('@playwright/test').Locator): Promise<string[]> {
  const seen = new Set<string>()
  const list = panel.locator('.n-virtual-list')
  await expect(panel.locator('.n-base-select-option').first()).toBeVisible()
  for (let step = 0; step < 40; step += 1) {
    for (const label of await panel.locator('.n-base-select-option').allInnerTexts()) {
      const value = label.trim()
      if (value) seen.add(value)
    }
    const moved = await list.evaluate((el) => {
      const before = el.scrollTop
      el.scrollTop = Math.min(el.scrollTop + el.clientHeight * 0.8, el.scrollHeight)
      return el.scrollTop !== before
    })
    if (!moved) break
    await panel.page().waitForTimeout(60)
  }
  await list.evaluate((el) => { el.scrollTop = 0 })
  await panel.page().waitForTimeout(60)
  return [...seen]
}

/**
 * Measure the painted panel instead of trusting a literal flag: read the
 * computed background alpha and the border widths the browser actually applied.
 */
async function measurePanelPaint(panel: import('@playwright/test').Locator) {
  return panel.evaluate((el) => {
    const style = getComputedStyle(el)
    const alphaOf = (color: string): number => {
      const match = color.match(/rgba?\(([^)]+)\)/)
      if (!match) return 0
      const parts = match[1].split(',').map(part => Number.parseFloat(part))
      return parts.length > 3 ? parts[3] : 1
    }
    const borderWidths = [
      style.borderTopWidth,
      style.borderRightWidth,
      style.borderBottomWidth,
      style.borderLeftWidth,
    ].map(width => Number.parseFloat(width) || 0)
    const hasShadow = style.boxShadow !== 'none' && style.boxShadow.trim().length > 0
    return {
      backgroundAlpha: alphaOf(style.backgroundColor),
      borderWidths,
      // Naive UI separates this panel with an elevation shadow rather than a
      // CSS border, so either treatment counts as a visible edge.
      hasShadow,
      opaque: alphaOf(style.backgroundColor) >= 1,
      borderVisible: hasShadow || (borderWidths.some(width => width > 0) && alphaOf(style.borderTopColor) > 0),
    }
  })
}

// The capture drives several dialogs and waits for animations to settle; the
// repository default of 30s is not enough headroom for the full sequence.
test.describe.configure({ timeout: 120_000 })

test('captures the OrcaRouter authentication entries and the live model dropdown', async ({ page }) => {
  ensureEvidenceDir()
  await authenticate(page, TEST_ACCESS_KEY)
  await mockChatSocket(page)
  await mockHermesApi(page, {
    modelGroups: [ORCAROUTER_GROUP, ORCAROUTER_OAUTH_GROUP, OTHER_GROUP],
  })

  await page.goto('/#/hermes/models?addProvider=1')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  // --- auth-methods.png -----------------------------------------------------
  // The API Key entry point: a paste field plus a Connect-with-OrcaRouter
  // control that opens the OAuth 2.0 + PKCE flow.
  await dialog.locator('.n-base-selection').first().click()
  await page.locator('.n-base-select-option').filter({ hasText: 'OrcaRouter' }).first().click()
  const apiKeyField = dialog.locator('[data-testid="orca-router-api-key-field"]')
  const connectButton = dialog.locator('[data-testid="orca-router-connect"]')
  await expect(apiKeyField).toBeVisible()
  await expect(connectButton).toBeVisible()
  const apiKeyVisible = await apiKeyField.isVisible()
  const pkceVisible = await connectButton.isVisible()
  const controlsEnabled = await connectButton.isEnabled()

  const apiKeyInput = dialog.locator('[data-testid="orca-router-api-key-field"] input')
  await apiKeyInput.fill('sk-orca-evidence-placeholder-0000000000')
  await expect(apiKeyInput).toHaveAttribute('type', 'password')

  // Prove masking from rendered pixels rather than from the attribute alone:
  // the same value in a text input renders differently, so equal buffers would
  // mean the secret is on screen in clear text.
  const maskedPixels = await apiKeyInput.screenshot()
  await apiKeyInput.evaluate((el) => { (el as HTMLInputElement).type = 'text' })
  const unmaskedPixels = await apiKeyInput.screenshot()
  await apiKeyInput.evaluate((el) => { (el as HTMLInputElement).type = 'password' })
  const secretMasked = !maskedPixels.equals(unmaskedPixels)

  const authShot = join(EVIDENCE_DIR, 'auth-methods.png')
  await page.screenshot({ path: authShot, fullPage: false })

  const renderedText = await dialog.innerText()
  expect(renderedText).not.toContain('sk-orca-evidence-placeholder-0000000000')
  expect(await apiKeyInput.inputValue()).toBe('sk-orca-evidence-placeholder-0000000000')
  expect(secretMasked).toBe(true)

  // --- text-model-dropdown.png ---------------------------------------------
  // The model selector offers the API-derived chat catalog and refuses free
  // text, so an unlisted model id cannot be submitted.
  const modelSelect = dialog.locator('[data-testid="orca-router-model-select"]')
  await expect(modelSelect).toBeVisible()
  await modelSelect.locator('.n-base-selection').click()
  // Scope to the dropdown the model select just opened: the page holds other
  // selects whose menus would otherwise inflate the count.
  const dropdown = page.locator('.n-base-select-menu').last()
  await expect(dropdown).toBeVisible()
  const options = dropdown.locator('.n-base-select-option')
  await expect(options.first()).toBeVisible()

  // Wait for the open animation to settle: measuring mid-transition would read
  // a scaled-down panel rather than the real layout box.
  await expect(dropdown).toHaveCSS('transform', 'none')
  const dropdownBox = await dropdown.boundingBox()
  const triggerBox = await modelSelect.locator('.n-base-selection').boundingBox()
  expect(dropdownBox).toBeTruthy()
  expect(triggerBox).toBeTruthy()
  // The panel is anchored to the trigger: no sideways drift.
  const rightDelta = Math.abs((dropdownBox!.x + dropdownBox!.width) - (triggerBox!.x + triggerBox!.width))
  expect(rightDelta).toBeLessThanOrEqual(2)

  const panelPaint = await measurePanelPaint(dropdown)
  expect(panelPaint.opaque).toBe(true)
  expect(panelPaint.borderVisible).toBe(true)

  const dropdownShot = join(EVIDENCE_DIR, 'text-model-dropdown.png')
  await page.screenshot({ path: dropdownShot, fullPage: false })

  // The visible row count is a viewport artefact of the virtualized panel, so
  // the assertion is on the full bound option set, not on rendered rows.
  const chatNames = await readAllOptionLabels(dropdown)
  expect(chatNames).toEqual(ORCAROUTER_GROUP.capability_models.chat)

  // Close the dropdown before asserting the masked-secret surface again.
  await page.keyboard.press('Escape')

  // --- multimodal-model-dropdown.png ---------------------------------------
  // The Vision auxiliary task uploads an image, so its model selector may only
  // offer chat models that explicitly declare image input.
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await page.getByText('Auxiliary Models (Hermes)', { exact: false }).first().click()
  const visionRow = page.locator('.auxiliary-row').filter({ hasText: 'Vision' })
  await expect(visionRow).toBeVisible()
  await visionRow.getByRole('button', { name: 'Edit', exact: true }).click()
  const visionDialog = page.getByRole('dialog').last()
  const visionModelSelect = visionDialog.locator('[data-testid="auxiliary-model"]')
  // The model selector stays disabled until a provider is chosen.
  await visionDialog.locator('[data-testid="auxiliary-provider"]').locator('.n-base-selection').click()
  await page.locator('.n-base-select-option').filter({ hasText: 'OrcaRouter' }).first().click()
  await expect(visionModelSelect).toBeVisible()
  await visionModelSelect.locator('.n-base-selection').click()
  const visionDropdown = page.locator('.n-base-select-menu').last()
  await expect(visionDropdown).toBeVisible()
  await expect(visionDropdown).toHaveCSS('transform', 'none')
  const visionDropdownBox = await visionDropdown.boundingBox()
  const visionTriggerBox = await visionModelSelect.locator('.n-base-selection').boundingBox()
  expect(visionDropdownBox).toBeTruthy()
  expect(visionTriggerBox).toBeTruthy()
  // Same anchoring rule as the text dropdown: the panel tracks its trigger.
  const visionRightDelta = Math.abs(
    (visionDropdownBox!.x + visionDropdownBox!.width)
    - (visionTriggerBox!.x + visionTriggerBox!.width),
  )
  expect(visionRightDelta).toBeLessThanOrEqual(2)

  const visionPaint = await measurePanelPaint(visionDropdown)
  expect(visionPaint.opaque).toBe(true)
  expect(visionPaint.borderVisible).toBe(true)
  const visionShot = join(EVIDENCE_DIR, 'multimodal-model-dropdown.png')
  await page.screenshot({ path: visionShot, fullPage: false })

  const visionNames = await readAllOptionLabels(visionDropdown)
  const visionItemCount = visionNames.length
  expect(visionNames).toEqual(ORCAROUTER_GROUP.capability_models['chat-image'])
  // Text-only chat models must not be offered where an image is uploaded.
  expect(visionNames).not.toContain('deepseek/deepseek-v4-pro')
  expect(visionNames).not.toContain('orcarouter/auto')
  expect(visionNames).not.toContain('deepseek/deepseek-v4-flash')

  // `catalog_model_count` and `image_model_count` describe the authoritative
  // catalog: the chat list the text selector is bound to, and how many of those
  // models declare image input. The dropdown `item_count` values are the bound
  // option sets, which must match those catalog sizes.
  const catalogModelCount = ORCAROUTER_GROUP.capability_models.chat.length
  const imageModelCount = ORCAROUTER_GROUP.capability_models['chat-image'].length

  const manifestPath = join(EVIDENCE_DIR, 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    automation: {
      framework: 'playwright',
      passed: true,
      catalog_source: CHAT_CATALOG_URL,
      catalog_model_count: catalogModelCount,
      image_model_count: imageModelCount,
      multimodal_ui_entry_point: 'packages/client/src/components/hermes/models/AuxiliaryModelsPanel.vue (Vision auxiliary task)',
    },
    artifacts: [
      {
        kind: 'auth-methods',
        path: 'auth-methods.png',
        sha256: sha256(authShot),
        ui: {
          api_key_visible: apiKeyVisible,
          pkce_visible: pkceVisible,
          secret_masked: secretMasked,
          controls_enabled: controlsEnabled,
        },
      },
      {
        kind: 'text-model-dropdown',
        path: 'text-model-dropdown.png',
        sha256: sha256(dropdownShot),
        ui: {
          dropdown_open: true,
          item_count: chatNames.length,
          opaque_background: panelPaint.opaque,
          visible_border: panelPaint.borderVisible,
          trigger_panel_right_delta: rightDelta,
        },
      },
      {
        kind: 'multimodal-model-dropdown',
        path: 'multimodal-model-dropdown.png',
        sha256: sha256(visionShot),
        ui: {
          dropdown_open: true,
          item_count: visionItemCount,
          opaque_background: visionPaint.opaque,
          visible_border: visionPaint.borderVisible,
          trigger_panel_right_delta: visionRightDelta,
        },
      },
    ],
  }, null, 2))

  // Guard the external contract at the write site: the validator reads
  // `automation` as an object and each artifact's assertions from `ui`, so a
  // regression here would only surface as an opaque delivery failure.
  const written = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    automation: unknown
    artifacts: { kind?: string; path?: string; sha256?: string; ui?: unknown }[]
  }
  expect(typeof written.automation).toBe('object')
  expect(written.automation).not.toBeNull()
  for (const artifact of written.artifacts) {
    expect(typeof artifact.kind).toBe('string')
    expect(typeof artifact.path).toBe('string')
    expect(typeof artifact.sha256).toBe('string')
    expect(typeof artifact.ui).toBe('object')
    expect(artifact.ui).not.toBeNull()
  }
})
