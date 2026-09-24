import { setTimeout as delay } from 'timers/promises'
import { createConnection, type Socket } from 'net'
import { tmpdir } from 'os'
import { URL } from 'url'
import { join } from 'path'
import { bridgeLogger } from '../../../studio/public/logging'
import type { McpActionResponse } from '../../contracts/mcp'
import { getActiveProfileName, getProfileDir } from '../profiles/profile'

function resolveDefaultAgentBridgeEndpoint(): string {
  if (process.env.VITEST) {
    return process.platform === 'win32'
      ? `tcp://127.0.0.1:${28000 + (process.pid % 10000)}`
      : `ipc://${join(tmpdir(), `hermes-agent-bridge-test-${process.pid}.sock`)}`
  }
  return process.platform === 'win32'
    ? 'tcp://127.0.0.1:18765'
    : 'ipc:///tmp/hermes-agent-bridge.sock'
}

export const DEFAULT_AGENT_BRIDGE_ENDPOINT = resolveDefaultAgentBridgeEndpoint()
export const DEFAULT_AGENT_BRIDGE_TIMEOUT_MS = 120000

function envPositiveInt(name: string): number | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

export type AgentBridgeStatus = 'running' | 'complete' | 'interrupted' | 'error'

export interface AgentBridgeOptions {
  endpoint?: string
  timeoutMs?: number
  connectRetryMs?: number
}

export interface AgentBridgeRequestOptions {
  timeoutMs?: number
  serialize?: boolean
}

export interface AgentBridgeChatOptions {
  force_compress?: boolean
  /** Agent-session creation policy. False keeps delegate_task available but
   * makes background=true fall back to synchronous execution. */
  background_delegation_enabled?: boolean
  storage_message?: AgentBridgeMessage
  model?: string
  provider?: string
  workspace?: string
  source?: string
  wait?: boolean
  timeout?: number
  /** Local patch (reasoning-effort): per-session reasoning effort override.
   * Empty/undefined = use config.yaml default. */
  reasoning_effort?: string
}

export type AgentBridgeMessage =
  | string
  | Array<Record<string, unknown>>

export interface AgentBridgeResponse {
  ok: true
  [key: string]: unknown
}

export interface AgentBridgeChatStarted extends AgentBridgeResponse {
  run_id: string
  session_id: string
  status: AgentBridgeStatus
}

export interface AgentBridgeOutput extends AgentBridgeResponse {
  run_id: string
  session_id: string
  status: AgentBridgeStatus
  delta: string
  cursor: number
  output: string
  done: boolean
  result?: unknown
  error?: string | null
  events: Array<Record<string, unknown>>
  event_cursor: number
}

export interface AgentBridgeRunResult extends AgentBridgeResponse {
  run_id: string
  session_id: string
  status: AgentBridgeStatus
  output: string
  deltas: string[]
  events: unknown[]
  result?: unknown
  error?: string | null
}

export type AgentBridgeBoundaryInterruptStatus =
  | 'accepted'
  | 'already_pending'
  | 'not_running'
  | 'run_mismatch'
  | 'unsupported'

export interface AgentBridgeBoundaryInterrupt extends AgentBridgeResponse {
  status: AgentBridgeBoundaryInterruptStatus
  session_id: string
  run_id?: string
  phase?: 'model' | 'tool_batch'
  guarantee: 'strict' | 'none'
  reason?: string
}

export interface AgentBridgeSessionTitle extends AgentBridgeResponse {
  session_id: string
  title: string
}

export interface AgentBridgeContextEstimate extends AgentBridgeResponse {
  session_id: string
  token_count?: number | null
  fixed_context_tokens?: number | null
  system_prompt_tokens?: number | null
  tool_tokens?: number | null
  message_count: number
  tool_count: number
  tool_names?: string[]
  system_prompt_chars: number
  profile?: string
  model?: string
  provider?: string
}

