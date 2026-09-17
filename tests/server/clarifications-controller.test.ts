import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestClarification } from '../../packages/server/src/modules/studio/controllers/clarifications'
import { setChatRunServer } from '../../packages/server/src/modules/studio/services/chat-run/server-registry'
import { ClarificationRuns } from '../../packages/server/src/modules/studio/services/clarification-runs'

afterEach(() => setChatRunServer(null))
const context = () => ({
  state: { profile: { name: 'research' } }, res: new EventEmitter(), status: 200, body: undefined as any,
  request: { body: { context_id: 'ctx', question: 'Which folder?', session_id: 'other-session' } },
})

describe('clarification HTTP controller', () => {
  it('binds the request to the authenticated profile and current turn, ignoring supplied session ids', async () => {
    const publish = vi.fn()
    const runs = new ClarificationRuns(publish)
    runs.begin('ctx', 'owned-session', 'research', () => ({ isWorking: true, activeRunMarker: 'turn' }))
    setChatRunServer({ requestClarification: runs.request.bind(runs) })
    const ctx = context()
    const pending = requestClarification(ctx as any)
    expect(publish).toHaveBeenCalledWith('owned-session', 'clarify.requested', expect.any(Object))
    runs.respond('owned-session', publish.mock.calls[0][2].clarify_id, 'src')
    await pending
    expect(ctx.body).toMatchObject({ ok: true, response: 'src', reason: 'response' })
    expect(ctx.res.listenerCount('close')).toBe(0)
    ctx.state.profile.name = 'other'
    await requestClarification(ctx as any)
    expect(ctx.status).toBe(409)
  })

  it('cancels the waiting prompt when the MCP HTTP connection closes', async () => {
    const publish = vi.fn()
    const runs = new ClarificationRuns(publish)
    runs.begin('ctx', 'owned-session', 'research', () => ({ isWorking: true, activeRunMarker: 'turn' }))
    setChatRunServer({ requestClarification: runs.request.bind(runs) })
    const ctx = context()
    const pending = requestClarification(ctx as any)
    ctx.res.emit('close')
    await pending
    expect(ctx.body).toMatchObject({ ok: true, response: '', reason: 'cancelled' })
  })

  it('reports missing context and unavailable service', async () => {
    const ctx = context()
    await requestClarification(ctx as any)
    expect(ctx.status).toBe(503)
    const request = vi.fn()
    setChatRunServer({ requestClarification: request })
    ctx.request.body.context_id = ''
    await requestClarification(ctx as any)
    expect(ctx.status).toBe(400)
    expect(request).not.toHaveBeenCalled()
  })
})
