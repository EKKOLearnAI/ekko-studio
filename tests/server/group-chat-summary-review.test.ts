import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import { GroupSummaryReviewService, type GroupSummaryReviewRecord } from '../../packages/server/src/modules/studio/services/group-chat/summary-review'
import { saveJevSettings, deleteJevSettings } from '../../packages/server/src/modules/studio/services/jev/settings'
import type { GroupRoomSummary } from '../../packages/server/src/modules/studio/services/group-chat/room-summary'
import type { JevGenerationContext } from '../../packages/server/src/modules/studio/public/jev'

const response = (value: number) => ({ model: 'jev-test', usage: {}, answers: {
  missing_constraints: { type: 'noul', noul: value }, stale_or_overstated: { type: 'noul', noul: 0.1 }, unsupported_completion: { type: 'noul', noul: 0.1 },
} })

const services: GroupSummaryReviewService[] = []
async function idle(service: GroupSummaryReviewService) {
  await vi.waitFor(() => expect((service as any).sidecar.status()).toMatchObject({ queued: 0, logicalActive: 0 }))
}
function harness(options: { revision?: boolean; revise?: (input: unknown, context: JevGenerationContext) => Promise<string> } = {}) {
  let summary: GroupRoomSummary = { roomId: 'room-1', summary: 'Original summary', summaryThroughMessageId: 'm2',
    summaryThroughMessageTimestamp: 2, summarizedTurnCount: 2, status: 'success', version: 1, updatedAt: 3, lastError: null }
  const records: GroupSummaryReviewRecord[] = []
  const room = { id: 'room-1', summaryProfile: 'default', summaryGeneration: 0, ownerAuthUserId: 1 }
  const storage = {
    getRoom: () => room, getRoomSummary: () => summary, getLatestSummaryReview: () => records.at(-1) || null,
    applySummaryReviewOutcome: (input: any) => { if (input.revision) summary = { ...summary, summary: input.revision.nextText, version: summary.version + 1 }; records.push({ ...input.record, appliedRevisionVersion: input.revision ? summary.version : null }); return true },
  }
  const service = new GroupSummaryReviewService(storage, options.revise)
  services.push(service)
  service.schedule({ previous: { ...summary, summary: '', version: 0 }, summary, profile: 'default', messages: [
    { id: 'm1', role: 'user', senderName: 'Alice', timestamp: 1, content: 'Keep deadline Friday' },
    { id: 'm2', role: 'assistant', senderName: 'Agent', timestamp: 2, content: 'Done' },
  ] })
  return { records, service, get summary() { return summary } }
}

async function waitFor(check: () => boolean) { for (let i=0;i<100;i+=1) { if (check()) return; await new Promise(r=>setTimeout(r,5)) } throw new Error('timeout') }
beforeEach(async () => { await saveJevSettings('default', { apiKey: 'key', groupSummaryReviewEnabled: true }) })
afterEach(async () => {
  services.splice(0).forEach(service => (service as any).sidecar.close())
  vi.unstubAllGlobals(); await deleteJevSettings('default')
})

