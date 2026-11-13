/**
 * Realtime 工具调用的服务端 Agent 代理。
 *
 * 给 Omni-Realtime（`/ws/omni-realtime` → Qwen3.8-Omni-Flash-Realtime）的
 * function calling 提供一个能直接驱动 Hermes Agent 的能力。客户端工具
 * `query_hermes_agent(question)` 通过 HTTP POST 把用户随口问的一句问题送到
 * 这里，本控制器走与 `/chat-run` 同款的 AgentBridgeClient 链路：
 *
 *   1. 启动一个临时 session（不落库、不进 sidebar）；
 *   2. 调用 `bridge.chat()` 触发 AIAgent，可以走用户的 MCP / skills / terminal_exec 等；
 *   3. 流式收集 `bridge.streamOutput()` 的 delta；
 *   4. 在 timeoutMs（默认 60s）内拼成最终回复文本返回。
 *
 * 为什么不直接走 `/chat-run` Socket.IO：
 *   - 该路径会落到 chat-store 并开始长连接流，realtime 工具是一次性的快路径；
 *   - 这里只关心 final_response 文本，工具调用事件对调用方不可见；
 *   - 不占用 chat-run 命名空间、不污染 session 列表。
 *
 * 输出大小硬限 16 KB：与 Omni 工具结果客户端上限 4 KB 兼容（前端会再做截断），
 * 也避免 agent 长输出把单次 HTTP 拉爆。
 */
import { createPrimaryAgentBridge, type PrimaryAgentBridgeOutput as AgentBridgeOutput } from '../public/chat-agent-runtime'
import type { MeetingAgentBridge } from '../services/meeting-asr/agent-bridge'

const MAX_OUTPUT_CHARS = 16_000
const DEFAULT_TIMEOUT_MS = 60_000

type BridgeLike = MeetingAgentBridge

export interface RealtimeAgentBridgeDeps {
  createBridge?: () => Promise<BridgeLike> | BridgeLike
}

async function defaultCreateBridge(): Promise<BridgeLike> {
  return createPrimaryAgentBridge({ connectRetryMs: 1500 }) as BridgeLike
}

function trimOutput(value: string): string {
  if (value.length <= MAX_OUTPUT_CHARS) return value
  return `${value.slice(0, MAX_OUTPUT_CHARS)}…(truncated ${value.length - MAX_OUTPUT_CHARS} chars)`
}

/**
 * 与 packages/server/src/services/meeting-asr/agent-bridge.ts 同源的 agent
 * 优雅失败识别，避免把 "API call failed after N retries" 这种假完成回复
 * 当成真正的答案吐给前端。
 */
function looksLikeStandaloneAgentFailure(value: string): boolean {
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text) return false
  if (text.length > 2_000) return false
  return (
    /\bAPI call failed after\b/i.test(text)
    || /\bHTTP\s+(?:4\d\d|5\d\d)\b/i.test(text)
    || /\bProvider returned an empty stream\b/i.test(text)
    || /\b(?:401|403)\b.{0,100}\b(?:unauthorized|forbidden|authentication|auth|invalid api key|permission denied)\b/i.test(text)
    || /\b(?:unauthorized|forbidden|authentication|auth|invalid api key|permission denied)\b.{0,100}\b(?:401|403)\b/i.test(text)
    || /\b429\b.{0,100}\b(?:rate limit|too many requests|quota)\b/i.test(text)
    || /\b(?:rate limit|too many requests|quota)\b.{0,100}429\b/i.test(text)
    || /\b(?:500|502|503|504)\b.{0,100}\b(?:server error|bad gateway|service unavailable|gateway timeout|upstream|provider|request failed|api)\b/i.test(text)
    || /\b(?:server error|bad gateway|service unavailable|gateway timeout|upstream|provider|request failed|api)\b.{0,100}\b(?:500|502|503|504)\b/i.test(text)
    || /(?:无可用渠道|渠道不可用|认证失败|鉴权失败|额度不足|余额不足|请求失败|接口调用失败)/i.test(text)
  )
}

/**
 * 一次性驱动 Hermes Agent 回答用户问题，返回最终回复文本。
 * 不抛出上游 SDK 异常：失败时返回 `{ ok: false, error }`，由 controller
 * 落到 502 响应里。
 */
