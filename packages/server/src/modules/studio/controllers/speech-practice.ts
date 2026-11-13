import {
  speechPracticeReportStore,
  PRACTICE_REPORT_MAX_CHARS,
} from '../services/speech-practice-report'
import {
  generateOmniPracticeAnalysis,
  streamOmniPracticeAnalysis,
  validateOmniAnalysisInput,
  OMNI_ANALYSIS_DEFAULT_MODEL,
  type OmniPracticeAnalysisInput,
} from '../services/speech-practice-omni'

function readString(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value.slice(0, max)
}

/** 把 body 里的数组字段安全地抽出来（只保留对象元素）。 */
function readArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Record<string, unknown> =>
    !!item && typeof item === 'object' && !Array.isArray(item),
  )
}

/**
 * POST /api/studio/speech-practice/report
 * body: { markdown: string, suggestedName?: string }
 * response: { ok: true, fileName: string, path: string }
 *          | { ok: false, error: string }
 *
 * 口语对练结束后的分析报告（Markdown）落盘到 Web UI state 目录（upload
 * 子树下的 speech-practice/），返回文件名与绝对路径；下载由客户端用
 * `/api/studio/download?path=…&name=…` 完成。
 */
export async function savePracticeReport(ctx: any): Promise<void> {
  const body = (ctx.request?.body || {}) as Record<string, unknown>
  const rawMarkdown = typeof body.markdown === 'string' ? body.markdown : ''
  if (!rawMarkdown.trim()) {
    ctx.status = 400
    ctx.body = { ok: false, error: 'markdown is required' }
    return
  }
  if (rawMarkdown.length > PRACTICE_REPORT_MAX_CHARS) {
    ctx.status = 413
    ctx.body = { ok: false, error: `markdown too large (max ${PRACTICE_REPORT_MAX_CHARS} chars)` }
    return
  }
  const markdown = rawMarkdown.trim()
  const suggestedName = readString(body.suggestedName, 200)

  try {
    const saved = await speechPracticeReportStore.saveReport(markdown, suggestedName)
    ctx.status = 200
    ctx.body = { ok: true, fileName: saved.fileName, path: saved.absPath }
  } catch (err: any) {
    const code = String(err?.code || '')
    if (code === 'report_too_large') {
      ctx.status = 413
      ctx.body = { ok: false, error: err?.message || 'report too large' }
      return
    }
    ctx.status = 500
    ctx.body = { ok: false, error: err?.message || 'failed to save report' }
  }
}

/**
 * POST /api/studio/speech-practice/omni-analysis
 * body: {
 *   config: { language?, direction?, difficulty?, durationMinutes? },
 *   turns: [{ role, text }],
 *   feedback: [{ round, overall, … }],
 *   audioSegments: [{ index, text, wavBase64 }],   // WAV base64
 *   frames: string[],                              // data:image/jpeg;base64,…
 *   apiKey?: string,                               // 客户端持有的 DashScope key
 *   model?: string
 * }
 * response: { ok: true, markdown: string } | { ok: false, error: string }
 *
 * 会话结束后把录音 + 画面 + 转写交给 Qwen3.5-Omni（HTTP 全模态）生成一段
 * Markdown 深度分析；客户端随后把该段拼接到确定性报告末尾再走 /report 落盘。
 */
