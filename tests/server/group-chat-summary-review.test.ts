import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import { GroupSummaryReviewService, type GroupSummaryReviewRecord } from '../../packages/server/src/modules/studio/services/group-chat/summary-review'
import { saveJevSettings, deleteJevSettings } from '../../packages/server/src/modules/studio/services/jev/settings'
import type { GroupRoomSummary } from '../../packages/server/src/modules/studio/services/group-chat/room-summary'

const response = (value: number) => ({ model: 'jev-test', usage: {}, answers: {
  missing_constraints: { type: 'noul', noul: value }, stale_or_overstated: { type: 'noul', noul: 0.1 }, unsupported_completion: { type: 'noul', noul: 0.1 },
} })

function harness(options: { revision?: boolean; revise?: () => Promise<string> } = {}) {
  let summary: GroupRoomSummary = { roomId: 'room-1', summary: 'Original summary', summaryThroughMessageId: 'm2',
    summaryThroughMessageTimestamp: 2, summarizedTurnCount: 2, status: 'success', version: 1, updatedAt: 3, lastError: null }
  const records: GroupSummaryReviewRecord[] = []
  const room = { id: 'room-1', summaryProfile: 'default', evaluationProfile: 'default', summaryReviewMode: 'inherit',
    summaryRevisionEnabled: options.revision ? 1 : 0, summaryGeneration: 0, ownerAuthUserId: 1 }
  const storage = {
    getRoom: () => room, getRoomSummary: () => summary, getLatestSummaryReview: () => records.at(-1) || null,
    applySummaryReviewOutcome: (input: any) => { if (input.revision) summary = { ...summary, summary: input.revision.nextText, version: summary.version + 1 }; records.push({ ...input.record, appliedRevisionVersion: input.revision ? summary.version : null }); return true },
  }
  const service = new GroupSummaryReviewService(storage, options.revise)
  service.schedule({ previous: { ...summary, summary: '', version: 0 }, summary, profile: 'default', messages: [
    { id: 'm1', role: 'user', senderName: 'Alice', timestamp: 1, content: 'Keep deadline Friday' },
    { id: 'm2', role: 'assistant', senderName: 'Agent', timestamp: 2, content: 'Done' },
  ] })
  return { records, get summary() { return summary } }
}

async function waitFor(check: () => boolean) { for (let i=0;i<100;i+=1) { if (check()) return; await new Promise(r=>setTimeout(r,5)) } throw new Error('timeout') }
beforeEach(async () => { await saveJevSettings('default', { apiKey: 'key', groupSummaryReviewEnabled: true }) })
afterEach(async () => { vi.unstubAllGlobals(); await deleteJevSettings('default') })

describe('group summary JEV review', () => {
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
    const state = harness({ revision: true, revise: async () => 'Revised summary' }); await waitFor(() => state.records.length === 1)
    expect(state.summary).toMatchObject({ summary: 'Revised summary', version: 2, summaryThroughMessageId: 'm2', summarizedTurnCount: 2 })
    expect(state.records[0].appliedRevisionVersion).toBe(2)
  })

  it('makes no provider request when room review is disabled', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const summary: GroupRoomSummary = { roomId:'room-1', summary:'S0', summaryThroughMessageId:'m1', summaryThroughMessageTimestamp:1,
      summarizedTurnCount:1, status:'success', version:1, updatedAt:1, lastError:null }
    const storage: any = { getRoom: () => ({ id:'room-1', summaryReviewMode:'off' }), getRoomSummary:()=>summary,
      getLatestSummaryReview:()=>null, applySummaryReviewOutcome:()=>true }
    new GroupSummaryReviewService(storage).schedule({ previous: summary, summary, messages: [], profile:'default' })
    await new Promise(r=>setTimeout(r,20)); expect(fetch).not.toHaveBeenCalled()
  })
})
