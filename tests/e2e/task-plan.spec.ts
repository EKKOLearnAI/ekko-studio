import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const now = Date.now()
const plan = {
  session_id: 'plan-session', run_id: 'plan-run', plan_id: 'plan-run', revision: 1,
  execution_state: 'running', created_at: now, updated_at: now,
  plan: [
    { id: 'inspect', step: 'Inspect existing implementation', status: 'pending' },
    { id: 'build', step: 'Build the task plan card', status: 'pending' },
    { id: 'verify', step: 'Verify refresh recovery', status: 'pending' },
  ],
}

test('updates one plan card live and preserves unfinished work on stop with tool traces hidden', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(() => localStorage.setItem('hermes_show_tool_calls', 'false'))
  await mockHermesApi(page)
  await mockChatSocket(page)
  await page.goto('/#/hermes/chat')
  await page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)').fill('Implement task planning')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const run = await (await page.waitForFunction(() => (window as any).__PW_CHAT_SOCKET__?.emitted.find((entry: any) => entry.event === 'run')?.payload)).jsonValue()
  const active = { ...plan, session_id: run.session_id, created_at: Date.now(), updated_at: Date.now() }
  await page.evaluate(p => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: p.session_id, run_id: p.run_id })
    socket.__trigger('plan.updated', { event: 'plan.updated', ...p })
  }, active)
  const card = page.getByTestId('task-plan-card')
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('0/3 completed')
  // Output can grow for a long time without another update_plan call.
  await page.evaluate(p => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('message.delta', { event: 'message.delta', session_id: p.session_id, run_id: p.run_id, delta: 'Progress after the plan was created.' })
  }, active)
  const progress = page.getByText('Progress after the plan was created.', { exact: true })
  await expect(progress).toBeVisible()
  await expect.poll(async () => {
    const outputBox = await progress.boundingBox()
    const planBox = await card.boundingBox()
    return !!outputBox && !!planBox && planBox.y >= outputBox.y + outputBox.height
  }).toBe(true)
  await page.evaluate(p => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('message.delta', { event: 'message.delta', session_id: p.session_id, run_id: p.run_id,
      delta: '\n\n' + Array.from({ length: 60 }, (_, i) => `Long task progress ${i}`).join('\n\n') })
  }, active)
  await expect(card).toBeInViewport()
  await page.evaluate(p => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('plan.updated', { event: 'plan.updated', ...p, revision: 2,
      plan: p.plan.map((step, i) => ({ ...step, status: i === 0 ? 'completed' : i === 1 ? 'in_progress' : 'pending' })) })
    socket.__trigger('plan.updated', { event: 'plan.updated', ...p })
  }, active)
  await expect(card).toContainText('1/3 completed')
  await expect(card).toContainText('In progress')
  await page.evaluate(p => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('plan.updated', { event: 'plan.updated', ...p, revision: 3, execution_state: 'interrupted',
      plan: p.plan.map((step, i) => ({ ...step, status: i === 0 ? 'completed' : 'pending' })) })
    socket.__trigger('abort.completed', { event: 'abort.completed', session_id: p.session_id, run_id: p.run_id, synced: true })
  }, active)
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('Interrupted; unfinished steps remain')
  await expect(card.locator('.pending')).toHaveCount(2)
  await card.getByRole('button').click()
  await expect(card.locator('ol')).toHaveCount(0)
  await card.getByRole('button').click()
  await expect(card.locator('li')).toHaveCount(3)
})

for (const agent of ['ekko-agent', 'codex']) {
  test(`restores a ${agent} completed plan from a resume snapshot after reload`, async ({ page }) => {
    await authenticate(page, TEST_ACCESS_KEY, 'research')
    const completed = { ...plan, plan_id: agent === 'codex' ? 'mcp:codex-turn-context' : plan.plan_id, execution_state: 'ended', revision: 4,
      plan: plan.plan.map(step => ({ ...step, status: 'completed' })) }
    await page.addInitScript(p => {
      ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = {
        [p.session_id]: {
          session_id: p.session_id, isWorking: false, events: [], taskPlans: [p],
          messages: [
            { id: 1, role: 'user', content: 'Implement task planning', timestamp: p.created_at / 1000 - 1 },
            { id: 2, role: 'assistant', content: 'Task planning is ready', run_marker: p.run_id, timestamp: p.created_at / 1000 + 1 },
          ],
        },
      }
      localStorage.setItem('hermes_show_tool_calls', 'false')
    }, completed)
    await mockHermesApi(page, { sessions: [{ id: plan.session_id, profile: 'research', source: 'coding_agent', agent,
      model: 'test-model', title: 'Task plan session', preview: 'Implement task planning', started_at: now / 1000,
      ended_at: now / 1000 + 1, last_active: now / 1000 + 1, message_count: 2, tool_call_count: 1, input_tokens: 0, output_tokens: 0 }] })
    await mockChatSocket(page)
    await page.goto(`/#/hermes/session/${plan.session_id}`)
    await expect(page.getByTestId('task-plan-card')).toContainText('3/3 completed')
    await page.reload()
    await expect(page.getByTestId('task-plan-card')).toHaveCount(1)
    await expect(page.getByTestId('task-plan-card')).toContainText('3/3 completed')
    await expect(page.getByText('Task planning is ready', { exact: true })).toBeVisible()
    await expect.poll(async () => {
      const outputBox = await page.getByText('Task planning is ready', { exact: true }).boundingBox()
      const planBox = await page.getByTestId('task-plan-card').boundingBox()
      return !!outputBox && !!planBox && planBox.y >= outputBox.y + outputBox.height
    }).toBe(true)
    await page.setViewportSize({ width: 390, height: 844 })
    const card = page.getByTestId('task-plan-card')
    await expect(card).toBeVisible()
    const width = await card.evaluate(el => el.scrollWidth <= el.clientWidth)
    expect(width).toBe(true)
  })

}


test('keeps two successive Hermes turn plans as separate cards', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  await mockChatSocket(page)
  await page.goto('/#/hermes/chat')
  const input = page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)')
  for (const turn of [1, 2]) {
    await input.fill(`Show task card ${turn}`)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await page.waitForFunction(n => (window as any).__PW_CHAT_SOCKET__?.emitted.filter((entry: any) => entry.event === 'run').length >= n, turn)
    await page.evaluate(({ p, turn }) => {
      const socket = (window as any).__PW_CHAT_SOCKET__.latest
      const sid = (window as any).__PW_CHAT_SOCKET__.emitted.filter((entry: any) => entry.event === 'run').at(-1).payload.session_id
      const snapshot = { ...p, session_id: sid, run_id: `cli-turn-${turn}`, plan_id: `mcp:turn-${turn}`, created_at: p.created_at + turn * 1000 }
      socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: snapshot.run_id })
      socket.__trigger('plan.updated', { event: 'plan.updated', ...snapshot })
      socket.__trigger('plan.updated', { event: 'plan.updated', ...snapshot, revision: 2, execution_state: 'ended', plan: p.plan.map(step => ({ ...step, status: 'completed' })) })
      socket.__trigger('run.completed', { event: 'run.completed', session_id: sid, run_id: snapshot.run_id })
    }, { p: plan, turn })
    await expect(page.getByTestId('task-plan-card')).toHaveCount(turn)
  }
  for (const card of await page.getByTestId('task-plan-card').all()) await expect(card).toContainText('3/3 completed')
})
