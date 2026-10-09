import { expect, type Page } from '@playwright/test'

export async function selectNewChatAgent(page: Page, label: string) {
  const cards = page.locator('.agent-card').filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
  await expect(cards.first()).toBeAttached()
  await cards.nth((await cards.count()) === 3 ? 1 : 0).click()
  await expect(page.locator('.agent-card.active')).toHaveText(label)
}

export async function sendNewChatMessage(page: Page, text = 'First message') {
  const draft = page.locator('.new-chat-page')
  await draft.locator('textarea').fill(text)
  await draft.getByRole('button', { name: 'Send', exact: true }).click()
}

export async function selectNewChatLaunchMode(page: Page, mode: 'global' | 'scoped') {
  const group = page.locator('.new-chat-page').getByRole('radiogroup', { name: 'Launch mode', exact: true })
  const option = group.getByRole('radio', { name: mode === 'global' ? 'Global' : 'Model', exact: true })
  await option.click()
  await expect(option).toHaveAttribute('aria-checked', 'true')
}

export async function expectNewChatEffectsMoving(page: Page) {
  const points = page.locator('.agent-card-effects .agent-card-ember')
  await expect(points).toHaveCount(24)
  await expect.poll(() => points.evaluateAll(elements => elements.filter(el => Number(getComputedStyle(el).opacity) > .15).length)).toBeGreaterThan(3)
  const initial = await points.evaluateAll(elements => elements.map(el => el.getBoundingClientRect().top))
  await expect.poll(() => points.evaluateAll((elements, before) => elements.filter((el, index) =>
    before[index] - el.getBoundingClientRect().top > 1.5 && Number(getComputedStyle(el).opacity) > .15).length, initial)).toBeGreaterThan(8)
  await expect(points.first()).toHaveCSS('pointer-events', 'none')
  await expect(page.locator('.agent-card-effects')).toHaveCSS('z-index', '12')
}