export async function generateOmniAnalysis(ctx: any): Promise<void> {
  const body = (ctx.request?.body || {}) as Record<string, unknown>
  const configRaw = (body.config && typeof body.config === 'object'
    ? body.config
    : {}) as Record<string, unknown>

  const input: OmniPracticeAnalysisInput = {
    config: {
      language: readString(configRaw.language, 20) || undefined,
      direction: readString(configRaw.direction, 300) || undefined,
      difficulty: readString(configRaw.difficulty, 20) || undefined,
      durationMinutes:
        typeof configRaw.durationMinutes === 'number' && Number.isFinite(configRaw.durationMinutes)
          ? configRaw.durationMinutes
          : undefined,
    },
    turns: readArray(body.turns).map((turn) => ({
      role: turn.role === 'user' ? 'user' as const : 'assistant' as const,
      text: readString(turn.text, 2000),
    })).filter((turn) => turn.text.length > 0),
    feedback: readArray(body.feedback).map((f) => ({
      round: typeof f.round === 'number' ? f.round : 0,
      overall: typeof f.overall === 'number' ? f.overall : 0,
      fluency: typeof f.fluency === 'number' ? f.fluency : null,
      pronunciation: typeof f.pronunciation === 'number' ? f.pronunciation : null,
      grammar: typeof f.grammar === 'number' ? f.grammar : null,
      vocabulary: typeof f.vocabulary === 'number' ? f.vocabulary : null,
      content: typeof f.content === 'number' ? f.content : null,
      bodyLanguage: typeof f.bodyLanguage === 'number' ? f.bodyLanguage : null,
      comment: readString(f.comment, 600),
      strengths: readString(f.strengths, 400),
      improvements: readString(f.improvements, 400),
      example: readString(f.example, 400),
    })),
    audioSegments: readArray(body.audioSegments).map((seg) => ({
      index: typeof seg.index === 'number' ? seg.index : 0,
      text: readString(seg.text, 600),
      wavBase64: readString(seg.wavBase64, 2_000_000),
    })).filter((seg) => seg.wavBase64.length > 0),
    frames: Array.isArray(body.frames)
      ? body.frames.map((f) => (typeof f === 'string' ? f : '')).filter(Boolean)
      : [],
    apiKey: readString(body.apiKey, 512) || undefined,
    model: readString(body.model, 120) || OMNI_ANALYSIS_DEFAULT_MODEL,
  }

  try {
    validateOmniAnalysisInput(input)
  } catch (err: any) {
    ctx.status = 413
    ctx.body = { ok: false, error: err?.message || 'invalid analysis input' }
    return
  }

  if (input.audioSegments.length === 0 && input.frames.length === 0) {
    ctx.status = 400
    ctx.body = { ok: false, error: 'audioSegments and frames are both empty' }
    return
  }

  // body.stream（或 ?stream=1）：以 SSE 流式返回生成增量，前端实时渲染
  // “md 看板”。DashScope 端本身强制 stream，这里把增量转发成
  // `data: {"type":"delta","text":…}` 事件；出错发 error 事件后关闭。
  const streamRequested = body.stream === true || String(ctx.query?.stream || '') === '1'
  if (streamRequested) {
    await streamOmniAnalysisResponse(ctx, input)
    return
  }

  try {
    const markdown = await generateOmniPracticeAnalysis(input)
    ctx.status = 200
    ctx.body = { ok: true, markdown }
  } catch (err: any) {
    const message = err?.message || String(err || 'unknown error')
    const status = /timeout/i.test(message) || /timed out/i.test(message) ? 504 : 502
    ctx.status = status
    ctx.body = { ok: false, error: message.slice(0, 500) }
  }
}

/** SSE 转发：把 Omni 分析增量逐段写给浏览器，客户端断开即中止上游（省 token）。 */
async function streamOmniAnalysisResponse(ctx: any, input: OmniPracticeAnalysisInput): Promise<void> {
  ctx.status = 200
  ctx.set('Content-Type', 'text/event-stream; charset=utf-8')
  ctx.set('Cache-Control', 'no-cache')
  ctx.set('Connection', 'keep-alive')
  ctx.set('X-Accel-Buffering', 'no')
  // 手动接管响应体（不再由 koa 写 JSON）
  ctx.respond = false
  const res = ctx.res
  if (typeof res.flushHeaders === 'function') res.flushHeaders()

  const controller = new AbortController()
  const onClose = (): void => controller.abort()
  if (typeof ctx.req?.on === 'function') ctx.req.on('close', onClose)

  const writeEvent = (event: unknown): void => {
    if (res.destroyed) return
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  try {
    for await (const event of streamOmniPracticeAnalysis(input, { signal: controller.signal })) {
      if (res.destroyed) break
      writeEvent(event)
      if (event.type === 'error' || event.type === 'done') break
    }
  } catch (err: any) {
    writeEvent({ type: 'error', message: String(err?.message || err || 'stream failed').slice(0, 500) })
  } finally {
    if (typeof ctx.req?.off === 'function') ctx.req.off('close', onClose)
    if (!res.destroyed) res.end()
  }
}
