import { afterEach, beforeEach, expect, it } from 'vitest'
import { acceptanceFixture, type AcceptanceFixture } from './fixtures/person-acceptance'
import { countTokens } from '../../packages/server/src/modules/studio/services/context-compressor'

let f: AcceptanceFixture

beforeEach(async () => {
  f = await acceptanceFixture()
})

afterEach(async context => {
  await f.close(context.task.name)
})

it('passes only the assigned Bot history to the worker and keeps the task in the person bot bucket', async () => {
  const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
  sessions.createSession({
    id: 'person-main-other',
    studio_user_id: 1,
    user_id: 1,
    title: 'Other Bot',
    workspace: f.workspace,
    source: 'builtin_agent',
    agent: 'ekko-agent',
    agent_preset: 'person',
    profile: 'default',
  })
  sessions.addMessage({ session_id: 'person-main-1', role: 'user', content: '当前 Bot 负责 Studio App 的菜单问题。' })
  sessions.addMessage({ session_id: 'person-main-1', role: 'assistant', content: '当前 Bot 已确认要保留任务计划和历史上下文。' })
  sessions.addMessage({ session_id: 'person-main-other', role: 'user', content: 'OTHER_BOT_SECRET should never reach this worker.' })
  sessions.addMessage({ session_id: 'person-main-2', role: 'user', content: 'OTHER_ACCOUNT_SECRET should never reach this worker.' })

  const { task } = await f.create({ title: '修复 Studio App 历史上下文', goal: '保留当前 Bot 的菜单任务上下文并完成修复。' })
  await f.run(task.id)

  const prompt = String(f.execute.mock.calls[0][0].prompt)
  expect(prompt).toContain('## Current Bot conversation history')
  expect(prompt).toContain('当前 Bot 已确认要保留任务计划和历史上下文')
  expect(prompt).toContain('person-main-1')
  expect(prompt).not.toContain('OTHER_BOT_SECRET')
  expect(prompt).not.toContain('OTHER_ACCOUNT_SECRET')
  expect(f.db.prepare('SELECT bot_id,session_id FROM session_tasks WHERE id=?').get(task.id)).toEqual({
    bot_id: 'person:1',
    session_id: 'person-main-1',
  })
  expect(f.store.listPersonTasks(2)).toEqual([])
})

it('bounds a long Bot history before passing it to the worker', async () => {
  const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
  for (let index = 0; index < 16; index++) {
    sessions.addMessage({
      session_id: 'person-main-1',
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `历史上下文 ${index}\n${'需要保留的背景信息。'.repeat(180)}`,
    })
  }
  const { task } = await f.create({ title: 'Bounded history', goal: 'Use the available current Bot context.' })
  await f.run(task.id)

  const prompt = String(f.execute.mock.calls[0][0].prompt)
  expect(prompt).toContain('## Current Bot conversation history')
  expect(prompt).toContain('历史上下文 15')
  expect(countTokens(prompt)).toBeLessThan(4_000)
}, 30_000)

it('omits the history section when the Bot has no messages', async () => {
  const empty = await f.create({ title: 'No history', goal: 'Run with no prior Bot messages.' })
  await f.run(empty.task.id)
  const emptyPrompt = String(f.execute.mock.calls[0][0].prompt)
  expect(emptyPrompt).not.toContain('## Current Bot conversation history')
  expect(emptyPrompt).toContain('Run with no prior Bot messages.')
}, 30_000)
