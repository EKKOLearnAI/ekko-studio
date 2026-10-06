import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY, TEST_MODEL_GROUP } from './fixtures'

for (const [name, metadata, max] of [
  ['advertised effort levels', { reasoning: true, reasoning_efforts: ['low', 'high', 'max'] }, 3],
  ['no reasoning support', { reasoning: false, reasoning_efforts: [] }, 0],
  ['unknown capabilities', {}, 7],
] as const) {
  test(`chat uses ${name} from the selected model and forwards the chosen effort`, async ({ page }) => {
    await authenticate(page, TEST_ACCESS_KEY)
    await mockHermesApi(page, { modelGroups: [{ ...TEST_MODEL_GROUP, model_meta: { 'test-model': metadata } }] })
    await mockChatSocket(page)
    await page.goto('/#/hermes/chat')
    const input = page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)')
    await input.fill('Start a session')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.filter((item: any) => item.event === 'run').length || 0)).toBe(1)
    await page.evaluate(() => {
      const state = (window as any).__PW_CHAT_SOCKET__
      const run = state.emitted.find((item: any) => item.event === 'run').payload
      state.latest.__trigger('run.completed', { event: 'run.completed', session_id: run.session_id, run_id: 'first-run', output: 'Ready' })
    })
    await page.locator('.reasoning-effort-button').click()
    const slider = page.getByRole('slider')
    await expect(slider).toHaveAttribute('aria-valuemax', String(max))
    if (max === 0) {
      await expect(slider).toHaveAttribute('aria-disabled', 'true')
    } else {
      await slider.focus()
      for (let step = 0; step < max; step++) await page.keyboard.press('ArrowRight')
      await expect(page.locator('.reasoning-effort-button')).toHaveAttribute('aria-label', /max/i)
    }
    await input.click()
    await input.fill('Use selected effort')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.filter((item: any) => item.event === 'run').length || 0)).toBe(2)
    const effort = await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((item: any) => item.event === 'run')[1].payload.reasoning_effort)
    expect(effort).toBe(max ? 'max' : undefined)
  })
}
