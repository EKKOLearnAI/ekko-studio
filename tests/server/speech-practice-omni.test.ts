/**
 * speech-practice-omni 服务单测（Qwen3.5-Omni 全模态分析生成）。
 *
 * 覆盖：提示词组装、请求体（audio/image content parts 形态）、防御性裁剪、
 * 以及注入 fetch 的 SSE 成功 / 失败路径。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildOmniAnalysisPrompt,
  buildOmniAnalysisRequestBody,
  generateOmniPracticeAnalysis,
  streamOmniPracticeAnalysis,
  validateOmniAnalysisInput,
  OMNI_AUDIO_SEGMENT_MAX,
  OMNI_FRAMES_MAX,
} from '../../packages/server/src/modules/studio/services/speech-practice-omni'

const originalDashScopeKey = process.env.DASHSCOPE_API_KEY
const originalDataDir = process.env.MEETING_ASR_DATA_DIR

afterEach(() => {
  if (originalDashScopeKey === undefined) delete process.env.DASHSCOPE_API_KEY
  else process.env.DASHSCOPE_API_KEY = originalDashScopeKey
  if (originalDataDir === undefined) delete process.env.MEETING_ASR_DATA_DIR
  else process.env.MEETING_ASR_DATA_DIR = originalDataDir
  vi.restoreAllMocks()
})

function sampleInput() {
  return {
    config: {
      language: 'en',
      direction: '求职面试自我介绍',
      difficulty: 'intermediate',
      durationMinutes: 10,
    },
    turns: [
      { role: 'user' as const, text: 'Hello, my name is Tom.' },
      { role: 'assistant' as const, text: 'Nice to meet you!' },
    ],
    feedback: [{ round: 1, overall: 8, fluency: 7, pronunciation: 8, comment: 'good' }],
    audioSegments: [{ index: 1, text: 'Hello, my name is Tom.', wavBase64: 'QUFB' }],
    frames: ['data:image/jpeg;base64,QUJD'],
    apiKey: 'sk-test',
  }
}

describe('buildOmniAnalysisPrompt', () => {
  it('summarises the practice config, transcript and per-round scores', () => {
    const text = buildOmniAnalysisPrompt(sampleInput())
    expect(text).toContain('英语')
    expect(text).toContain('求职面试自我介绍')
    expect(text).toContain('定时 10 分钟')
    expect(text).toContain('[1] 用户：Hello, my name is Tom.')
    expect(text).toContain('总分 8')
    expect(text).toContain('## 四、AI 全模态深度分析（基于录音与画面的评审）')
  })

  it('states when no audio / no frames were provided instead of hallucinating them', () => {
    const input = { ...sampleInput(), audioSegments: [], frames: [] }
    const text = buildOmniAnalysisPrompt(input)
    expect(text).toContain('没有提供用户录音')
    expect(text).toContain('没有提供画面（摄像头未开启）')
  })
})

describe('buildOmniAnalysisRequestBody', () => {
  it('uses the DashScope-compatible wire shape (data URL audio + image_url)', () => {
    const body = buildOmniAnalysisRequestBody(sampleInput(), 'prompt-text') as any
    expect(body.model).toBe('qwen3.5-omni-flash')
    expect(body.stream).toBe(true)
    expect(body.modalities).toEqual(['text'])
    const content = body.messages[0].content as any[]
    expect(content[0]).toEqual({ type: 'text', text: 'prompt-text' })
    const audio = content.find((part: any) => part.type === 'input_audio')
    expect(audio.input_audio.data).toBe('data:;base64,QUFB')
    expect(audio.input_audio.format).toBe('wav')
    const image = content.find((part: any) => part.type === 'image_url')
    expect(image.image_url.url).toBe('data:image/jpeg;base64,QUJD')
  })

  it('honours a custom model and drops malformed frames', () => {
    const body = buildOmniAnalysisRequestBody(
      { ...sampleInput(), model: 'qwen3.5-omni-plus', frames: ['not-a-data-url', 'data:image/png;base64,WA=='] },
      'prompt',
    ) as any
    expect(body.model).toBe('qwen3.5-omni-plus')
    const parts = (body.messages[0].content as any[]).filter((p: any) => p.type === 'image_url')
    expect(parts).toHaveLength(1)
    expect(parts[0].image_url.url).toBe('data:image/png;base64,WA==')
  })
})

describe('validateOmniAnalysisInput', () => {
  it('clips audio segments and frames to the documented caps', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      index: i + 1,
      text: `turn ${i + 1}`,
      wavBase64: 'QUFB',
    }))
    const frames = Array.from({ length: 10 }, (_, i) => `data:image/jpeg;base64,${i}`)
    const input = { ...sampleInput(), audioSegments: many, frames }
    const clipped = validateOmniAnalysisInput(input as any)
    expect(clipped.audioSegments).toHaveLength(OMNI_AUDIO_SEGMENT_MAX)
    expect(clipped.audioSegments[0].index).toBe(9) // keeps the NEWEST segments
    expect(clipped.frames).toHaveLength(OMNI_FRAMES_MAX)
  })

  it('rejects an oversized single audio segment', () => {
    const oversized = { ...sampleInput(), audioSegments: [{ index: 1, text: 'x', wavBase64: 'A'.repeat(1_000_001) }] }
    expect(() => validateOmniAnalysisInput(oversized)).toThrow(/audio segment too large/)
  })

  it('drops the oldest segments when the total audio budget would be exceeded', () => {
    const segments = Array.from({ length: 12 }, (_, i) => ({ index: i + 1, text: 'x', wavBase64: 'A'.repeat(1_000_000) }))
    const clipped = validateOmniAnalysisInput({ ...sampleInput(), audioSegments: segments })
    // 12 × 1M > 11M budget → 只保留最新的 11 段，不抛错
    expect(clipped.audioSegments).toHaveLength(11)
    const total = clipped.audioSegments.reduce((sum, seg) => sum + seg.wavBase64.length, 0)
    expect(total).toBeLessThanOrEqual(11_000_000)
    expect(clipped.audioSegments[0].index).toBe(2) // oldest surviving is index 2
  })
})

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
  return new Response(body, { status })
}

describe('generateOmniPracticeAnalysis', () => {
  it('accumulates streamed deltas and strips code fences', async () => {
    const fetchImpl = vi.fn(async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"## 四、AI 全模态深度分析"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"（基于录音与画面的评审）\\n\\n语音表现…"}}]}\n\n',
      'data: [DONE]\n\n',
    ]))
    const markdown = await generateOmniPracticeAnalysis(sampleInput(), { fetchImpl })
    expect(markdown).toContain('## 四、AI 全模态深度分析')
    expect(markdown).toContain('语音表现')
    const called = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(called[0]).toContain('/chat/completions')
    expect((called[1].headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
  })

  it('throws a readable error on a non-OK upstream response', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":{"message":"quota exceeded"}}', { status: 429 }))
    await expect(generateOmniPracticeAnalysis(sampleInput(), { fetchImpl }))
      .rejects.toThrow(/DashScope omni analysis failed \(HTTP 429\)/)
  })

  it('surfaces errors embedded in the SSE stream', async () => {
    const fetchImpl = vi.fn(async () => sseResponse([
      'data: {"error":{"message":"invalid audio format"}}\n\n',
    ]))
    await expect(generateOmniPracticeAnalysis(sampleInput(), { fetchImpl }))
      .rejects.toThrow(/invalid audio format/)
  })

  it('rejects requests with neither audio nor frames', async () => {
    await expect(generateOmniPracticeAnalysis({ ...sampleInput(), audioSegments: [], frames: [] }))
      .rejects.toThrow(/no audio or frames/)
  })

  it('rejects when no DashScope key can be resolved', async () => {
    process.env.MEETING_ASR_DATA_DIR = '/nonexistent/speech-practice-omni-test'
    delete process.env.DASHSCOPE_API_KEY
    await expect(generateOmniPracticeAnalysis({ ...sampleInput(), apiKey: '' }))
      .rejects.toThrow(/DASHSCOPE_API_KEY is not configured/)
  })

  it('times out via the abort controller', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        ;(init?.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')))
      })
      return new Response()
    })
    await expect(generateOmniPracticeAnalysis(sampleInput(), { fetchImpl, timeoutMs: 20 }))
      .rejects.toThrow(/timed out/)
  })
})

describe('streamOmniPracticeAnalysis', () => {
  it('yields text deltas then a done event', async () => {
    const fetchImpl = vi.fn(async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"## 四、AI"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" 全模态深度分析"}}]}\n\n',
      'data: [DONE]\n\n',
    ]))
    const events: string[] = []
    for await (const event of streamOmniPracticeAnalysis(sampleInput(), { fetchImpl })) {
      if (event.type === 'delta') events.push(event.text)
      else events.push(event.type)
    }
    expect(events.join('')).toContain('## 四、AI')
    expect(events.join('')).toContain(' 全模态深度分析')
    expect(events[events.length - 1]).toBe('done')
  })

  it('yields an error event instead of throwing on a non-OK upstream', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":{"message":"boom"}}', { status: 429 }))
    const collected: string[] = []
    for await (const event of streamOmniPracticeAnalysis(sampleInput(), { fetchImpl })) {
      if (event.type === 'error') collected.push(event.message)
    }
    expect(collected.join('')).toContain('DashScope omni analysis failed (HTTP 429)')
  })
})

describe('practice skill context (v2 跨场景)', () => {
  it('injects skill display name, criteria and instructions into the prompt', () => {
    const input = {
      ...sampleInput(),
      config: {
        ...sampleInput().config,
        skill: {
          name: 'sales-pitch',
          displayName: '新品销售陪练',
          description: '角色扮演：顾客/销售',
          criteria: '- **需求挖掘**：1-3 不提问；4-7 会追问；8-10 系统挖掘',
          instructions: '按门店话术规范点评',
          background: '销售技巧说明',
        },
      },
    }
    const text = buildOmniAnalysisPrompt(input as any)
    expect(text).toContain('练习技能：新品销售陪练')
    expect(text).toContain('顾客/销售')
    expect(text).toContain('需求挖掘')
    expect(text).toContain('技能专属评审要求：按门店话术规范点评')
    expect(text).toContain('销售技巧说明')
  })

  it('prints skill-defined feedback dimensions generically (not bound to language dims)', () => {
    const input = {
      ...sampleInput(),
      feedback: [{ round: 1, overall: 8, probing: 7, objection: 6, comment: 'ok' }],
    }
    const text = buildOmniAnalysisPrompt(input as any)
    expect(text).toContain('总分 8')
    expect(text).toContain('probing 7')
    expect(text).toContain('objection 6')
    expect(text).not.toContain('流利 7')
  })
})

describe('streamOmniPracticeAnalysis meta event', () => {
  it('yields a meta event first with the server-validated media manifest', async () => {
    const fetchImpl = vi.fn(async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: [DONE]\n\n',
    ]))
    const events: any[] = []
    for await (const event of streamOmniPracticeAnalysis(sampleInput(), { fetchImpl })) {
      events.push(event)
    }
    expect(events[0]).toEqual({
      type: 'meta',
      audioSegments: 1,
      frames: 1,
      model: 'qwen3.5-omni-flash',
    })
    expect(events.some((event: any) => event.type === 'done')).toBe(true)
  })

  it('still refuses to run without any media (no meta event)', async () => {
    const fetchImpl = vi.fn()
    const collected: string[] = []
    for await (const event of streamOmniPracticeAnalysis(
      { ...sampleInput(), audioSegments: [], frames: [] },
      { fetchImpl },
    )) {
      if (event.type === 'error') collected.push(event.message)
    }
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(collected.join('')).toContain('no audio or frames to analyze')
  })
})
