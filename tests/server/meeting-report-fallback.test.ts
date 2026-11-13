import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { mkdtemp } from 'fs/promises'

// 用 vi.hoisted 保证 mock 在 vi.mock 工厂被提升后仍可引用。
const mocks = vi.hoisted(() => ({
  AgentBridgeClientMock: vi.fn(),
  chatMock: vi.fn(),
  streamOutputMock: vi.fn(),
  destroyMock: vi.fn(),
  fetchMock: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({
  createPrimaryAgentBridge: mocks.AgentBridgeClientMock,
}))

// 避免技能解析触碰真实文件系统 / 缓存。
vi.mock('../../packages/server/src/modules/studio/services/meeting-asr/skill-resolver', () => ({
  prepareAnalysisSkillSection: vi.fn().mockResolvedValue(''),
}))

// loadLLMConfig 会读 <cwd>/data/meeting-asr/config.json。历史上仓库里恰好
// 提交过带真实 key 的该文件，测试隐式依赖它；设备侧清理密钥后此依赖断裂。
// 现在测试自给自足：写一个假 key 的配置，结束后恢复原状（密钥永不入库）。
const RUNTIME_DIR = await mkdtemp(join(tmpdir(), 'meeting-fallback-'))
const RUNTIME_CONFIG = join(RUNTIME_DIR, 'config.json')
const previousDataDir = process.env.MEETING_ASR_DATA_DIR
process.env.MEETING_ASR_DATA_DIR = RUNTIME_DIR
let originalConfig: string | null = null

beforeAll(async () => {
  try {
    originalConfig = await readFile(RUNTIME_CONFIG, 'utf-8')
  } catch {
    originalConfig = null
  }
  await mkdir(dirname(RUNTIME_CONFIG), { recursive: true })
  await writeFile(
    RUNTIME_CONFIG,
    JSON.stringify({ llm: { api_key: 'sk-test-fallback', base_url: 'https://mock.local/v1', model: 'test-model' } }),
    'utf-8',
  )
})

afterEach(async () => {
  // 每个用例后恢复假配置（部分用例可能触发对文件系统的意外写路径）
  await writeFile(
    RUNTIME_CONFIG,
    JSON.stringify({ llm: { api_key: 'sk-test-fallback', base_url: 'https://mock.local/v1', model: 'test-model' } }),
    'utf-8',
  ).catch(() => {})
})

afterAll(async () => {
  if (previousDataDir === undefined) delete process.env.MEETING_ASR_DATA_DIR
  else process.env.MEETING_ASR_DATA_DIR = previousDataDir
  if (originalConfig === null) {
    await rm(RUNTIME_DIR, { force: true, recursive: true })
  } else {
    await writeFile(RUNTIME_CONFIG, originalConfig, 'utf-8')
  }
})

function wireBridge(): void {
  mocks.AgentBridgeClientMock.mockImplementation(() => ({
    chat: mocks.chatMock,
    streamOutput: mocks.streamOutputMock,
    destroy: mocks.destroyMock,
  }))
  mocks.destroyMock.mockResolvedValue({ ok: true })
}

/** 构造一个最小 SSE reader，模拟直调 LLM 的流式响应体。 */
function sseReader(payloads: string[]) {
  const encoder = new TextEncoder()
  let i = 0
  return {
    read: async () => {
      if (i >= payloads.length) return { done: true, value: undefined }
      return { done: false, value: encoder.encode(payloads[i++]) }
    },
  }
}

function stubDirectLLM(content: string): void {
  mocks.fetchMock.mockResolvedValue({
    ok: true,
    body: {
      getReader: () => sseReader([
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] }) }\n\n`,
        'data: [DONE]\n\n',
      ]),
    },
  })
  vi.stubGlobal('fetch', mocks.fetchMock)
}

async function collect(gen: AsyncGenerator<string | symbol>): Promise<string> {
  let out = ''
  for await (const chunk of gen) {
    if (typeof chunk === 'symbol') {
      // 跳过 fallback marker，只统计可见文本。
      continue
    }
    out += chunk
  }
  return out
}

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('meeting report generation (agent-first with fallback)', () => {
  it('uses the Hermes Agent path when the bridge is available', async () => {
    wireBridge()
    mocks.chatMock.mockResolvedValue({ ok: true, run_id: 'run-1' })
    mocks.streamOutputMock.mockImplementation(async function* () {
      yield { delta: 'Agent ', done: false }
      yield { delta: 'Report', done: true }
    })
    stubDirectLLM('SHOULD NOT BE USED')

    const { realtimeAssistService } = await import('../../packages/server/src/modules/studio/services/meeting-asr/realtime-assist')
    const report = await collect(realtimeAssistService.generateReportStream('s1', 'transcript', 'general', 'default'))

    expect(report).toBe('Agent Report')
    expect(mocks.chatMock).toHaveBeenCalledTimes(1)
    // 透传场景 reportPrompt 作为 instructions、profile 作为目标 profile。
    const chatArgs = mocks.chatMock.mock.calls[0]
    expect(chatArgs[3]).toContain('结构化 Markdown 报告')
    expect(chatArgs[4]).toBe('default')
    expect(mocks.fetchMock).not.toHaveBeenCalled()
    // 一次性会话结束后销毁。
    expect(mocks.destroyMock).toHaveBeenCalledWith('meeting-report-s1', 'default')
  })

  it('falls back to direct LLM when the bridge is unavailable and nothing was yielded', async () => {
    wireBridge()
    mocks.chatMock.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:18765'))
    stubDirectLLM('Direct LLM Report')

    const { realtimeAssistService } = await import('../../packages/server/src/modules/studio/services/meeting-asr/realtime-assist')
    const report = await collect(realtimeAssistService.generateReportStream('s2', 'transcript', 'general', 'default'))

    expect(report).toBe('Direct LLM Report')
    expect(mocks.fetchMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to direct LLM even after the agent streams partial output (A+C contract)', async () => {
    // 之前契约：agent 已经 yield 过部分内容就直接抛错。
    // 现在契约（A+C）：仍强制回退到 direct LLM，丢弃部分内容；
    // 服务层 yield 一个 REPORT_FALLBACK_MARKER sentinel 作为"我已切换路径"的信号，
    // 由 controller 翻译成 { fallback: true } SSE 帧，前端收到后再清空已显示的部分。
    wireBridge()
    mocks.chatMock.mockResolvedValue({ ok: true, run_id: 'run-1' })
    mocks.streamOutputMock.mockImplementation(async function* () {
      yield { delta: 'partial', done: false }
      throw new Error('stream broken mid-way')
    })
    stubDirectLLM('Fresh LLM Report')

    const { realtimeAssistService, REPORT_FALLBACK_MARKER } = await import(
      '../../packages/server/src/modules/studio/services/meeting-asr/realtime-assist'
    )

    // 直接消费生成器，验证 sentinel 出现在 agent 部分与 LLM 部分之间。
    const seen: Array<string | symbol> = []
    for await (const chunk of realtimeAssistService.generateReportStream('s3', 'transcript', 'general', 'default')) {
      seen.push(chunk)
    }

    expect(seen[0]).toBe('partial')
    expect(seen).toContain(REPORT_FALLBACK_MARKER)
    // sentinel 之后只能出现 LLM 的输出，不应重复 agent 的 'partial'。
    const afterMarker = seen.slice(seen.indexOf(REPORT_FALLBACK_MARKER) + 1)
    expect(afterMarker.join('')).toBe('Fresh LLM Report')
    // fallback 路径必须真的被调用过。
    expect(mocks.fetchMock).toHaveBeenCalledTimes(1)
  })

  it('extracts final text from result when the agent yields no incremental delta', async () => {
    wireBridge()
    mocks.chatMock.mockResolvedValue({ ok: true, run_id: 'run-1' })
    mocks.streamOutputMock.mockImplementation(async function* () {
      yield { delta: '', done: true, output: 'Final Report Text', status: 'complete' }
    })
    stubDirectLLM('SHOULD NOT BE USED')

    const { realtimeAssistService } = await import('../../packages/server/src/modules/studio/services/meeting-asr/realtime-assist')
    const report = await collect(realtimeAssistService.generateReportStream('s4', 'transcript', 'general', 'default'))

    expect(report).toBe('Final Report Text')
    expect(mocks.fetchMock).not.toHaveBeenCalled()
  })

  it('throws when the direct LLM stream contains an in-band error frame', async () => {
    // Provider 偶尔会在 SSE 流里塞 error 帧而不是断开连接：
    //   data: {"error":{"message":"empty stream","type":"upstream_error"}}
    // 之前会被当成普通 chunk 静默忽略，现在必须抛错让上游 catch 处理。
    wireBridge()
    mocks.chatMock.mockRejectedValue(new Error('bridge unavailable'))
    mocks.fetchMock.mockResolvedValue({
      ok: true,
      body: {
        getReader: () => sseReader([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`,
          `data: ${JSON.stringify({ error: { message: 'Provider returned an empty stream with no finish_reason', type: 'upstream_error' } })}\n\n`,
        ]),
      },
    })
    vi.stubGlobal('fetch', mocks.fetchMock)

    const { realtimeAssistService } = await import('../../packages/server/src/modules/studio/services/meeting-asr/realtime-assist')
    const collected: string[] = []
    const gen = realtimeAssistService.generateReportStream('s5', 'transcript', 'general', 'default')
    await expect((async () => {
      for await (const c of gen) {
        // generator 现在会先 yield 一个 REPORT_FALLBACK_MARKER sentinel，
        // 测试过滤掉它，只统计可见文本 chunk。
        if (typeof c === 'symbol') continue
        collected.push(c)
      }
    })()).rejects.toThrow(/empty stream/)
    expect(collected.join('')).toBe('partial')
  })

  it('flushes the trailing buffer line when the SSE stream ends without a trailing newline', async () => {
    // 之前 buffer 里最后一行不带换行的 chunk 会被 .pop() 留到下次读取，
    // 而服务端又不会再 push，结果那段永远到不了前端。
    wireBridge()
    mocks.chatMock.mockRejectedValue(new Error('bridge unavailable'))
    const trailingChunk = `data: ${JSON.stringify({ choices: [{ delta: { content: 'tail' } }] })}`
    mocks.fetchMock.mockResolvedValue({
      ok: true,
      body: {
        getReader: () => sseReader([
          // 注意末尾没有 \n\n
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'head' } }] })}\n\n${trailingChunk}`,
        ]),
      },
    })
    vi.stubGlobal('fetch', mocks.fetchMock)

    const { realtimeAssistService } = await import('../../packages/server/src/modules/studio/services/meeting-asr/realtime-assist')
    const report = await collect(realtimeAssistService.generateReportStream('s6', 'transcript', 'general', 'default'))

    expect(report).toBe('headtail')
  })

  it('merges agent and fallback errors when both paths fail (ReportStreamBothFailed)', async () => {
    wireBridge()
    mocks.chatMock.mockRejectedValue(new Error('bridge pool exhausted'))
    // fallback 路径产出一个 SSE error 帧 → 触发 generator 抛错。
    mocks.fetchMock.mockResolvedValue({
      ok: true,
      body: {
        getReader: () => sseReader([
          `data: ${JSON.stringify({ error: { message: 'Provider returned an empty stream with no finish_reason', type: 'upstream_error' } })}\n\n`,
        ]),
      },
    })
    vi.stubGlobal('fetch', mocks.fetchMock)

    const { realtimeAssistService } = await import('../../packages/server/src/modules/studio/services/meeting-asr/realtime-assist')
    const gen = realtimeAssistService.generateReportStream('s7', 'transcript', 'general', 'default')
    let captured: unknown = null
    try {
      for await (const _chunk of gen) { /* no-op */ }
    } catch (e) {
      captured = e
    }
    expect(captured).toBeInstanceOf(Error)
    const err = captured as Error & { name?: string }
    expect(err.name).toBe('ReportStreamBothFailed')
    expect(err.message).toMatch(/agent: bridge pool exhausted/)
    expect(err.message).toMatch(/fallback: /)
  })

  it('rethrows the original agent error when the fallback stream produces zero chunks', async () => {
    wireBridge()
    const originalError = new Error('empty stream with no finish_reason')
    mocks.chatMock.mockRejectedValue(originalError)
    // 直接 LLM 路径：第一次调用 (streaming) 返回空；第二次调用 (non-streaming retry) 也失败。
    // 两次失败都会被合并到 ReportStreamBothFailed，但我们要验证 agent 原错信息保留在前缀里。
    mocks.fetchMock
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => sseReader(['data: [DONE]\n\n']),
        },
      })
      .mockRejectedValueOnce(new Error('non-streaming fallback also down'))
    vi.stubGlobal('fetch', mocks.fetchMock)

    const { realtimeAssistService } = await import('../../packages/server/src/modules/studio/services/meeting-asr/realtime-assist')
    const gen = realtimeAssistService.generateReportStream('s8', 'transcript', 'general', 'default')
    let captured: unknown = null
    try {
      for await (const _chunk of gen) { /* no-op */ }
    } catch (e) {
      captured = e
    }
    expect(captured).toBeInstanceOf(Error)
    const err = captured as Error & { name?: string }
    expect(err.name).toBe('ReportStreamBothFailed')
    // 原始 agent 错误必须在合并消息的前缀里（更接近根因）。
    expect(err.message).toMatch(/agent: empty stream with no finish_reason/)
    expect(err.message).toMatch(/fallback: /)
  })

  it('treats agent "graceful failure" final_response as an error and falls back to direct LLM', async () => {
    // 关键 bug fix：外部 agent 包在 provider 错误时不抛异常，而是把错误信息
    // 写成 final_response（例如 "API call failed after 3 retries: Provider
    // returned an empty stream..."）并把 run status 标为 'complete'。
    // 旧契约：把这些错误文本当报告 yield 出去 → 用户看到错误块。
    // 新契约：在流末尾识别出这种"假完成"内容，抛错回退到 direct LLM。
    wireBridge()
    mocks.chatMock.mockResolvedValue({ ok: true, run_id: 'run-graceful-fail' })
    const agentFailureText =
      'API call failed after 3 retries: Provider returned an empty stream with no finish_reason ' +
      '(possible upstream error or malformed SSE response).'
    mocks.streamOutputMock.mockImplementation(async function* () {
      // 模拟 agent 优雅失败：先 yield 一段开头空响应（让消费者以为真在流），
      // 最后一段才把整段错误文本倾倒出来 + done=true。
      yield { delta: '', done: false }
      yield { delta: agentFailureText, done: true, status: 'complete' }
    })
    stubDirectLLM('Recovered via direct LLM')

    const { realtimeAssistService, REPORT_FALLBACK_MARKER } = await import(
      '../../packages/server/src/modules/studio/services/meeting-asr/realtime-assist'
    )
    const seen: Array<string | symbol> = []
    for await (const chunk of realtimeAssistService.generateReportStream('s9', 'transcript', 'general', 'default')) {
      seen.push(chunk)
    }
    // 关键断言：agent 的错误文本不应出现在最终输出里。
    const visibleText = seen.filter((c): c is string => typeof c === 'string').join('')
    expect(visibleText).not.toMatch(/API call failed after/)
    expect(visibleText).toBe('Recovered via direct LLM')
    // 应当走过 fallback：sentinel 必须出现，且 fallback 必须真的被调用。
    expect(seen).toContain(REPORT_FALLBACK_MARKER)
    expect(mocks.fetchMock).toHaveBeenCalledTimes(1)
  })
})
