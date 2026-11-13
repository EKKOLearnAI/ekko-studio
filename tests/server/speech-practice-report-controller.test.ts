/**
 * POST /api/studio/speech-practice/report controller tests.
 *
 * The store itself is covered with a real temp dir in
 * speech-practice-report-store.test.ts; here the store is mocked so the
 * controller's validation and response-shape logic is tested in isolation
 * (files-routes.test.ts style).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/modules/studio/services/speech-practice-report', () => ({
  PRACTICE_REPORT_MAX_CHARS: 1000,
  speechPracticeReportStore: {
    saveReport: vi.fn(),
  },
}))

import {
  PRACTICE_REPORT_MAX_CHARS,
  speechPracticeReportStore,
} from '../../packages/server/src/modules/studio/services/speech-practice-report'

const saveReportMock = vi.mocked(speechPracticeReportStore.saveReport)

async function dispatch(body: unknown): Promise<{ status: number; body: unknown }> {
  const { savePracticeReport } = await import('../../packages/server/src/modules/studio/controllers/speech-practice')
  const ctx: any = {
    request: { body },
    status: 0,
    body: undefined,
  }
  await savePracticeReport(ctx)
  return { status: ctx.status, body: ctx.body }
}

beforeEach(() => {
  saveReportMock.mockReset()
  saveReportMock.mockImplementation(async (_markdown: string, stem?: string) => ({
    fileName: `${stem || 'report'}.md`,
    absPath: `/tmp/reports/${stem || 'report'}.md`,
  }))
})

describe('POST /api/studio/speech-practice/report controller', () => {
  it('returns 400 for empty markdown without touching the store', async () => {
    const res = await dispatch({ markdown: '   ' })
    expect(res.status).toBe(400)
    expect((res.body as any).ok).toBe(false)
    expect(saveReportMock).not.toHaveBeenCalled()
  })

  it('returns 413 for oversized markdown without touching the store', async () => {
    expect(PRACTICE_REPORT_MAX_CHARS).toBe(1000)
    const res = await dispatch({ markdown: 'x'.repeat(1001) })
    expect(res.status).toBe(413)
    expect((res.body as any).ok).toBe(false)
    expect(saveReportMock).not.toHaveBeenCalled()
  })

  it('saves a valid report and returns fileName + path', async () => {
    const res = await dispatch({ markdown: '# 口语对练分析报告', suggestedName: '口语对练-英语' })
    expect(res.status).toBe(200)
    const payload = res.body as { ok: boolean; fileName: string; path: string }
    expect(payload.ok).toBe(true)
    expect(payload.fileName).toBe('口语对练-英语.md')
    expect(payload.path).toContain('/tmp/reports/')
    expect(saveReportMock).toHaveBeenCalledWith('# 口语对练分析报告', '口语对练-英语')
  })

  it('maps a store write failure to a 500 response', async () => {
    saveReportMock.mockRejectedValue(Object.assign(new Error('disk full'), { code: 'write_failed' }))
    const res = await dispatch({ markdown: '# 报告' })
    expect(res.status).toBe(500)
    expect((res.body as any).ok).toBe(false)
  })
})
