import type { Context } from 'koa'
import { PassThrough } from 'node:stream'
import http from 'node:http'
import https from 'node:https'
import { meetingASRService } from '../services/meeting-asr/index'
import { REPORT_FALLBACK_MARKER } from '../services/meeting-asr/realtime-assist'
import { logger } from '../public/logging'
import { userCanAccessProfile } from '../public/users'

/**
 * Meeting assist runs against an agent profile's knowledge. Enforce the same
 * profile-ownership rules as the rest of the app for JWT users; loopback
 * server-token callers (the local ASR service itself) and super admins pass.
 * Returns true when access was denied (response already written).
 */
function denyProfileAccess(ctx: Context, profile: unknown): boolean {
  if (typeof profile !== 'string' || !profile.trim()) return false
  const user = ctx.state.user
  if (!user || user.role === 'super_admin' || ctx.state.serverTokenAuth) return false
  if (!userCanAccessProfile(user.id, profile.trim())) {
    ctx.status = 403
    ctx.body = { error: `Profile "${profile}" is not accessible for this user` }
    return true
  }
  return false
}

/**
 * Talk to the local ASR backend over the protocol it was spawned with.
 *
 * Uses `node:http(s)` rather than `fetch` on purpose: the device image can
 * spawn uvicorn with a self-signed cert (`HERMES_WEB_UI_MEETING_ASR_TLS=true`),
 * and undici's `dispatcher` option rejects a `node:https.Agent` with
 * `agent.dispatch is not a function` — every proxied call then fails with 502.
 * `rejectUnauthorized:false` on the native transport is the supported way to
 * accept the shared cert.
 */
