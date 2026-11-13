/**
 * POST /api/studio/speech-practice/omni-analysis controller tests.
 *
 * The DashScope call itself is covered with an injected fetch in
 * speech-practice-omni.test.ts; here the service is mocked so the
 * controller's validation / response-mapping is tested in isolation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/modules/studio/services/speech-practice-omni', () => ({
  generateOmniPracticeAnalysis: vi.fn(),
  streamOmniPracticeAnalysis: vi.fn(),
  validateOmniAnalysisInput: vi.fn((input: unknown) => input),
  OMNI_ANALYSIS_DEFAULT_MODEL: 'qwen3.5-omni-flash',
}))

import { generateOmniPracticeAnalysis, streamOmniPracticeAnalysis, validateOmniAnalysisInput } from '../../packages/server/src/modules/studio/services/speech-practice-omni'

const generateMock = vi.mocked(generateOmniPracticeAnalysis)
const streamMock = vi.mocked(streamOmniPracticeAnalysis)
const validateMock = vi.mocked(validateOmniAnalysisInput)

async function dispatch(body: unknown): Promise<{ status: number; body: unknown }> {
  const { generateOmniAnalysis } = await import('../../packages/server/src/modules/studio/controllers/speech-practice')
  const ctx: any = {
    request: { body },
    status: 0,
    body: undefined,
  }
  await generateOmniAnalysis(ctx)
  return { status: ctx.status, body: ctx.body }
}

function sampleBody() {
  return {
    config: { language: 'en', direction: '面试', difficulty: 'intermediate', durationMinutes: 10 },
    turns: [{ role: 'user', text: 'Hello' }],
    feedback: [{ round: 1, overall: 8 }],
    audioSegments: [{ index: 1, text: 'Hello', wavBase64: 'QUFB' }],
    frames: [],
    apiKey: 'sk-client',
  }
}

beforeEach(() => {
  generateMock.mockReset()
  streamMock.mockReset()
  validateMock.mockReset()
  validateMock.mockImplementation((input: unknown) => input as never)
})

describe('POST /api/studio/speech-practice/omni-analysis controller', () => {
  it('returns the generated markdown on success', async () => {
    generateMock.mockResolvedValue('## 四、AI 全模态深度分析\n\n正文')
    const res = await dispatch(sampleBody())
    expect(res.status).toBe(200)
    expect((res.body as any).ok).toBe(true)
    expect((res.body as any).markdown).toContain('AI 全模态深度分析')
    expect(generateMock).toHaveBeenCalledTimes(1)
  })

  it('maps service errors to a 502 response with a readable error', async () => {
    generateMock.mockRejectedValue(new Error('DASHSCOPE_API_KEY is not configured'))
    const res = await dispatch(sampleBody())
    expect(res.status).toBe(502)
    expect((res.body as any).ok).toBe(false)
    expect(String((res.body as any).error)).toContain('DASHSCOPE_API_KEY')
  })

  it('maps timeouts to 504', async () => {
    generateMock.mockRejectedValue(new Error('DashScope omni analysis timed out after 20s'))
    const res = await dispatch(sampleBody())
    expect(res.status).toBe(504)
  })

  it('rejects requests with neither audio nor frames', async () => {
    const res = await dispatch({ ...sampleBody(), audioSegments: [], frames: [] })
    expect(res.status).toBe(400)
    expect(generateMock).not.toHaveBeenCalled()
  })

  it('maps validation failures to 413 without calling DashScope', async () => {
    validateMock.mockImplementation(() => {
      throw new Error('audio segment too large')
    })
    const res = await dispatch(sampleBody())
    expect(res.status).toBe(413)
    expect(generateMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/studio/speech-practice/omni-analysis controller (SSE stream)', () => {
  function sseCtx(body: unknown) {
    const writes: string[] = []
    const ctx: any = {
      request: { body },
      query: {},
      status: 0,
      body: undefined,
      respond: true,
      req: { on: () => undefined, off: () => undefined },
      res: {
        destroyed: false,
        write: (chunk: string) => { writes.push(chunk); return true },
        end: () => { ctx.res.destroyed = true },
        flushHeaders: () => undefined,
      },
      set: () => undefined,
    }
    return { ctx, writes }
  }

  it('streams delta/done events as SSE data lines when body.stream is true', async () => {
    streamMock.mockImplementation(async function* () {
      yield { type: 'delta', text: '## 四、AI 全模态深度分析' }
      yield { type: 'delta', text: '\n\n语音表现…' }
      yield { type: 'done' }
    })
    const { ctx, writes } = sseCtx({ ...sampleBody(), stream: true })
    const { generateOmniAnalysis } = await import('../../packages/server/src/modules/studio/controllers/speech-practice')
    await generateOmniAnalysis(ctx)
    expect(writes.length).toBeGreaterThanOrEqual(3)
    expect(writes[0]).toContain('"type":"delta"')
    expect(writes[0]).toContain('AI 全模态深度分析')
    expect(writes.some((w) => w.includes('"type":"done"'))).toBe(true)
    expect(generateMock).not.toHaveBeenCalled()
  })

  it('writes an error event when the upstream stream errors', async () => {
    streamMock.mockImplementation(async function* () {
      yield { type: 'error', message: 'upstream boom' }
    })
    const { ctx, writes } = sseCtx({ ...sampleBody(), stream: true })
    const { generateOmniAnalysis } = await import('../../packages/server/src/modules/studio/controllers/speech-practice')
    await generateOmniAnalysis(ctx)
    expect(writes.some((w) => w.includes('upstream boom'))).toBe(true)
  })
})
