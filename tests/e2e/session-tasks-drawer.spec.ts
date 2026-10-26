import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

const description = '任务列表从单聊顶部打开，统一查看会话中的任务、进展与完成状态。'.repeat(12)
const tasks = [
  { id: 'design', session_id: 'conversation', session_title: 'Studio 会话任务', profile: 'research', source: 'coding_agent', agent: 'codex',
    title: '设计任务展示页面', summary: description, status: 'open', updated_at: Date.now(), message_id: 51 },
  { id: 'build', session_id: 'conversation', session_title: 'Studio 会话任务', profile: 'research', source: 'coding_agent', agent: 'codex',
    title: '修复 GitHub 构建失败', summary: '补齐路由测试，构建已通过验证。', status: 'completed', updated_at: Date.now() - 120_000, message_id: 53 },
  { id: 'ledger', session_id: 'conversation', session_title: '看下任务页的消息定位和列表展示', profile: 'default', source: 'builtin_agent', agent: 'ekko-agent',
    title: '接入会话任务记录', summary: '支持一个会话中的多个任务，并保留原始请求与完成轮次的关联。', status: 'completed', updated_at: Date.now() - 600_000, message_id: 55 },
]
async function setup(page: Page, brightness: 'light' | 'dark' = 'light') {
  await authenticate(page)
  await page.addInitScript(() => localStorage.setItem('hermes_locale', 'zh'))
  await mockHermesApi(page, { theme: { brightness } })
  await mockChatSocket(page)
  let reads = 0
  await page.route('**/api/studio/session-tasks?**', route => {
    reads++
    return route.fulfill({ json: { tasks, total: tasks.length, has_more: false } })
  })
  return () => reads
}
for (const width of [1440, 390]) {
  test(`fills a ${width}px task drawer and expands descriptions without navigating`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const reads = await setup(page)
    await page.goto('/#/hermes/chat')
    const entry = page.locator('.chat-header').getByRole('button', { name: '任务', exact: true })
    await entry.click()
    const drawer = page.locator('.session-tasks-drawer')
    await expect(drawer).toBeVisible()
    await expect(drawer.locator('.task-row')).toHaveCount(3)
    const sourceName = drawer.locator(width === 390 ? '.mobile-session-name' : '.source-session div > span')
    await expect(sourceName.nth(2)).toHaveText(tasks[2].session_title)
    await expect(entry).toHaveAttribute('aria-expanded', 'true')
    await expect(drawer).toHaveCSS('width', width === 1440 ? '1200px' : '390px')
    expect((await drawer.boundingBox())!.y + (await drawer.boundingBox())!.height).toBe(900)
    await expect(entry.locator('svg')).toHaveAttribute('width', '16')
    await expect(drawer.locator('.drawer-title svg')).toHaveAttribute('width', '18')
    if (width === 390) {
      const filter = await drawer.getByRole('button', { name: '筛选任务状态' }).boundingBox()
      expect(Math.round(width - filter!.x - filter!.width)).toBe(20)
      const row=drawer.locator('.task-row').first()
      const avatar=(await row.locator('.mobile-source img').boundingBox())!
      const name=(await row.locator('.mobile-session-name').boundingBox())!
      const meta=(await row.locator('.mobile-meta').boundingBox())!
      expect(avatar.width).toBe(34)
      expect(name.x).toBeGreaterThanOrEqual(avatar.x+avatar.width)
      expect(meta.x).toBe(name.x)
      expect(meta.y).toBeGreaterThanOrEqual(name.y+name.height)
      await expect(row.locator('.status-cell')).toBeHidden()
      await expect(row.locator('.mobile-meta .task-status')).toBeVisible()
      await expect(row.locator('.mobile-meta .mobile-time')).toBeVisible()
    }
    const bounds = await drawer.locator('.task-list').boundingBox()
    expect(bounds?.width).toBe(width === 1440 ? 1200 : 390)
    expect(await drawer.locator('.task-list-scroll').evaluate(el => el.clientHeight)).toBeGreaterThan(760)
    await expect(drawer.locator('.task-open svg')).toHaveCount(3)
    expect(await drawer.innerText()).not.toMatch(/[⌄↓↑●○›]/)
    const detail = drawer.locator('.task-description').first()
    const text = detail.locator('.description-text')
    const collapsed = await text.evaluate(el => el.getBoundingClientRect().height)
    await page.screenshot({ path: `/tmp/ekko-task-drawer-${width}.png` })
    await detail.locator('summary').click()
    await expect(detail).toHaveAttribute('open', '')
    expect(await text.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThan(collapsed * 3)
    const titleBounds = (await drawer.locator('.task-title').first().boundingBox())!
    const textBounds = (await text.boundingBox())!
    expect(Math.abs(textBounds.x - titleBounds.x)).toBeLessThan(1)
    expect(Math.abs(textBounds.width - titleBounds.width)).toBeLessThan(1)
    await expect.poll(async () => {
      const iconBounds = (await detail.locator('svg').boundingBox())!
      return iconBounds.y - textBounds.y - textBounds.height
    }).toBeGreaterThanOrEqual(1)
    await expect(page).toHaveURL(/hermes\/chat\?tasks=1$/)
    await page.screenshot({ path: `/tmp/ekko-task-drawer-${width}-expanded.png` })
    await detail.locator('summary').click()
    await expect(detail).not.toHaveAttribute('open', '')
    expect(await text.evaluate(el => el.getBoundingClientRect().height)).toBe(collapsed)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    await expect(entry).toBeFocused()
    const before = reads()
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(reads).toBe(before)
    await entry.click()
    await expect(drawer).toBeVisible()
  })
}
test('renders the full task drawer in the dark preset', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await setup(page, 'dark')
  await page.goto('/#/hermes/chat?tasks=1')
  await expect(page.locator('.task-row')).toHaveCount(3)
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.screenshot({ path: '/tmp/ekko-task-drawer-dark.png' })
})