function backendHttpRequest(
  asrPort: number,
  useTls: boolean,
  path: string,
  method: 'GET' | 'POST',
  body?: string,
  headers?: Record<string, string>,
  timeoutMs = 30_000,
): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const transport = useTls ? https : http
    const req = transport.request(
      {
        host: '127.0.0.1',
        port: asrPort,
        path,
        method,
        headers: headers ?? {},
        timeout: timeoutMs,
        ...(useTls ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({
          status: res.statusCode || 502,
          body: Buffer.concat(chunks).toString('utf-8'),
          contentType: String(res.headers['content-type'] || ''),
        }))
      },
    )
    req.on('timeout', () => {
      req.destroy(new Error(`backend request timed out after ${timeoutMs}ms`))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

async function proxyToBackend(ctx: Context, path: string, method: 'GET' | 'POST' = 'GET', body?: any): Promise<any> {
  const status = meetingASRService.status
  if (!status.isRunning || !status.asrPort) {
    ctx.status = 503
    // Carry the service-side reason (crash / restart phase / last error) so a
    // bare "Service Unavailable" in the browser console is diagnosable.
    ctx.body = {
      error: 'ASR service is not running',
      detail: status.error || null,
      startupPhase: status.startupPhase,
      uptime: status.uptime,
      pid: status.pid,
    }
    return null
  }

  try {
    const payload = body && method === 'POST' ? JSON.stringify(body) : undefined
    const response = await backendHttpRequest(
      status.asrPort,
      !!status.useTls,
      path,
      method,
      payload,
      { 'Content-Type': 'application/json' },
      // The analysis/HTML routes can be slow on ARM64; keep the old generous
      // ceiling so this refactor does not introduce new timeouts.
      path === '/api/analysis/html' || path.startsWith('/api/analysis/') ? 120_000 : 30_000,
    )

    if (path === '/api/analysis/html') {
      ctx.type = 'text/html'
      ctx.body = response.body
      return null
    }

    ctx.status = response.status
    try {
      ctx.body = response.body ? JSON.parse(response.body) : null
    } catch {
      // Backend returned non-JSON — surface the raw body so the client still sees something useful.
      ctx.body = response.body
    }
    return ctx.body
  } catch (err) {
    ctx.status = 502
    ctx.body = { error: `Failed to proxy to ASR backend: ${err}` }
    return null
  }
}

// Service lifecycle
export async function startASRService(ctx: Context): Promise<void> {
  try {
    const config = ctx.request.body as any || {}

    // If no API key provided, check if we have it in stored config
    if (!config.dashscopeApiKey) {
      // Try to read from data directory. Resolve the same way as
      // MeetingASRService.getDataDir() so controller + service agree on the
      // root. Before this fix, the controller hardcoded process.cwd()/data
      // which diverged from the service's MEETING_ASR_DATA_DIR override,
      // so a key saved under the env-overridden data dir was invisible here.
      const fs = await import('fs/promises')
      const path = await import('path')
      const dataDir = config.dataDir
        || process.env.MEETING_ASR_DATA_DIR
        || path.join(process.cwd(), 'data', 'meeting-asr')

      // 1. config.json (JSON structure)
      const configFile = path.join(dataDir, 'config.json')
      try {
        const content = await fs.readFile(configFile, 'utf-8')
        const storedConfig = JSON.parse(content)
        if (storedConfig.asr?.dashscope_api_key) {
          config.dashscopeApiKey = storedConfig.asr.dashscope_api_key
          logger.info('[meeting-asr-ctrl] dashscopeApiKey from config.asr.dashscope_api_key')
        } else if (storedConfig.llm?.api_key) {
          config.dashscopeApiKey = storedConfig.llm.api_key
          logger.info('[meeting-asr-ctrl] dashscopeApiKey fallback from config.llm.api_key')
        }
        if (storedConfig.llm?.api_key) {
          config.llmApiKey = storedConfig.llm.api_key
        }
        if (storedConfig.llm?.base_url) {
          config.llmBaseUrl = storedConfig.llm.base_url
        }
        if (storedConfig.llm?.model) {
          config.llmModel = storedConfig.llm.model
        }
      } catch {
        logger.error('[meeting-asr-ctrl] failed to read config file: %s', configFile)
      }

      // 2. config.env (shell-style KEY=VALUE). The Python backend writes
      // DASHSCOPE_API_KEY here via storage.update_config(); if the JSON
      // path didn't yield a key, this is where it lives.
      if (!config.dashscopeApiKey) {
        try {
          const envFile = path.join(dataDir, 'config.env')
          const raw = await fs.readFile(envFile, 'utf-8')
          for (const line of raw.split('\n')) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith('#')) continue
            const eq = trimmed.indexOf('=')
            if (eq === -1) continue
            if (trimmed.slice(0, eq).trim() === 'DASHSCOPE_API_KEY') {
              let val = trimmed.slice(eq + 1).trim()
              if ((val.startsWith('"') && val.endsWith('"')) ||
                  (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1)
              }
              if (val) {
                config.dashscopeApiKey = val
                logger.info('[meeting-asr-ctrl] dashscopeApiKey from config.env')
                break
              }
            }
          }
        } catch {
          // config.env missing — not an error, just no key there
        }
      }

      if (!config.dashscopeApiKey) {
        logger.warn('[meeting-asr-ctrl] no dashscopeApiKey found in config.json or config.env')
      }
    } else {
      logger.info('[meeting-asr-ctrl] dashscopeApiKey provided by frontend')
    }

    await meetingASRService.start(config)
    ctx.body = {
      status: 'started',
      ...meetingASRService.status,
    }
  } catch (err) {
    ctx.status = 500
    ctx.body = {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function stopASRService(ctx: Context): Promise<void> {
  try {
    await meetingASRService.stop()
    ctx.body = {
      status: 'stopped',
    }
  } catch (err) {
    ctx.status = 500
    ctx.body = {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function getASRStatus(ctx: Context): Promise<void> {
  ctx.body = meetingASRService.status
}

export async function updateASRConfig(ctx: Context): Promise<void> {
  try {
    const config = ctx.request.body as any
    await meetingASRService.updateConfig(config)
    ctx.body = { status: 'ok', message: 'Configuration updated' }
  } catch (err) {
    ctx.status = 500
    ctx.body = {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// Proxy endpoints
export async function proxyHealthCheck(ctx: Context): Promise<void> {
  await proxyToBackend(ctx, '/healthz')
}

export async function getCurrentConfig(ctx: Context): Promise<void> {
  await proxyToBackend(ctx, '/api/config')
}

export async function updateCurrentConfig(ctx: Context): Promise<void> {
  await proxyToBackend(ctx, '/api/config', 'POST', ctx.request.body)
}

// Analysis endpoints
export async function startAnalysis(ctx: Context): Promise<void> {
  await proxyToBackend(ctx, '/api/analysis/start', 'POST', ctx.request.body)
}

export async function stopAnalysis(ctx: Context): Promise<void> {
  await proxyToBackend(ctx, '/api/analysis/stop', 'POST')
}

export async function triggerAnalysis(ctx: Context): Promise<void> {
  await proxyToBackend(ctx, '/api/analysis/trigger', 'POST')
}

export async function getAnalysisStatus(ctx: Context): Promise<void> {
  await proxyToBackend(ctx, '/api/analysis/status')
}

export async function getAnalysisResult(ctx: Context): Promise<void> {
  await proxyToBackend(ctx, '/api/analysis/result')
}

export async function getAnalysisHTML(ctx: Context): Promise<void> {
  await proxyToBackend(ctx, '/api/analysis/html')
}

export async function proxyAnalysisStream(ctx: Context): Promise<void> {
  const status = meetingASRService.status
  if (!status.isRunning || !status.asrPort) {
    ctx.status = 503
    ctx.body = { error: 'ASR service is not running' }
    return
  }

  ctx.type = 'text/event-stream'
  ctx.set('Cache-Control', 'no-cache')
  ctx.set('Connection', 'keep-alive')

  try {
    // Same transport rule as proxyToBackend: undici cannot accept the
    // node:https.Agent used for the self-signed backend cert, so the
    // long-lived SSE stream is opened with node:http(s) and piped to Koa.
    const transport = status.useTls ? https : http
    const upstream = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = transport.request(
        {
          host: '127.0.0.1',
          port: status.asrPort!,
          path: '/api/analysis/stream',
          method: 'GET',
          // SSE: no request timeout — the stream stays open for the session.
          timeout: 0,
          ...(status.useTls ? { rejectUnauthorized: false } : {}),
        },
        (res) => resolve(res),
      )
      req.on('error', reject)
      req.end()
    })

    ctx.status = upstream.statusCode || 502
    upstream.on('error', (err) => {
      logger.warn('[meeting-asr-ctrl] analysis stream aborted: %s', err instanceof Error ? err.message : err)
    })
    ctx.body = upstream
  } catch (err) {
    ctx.status = 502
    ctx.body = { error: `Failed to proxy to ASR backend: ${err}` }
  }
}

// Scene templates
export async function getSceneTemplates(ctx: Context): Promise<void> {
  const { SCENE_TEMPLATES } = await import('../services/meeting-asr/scene-templates')
  ctx.body = SCENE_TEMPLATES.map(t => ({
    id: t.id,
    name: t.name,
    description: t.description,
  }))
}

// Realtime assist
export async function startAssist(ctx: Context): Promise<void> {
  const { realtimeAssistService } = await import('../services/meeting-asr/realtime-assist')
  const { sessionId, sceneTemplate, profile, speechContext } = ctx.request.body as any || {}
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) {
    ctx.status = 400
    ctx.body = { error: 'sessionId is required' }
    return
  }
  if (denyProfileAccess(ctx, profile)) return
  await realtimeAssistService.startSession(sessionId, sceneTemplate || 'general', profile, speechContext || null, ctx.state.user?.id)
  ctx.body = { status: 'started', sessionId, sceneTemplate: sceneTemplate || 'general', profile: profile || null }
}

export async function stopAssist(ctx: Context): Promise<void> {
  const { realtimeAssistService } = await import('../services/meeting-asr/realtime-assist')
  const { sessionId } = ctx.request.body as any || {}
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) {
    ctx.status = 400
    ctx.body = { error: 'sessionId is required' }
    return
  }
  realtimeAssistService.stopSession(sessionId, ctx.state.user?.id)
  ctx.body = { status: 'stopped', sessionId }
}

export async function updateAssistContext(ctx: Context): Promise<void> {
  const { realtimeAssistService } = await import('../services/meeting-asr/realtime-assist')
  const { sessionId, speechContext } = ctx.request.body as any || {}
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200 || !speechContext) {
    ctx.status = 400
    ctx.body = { error: 'sessionId and speechContext are required' }
    return
  }
  realtimeAssistService.updateSpeechContext(sessionId, speechContext, ctx.state.user?.id)
  ctx.body = { status: 'ok', sessionId }
}

export async function analyzeAssist(ctx: Context): Promise<void> {
  const { realtimeAssistService } = await import('../services/meeting-asr/realtime-assist')
  const { sessionId, speechContext } = ctx.request.body as any || {}
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) {
    ctx.status = 400
    ctx.body = { error: 'sessionId is required' }
    return
  }
  // 允许随触发请求携带最新演讲上下文（当前倒计时等），先应用再立即分析。
  if (speechContext) {
    realtimeAssistService.updateSpeechContext(sessionId, speechContext, ctx.state.user?.id)
  }
  realtimeAssistService.flushNow(sessionId, ctx.state.user?.id)
  ctx.body = { status: 'ok', sessionId }
}

export async function pushAssistSentence(ctx: Context): Promise<void> {
  const { realtimeAssistService } = await import('../services/meeting-asr/realtime-assist')
  const { sessionId, speaker, text, timestamp } = ctx.request.body as any || {}
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200 || !text) {
    ctx.status = 400
    ctx.body = { error: 'sessionId and text are required' }
    return
  }
  realtimeAssistService.pushSentence(sessionId, { speaker, text, timestamp }, ctx.state.user?.id)
  ctx.body = { status: 'ok' }
}

// Report generation (SSE streaming)
export async function streamReport(ctx: Context): Promise<void> {
  const { realtimeAssistService } = await import('../services/meeting-asr/realtime-assist')
  const { sessionId, sceneTemplate, transcript, profile } = (ctx.request.body as any) || {}

  if (!sessionId || !transcript) {
    ctx.status = 400
    ctx.body = { error: 'sessionId and transcript are required' }
    return
  }
  if (denyProfileAccess(ctx, profile)) return

  ctx.type = 'text/event-stream'
  ctx.set('Cache-Control', 'no-cache')
  ctx.set('Connection', 'keep-alive')
  ctx.status = 200

  // 使用 Node.js PassThrough 流（Koa 原生支持管道传输）。
  // 注意：WHATWG Web ReadableStream 会被 Koa 序列化为 {}，不能直接用作 ctx.body。
  const passthrough = new PassThrough()
  ctx.body = passthrough

  void (async () => {
    try {
      const stream = realtimeAssistService.generateReportStream(sessionId, transcript, sceneTemplate, profile)
      for await (const chunk of stream) {
        // 服务层会在「agent 中途失败、回退到 direct LLM」时 yield 一个 Symbol sentinel；
        // 把它翻译成专用的 SSE 控制帧，前端识别后清空已累积的部分内容，
        // 再继续接收 LLM 的真实 chunks。Symbol 永远不会出现在 LLM 文本里，安全。
        if (typeof chunk === 'symbol' && chunk === REPORT_FALLBACK_MARKER) {
          passthrough.write(`data: ${JSON.stringify({ fallback: true })}\n\n`)
          continue
        }
        passthrough.write(`data: ${JSON.stringify({ text: chunk })}\n\n`)
      }
      passthrough.write('data: [DONE]\n\n')
    } catch (err) {
      // 上游错误（LLM 流中断 / provider 返回错误帧 / agent bridge 失败），
      // 之前 String(err) 会把整个 stack 字符串化塞给前端；这里只保留可读 message，
      // 同时附上完整 error 的 type，方便前端归类（timeout / network / llm / agent / unknown）。
      const message = err instanceof Error ? err.message : String(err)
      const errorType = err instanceof Error ? err.name : 'UnknownError'
      passthrough.write(`data: ${JSON.stringify({ error: { message, type: errorType } })}\n\n`)
    } finally {
      passthrough.end()
    }
  })()
}

// Note: transcripts and prompts were removed as dead code (v0.7.6 audit #17).
// Frontend manages transcript locally via meetingStore; prompts are configured
// via /api/studio/meeting-asr/config and used by the Python analysis service directly.

/**
 * 会议自动命名（首次 AI 分析完成时，前端基于当前已有转写调用一次，拿到简短标题）。
 * 走 meeting-asr 直调 LLM 快路径（config.json），任一步失败都返回 { title: null }，
 * 不打断会议主流程（最终报告标题行仍会兜底命名）。
 */
export async function meetingTitle(ctx: Context): Promise<void> {
  const { transcript } = (ctx.request.body as any) || {}
  if (!transcript || typeof transcript !== 'string' || !transcript.trim()) {
    ctx.status = 400
    ctx.body = { error: 'transcript is required' }
    return
  }

  try {
    const { generateMeetingTitle } = await import('../services/meeting-asr/direct-llm')
    const title = await generateMeetingTitle(transcript)
    ctx.body = { title }
  } catch (err) {
    logger.warn('[meeting-asr-ctrl] meetingTitle failed: %s', err instanceof Error ? err.message : String(err))
    ctx.body = { title: null }
  }
}

// ── Whole-file transcription (batch) ─────────────────────────────────────
// The raw audio body is streamed straight through to the Python backend,
// which starts a background job and answers with a job id. The client polls
// /transcribe/status/:jobId — long recordings can take minutes to transcribe
// and must not hold a single request open.

/** Mirrors the Python-side cap; keeps runaway uploads off the proxy. */
const TRANSCRIBE_MAX_BYTES = Number(process.env.MEETING_TRANSCRIBE_MAX_BYTES) || 250 * 1024 * 1024

/**
 * Pipe the request body to the local ASR backend and resolve with its JSON
 * response. Uses node:http instead of fetch so the stream body can be
 * forwarded without buffering it in memory, and TLS (device images spawn
 * uvicorn with a self-signed cert) can be handled explicitly.
 */
function requestBackendRaw(
  asrPort: number,
  useTls: boolean,
  path: string,
  source: NodeJS.ReadableStream,
  contentType: string,
  contentLength?: number,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const transport = useTls ? https : http
    const headers: Record<string, string> = { 'Content-Type': contentType }
    if (contentLength && Number.isFinite(contentLength)) {
      headers['Content-Length'] = String(contentLength)
    }
    const req = transport.request(
      {
        host: '127.0.0.1',
        port: asrPort,
        path,
        method: 'POST',
        headers,
        // 0 disables the socket timeout: transcription upload can be large.
        timeout: 0,
        ...(useTls ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            status: res.statusCode || 502,
            body: Buffer.concat(chunks).toString('utf-8'),
          })
        })
      },
    )
    req.on('error', reject)
    source.on('error', (err: Error) => {
      req.destroy(err)
      reject(err)
    })
    source.pipe(req)
  })
}