export interface AgentBridgeProviderCredentials extends AgentBridgeResponse {
  resolved: boolean
  requested_provider: string
  provider?: string
  api_key?: string
  base_url?: string
  api_mode?: string
  source?: string
  last_refresh?: string
  expires_at?: string
  expires_at_ms?: number
  error?: string
  code?: string
  relogin_required?: boolean
}

export interface AgentBridgeImageProvider {
  name: string
  display_name: string
  available: boolean
  active: boolean
  default_model?: string | null
  models: Array<{ id: string; display?: string; [key: string]: unknown }>
  capabilities: { modalities?: string[]; max_reference_images?: number; [key: string]: unknown }
  setup: { badge?: string; tag?: string; required_env_vars?: string[] }
}

export interface AgentBridgeImageProviders extends AgentBridgeResponse {
  providers: AgentBridgeImageProvider[]
}

export interface AgentBridgeImageGenerateResult extends AgentBridgeResponse {
  provider: string
  result: {
    success: boolean
    image?: string | null
    model?: string
    error?: string
    error_type?: string
    [key: string]: unknown
  }
}

export interface AgentBridgeCommandResult extends AgentBridgeResponse {
  session_id: string
  command: string
  handled: boolean
  type?: string
  action?: string
  message?: string
  output?: string
  notice?: string
  loaded?: string[]
  missing?: string[]
  new_session_id?: string
  history?: unknown[]
  retry?: boolean
  retry_input?: AgentBridgeMessage
  title?: string
  kickoff_prompt?: string
  clear_goal_continuations?: boolean
  max_turns?: number
}

export interface AgentBridgeSkillReloadResult extends AgentBridgeResponse {
  action: 'reload-skills'
  added: Array<{ name: string; description?: string }>
  removed: Array<{ name: string; description?: string }>
  unchanged: string[]
  total: number
  commands?: number
}

export interface AgentBridgeSessionModelSwitch extends AgentBridgeResponse {
  session_id: string
  model: string
  provider?: string
  loaded: boolean
  switched: boolean
  deferred?: boolean
  reason?: string
}

export interface AgentBridgeGoalEvaluation extends AgentBridgeResponse {
  session_id: string
  handled: boolean
  active?: boolean
  status?: string | null
  should_continue?: boolean
  continuation_prompt?: string | null
  verdict?: string
  reason?: string
  message?: string
}

export interface AgentBridgeGoalPause extends AgentBridgeResponse {
  session_id: string
  handled: boolean
  active?: boolean
  status?: string | null
  reason?: string
  message?: string
}

export interface AgentBridgeBackgroundTask {
  subagent_id: string
  status?: string
  goal?: string
  model?: string
  last_event?: string
  last_tool?: string
  preview?: string
  updated_at?: number
  [key: string]: unknown
}

export interface AgentBridgeBackgroundSession {
  session_id: string
  profile: string
  events: Array<Record<string, unknown>>
  tasks: AgentBridgeBackgroundTask[]
  running_count: number
}

export interface AgentBridgeBackgroundNotification {
  delegation_id: string
  session_id: string
  profile: string
  claim_id: string
  status?: string
  message: string
  event: Record<string, unknown>
}

export interface AgentBridgeBackgroundPoll extends AgentBridgeResponse {
  broker_id?: string
  pending_count?: number
  sessions: AgentBridgeBackgroundSession[]
  notifications: AgentBridgeBackgroundNotification[]
}

export interface AgentBridgeBackgroundRoute {
  profile: string
  session_ids: string[]
}

export class AgentBridgeError extends Error {
  response?: unknown
}

export class AgentBridgeClient {
  readonly endpoint: string
  readonly timeoutMs: number
  readonly connectRetryMs: number
  private lock: Promise<unknown> = Promise.resolve()

  constructor(options: AgentBridgeOptions = {}) {
    this.endpoint = options.endpoint || process.env.HERMES_AGENT_BRIDGE_ENDPOINT || DEFAULT_AGENT_BRIDGE_ENDPOINT
    this.timeoutMs = options.timeoutMs ?? envPositiveInt('HERMES_AGENT_BRIDGE_TIMEOUT_MS') ?? DEFAULT_AGENT_BRIDGE_TIMEOUT_MS
    this.connectRetryMs = options.connectRetryMs ?? envPositiveInt('HERMES_AGENT_BRIDGE_CONNECT_RETRY_MS') ?? 5000
  }

