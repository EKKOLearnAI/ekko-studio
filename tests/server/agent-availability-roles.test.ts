import { beforeEach, describe, expect, it } from 'vitest'
import Koa from 'koa'
import type { Context } from 'koa'
import { agentStatusRoutes } from '../../packages/server/src/modules/studio/routes/agent-status'
import { getAgentAvailabilitySnapshot, isAgentAvailable, resetAgentStatusRegistryForTests, updateAgentStatus } from '../../packages/server/src/modules/studio/public/agent-status-registry'

// Exercise the registered route chain and its actual role middleware, without a server or JWT fixtures.
async function request(path: string, role: 'user' | 'admin' | 'super_admin') {
  const ctx = { method: 'GET', path, request: {}, state: { user: { role } }, status: 200, app: new Koa() } as unknown as Context
  await agentStatusRoutes.routes()(ctx, async () => {})
  return ctx
}

describe('Agent availability role boundary', () => {
  beforeEach(resetAgentStatusRegistryForTests)
  it.each(['user', 'admin', 'super_admin'] as const)('exposes only public execution eligibility to %s', async role => {
    updateAgentStatus('hermes', { installed: true, source: 'managed-runtime', path: '/private/fake/hermes', version: 'test', error: 'private diagnostic' })
    const ctx = await request('/api/agents/availability', role)
    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual(getAgentAvailabilitySnapshot())
    for (const record of (ctx.body as ReturnType<typeof getAgentAvailabilitySnapshot>).agents) {
      expect(Object.keys(record).sort()).toEqual(['available', 'id', 'installed', 'source'])
      expect(record.available).toBe(isAgentAvailable(record.id))
    }
    expect(JSON.stringify(ctx.body)).not.toContain('/private/')
    expect(JSON.stringify(ctx.body)).not.toContain('private diagnostic')
  })
  it.each(['user', 'admin'] as const)('retains the private status denial for %s', async role => {
    const ctx = await request('/api/agents/status', role)
    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({ error: 'Super administrator privileges are required' })
  })
  it('keeps full status accessible to super administrators', async () => {
    updateAgentStatus('hermes', { path: '/private/fake/hermes' })
    const ctx = await request('/api/agents/status', 'super_admin')
    expect(ctx.status).toBe(200)
    expect(JSON.stringify(ctx.body)).toContain('/private/fake/hermes')
  })
  it('distinguishes installed Hermes metadata from execution eligibility', async () => {
    updateAgentStatus('hermes', { installed: true, source: 'user-cli', path: '' })
    const ctx = await request('/api/agents/availability', 'user')
    expect((ctx.body as ReturnType<typeof getAgentAvailabilitySnapshot>).agents.find(a => a.id === 'hermes')).toEqual({ id: 'hermes', installed: true, source: 'user-cli', available: false })
    updateAgentStatus('codex', { installed: true, source: 'user-cli', path: '' })
    expect(getAgentAvailabilitySnapshot().agents.find(a => a.id === 'codex')?.available).toBe(true)
    expect(getAgentAvailabilitySnapshot().agents.find(a => a.id === 'ekko-agent')?.available).toBe(true)
  })
})