/** Map the client's camelCase query keys onto the Python snake_case ones. */
function buildTranscribeQuery(ctx: Context): string {
  const q = ctx.query || {}
  const params = new URLSearchParams()
  const engine = String(q.engine ?? 'minimax')
  params.set('engine', engine === 'qwen' || engine === 'dashscope' ? 'qwen' : 'minimax')
  const diarize = String(q.diarize ?? 'false')
  params.set('diarize', diarize === 'true' || diarize === '1' ? 'true' : 'false')
  const speakerCount = String(q.speakerCount ?? q.speaker_count ?? '0')
  params.set('speaker_count', /^\d+$/.test(speakerCount) ? speakerCount : '0')
  if (q.language) params.set('language', String(q.language))
  if (q.sessionId) params.set('session_id', String(q.sessionId))
  return params.toString()
}

export async function startFileTranscription(ctx: Context): Promise<void> {
  const status = meetingASRService.status
  if (!status.isRunning || !status.asrPort) {
    ctx.status = 503
    ctx.body = { error: 'ASR service is not running' }
    return
  }

  const declared = Number(ctx.request.length ?? ctx.req.headers['content-length'] ?? 0)
  if (declared && declared > TRANSCRIBE_MAX_BYTES) {
    ctx.status = 413
    ctx.body = { error: `Audio too large: ${declared} > ${TRANSCRIBE_MAX_BYTES} bytes` }
    return
  }

  const query = buildTranscribeQuery(ctx)
  try {
    const result = await requestBackendRaw(
      status.asrPort,
      !!status.useTls,
      `/api/transcribe/file?${query}`,
      ctx.req,
      ctx.request.type || 'application/octet-stream',
      declared || undefined,
    )
    ctx.status = result.status
    try {
      ctx.body = result.body ? JSON.parse(result.body) : null
    } catch {
      ctx.body = result.body
    }
  } catch (err) {
    ctx.status = 502
    ctx.body = { error: `Failed to proxy audio to ASR backend: ${err}` }
  }
}

export async function getFileTranscriptionStatus(ctx: Context): Promise<void> {
  const { jobId } = ctx.params
  if (!jobId || !/^[a-zA-Z0-9_-]+$/.test(jobId)) {
    ctx.status = 400
    ctx.body = { error: 'invalid jobId' }
    return
  }
  await proxyToBackend(ctx, `/api/transcribe/status/${jobId}`)
}
