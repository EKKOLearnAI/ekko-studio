import { expect, it, vi } from 'vitest'
vi.mock('../../packages/server/src/modules/studio/public/provider-account', () => ({ providerAccountId: () => 1, providerRequestProfile: () => 'default' }))
import { AgentTargetRegistry } from '../../packages/server/src/modules/coding-agents/protocol/target-registry'

it('indexes updated targets by credential and route, and removes both indexes on disposal', () => {
  const registry = new AgentTargetRegistry(input => [input.model])
  const input = { provider: 'deepseek', model: 'model', baseUrl: 'https://upstream.invalid/v1', apiKey: 'first' }
  const first = registry.register(input)
  const updated = registry.register({ ...input, apiKey: 'second' })
  expect(updated.token).toBe(first.token)
  expect(registry.find(first.routeKey)?.apiKey).toBe('second')
  expect(registry.findByToken(first.token)?.apiKey).toBe('second')
  expect(registry.removeWhere(value => value.token === first.token)).toBe(1)
  expect(registry.find(first.routeKey)).toBeNull()
  expect(registry.findByToken(first.token)).toBeNull()
})

it('keeps an older saved credential usable beside a newly prepared credential for the same session', () => {
  const registry = new AgentTargetRegistry(input => [input.model])
  const input = { provider: 'deepseek', model: 'model', baseUrl: 'https://upstream.invalid/v1', apiKey: 'current-key' }
  const current = registry.register(input)
  const older = registry.register(input, { token: 'hwui_old_saved_credential' })
  expect(older.token).toBe('hwui_old_saved_credential')
  expect(older.routeKey).not.toBe(current.routeKey)
  expect(registry.findByToken(current.token)).toBe(current)
  expect(registry.findByToken(older.token)).toBe(older)
  registry.removeWhere(target => target.token === older.token)
  expect(registry.findByToken(current.token)).toBe(current)
  expect(registry.findByToken(older.token)).toBeNull()
})