  private summarizePayload(payload: Record<string, unknown>): Record<string, unknown> {
    const action = String(payload.action || '')
    const summary: Record<string, unknown> = { action }
    for (const key of ['session_id', 'run_id', 'expected_run_id', 'request_id', 'approval_id', 'profile', 'worker_key']) {
      if (payload[key] != null) summary[key] = payload[key]
    }
    if (Array.isArray(payload.conversation_history)) summary.conversation_history_count = payload.conversation_history.length
    if (Array.isArray(payload.messages)) summary.messages_count = payload.messages.length
    if (typeof payload.message === 'string') summary.message_chars = payload.message.length
    else if (Array.isArray(payload.message)) summary.message_parts = payload.message.length
    if (typeof payload.command === 'string') summary.command = payload.command
    if (typeof payload.text === 'string') summary.text_chars = payload.text.length
    if (typeof payload.error === 'string') summary.error = payload.error
    if (payload.force_compress === true) summary.force_compress = true
    return summary
  }

  private summarizeResponse(response: Record<string, unknown>): Record<string, unknown> {
    const summary: Record<string, unknown> = { ok: response.ok === true }
    for (const key of ['session_id', 'run_id', 'request_id', 'status', 'cursor', 'event_cursor']) {
      if (response[key] != null) summary[key] = response[key]
    }
    if (typeof response.delta === 'string') summary.delta_chars = response.delta.length
    if (typeof response.output === 'string') summary.output_chars = response.output.length
    if (Array.isArray(response.events)) summary.events_count = response.events.length
    if (typeof response.error === 'string') summary.error = response.error
    if (Array.isArray(response.history)) summary.history_count = response.history.length
    return summary
  }

  private runtimeContext(payload: Record<string, unknown>): Record<string, unknown> {
    const requestedProfile = typeof payload.profile === 'string' ? payload.profile.trim() : ''
    let profile = requestedProfile || 'default'
    try {
      if (!requestedProfile) profile = getActiveProfileName()
    } catch {}

    const context: Record<string, unknown> = {
      profile,
      cwd: process.cwd(),
    }
    try {
      const profileDir = getProfileDir(profile)
      context.profile_dir = profileDir
      context.config_path = join(profileDir, 'config.yaml')
    } catch {}
    return context
  }

  async connect(): Promise<this> {
    return this
  }

  async close(): Promise<void> {
    return undefined
  }

  private connectSocketOnce(): Promise<Socket> {
    return new Promise((resolveConnect, rejectConnect) => {
      const endpoint = this.endpoint
      let socket: Socket
      if (endpoint.startsWith('ipc://')) {
        socket = createConnection(endpoint.slice('ipc://'.length))
      } else if (endpoint.startsWith('tcp://')) {
        const url = new URL(endpoint)
        socket = createConnection({
          host: url.hostname || '127.0.0.1',
          port: Number(url.port),
        })
      } else {
        rejectConnect(new Error(`unsupported agent bridge endpoint: ${endpoint}`))
        return
      }

      const cleanup = () => {
        socket.off('connect', onConnect)
        socket.off('error', onError)
      }
      const onConnect = () => {
        cleanup()
        resolveConnect(socket)
      }
      const onError = (err: Error) => {
        cleanup()
        socket.destroy()
        rejectConnect(err)
      }
      socket.once('connect', onConnect)
      socket.once('error', onError)
    })
  }

