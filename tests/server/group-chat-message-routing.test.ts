import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveJevSettings, deleteJevSettings } from '../../packages/server/src/modules/studio/services/jev/settings'
import { GroupMessageRoutingService, type GroupRoutingDecision } from '../../packages/server/src/modules/studio/services/group-chat/message-routing'

const response = { model: 'jev', usage: {}, answers: {
  target: { type: 'choice', choice: 'agent-1', confidence: .98, probabilities: { 'agent-1': .98, none: .02 } },
  handoff_complete: { type: 'noul', noul: .99 }, repeated_loop: { type: 'noul', noul: .01 },
} }
const candidates = [{ id: 'agent-1', name: 'Analyst', description: 'Analyze logs' }]
const services: GroupMessageRoutingService[] = []
async function idle(service: GroupMessageRoutingService) {
  await vi.waitFor(() => expect((service as any).sidecar.status()).toMatchObject({ logicalActive: 0, queued: 0 }))
}
function harness(profile = 'default') {
  const decisions: GroupRoutingDecision[] = []
  const room = { id: 'room', summaryProfile: profile }
  const message = { id: 'm1', roomId: 'room', senderId: 'user', senderName: 'Alice', content: 'Please analyze logs', timestamp: 1, mentions: [] }
  const claim = vi.fn((decision: GroupRoutingDecision) => {
    const next = { ...decision, status: 'queued' as const, queueId: 'q1' }
    decisions.push(next)
    return next
  })
  const storage = { getRoom: () => room, getMessage: () => message, getRoomAgents: () => [],
    getMessageRoutingDecision: () => decisions[0] || null,
    saveRoutingSuggestion: (decision: GroupRoutingDecision) => { decisions.push(decision); return true },
    claimAndEnqueueAutoRouting: claim }
  const service = new GroupMessageRoutingService(storage)
  services.push(service)
  return { service, decisions, message, room, claim, start: () => service.schedule({ ...message }, candidates) }
}

beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(response)))
  await saveJevSettings('default', { apiKey: 'key', groupMessageRoutingEnabled: true, groupMessageRoutingMode: 'suggest' })
})
afterEach(async () => {
  services.splice(0).forEach(service => (service as any).sidecar.close())
  vi.unstubAllGlobals()
  await deleteJevSettings('default')
  await deleteJevSettings('other')
})

describe('group JEV message routing', () => {
  it('stores a suggestion without executing it', async () => {
    const h = harness(); h.start(); await idle(h.service)
    expect(h.decisions[0]).toMatchObject({ status: 'suggested', targetAgentId: 'agent-1' })
    expect(h.claim).not.toHaveBeenCalled()
  })
  it('applies auto routing through the guarded storage port', async () => {
    await saveJevSettings('default', { groupMessageRoutingMode: 'auto' })
    const h = harness(); h.start(); await idle(h.service)
    expect(h.decisions[0]).toMatchObject({ status: 'queued', queueId: 'q1' })
    expect(h.claim).toHaveBeenCalledTimes(1)
  })
  it.each(['disabled', 'no-key', 'other-profile', 'mentions', 'no-candidates'])('makes zero requests for %s', async mode => {
    if (mode === 'disabled') await saveJevSettings('default', { groupMessageRoutingEnabled: false })
    if (mode === 'no-key') { await deleteJevSettings('default'); await saveJevSettings('default', { groupMessageRoutingEnabled: true }) }
    const h = harness(mode === 'other-profile' ? 'other' : 'default')
    h.service.schedule({ ...h.message, mentions: mode === 'mentions' ? [{ type: 'agent' }] : [] }, mode === 'no-candidates' ? [] : candidates)
    await idle(h.service)
    expect(fetch).not.toHaveBeenCalled()
    expect(h.decisions).toEqual([])
  })
  it.each(['disabled', 'mode', 'credential', 'message', 'profile'])('does not apply a late result after changing %s', async change => {
    await saveJevSettings('default', { groupMessageRoutingMode: 'auto' })
    let release!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { release = resolve })))
    const h = harness(); h.start()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    if (change === 'disabled') await saveJevSettings('default', { groupMessageRoutingEnabled: false })
    if (change === 'mode') await saveJevSettings('default', { groupMessageRoutingMode: 'suggest' })
    if (change === 'credential') await saveJevSettings('default', { apiKey: 'rotated' })
    if (change === 'message') h.message.content = 'Cancel this task'
    if (change === 'profile') h.room.summaryProfile = 'other'
    release(Response.json(response)); await idle(h.service)
    expect(h.decisions).toEqual([])
    expect(h.claim).not.toHaveBeenCalled()
  })
  it.each(['missing-handoff', 'missing-loop', 'invalid-noul', 'invalid-confidence', 'unknown-target', 'wrong-type', 'provider-error'])('preserves the baseline for %s', async fault => {
    await saveJevSettings('default', { groupMessageRoutingMode: 'auto' })
    const body: any = structuredClone(response)
    if (fault === 'missing-handoff') delete body.answers.handoff_complete
    if (fault === 'missing-loop') delete body.answers.repeated_loop
    if (fault === 'invalid-noul') body.answers.handoff_complete.noul = 2
    if (fault === 'invalid-confidence') body.answers.target.confidence = '0.98'
    if (fault === 'unknown-target') body.answers.target.choice = 'outsider'
    if (fault === 'wrong-type') body.answers.target.type = 'noul'
    vi.stubGlobal('fetch', vi.fn(async () => fault === 'provider-error' ? new Response('', { status: 503 }) : Response.json(body)))
    const h = harness(); h.start(); await idle(h.service)
    expect(h.claim).not.toHaveBeenCalled()
    expect(h.decisions).toEqual([])
  })
  it('discards a late provider response after the cumulative timeout', async () => {
    await saveJevSettings('default', { groupMessageRoutingMode: 'auto', groupMessageRoutingTimeoutMs: 100 })
    let release!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { release = resolve })))
    const h = harness(); h.start()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await idle(h.service)
    release(Response.json(response))
    await vi.waitFor(() => expect((h.service as any).sidecar.status().physicalRequests).toBe(0))
    expect(h.claim).not.toHaveBeenCalled()
  })
})