describe('group summary JEV review', () => {
  it('aborts revision generation when room work is canceled and ignores its late result', async () => {
    await saveJevSettings('default', { groupSummaryRevisionEnabled: true })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(response(.95))))
    let release!: (text: string) => void
    let signal: AbortSignal | undefined
    const state = harness({ revise: (_input, context) => {
      signal = context.signal
      return new Promise<string>(resolve => { release = resolve })
    } })
    await vi.waitFor(() => expect(signal).toBeDefined())
    state.service.cancelRoom('room-1')
    await idle(state.service)
    expect(signal?.aborted).toBe(true)
    release('Late revision')
    await vi.waitFor(() => expect((state.service as any).sidecar.status().physicalGenerations).toBe(0))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(state.records).toEqual([])
    expect(state.summary.summary).toBe('Original summary')
  })
  it.each(['review-off', 'revision-off', 'credential-rotated'])('does not start revision after %s during evaluation', async change => {
    await saveJevSettings('default', { groupSummaryRevisionEnabled: true })
    let release!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { release = resolve })))
    const revise = vi.fn(async () => 'Revised')
    const state = harness({ revise })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await saveJevSettings('default', change === 'review-off' ? { groupSummaryReviewEnabled: false }
      : change === 'revision-off' ? { groupSummaryRevisionEnabled: false } : { apiKey: 'rotated' })
    release(Response.json(response(.95))); await idle(state.service)
    expect(revise).not.toHaveBeenCalled()
    expect(state.records).toEqual([])
    expect(state.summary.summary).toBe('Original summary')
  })

  it('rechecks the revision switch at the actual generation dispatch boundary', async () => {
    await saveJevSettings('default', { groupSummaryRevisionEnabled: true })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(response(.95))))
    const provider = vi.fn()
    const state = harness({ revise: async (_input, context) => {
      await saveJevSettings('default', { groupSummaryRevisionEnabled: false })
      await context.beforeDispatch()
      provider()
      return 'Revised'
    } })
    await idle(state.service)
    expect(provider).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(state.summary.summary).toBe('Original summary')
  })

  it('does not store a late observation after the master switch is disabled', async () => {
    let release!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { release = resolve })))
    const state = harness()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await saveJevSettings('default', { groupSummaryReviewEnabled: false })
    release(Response.json(response(.1))); await idle(state.service)
    expect(state.records).toEqual([])
  })

  it.each(['no-key', 'provider-error', 'invalid-answer'])('preserves the committed summary for %s', async fault => {
    if (fault === 'no-key') { await deleteJevSettings('default'); await saveJevSettings('default', { groupSummaryReviewEnabled: true }) }
    vi.stubGlobal('fetch', vi.fn(async () => fault === 'provider-error'
      ? new Response('', { status: 503 }) : Response.json({ answers: {} })))
    const state = harness(); await idle(state.service)
    expect(state.records).toEqual([])
    expect(state.summary).toMatchObject({ summary: 'Original summary', version: 1, summaryThroughMessageId: 'm2', summarizedTurnCount: 2 })
    if (fault === 'no-key') expect(fetch).not.toHaveBeenCalled()
  })
  it('records a passing review after the baseline summary is already committed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(response(0.1))))
    const state = harness(); await waitFor(() => state.records.length === 1)
    expect(state.records[0]).toMatchObject({ sourceVersion: 1, decision: 'pass', status: 'completed' })
    expect(state.summary).toMatchObject({ summary: 'Original summary', version: 1 })
  })

  it('reports improvement without changing S0 when revision is disabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(response(0.95))))
    const state = harness(); await waitFor(() => state.records.length === 1)
    expect(state.records[0].decision).toBe('needs_improvement')
    expect(state.summary.summary).toBe('Original summary')
  })

  it('optionally applies one revision without changing the anchor or turn count', async () => {
    let call = 0; vi.stubGlobal('fetch', vi.fn(async () => Response.json(response(call++ === 0 ? 0.95 : 0.1))))
    await saveJevSettings('default', { groupSummaryRevisionEnabled: true }); const state = harness({ revision: true, revise: async () => 'Revised summary' }); await waitFor(() => state.records.length === 1)
    expect(state.summary).toMatchObject({ summary: 'Revised summary', version: 2, summaryThroughMessageId: 'm2', summarizedTurnCount: 2 })
    expect(state.records[0].appliedRevisionVersion).toBe(2)
  })

  it('makes no provider request when the central review switch is disabled', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const summary: GroupRoomSummary = { roomId:'room-1', summary:'S0', summaryThroughMessageId:'m1', summaryThroughMessageTimestamp:1,
      summarizedTurnCount:1, status:'success', version:1, updatedAt:1, lastError:null }
    await saveJevSettings('default', { groupSummaryReviewEnabled: false }); const storage: any = { getRoom: () => ({ id:'room-1', summaryProfile:'default' }), getRoomSummary:()=>summary,
      getLatestSummaryReview:()=>null, applySummaryReviewOutcome:()=>true }
    new GroupSummaryReviewService(storage).schedule({ previous: summary, summary, messages: [], profile:'default' })
    await new Promise(r=>setTimeout(r,20)); expect(fetch).not.toHaveBeenCalled()
  })
})