  private isRetryableConnectError(err: any): boolean {
    const code = String(err?.code || '')
    return ['ECONNREFUSED', 'ENOENT', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(code)
  }

  private async connectSocket(): Promise<Socket> {
    const deadline = Date.now() + Math.max(0, this.connectRetryMs)
    for (;;) {
      try {
        return await this.connectSocketOnce()
      } catch (err) {
        if (!this.isRetryableConnectError(err) || Date.now() >= deadline) {
          throw err
        }
        await delay(100)
      }
    }
  }

  private readResponse(socket: Socket, timeoutMs: number): Promise<string> {
    return new Promise((resolveRead, rejectRead) => {
      let buffer = ''
      const timeout = timeoutMs > 0
        ? setTimeout(() => {
            cleanup()
            socket.destroy()
            rejectRead(new Error(`Agent bridge request timed out after ${timeoutMs}ms`))
          }, timeoutMs)
        : null

      const cleanup = () => {
        if (timeout) clearTimeout(timeout)
        socket.off('data', onData)
        socket.off('error', onError)
        socket.off('end', onEnd)
        socket.off('close', onClose)
      }
      const finish = (line: string) => {
        cleanup()
        socket.end()
        resolveRead(line)
      }
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const idx = buffer.indexOf('\n')
        if (idx >= 0) finish(buffer.slice(0, idx))
      }
      const onError = (err: Error) => {
        cleanup()
        socket.destroy()
        rejectRead(err)
      }
      const onEnd = () => {
        const line = buffer.trim()
        if (line) finish(line)
      }
      const onClose = () => {
        if (!buffer.trim()) {
          cleanup()
          rejectRead(new Error('Agent bridge socket closed without a response'))
        }
      }

      socket.on('data', onData)
      socket.once('error', onError)
      socket.once('end', onEnd)
      socket.once('close', onClose)
    })
  }

  async request<T extends AgentBridgeResponse = AgentBridgeResponse>(
    payload: Record<string, unknown>,
    options: AgentBridgeRequestOptions = {},
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const timeoutMs = options.timeoutMs || this.timeoutMs
      const startedAt = Date.now()
      const action = String(payload.action || '')
      const shouldLogRequest = action !== 'get_output' && action !== 'background_poll'
      const runtimeContext = shouldLogRequest ? this.runtimeContext(payload) : undefined
      if (shouldLogRequest) {
        bridgeLogger.info({
          endpoint: this.endpoint,
          timeoutMs,
          runtime: runtimeContext,
          request: this.summarizePayload(payload),
        }, '[agent-bridge-client] request')
      }
      try {
        const socket = await this.connectSocket()
        socket.write(`${JSON.stringify(payload)}\n`)
        const raw = await this.readResponse(socket, timeoutMs)
        const response = JSON.parse(raw) as { ok?: boolean; error?: string }
        if (!response.ok) {
          const error = new AgentBridgeError(response.error || 'Agent bridge request failed')
          error.response = response
          bridgeLogger.warn({
            durationMs: Date.now() - startedAt,
            runtime: runtimeContext,
            response: this.summarizeResponse(response as Record<string, unknown>),
          }, '[agent-bridge-client] request rejected')
          throw error
        }
        if (shouldLogRequest) {
          bridgeLogger.info({
            durationMs: Date.now() - startedAt,
            runtime: runtimeContext,
            response: this.summarizeResponse(response as Record<string, unknown>),
          }, '[agent-bridge-client] response')
        }
        return response as T
      } catch (err: any) {
        if (!(err instanceof AgentBridgeError) && action !== 'background_poll') {
          bridgeLogger.error({
            durationMs: Date.now() - startedAt,
            err: { message: err?.message, name: err?.name },
            runtime: runtimeContext,
            request: this.summarizePayload(payload),
          }, '[agent-bridge-client] request failed')
        }
        throw err
      }
    }

    if (!options.serialize) {
      return run()
    }

