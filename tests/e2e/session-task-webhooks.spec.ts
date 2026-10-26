import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'
import en from '../../packages/client/src/i18n/locales/en'
import zh from '../../packages/client/src/i18n/locales/zh'

for (const [locale, messages, brightness] of [['en', en, 'light'], ['zh', zh, 'dark']] as const) {
  test(`saves session-task webhook subscriptions and content preferences in ${locale}`, async ({ page }, testInfo) => {
    await authenticate(page, TEST_ACCESS_KEY, 'research')
    await page.addInitScript(({ locale, brightness }) => {
      localStorage.setItem('hermes_locale', locale)
      localStorage.setItem('hermes_brightness', brightness)
    }, { locale, brightness })
    await mockHermesApi(page)
    await mockChatSocket(page)
    let endpoint: Record<string, any> | null = null
    const saved: Array<Record<string, any>> = []
    await page.route('**/api/studio/webhooks/endpoints', async route => {
      if (route.request().method() === 'POST') {
        const payload = route.request().postDataJSON()
        saved.push(payload)
        endpoint = { ...payload, id: 'task-hook', has_secret: false,
          runtime: { state: 'idle', queued: 0, active: 0 }, created_at: Date.now(), updated_at: Date.now() }
        await route.fulfill({ status: 201, json: { endpoint } })
      } else await route.fulfill({ json: { endpoints: endpoint ? [endpoint] : [] } })
    })
    await page.route('**/api/studio/webhooks/endpoints/task-hook', async route => {
      const payload = route.request().postDataJSON()
      saved.push(payload)
      endpoint = { ...endpoint, ...payload }
      await route.fulfill({ json: { endpoint } })
    })
    await page.route('**/api/studio/webhooks/local-test-events', route => route.fulfill({ json: { events: [] } }))
    await page.goto('/#/hermes/settings?tab=webhooks')
    const copy = messages.settings.webhooks
    const panel = page.locator('.webhook-settings')
    await expect(panel).toBeVisible()
    await panel.getByRole('button', { name: copy.actions.add, exact: true }).click()
    const create = page.getByRole('dialog').filter({ hasText: copy.createTitle })
    await create.locator('.n-form-item').filter({ hasText: copy.form.name }).getByRole('textbox').fill('Session tasks')
    await create.locator('.n-form-item').filter({ hasText: copy.form.url }).getByRole('textbox').fill('https://example.com/tasks')
    await expect(create).toContainText(copy.events.taskCreated)
    await expect(create).toContainText(copy.events.taskCompleted)
    await create.getByRole('button', { name: messages.common.save, exact: true }).click()
    await expect(create).toBeHidden()
    expect(saved[0].event_types).toEqual(expect.arrayContaining(['chat.task.created', 'chat.task.completed']))
    expect(saved[0].include_content).toBe(false)
    await panel.getByRole('button', { name: messages.common.edit, exact: true }).click()
    const edit = page.getByRole('dialog').filter({ hasText: copy.editTitle })
    const completedTag = edit.locator('.n-tag').filter({ hasText: copy.events.taskCompleted })
    await completedTag.getByRole('button', { name: 'close', exact: true }).click()
    await expect(edit).not.toContainText(copy.events.taskCompleted)
    const content = edit.locator('.n-form-item').filter({ hasText: copy.form.includeContent }).getByRole('switch')
    await content.click()
    await expect(edit).toContainText(copy.form.includeContentHint)
    await page.screenshot({ path: testInfo.outputPath(`task-webhooks-${locale}.png`), animations: 'disabled' })
    await edit.getByRole('button', { name: messages.common.save, exact: true }).click()
    await expect(edit).toBeHidden()
    expect(saved[1].event_types).toContain('chat.task.created')
    expect(saved[1].event_types).not.toContain('chat.task.completed')
    expect(saved[1].include_content).toBe(true)
    await page.reload()
    await panel.getByRole('button', { name: messages.common.edit, exact: true }).click()
    await expect(edit).toContainText(copy.events.taskCreated)
    await expect(edit).not.toContainText(copy.events.taskCompleted)
    await expect(content).toBeChecked()
  })
}