export async function runRealtimeAgentQuery(
  question: string,
  profile: string,
  options: {
    timeoutMs?: number
    sessionIdHint?: string
    deps?: RealtimeAgentBridgeDeps
  } = {},
): Promise<{ ok: true; text: string; sessionId: string } | { ok: false; error: string; sessionId: string }> {
  const bridge = options.deps?.createBridge
    ? await options.deps.createBridge()
    : await defaultCreateBridge()
  const sessionId = options.sessionIdHint || `omni-realtime-${Date.now()}`
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  try {
    const started = await bridge.chat(
      sessionId,
      question,
      undefined,
      undefined,
      profile || undefined,
      { source: 'omni-realtime', wait: true, timeout: timeoutMs },
    )

    let accumulated = ''
    let yieldedAny = false
    for await (const chunk of bridge.streamOutput(started.run_id, { timeoutMs })) {
      if (chunk.delta) {
        accumulated += chunk.delta
        yieldedAny = true
        if (accumulated.length > MAX_OUTPUT_CHARS * 2) break
      }
      if (chunk.done) {
        if (!yieldedAny) {
          const result = chunk.result as { final_response?: string } | undefined
          accumulated = result?.final_response || chunk.output || ''
        }
        break
      }
      if (chunk.status === 'error') {
        return { ok: false, error: chunk.error || 'agent run failed', sessionId }
      }
    }

    const text = accumulated.trim()
    if (!text) return { ok: false, error: 'agent produced no output', sessionId }
    if (looksLikeStandaloneAgentFailure(text)) {
      return { ok: false, error: text, sessionId }
    }
    return { ok: true, text: trimOutput(text), sessionId }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message || 'agent run failed', sessionId }
  } finally {
    void bridge.destroy(sessionId, profile || undefined).catch(() => { /* ignore */ })
  }
}

function requestedProfile(ctx: any): string {
  return ctx.state?.profile?.name || 'default'
}

function readString(value: unknown, max = 8_000): string {
  if (typeof value !== 'string') return ''
  return value.slice(0, max)
}

/**
 * POST /api/studio/realtime/agent-query
 * body: { question: string, profile?: string, timeoutMs?: number }
 * response: { ok: true, text: string, sessionId: string } | { ok: false, error: string }
 */
export async function queryAgent(ctx: any) {
  const body = (ctx.request?.body || {}) as Record<string, unknown>
  const question = readString(body.question).trim()
  if (!question) {
    ctx.status = 400
    ctx.body = { ok: false, error: 'question is required' }
    return
  }
  if (question.length > 4_000) {
    ctx.status = 400
    ctx.body = { ok: false, error: 'question too long (max 4000 chars)' }
    return
  }
  const profile = readString(body.profile) || requestedProfile(ctx)
  const timeoutMs = Math.min(180_000, Math.max(5_000, Number(body.timeoutMs) || DEFAULT_TIMEOUT_MS))

  const result = await runRealtimeAgentQuery(question, profile, { timeoutMs })
  ctx.status = result.ok ? 200 : 502
  ctx.body = result
}

/** Direct terminal calls preserve the terminal's super-admin boundary. */
export async function terminalCommand(ctx: any) {
  const { isAuthEnabled } = await import('../public/auth')
  if (await isAuthEnabled() && ctx.state.user?.role !== 'super_admin') {
    ctx.status = 403
    ctx.body = { error: 'Super administrator privileges are required' }
    return
  }
  const { command, args = [] } = ctx.request.body || {}
  if (typeof command !== 'string' || !command.trim() || command.length > 512 || command.includes('\0')
    || !Array.isArray(args) || args.length > 64
    || args.some((arg: unknown) => typeof arg !== 'string' || arg.length > 4000 || arg.includes('\0'))) {
    ctx.status = 400
    ctx.body = { error: 'Expected command and bounded string argument array' }
    return
  }
  const controller = new AbortController()
  const abort = () => controller.abort()
  ctx.res.once('close', abort)
  try {
    const { runRealtimeCommand } = await import('../services/terminal/realtime-command')
    ctx.body = await runRealtimeCommand(command, args, controller.signal)
  } finally {
    ctx.res.removeListener('close', abort)
  }
}