    const next = this.lock.then(run, run)
    this.lock = next.catch(() => undefined)
    return next
  }

  ping(): Promise<AgentBridgeResponse> {
    return this.request({ action: 'ping' })
  }

  chat(
    sessionId: string,
    message: AgentBridgeMessage,
    conversationHistory?: unknown[],
    instructions?: string,
    profile?: string,
    options: AgentBridgeChatOptions = {},
  ): Promise<AgentBridgeChatStarted> {
    return this.request<AgentBridgeChatStarted>({
      action: 'chat',
      session_id: sessionId,
      message,
      ...(options.storage_message !== undefined ? { storage_message: options.storage_message } : {}),
      ...(conversationHistory ? { conversation_history: conversationHistory } : {}),
      ...(instructions ? { instructions } : {}),
      ...(profile ? { profile } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.workspace ? { workspace: options.workspace } : {}),
      ...(options.source ? { source: options.source } : {}),
      ...(options.wait ? { wait: true } : {}),
      ...(options.timeout ? { timeout: options.timeout } : {}),
      ...(options.force_compress ? { force_compress: true } : {}),
      ...(options.background_delegation_enabled !== undefined
        ? { background_delegation_enabled: options.background_delegation_enabled }
        : {}),
      // Local patch (reasoning-effort): per-session reasoning effort override.
      ...(options.reasoning_effort ? { reasoning_effort: options.reasoning_effort } : {}),
    })
  }

  contextEstimate(
    sessionId: string,
    messages: unknown[],
    instructions?: string,
    profile?: string,
    options: Pick<AgentBridgeChatOptions, 'model' | 'provider' | 'workspace' | 'background_delegation_enabled'> = {},
  ): Promise<AgentBridgeContextEstimate> {
    return this.request<AgentBridgeContextEstimate>({
      action: 'context_estimate',
      session_id: sessionId,
      messages,
      ...(instructions ? { instructions } : {}),
      ...(profile ? { profile } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.workspace ? { workspace: options.workspace } : {}),
      ...(options.background_delegation_enabled !== undefined
        ? { background_delegation_enabled: options.background_delegation_enabled }
        : {}),
    })
  }

  providerCredentials(
    profile: string,
    provider: string,
    model?: string,
  ): Promise<AgentBridgeProviderCredentials> {
    return this.request<AgentBridgeProviderCredentials>({
      action: 'provider_credentials',
      profile,
      provider,
      ...(model ? { model } : {}),
    })
  }

  imageProviders(profile: string): Promise<AgentBridgeImageProviders> {
    return this.request<AgentBridgeImageProviders>({ action: 'image_providers', profile })
  }

  imageGenerate(
    profile: string,
    payload: Record<string, unknown>,
    options: AgentBridgeRequestOptions = {},
  ): Promise<AgentBridgeImageGenerateResult> {
    return this.request<AgentBridgeImageGenerateResult>({
      action: 'image_generate',
      profile,
      ...payload,
    }, options)
  }

  command(sessionId: string, command: string, profile?: string): Promise<AgentBridgeCommandResult> {
    return this.request<AgentBridgeCommandResult>({
      action: 'command',
      session_id: sessionId,
      command,
      ...(profile ? { profile } : {}),
    })
  }

  switchSessionModel(
    sessionId: string,
    model: string,
    provider?: string,
    profile?: string,
  ): Promise<AgentBridgeSessionModelSwitch> {
    return this.request<AgentBridgeSessionModelSwitch>({
      action: 'switch_session_model',
      session_id: sessionId,
      model,
      ...(provider ? { provider } : {}),
      ...(profile ? { profile } : {}),
    })
  }

  goalEvaluate(sessionId: string, finalResponse: string, profile?: string): Promise<AgentBridgeGoalEvaluation> {
    return this.request<AgentBridgeGoalEvaluation>({
      action: 'goal_evaluate',
      session_id: sessionId,
      final_response: finalResponse,
      ...(profile ? { profile } : {}),
    })
  }

  getOutput(runId: string, cursor = 0, eventCursor = 0, options: AgentBridgeRequestOptions = {}): Promise<AgentBridgeOutput> {
    return this.request<AgentBridgeOutput>({
      action: 'get_output',
      run_id: runId,
      cursor,
      event_cursor: eventCursor,
    }, options)
  }

  getSessionTitle(sessionId: string, profile?: string, options: AgentBridgeRequestOptions = {}): Promise<AgentBridgeSessionTitle> {
    return this.request<AgentBridgeSessionTitle>({
      action: 'get_session_title',
      session_id: sessionId,
      ...(profile ? { profile } : {}),
    }, options)
  }

  async *streamOutput(
    runId: string,
    options: AgentBridgeRequestOptions & { intervalMs?: number } = {},
  ): AsyncGenerator<AgentBridgeOutput> {
    const intervalMs = options.intervalMs || 100
    let cursor = 0
    let eventCursor = 0
    for (;;) {
      const chunk = await this.getOutput(runId, cursor, eventCursor, options)
      cursor = chunk.cursor
      eventCursor = chunk.event_cursor
      if (chunk.delta || chunk.done || (chunk.events && chunk.events.length > 0)) yield chunk
      if (chunk.done) return
      await delay(intervalMs)
    }
  }

  async chatStream(
    sessionId: string,
    message: AgentBridgeMessage,
    onDelta: (delta: string, chunk: AgentBridgeOutput) => void | Promise<void>,
    options: AgentBridgeRequestOptions & { intervalMs?: number } = {},
  ): Promise<AgentBridgeOutput> {
    const started = await this.chat(sessionId, message)
    let last: AgentBridgeOutput | null = null
    for await (const chunk of this.streamOutput(started.run_id, options)) {
      last = chunk
      if (chunk.delta) await onDelta(chunk.delta, chunk)
    }
    if (!last) throw new Error(`Agent bridge run ${started.run_id} produced no output state`)
    return last
  }

  getResult(runId: string, options: AgentBridgeRequestOptions = {}): Promise<AgentBridgeRunResult> {
    return this.request<AgentBridgeRunResult>({ action: 'get_result', run_id: runId }, options)
  }

  interrupt(sessionId: string, message?: string, profile?: string): Promise<AgentBridgeResponse> {
    return this.request({
      action: 'interrupt',
      session_id: sessionId,
      message,
      ...(profile ? { profile } : {}),
    })
  }

  requestBoundaryInterrupt(
    sessionId: string,
    expectedRunId?: string,
    profile?: string,
  ): Promise<AgentBridgeBoundaryInterrupt> {
    return this.request<AgentBridgeBoundaryInterrupt>({
      action: 'request_boundary_interrupt',
      session_id: sessionId,
      ...(expectedRunId ? { expected_run_id: expectedRunId } : {}),
      ...(profile ? { profile } : {}),
    })
  }

  goalPause(sessionId: string, reason: string, profile?: string): Promise<AgentBridgeGoalPause> {
    return this.request<AgentBridgeGoalPause>({
      action: 'goal_pause',
      session_id: sessionId,
      reason,
      ...(profile ? { profile } : {}),
    })
  }

  steer(sessionId: string, text: string, profile?: string): Promise<AgentBridgeResponse> {
    return this.request({
      action: 'steer',
      session_id: sessionId,
      text,
      ...(profile ? { profile } : {}),
    })
  }

  approvalRespond(approvalId: string, choice: string): Promise<AgentBridgeResponse> {
    return this.request({ action: 'approval_respond', approval_id: approvalId, choice })
  }

  clarifyRespond(clarifyId: string, response: string): Promise<AgentBridgeResponse> {
    return this.request({ action: 'clarify_respond', clarify_id: clarifyId, response })
  }

  compressionRespond(
    requestId: string,
    payload: { messages?: unknown[]; system_message?: string; error?: string },
  ): Promise<AgentBridgeResponse> {
    return this.request({
      action: 'compression_respond',
      request_id: requestId,
      ...payload,
    }, { timeoutMs: this.timeoutMs })
  }

  destroyAll(): Promise<AgentBridgeResponse> {
    return this.request({ action: 'destroy_all' }, { serialize: true })
  }

  destroyProfile(profile: string): Promise<AgentBridgeResponse> {
    return this.request({ action: 'destroy_profile', profile }, { serialize: true })
  }

  getHistory(sessionId: string, profile?: string): Promise<AgentBridgeResponse> {
    return this.request({
      action: 'get_history',
      session_id: sessionId,
      ...(profile ? { profile } : {}),
    })
  }

  status(sessionId: string, profile?: string): Promise<AgentBridgeResponse> {
    return this.request({
      action: 'status',
      session_id: sessionId,
      ...(profile ? { profile } : {}),
    })
  }

  statusIfLoaded(sessionId: string, profile?: string, options: AgentBridgeRequestOptions = {}): Promise<AgentBridgeResponse> {
    return this.request({
      action: 'status_if_loaded',
      session_id: sessionId,
      ...(profile ? { profile } : {}),
    }, options)
  }

  backgroundPoll(
    routes?: AgentBridgeBackgroundRoute[],
    options: AgentBridgeRequestOptions = {},
  ): Promise<AgentBridgeBackgroundPoll> {
    return this.request<AgentBridgeBackgroundPoll>({
      action: 'background_poll',
      ...(routes?.length ? { routes } : {}),
    }, options)
  }

  completeBackgroundNotification(
    sessionId: string,
    profile: string,
    delegationId: string,
    claimId: string,
  ): Promise<AgentBridgeResponse> {
    return this.request({
      action: 'background_notification_complete',
      session_id: sessionId,
      profile,
      delegation_id: delegationId,
      claim_id: claimId,
    })
  }

  releaseBackgroundNotification(
    sessionId: string,
    profile: string,
    delegationId: string,
    claimId: string,
  ): Promise<AgentBridgeResponse> {
    return this.request({
      action: 'background_notification_release',
      session_id: sessionId,
      profile,
      delegation_id: delegationId,
      claim_id: claimId,
    })
  }

  destroy(sessionId: string, profile?: string, workerKey?: string): Promise<AgentBridgeResponse> {
    return this.request({
      action: 'destroy',
      session_id: sessionId,
      ...(profile ? { profile } : {}),
      ...(workerKey ? { worker_key: workerKey } : {}),
    })
  }

  list(): Promise<AgentBridgeResponse> {
    return this.request({ action: 'list' })
  }

  shutdown(): Promise<AgentBridgeResponse> {
    return this.request({ action: 'shutdown' }, { serialize: true })
  }

  // ───── MCP Management ─────

  mcpList(profile?: string): Promise<McpActionResponse> {
    return this.request({ action: 'mcp_list', ...(profile ? { profile } : {}) })
  }

  mcpAdd(name: string, config: Record<string, unknown>, profile?: string): Promise<McpActionResponse> {
    return this.request({ action: 'mcp_server_add', name, config, ...(profile ? { profile } : {}) }, { serialize: true })
  }

  mcpUpdate(name: string, config: Record<string, unknown>, profile?: string): Promise<McpActionResponse> {
    return this.request({ action: 'mcp_server_update', name, config, ...(profile ? { profile } : {}) }, { serialize: true })
  }

  mcpRemove(name: string, profile?: string): Promise<McpActionResponse> {
    return this.request({ action: 'mcp_server_remove', name, ...(profile ? { profile } : {}) }, { serialize: true })
  }

  mcpTest(name: string, profile?: string): Promise<McpActionResponse> {
    return this.request({ action: 'mcp_server_test', name, ...(profile ? { profile } : {}) }, { timeoutMs: 180_000 })
  }

  mcpTools(server?: string, profile?: string, raw?: boolean): Promise<McpActionResponse> {
    return this.request({ action: 'mcp_tools_list', ...(server ? { server } : {}), ...(profile ? { profile } : {}), ...(raw ? { raw } : {}) })
  }

  mcpReload(server?: string, profile?: string): Promise<McpActionResponse> {
    return this.request({ action: 'mcp_reload', ...(server ? { server } : {}), ...(profile ? { profile } : {}) }, { serialize: true })
  }

  reloadSkills(profile?: string): Promise<AgentBridgeSkillReloadResult> {
    return this.request({ action: 'skills_reload', ...(profile ? { profile } : {}) }, { serialize: true })
  }
}

export default AgentBridgeClient
