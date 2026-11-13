import { expect, it } from 'vitest'
import { personTaskIdentity } from '../../packages/client/src/utils/person-task-identity'
import type { PersonAgentPreset } from '../../packages/client/src/api/person'

const selection = { runtime: 'codex', mode: 'scoped' as const, profile: 'default', provider: 'fixture', model: 'test', reasoningEffort: '' }
const agents: PersonAgentPreset[] = [{ id: 'backend', name: '后端工程师', description: '', selection }]
const task = (value: unknown, execution?: unknown) => ({ selection_json: JSON.stringify(value), execution_selection_json: execution ? JSON.stringify(execution) : null })
it('uses the execution snapshot after rename/removal, including historical executions', () => {
  expect(personTaskIdentity(task(selection, { ...selection, agentId: 'deleted', agentName: '原执行器' }), agents).name).toBe('原执行器')
  expect(personTaskIdentity(task({ ...selection, agentId: 'backend' }), agents).name).toBe('后端工程师')
})
it('resolves old tasks only from a unique full configuration, never runtime/model alone', () => {
  expect(personTaskIdentity(task(selection), agents).name).toBe('后端工程师')
  expect(personTaskIdentity(task(selection), [...agents, { ...agents[0], id: 'frontend', name: '前端工程师' }]).name).toBe('Codex')
  expect(personTaskIdentity(task({ runtime: 'codex' }), agents).name).toBe('Codex')
  expect(personTaskIdentity(task({ ...selection, profile: 'other' }), agents).name).toBe('Codex')
})
it('keeps the runtime logo and handles malformed or absent historical selections', () => {
  const identity = personTaskIdentity(task({ ...selection, agentName: '后端工程师' }))
  expect(identity.name).toBe('后端工程师')
  expect(identity.avatar?.label).toBe('Codex')
  expect(personTaskIdentity({ selection_json: '{' }).avatar).toBeNull()
  expect(personTaskIdentity({ selection_json: 'null' }).name).toBe('')
  expect(personTaskIdentity(task({ runtime: 'external-worker' }))).toEqual({ avatar: null, name: 'external-worker' })
})
