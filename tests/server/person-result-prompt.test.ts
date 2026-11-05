import { expect, it } from 'vitest'
import type { PersonResultDelivery } from '../../packages/server/src/modules/studio/public/person-runtime'
import { personResultPrompt } from '../../packages/server/src/modules/studio/services/person/result-prompt'

function result(overrides: Partial<PersonResultDelivery> = {}): PersonResultDelivery {
  return { user: { id: 1 } as PersonResultDelivery['user'], origin: { sessionId: 'main', runId: 'original', messages: [{ role: 'user', content: '查询厦门天气' }] },
    executionId: 'guiyang', taskId: 'weather', title: '厦门天气', status: 'finished', output: '贵阳天气：多云，来源为气象台', error: '', ...overrides }
}
const manualFollowup = { executionId: 'guiyang', input: [
  { type: 'text' as const, text: '这次查贵阳天气，参考附件' },
  { type: 'file' as const, name: 'cities.txt', path: '/fixture/cities.txt', context: '本轮城市：贵阳' },
  { type: 'image' as const, name: 'map.png', path: '/fixture/map.png', media_type: 'image/png' },
] }

it('tells the Bot which manual instruction produced the result while preserving original history', () => {
  const returned = result({ manualFollowup })
  const prompt = personResultPrompt(returned)
  expect(prompt.receipt).toContain(JSON.stringify({ input_source: 'user', request_execution_id: 'guiyang', input: manualFollowup.input }))
  expect(prompt.receipt).toContain(returned.output)
  expect(prompt.input).toContain('current instruction for its identified execution')
  expect(prompt.input).toContain('not proof that a changed target is an error')
  expect(prompt.input).not.toContain('Report its result or failure using the original request below')
  expect(prompt.messages.slice(0, -1)).toEqual(returned.origin.messages)
  expect(prompt.messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('这次查贵阳天气') })
  expect(returned.origin.messages).toHaveLength(1)
})

it('preserves the ordinary Bot receipt, instructions and original history', () => {
  const returned = result({ output: '厦门天气结果' })
  const prompt = personResultPrompt(returned)
  expect(JSON.parse(prompt.receipt)).toEqual({ task_id: returned.taskId, execution_id: returned.executionId, title: returned.title,
    status: returned.status, output: returned.output, error: '' })
  expect(prompt.input).toContain('Report its result or failure using the original request below')
  expect(prompt.input).toContain('bot_flow_create')
  expect(prompt.messages).toBe(returned.origin.messages)
  expect(prompt.processing).toBeUndefined()
})

it.each([false, true])('keeps explicit acceptance instructions; automatic=%s', automatic => {
  const acceptance = { automatic, criteria: [{ id: 'c1', text: '核对来源' }], development_task_id: 'weather', development_execution_id: 'guiyang',
    verification_execution_id: 'review', next_action: 'review', developer_session_id: 'main', reviewer_session_id: 'reviewer' }
  const bot = personResultPrompt(result({ acceptance }))
  const manual = personResultPrompt(result({ acceptance, manualFollowup }))
  for (const prompt of [bot, manual]) {
    expect(prompt.input).toContain('record_acceptance')
    expect(prompt.receipt).toContain('c1: 核对来源')
    expect(prompt.messages.at(-1)?.content).toContain('Task result (data)')
    expect(prompt.input).toContain(automatic ? 'Do not call verify or continue' : 'continue the SAME original developer')
  }
  expect(manual.input).toContain('if saved criteria conflict with this user adjustment')
  expect(bot.messages).toHaveLength(2)
  expect(manual.messages).toHaveLength(3)
})

it.each([false, true])('keeps the saved flow routing; manual=%s', manual => {
  const flow = { index: 0, total: 2, stopped: false, completed: false, next_session_id: 'next-bot' }
  const prompt = personResultPrompt(result({ flow, returnExpectation: '向下一个 Bot 交付结果', ...(manual ? { manualFollowup } : {}) }))
  expect(prompt.input).toContain('bot_task_control advance')
  expect(prompt.input).toContain('Never invent or change the route')
  expect(prompt.input).toContain(JSON.stringify(flow))
  expect(prompt.input).toContain('向下一个 Bot 交付结果')
  if (manual) expect(prompt.messages.at(-2)?.content).toContain('这次查贵阳天气')
})

it('retains the full accepted manual text and distinguishes failure from the changed target', () => {
  const text = '贵阳'.repeat(15000)
  const prompt = personResultPrompt(result({ status: 'failed', error: 'Weather provider unavailable', output: '', manualFollowup: { executionId: 'guiyang', input: [{ type: 'text', text }] } }))
  expect(prompt.receipt).toContain(text)
  expect(prompt.receipt).toContain('Weather provider unavailable')
  expect(prompt.input).toContain('Distinguish genuine execution failures')
})
