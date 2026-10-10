import { beforeEach, describe, expect, it, vi } from 'vitest'

const getModels = vi.hoisted(() => vi.fn())
vi.mock('../../packages/server/src/modules/coding-agents/services', () => ({ getCodingAgentModels: getModels }))
import { models } from '../../packages/server/src/modules/coding-agents/controllers/models'

beforeEach(() => { getModels.mockReset() })

describe('Coding Agent model discovery controller', () => {
  it('uses the same aggregate response for single and all-agent queries', async () => {
    getModels.mockResolvedValue({ agents: [] })
    for (const query of [{}, { agent: 'codex', refresh: 'true' }]) {
      const ctx = { query, set: vi.fn(), body: undefined }
      await models(ctx as any)
      expect(getModels).toHaveBeenLastCalledWith({ agent: (query as any).agent, refresh: (query as any).refresh === 'true' })
      expect(ctx.body).toEqual({ agents: [] })
      expect(ctx.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    }
  })

  it.each([{ agent: ['codex'] }, { agent: '' }, { refresh: '1' }, { refresh: ['true'] }])('rejects invalid query %j', async query => {
    const ctx = { query, status: 200, body: undefined }
    await models(ctx as any)
    expect(ctx.status).toBe(400)
    expect(getModels).not.toHaveBeenCalled()
  })

  it('returns only a generic error if platform initialization fails', async () => {
    getModels.mockRejectedValue(new Error('secret-token in platform output'))
    const ctx = { query: {}, set: vi.fn(), status: 200, body: undefined }
    await models(ctx as any)
    expect(ctx.status).toBe(500)
    expect(ctx.body).toEqual({ error: 'Unable to discover coding agent models' })
  })
})
