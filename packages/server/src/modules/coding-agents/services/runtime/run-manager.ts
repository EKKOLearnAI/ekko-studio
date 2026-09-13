import type { DshAcpTurn } from '../dsh/acp-turn'
import { startDshChatTurn } from '../dsh/chat-turn'
import { agentUpdateLocked, noteAgentActivity } from '../update-lock'
import { dirname, join } from 'path'
import { existsSync, accessSync, chmodSync, constants as fsConstants, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { spawn, type ChildProcess } from 'child_process'
import { createSession, addMessage, getSession, updateSession, updateSessionStats } from '../../../studio/public/sessions'
import type { ApiMode, CodingAgentImageInput } from '../../protocol/types'
import { logger } from '../../../studio/public/logging'
import { normalizeTokenUsage, recordSessionUsage } from '../../../studio/public/usage'
import {
  applyResponseStreamEvent,
  calcAndUpdateUsage,
  completeWorkspaceRunCheckpoint,
  extractResponseText,
  flushResponseRunToDb,
  getChatRunServer,
  startWorkspaceRunCheckpoint,
  updateContextTokenUsage,
} from '../../../studio/public/run-state'
import type { SessionState } from '../../../studio/contracts/runs/session'
import type { CanonicalResponsesEvent } from '../../protocol/adapters/responses-stream'
import { normalizeWindowsCommandPath, windowsCmdShimExecution, windowsCommandNeedsShell } from '../../../studio/public/windows-command'
import { killOwnedProcessTree } from '../../../studio/public/process-tree'
import { attachPiJsonlReader } from '../pi/jsonl-parser'
import { normalizePiThinkingLevel } from '../pi/thinking'
import { compactCodexThread } from './codex-compact'
import { updateManagedPromptFileSync } from '../prompt-file'
import { grokSessionExists, startGrokTurnProcess } from '../grok/turn-process'
import { applyGrokStreamEvent } from '../grok/event-adapter'
import { isolatedCodingAgentChildEnv } from './child-env'
import { NativeTurnUsage, type NativeUsageRow } from './native-usage'
import { readCodexTurnModel, readOpenCodeMessageModel } from './native-model'
import { getCodingAgentGlobalHome } from '../../../studio/public/coding-agent-global-home'

export { isolatedCodingAgentChildEnv } from './child-env'

const DEFAULT_IDLE_MS = 30 * 60 * 1000
const TERMINAL_OUTPUT_FLUSH_MS = 120
const MAX_TERMINAL_EVENT_CHARS = 4000
const CHILD_STDERR_TAIL_CHARS = 8 * 1024
const CODING_AGENT_TOOL_OUTPUT_STORAGE_LIMIT = 32 * 1024
const CODING_AGENT_TOOL_OUTPUT_HEAD_CHARS = 24 * 1024
const CODING_AGENT_TOOL_OUTPUT_TAIL_CHARS = 8 * 1024
const CODEX_REASONING_SUMMARY_ARGS = ['-c', 'model_reasoning_summary="auto"']
const HERMES_MCP_SERVER_NAME = 'hermes-studio'
const PI_RPC_REQUEST_TIMEOUT_MS = 30_000
const PI_RPC_COMPACT_TIMEOUT_MS = 5 * 60 * 1000

let pty: any = null

function ensureNodePtySpawnHelperExecutable() {
  if (process.platform !== 'darwin') return
  try {
    const nodePtyRoot = dirname(require.resolve('node-pty/package.json'))
    const candidates = [
      join(nodePtyRoot, 'build', 'Release', 'spawn-helper'),
      join(nodePtyRoot, 'build', 'Debug', 'spawn-helper'),
      join(nodePtyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    ]
    for (const helperPath of candidates) {
      if (!existsSync(helperPath)) continue
      try {
        accessSync(helperPath, fsConstants.X_OK)
      } catch {
        chmodSync(helperPath, 0o755)
      }
    }
  } catch (err) {
    logger.warn(err, '[coding-agent-run] failed to normalize node-pty helper permissions')
  }
}

try {
  ensureNodePtySpawnHelperExecutable()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  pty = require('node-pty')
} catch (err) {
  logger.warn(err, '[coding-agent-run] node-pty unavailable; hidden coding agent sessions disabled')
}

export interface CodingAgentRunLaunch {
  agentPreset?: string
  agentSessionId: string
  agentId: string
  mode: 'scoped' | 'global'
  profile: string
  provider: string
  model: string
  apiMode?: ApiMode
  sessionId: string
  agentNativeSessionId?: string
  nativeResume?: boolean
  command: string
  args: string[]
  shellCommand: string
  workspaceDir: string
  env?: NodeJS.ProcessEnv
  promptFile?: string
  state?: SessionState
  sessionSource?: 'global_agent' | 'workflow' | 'group_chat'
  reasoningEffort?: string
  approvalRequired?: boolean
}

export interface CodingAgentRunInfo {
  exists: boolean
  running: boolean
  agentId: string
  model: string
  provider: string
  workspaceDir: string
  nativeSessionId: string
  messageCount: number
}

export interface PiNativeSessionStats {
  sessionId: string
  userMessages: number
  assistantMessages: number
  toolCalls: number
  toolResults: number
  totalMessages: number
  tokens: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
  cost: number
  contextUsage?: {
    tokens: number | null
    contextWindow: number
    percent: number | null
  }
}

export interface PiNativeSessionState {
  model?: { id?: string; name?: string; provider?: string }
  thinkingLevel: string
  isStreaming: boolean
  isCompacting: boolean
  sessionId: string
  sessionName?: string
  autoCompactionEnabled: boolean
  messageCount: number
  pendingMessageCount: number
}

export type CodingAgentQueueInsertionInterruptResult =
  | { status: 'interrupted'; runId: string; responseId: string }
  | { status: 'not_found' | 'run_mismatch' | 'not_running' }

interface PiRpcPendingRequest {
  command: string
  resolve: (data: any) => void
  reject: (error: Error) => void
  timeoutTimer: ReturnType<typeof setTimeout>
}

export interface ManagedCodingAgentRun {
  id: string
  launch: CodingAgentRunLaunch
  pty?: { pid: number; write: (data: string) => void; kill: (signal?: string) => void; onData: (cb: (data: string) => void) => void; onExit: (cb: (event: { exitCode: number }) => void) => void }
  state: SessionState
  runMarker?: string
  lastActiveAt: number
  idleTimer?: ReturnType<typeof setTimeout>
  terminalBuffer?: string
  terminalFlushTimer?: ReturnType<typeof setTimeout>
  apiKeyPromptAnswered?: boolean
  startedAt: number
  exited: boolean
  dshTurn?: DshAcpTurn
  currentChild?: ChildProcess
  currentChildKillTimer?: ReturnType<typeof setTimeout>
  currentChildStderr?: string
  printResponseId?: string
  printMessageId?: string
  printTextStarted?: boolean
  printText?: string
  printCompleted?: boolean
  responseStartEmitted?: boolean
  terminalEventHandled?: boolean
  acceptingPrintEvent?: boolean
  printToolBlocks?: Map<number, { id: string; name: string; arguments: string; done: boolean }>
  nativeResumeReady?: boolean
  codexToolBlocks?: Map<string, { id: string; name: string; arguments: string; done: boolean }>
  codexChatText?: string
  codexPendingUsage?: any
  codexPendingError?: string
  codexTurnFailed?: boolean
  nativeUsage?: NativeTurnUsage
  nativeTurnStartedAt?: number
  nativeCompletionPending?: boolean
  terminalUsageRefresh?: Promise<void>
  stoppedByUser?: boolean
  pendingChatCompletionEvent?: 'run.completed' | 'run.failed'
  pendingChatCompletionPayload?: Record<string, unknown>
  memoryExportStarted?: boolean
  assistantMessageId?: string
  piDetachJsonl?: () => void
  piToolBlocks?: Map<string, { id: string; name: string; arguments: string; done: boolean }>
  piPendingError?: string
  piWillRetry?: boolean
  piFinalText?: string
  piFinishReason?: string
  turnActive?: boolean
  disposeAfterTurn?: boolean
  piUiRequests?: Map<string, any>
  piTextBuffer?: string
  piCurrentMessageText?: string
  piRpcRequests?: Map<string, PiRpcPendingRequest>
}

interface CodingAgentRunSendOptions {
  systemPrompt?: string
  images?: CodingAgentImageInput[]
  storageInput?: string
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

const TERMINAL_USAGE_WAIT_MS = 2_000

function makeId(): string {
  return `car_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function codingAgentGatewayErrorMessage(text: string): string | null {
  const value = String(text || '').trim()
  if (!value) return null
  if (/^API Error:\s*\d+\b/i.test(value)) return value
  if (/^Provider returned HTTP\s+\d+\b/i.test(value)) return value
  return null
}

function responseErrorMessage(error: unknown): string {
  if (!error) return ''
  if (typeof error === 'string') return error
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>
    const message = record.message || record.error || record.detail
    if (typeof message === 'string') return message
  }
  return String(error)
}

function compactTokenNumber(value: unknown): number | null {
  const num = Number(value)
  return Number.isFinite(num) && num >= 0 ? Math.floor(num) : null
}

function isProxyToolEvent(event: CanonicalResponsesEvent): boolean {
  const data: any = event.data || {}
  const item = data.item || data.output_item || data
  return event.type === 'response.function_call_arguments.delta' ||
    ((event.type === 'response.output_item.added' || event.type === 'response.output_item.done') &&
      (item?.type === 'function_call' || item?.type === 'function_call_output'))
}

function truncateCodingAgentToolOutputForStorage(output: unknown): string {
  const text = typeof output === 'string' ? output : JSON.stringify(output ?? '')
  if (text.length <= CODING_AGENT_TOOL_OUTPUT_STORAGE_LIMIT) return text
  const head = text.slice(0, CODING_AGENT_TOOL_OUTPUT_HEAD_CHARS)
  const tail = text.slice(-CODING_AGENT_TOOL_OUTPUT_TAIL_CHARS)
  const omitted = text.length - head.length - tail.length
  return [
    head,
    '',
    `[Hermes Web UI: coding-agent tool output truncated for storage; original_chars=${text.length}; omitted_chars=${omitted}]`,
    '',
    tail,
  ].join('\n')
}

function truncateCodingAgentToolOutputItem(item: any): any {
  if (!item || item.type !== 'function_call_output') return item
  const nextOutput = truncateCodingAgentToolOutputForStorage(item.output)
  if (nextOutput === item.output) return item
  return { ...item, output: nextOutput }
}

function truncateCodingAgentToolOutputEvent(event: CanonicalResponsesEvent): CanonicalResponsesEvent {
  const data: any = event.data || {}
  if (event.type === 'response.output_item.done') {
    const item = data.item || data.output_item || data
    const nextItem = truncateCodingAgentToolOutputItem(item)
    if (nextItem === item) return event
    if (data.item) return { ...event, data: { ...data, item: nextItem } }
    if (data.output_item) return { ...event, data: { ...data, output_item: nextItem } }
    return { ...event, data: nextItem }
  }

  if (event.type === 'response.completed') {
    const response = data.response || data
    const output = Array.isArray(response?.output) ? response.output : null
    if (!output) return event
    let changed = false
    const nextOutput = output.map((item: any) => {
      const nextItem = truncateCodingAgentToolOutputItem(item)
      if (nextItem !== item) changed = true
      return nextItem
    })
    if (!changed) return event
    const nextResponse = { ...response, output: nextOutput }
    return data.response
      ? { ...event, data: { ...data, response: nextResponse } }
      : { ...event, data: nextResponse }
  }

  return event
}

function isPrintAgent(agentId: string): boolean {
  return agentId === 'claude-code' || agentId === 'codex' || agentId === 'pi' || agentId === 'grok' || (agentId === 'opencode' || agentId === 'dsh')
}

function persistedCodingAgent(agentId: string): 'claude' | 'codex' | 'pi' | 'grok' | 'opencode' | 'dsh' {
  if (agentId === 'codex') return 'codex'
  if (agentId === 'pi') return 'pi'
  if (agentId === 'grok') return 'grok'
  if (agentId === 'dsh') return 'dsh'
  if (agentId === 'opencode') return 'opencode'
  return 'claude'
}

function usageCodingAgent(agentId: string): 'claude_code' | 'codex' | 'pi' | 'grok' | 'opencode' | 'dsh' {
  if (agentId === 'codex') return 'codex'
  if (agentId === 'pi') return 'pi'
  if (agentId === 'grok') return 'grok'
  if (agentId === 'dsh') return 'dsh'
  if (agentId === 'opencode') return 'opencode'
  return 'claude_code'
}

function hasManagedHermesMcpConfig(run: ManagedCodingAgentRun): boolean {
  if (run.launch.mode !== 'scoped') return true
  if (run.launch.agentId === 'pi') {
    const piHome = String(run.launch.env?.PI_CODING_AGENT_DIR || '').trim()
    if (!piHome) return false
    try {
      const config = readFileSync(join(piHome, 'mcp.json'), 'utf-8')
      return config.includes('"ekko-studio-api"') && config.includes('"ekko-studio-use"')
    } catch {
      return false
    }
  }
  if (run.launch.agentId === 'grok') {
    const grokHome = String(run.launch.env?.GROK_HOME || '').trim()
    if (!grokHome) return false
    try {
      const config = readFileSync(join(grokHome, 'config.toml'), 'utf-8')
      return config.includes('[mcp_servers.ekko-studio-api]') && config.includes('[mcp_servers.ekko-studio-use]')
    } catch {
      return false
    }
  }
  if (run.launch.agentId === 'opencode') {
    const configDir = String(run.launch.env?.OPENCODE_CONFIG_DIR || '').trim()
    if (!configDir) return false
    try {
      const config = readFileSync(join(configDir, 'opencode.json'), 'utf-8')
      return config.includes('"ekko-studio-api"') && config.includes('"ekko-studio-use"')
    } catch {
      return false
    }
  }
  if (run.launch.agentId !== 'codex') return true
  const codexHome = String(run.launch.env?.CODEX_HOME || '').trim()
  if (!codexHome) return false
  try {
    const config = readFileSync(join(codexHome, 'config.toml'), 'utf-8')
    return config.includes(`[mcp_servers.${HERMES_MCP_SERVER_NAME}]`)
  } catch {
    return false
  }
}

function childIsRunning(child?: ChildProcess): boolean {
  return Boolean(child && child.exitCode == null && child.signalCode == null && !child.killed)
}

function normalizeCliPromptArgument(prompt: string): string {
  const text = String(prompt || '').trim()
  if (!text || process.platform !== 'win32') return text
  return text
    .split(/\r\n|\n|\r/)
    .map(line => line.trim())
    .filter(Boolean)
    .join(' / ')
}

function normalizedImageMediaType(image: CodingAgentImageInput): string {
  const mediaType = String(image.mediaType || '').trim().toLowerCase()
  if (mediaType === 'image/jpg') return 'image/jpeg'
  return mediaType.startsWith('image/') ? mediaType : 'image/png'
}

export function codexImageArgs(images: CodingAgentImageInput[]): string[] {
  return images.flatMap((image) => {
    const path = String(image.path || '').trim()
    return path ? ['--image', path] : []
  })
}

export function buildClaudeStreamJsonInput(input: string, images: CodingAgentImageInput[]): string {
  const content: any[] = []
  const text = String(input || '').trim()
  if (text) content.push({ type: 'text', text })
  for (const image of images) {
    const path = String(image.path || '').trim()
    if (!path) continue
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: normalizedImageMediaType(image),
        data: readFileSync(path).toString('base64'),
      },
    })
  }
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content,
    },
    parent_tool_use_id: null,
  })
}

function hasArg(args: string[], name: string): boolean {
  return args.includes(name)
}

function decodeChildChunk(chunk: Buffer): string {
  const utf8 = chunk.toString('utf8')
  if (process.platform !== 'win32' || !utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gb18030').decode(chunk)
  } catch {
    return utf8
  }
}

function spawnCodingAgentChild(command: string, args: string[], options: {
  cwd: string
  env: NodeJS.ProcessEnv
  pipeStdin?: boolean
}): ChildProcess {
  const normalizedCommand = process.platform === 'win32' ? normalizeWindowsCommandPath(command) : command
  if (process.platform === 'win32' && windowsCommandNeedsShell(command)) {
    const execution = windowsCmdShimExecution(normalizedCommand, args)
    return spawn(execution.command, execution.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.pipeStdin ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments: execution.windowsVerbatimArguments,
      windowsHide: true,
    })
  }

  return spawn(normalizedCommand, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.pipeStdin ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: process.platform === 'win32',
  })
}

function piAssistantMessageText(message: any): string {
  if (!message || message.role !== 'assistant') return ''
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content
    .map((part: any) => part?.type === 'text' && typeof part.text === 'string' ? part.text : '')
    .join('')
}

function childProcessErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (!err || typeof err !== 'object') return String(err || 'Process failed')
  const record = err as Record<string, unknown>
  const message = record.message
  if (typeof message === 'string' && message.trim()) return message
  try {
    return JSON.stringify(record)
  } catch {
    return String(err)
  }
}

function appendChildStderr(run: ManagedCodingAgentRun, chunk: Buffer): string {
  const text = sanitizeCodingAgentTerminalOutput(decodeChildChunk(chunk))
  run.currentChildStderr = `${run.currentChildStderr || ''}${text}`.slice(-CHILD_STDERR_TAIL_CHARS)
  return text.trim()
}

function exitErrorMessage(agentName: string, code: number | null, stderr?: string): string {
  const message = `${agentName} exited with code ${code ?? 'unknown'}`
  const detail = String(stderr || '').trim()
  return detail ? `${message}: ${detail}` : message
}

function appendedTextDelta(existing: string, next: string): string {
  if (!existing || !next) return next
  if (next.startsWith(existing)) return next.slice(existing.length)
  const max = Math.min(existing.length, next.length)
  for (let length = max; length >= 16; length--) {
    if (existing.endsWith(next.slice(0, length))) return next.slice(length)
  }
  return next
}

function terminateChildProcess(child?: ChildProcess) {
  if (!child || !child.pid || !childIsRunning(child)) return
  if (process.platform === 'win32') {
    try { killOwnedProcessTree(child.pid, () => { child.kill() }) } catch {}
    return
  }
  try {
    process.kill(-child.pid, 'SIGINT')
  } catch {
    try { process.kill(child.pid, 'SIGINT') } catch {}
  }
}

function forceKillChildProcess(child?: ChildProcess) {
  if (!child || !child.pid || !childIsRunning(child)) return
  if (process.platform === 'win32') {
    try { killOwnedProcessTree(child.pid, () => { child.kill('SIGKILL') }) } catch {}
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try { process.kill(child.pid, 'SIGKILL') } catch {}
  }
}

function waitForChildProcessClose(child?: ChildProcess, timeoutMs = 2_500): Promise<void> {
  if (!child || child.exitCode != null || child.signalCode != null || typeof child.once !== 'function') {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off?.('close', finish)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    timer.unref?.()
    child.once('close', finish)
  })
}

function claudeContentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    if (content == null) return ''
    try {
      return JSON.stringify(content)
    } catch {
      return String(content)
    }
  }
  return content.map((block) => {
    if (typeof block === 'string') return block
    if (!block || typeof block !== 'object') return ''
    const record = block as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    if (typeof record.content === 'string') return record.content
    try {
      return JSON.stringify(record)
    } catch {
      return String(record)
    }
  }).filter(Boolean).join('\n')
}

function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe'
  const shell = process.env.SHELL || ''
  if (shell && existsSync(shell)) return shell
  if (existsSync('/bin/zsh')) return '/bin/zsh'
  if (existsSync('/bin/bash')) return '/bin/bash'
  return '/bin/sh'
}

export function sanitizeCodingAgentTerminalOutput(value: string): string {
  return String(value || '')
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|sk-ant|sk-proj|sk-or)-[A-Za-z0-9._-]{8,}\b/g, '[redacted-api-key]')
    .replace(/(api[_-]?key["'\s:=]+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
}

export class CodingAgentRunManager {
  private runs = new Map<string, ManagedCodingAgentRun>()
  private sessionIndex = new Map<string, string>()
  private memoryExportChildren = new Set<ChildProcess>()

  constructor(private readonly idleMs = DEFAULT_IDLE_MS) {}

  hasLiveAgent(id: string): boolean {
    return [...this.runs.values()].some(run => run.launch.agentId === id && !run.exited)
  }

  isAgentBusyForUpdate(id: string): boolean {
    if (this.memoryExportChildren.size > 0) return true
    return [...this.runs.values()].some(run => run.launch.agentId === id && !run.exited && (
      childIsRunning(run.currentChild) || Boolean(run.pty) || run.turnActive === true
      || run.state.isWorking || run.state.queue.length > 0 || Boolean(run.pendingChatCompletionEvent)
      || Boolean(run.piUiRequests?.size) || Boolean(run.piRpcRequests?.size)
      || run.state.events.some(entry => /^(approval|clarify|calendar|reminder)\.requested$/.test(entry.event))
    ))
  }

  isAvailable(): boolean {
    return !!pty
  }

  hasSession(sessionId: string): boolean {
    const run = this.getBySession(sessionId)
    return Boolean(run && !run.exited)
  }

  isSessionProcessing(sessionId: string): boolean {
    const run = this.getBySession(sessionId)
    if (!run) return false
    return run.launch.agentId === 'pi'
      ? run.turnActive === true
      : childIsRunning(run.currentChild)
  }

  runIdForSession(sessionId: string): string | undefined {
    const run = this.getBySession(sessionId)
    return run && !run.exited ? run.id : undefined
  }

  isSessionLaunchCompatible(sessionId: string, launch: {
    agentId: string
    mode?: 'scoped' | 'global'
    provider?: string
    model?: string
    reasoningEffort?: string
    apiMode?: ApiMode
  }): boolean {
    const run = this.getBySession(sessionId)
    if (!run || run.exited) return false
    const mode = launch.mode === 'global' ? 'global' : 'scoped'
    if (run.launch.agentId !== launch.agentId) return false
    if (run.launch.mode !== mode) return false
    if (mode === 'scoped') {
      const provider = String(launch.provider || '').trim()
      const model = String(launch.model || '').trim()
      if (provider && run.launch.provider !== provider) return false
      if (model && run.launch.model !== model) return false
      const apiMode = String(launch.apiMode || '').trim()
      if (apiMode && String(run.launch.apiMode || '').trim() !== apiMode) return false
    }
    if (String(run.launch.reasoningEffort || '').trim() !== String(launch.reasoningEffort || '').trim()) return false
    if (!hasManagedHermesMcpConfig(run)) return false
    return true
  }

  start(launch: CodingAgentRunLaunch): { runId: string; pid: number } {
    if (agentUpdateLocked(launch.agentId)) throw new Error('Agent is updating; retry after completion')
    const existingRunId = this.sessionIndex.get(launch.sessionId)
    if (existingRunId) {
      const existing = this.runs.get(existingRunId)
      if (existing && !existing.exited) return { runId: existing.id, pid: existing.pty?.pid || existing.currentChild?.pid || 0 }
    }

    const runId = launch.agentSessionId || makeId()
    const state = launch.state || { messages: [], isWorking: false, events: [], queue: [] }
    state.isWorking = true
    state.profile = launch.profile
    state.source = launch.sessionSource === 'group_chat'
      ? 'group_chat'
      : launch.sessionSource === 'workflow'
        ? 'workflow'
        : 'coding_agent'
    state.runId = runId

    if (isPrintAgent(launch.agentId)) {
      const run: ManagedCodingAgentRun = {
        id: runId,
        launch,
        state,
        lastActiveAt: Date.now(),
        startedAt: Date.now(),
        exited: false,
        nativeResumeReady: launch.nativeResume === true,
      }
      this.runs.set(run.id, run)
      this.sessionIndex.set(launch.sessionId, run.id)
      this.ensureDbSession(run)
      this.touch(run)
      if (launch.agentId === 'pi') {
        try {
          this.startPiRpcProcess(run)
        } catch (err) {
          this.cleanupRun(run, { kill: true, reportClosed: false })
          throw err
        }
      }
      const agentName = launch.agentId === 'codex'
        ? 'Codex'
        : launch.agentId === 'pi'
          ? 'Pi'
          : launch.agentId === 'grok'
            ? 'Grok'
            : launch.agentId === 'opencode'
              ? 'OpenCode'
            : launch.agentId === 'dsh'
              ? 'DeepSeek Harness'
            : 'Claude Code'
      this.emitTerminalStatus(run, `${agentName} chat runner ready.`)
      logger.info({
        runId: run.id,
        sessionId: launch.sessionId,
        agentId: launch.agentId,
        mode: launch.mode,
        profile: launch.profile,
        provider: launch.provider,
        model: launch.model,
      }, '[coding-agent-run] print runner started')
      return { runId: run.id, pid: run.currentChild?.pid || 0 }
    }

    if (!pty) throw new Error('Hidden coding agent terminal is unavailable because node-pty is not installed')

    const shell = defaultShell()
    const args = process.platform === 'win32'
      ? ['-NoExit', '-Command', launch.shellCommand]
      : ['-lc', launch.shellCommand]
    const proc = pty.spawn(shell, args, {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      cwd: existsSync(launch.workspaceDir) ? launch.workspaceDir : homedir(),
      env: {
        ...process.env,
        ...(launch.env || {}),
      },
    })

    const run: ManagedCodingAgentRun = {
      id: runId,
      launch,
      pty: proc,
      state,
      lastActiveAt: Date.now(),
      startedAt: Date.now(),
      exited: false,
    }

    this.runs.set(run.id, run)
    this.sessionIndex.set(launch.sessionId, run.id)
    this.ensureDbSession(run)
    this.touch(run)
    this.emitTerminalStatus(run, `${launch.agentId === 'codex' ? 'Codex' : 'Claude Code'} session started.`)

    proc.onData((data: string) => {
      this.touch(run)
      logger.debug({ runId: run.id, bytes: Buffer.byteLength(data || '', 'utf8') }, '[coding-agent-run] pty output')
      this.maybeAnswerClaudeApiKeyPrompt(run, data)
      this.bufferTerminalOutput(run, data)
    })
    proc.onExit(({ exitCode }: { exitCode: number }) => {
      run.exited = true
      this.cleanupRun(run, { kill: false })
      logger.info({ runId: run.id, sessionId: launch.sessionId, exitCode }, '[coding-agent-run] process exited')
    })

    logger.info({
      runId: run.id,
      sessionId: launch.sessionId,
      agentId: launch.agentId,
      mode: launch.mode,
      profile: launch.profile,
      provider: launch.provider,
      model: launch.model,
      pid: proc.pid,
    }, '[coding-agent-run] hidden session started')

    return { runId: run.id, pid: proc.pid }
  }

  send(sessionId: string, input: string, options: CodingAgentRunSendOptions = {}): { runId: string; messageId?: number } {
    const run = this.getBySession(sessionId)
    if (!run) throw new Error('Coding agent session not found')
    if (run.nativeCompletionPending) throw new Error('Coding agent is still completing the previous input')
    if (agentUpdateLocked(run.launch.agentId)) throw new Error('Agent is updating; retry after completion')
    const text = String(input || '').trim()
    const images = Array.isArray(options.images) ? options.images : []
    if (!text && images.length === 0) throw new Error('Input is required')
    // Keep native metadata separate from launch configuration: global CLIs can
    // choose a different model each turn, including during a resumed session.
    if (!childIsRunning(run.currentChild) || (run.launch.agentId === 'pi' && !run.turnActive)) {
      run.nativeUsage = new NativeTurnUsage()
      run.nativeTurnStartedAt = Date.now()
    }
    const systemPrompt = String(options.systemPrompt || '').trim()
    this.ensureDbSession(run)
    run.assistantMessageId = undefined
    const messageId = this.addUserMessage(run, options.storageInput ?? text)
    this.touch(run)
    this.emitTerminalStatus(run, 'Input sent to coding agent.')
    this.startWorkspaceRunDiff(run)
    if (run.launch.agentId === 'claude-code') {
      this.startClaudePrintTurn(run, text, systemPrompt, images)
      return { runId: run.id, messageId }
    }
    if (run.launch.agentId === 'codex') {
      this.startCodexExecTurn(run, text, systemPrompt, images)
      return { runId: run.id, messageId }
    }
    if (run.launch.agentId === 'grok') {
      this.startGrokPrintTurn(run, text, systemPrompt, images)
      return { runId: run.id, messageId }
    }
    if (run.launch.agentId === 'dsh') {
      this.startDshTurn(run, text, systemPrompt, images)
      return { runId: run.id, messageId }
    }
    if (run.launch.agentId === 'opencode') {
      this.startOpenCodeTurn(run, text, systemPrompt, images)
      return { runId: run.id, messageId }
    }
    if (run.launch.agentId === 'pi') {
      try {
        this.startPiRpcTurn(run, text, systemPrompt, images)
      } catch (err) {
        run.turnActive = false
        throw err
      }
      return { runId: run.id, messageId }
    }
    if (!run.pty) throw new Error('Coding agent terminal is not available')
    run.pty.write(`${text}\r`)
    return { runId: run.id, messageId }
  }

  getRunInfo(sessionId: string): CodingAgentRunInfo | null {
    const run = this.getBySession(sessionId)
    if (!run) return null
    return {
      exists: true,
      running: run.launch.agentId === 'pi'
        ? run.turnActive === true
        : childIsRunning(run.currentChild) || run.turnActive === true,
      agentId: run.launch.agentId,
      model: run.launch.model,
      provider: run.launch.provider,
      workspaceDir: run.launch.workspaceDir,
      nativeSessionId: String(run.launch.agentNativeSessionId || '').trim(),
      messageCount: run.state.messages.length,
    }
  }

  compact(sessionId: string, args = ''): { started: boolean } | Promise<{
    compacted: boolean
    beforeTokens?: number | null
    afterTokens?: number | null
  }> {
    const run = this.getBySession(sessionId)
    if (!run) throw new Error('Coding agent session not found')
    if (agentUpdateLocked(run.launch.agentId)) throw new Error('Agent is updating; retry after completion')
    if (run.launch.agentId === 'pi') {
      if (run.turnActive) throw new Error('Pi is still processing the previous input')
      if (!childIsRunning(run.currentChild)) throw new Error('Pi RPC process is not available')
      return this.requestPiRpc<any>(run, {
        type: 'compact',
        ...(args ? { customInstructions: args } : {}),
      }, PI_RPC_COMPACT_TIMEOUT_MS).then(result => ({
        compacted: true,
        beforeTokens: compactTokenNumber(result?.tokensBefore),
      }))
    }
    if (childIsRunning(run.currentChild)) throw new Error('Coding agent is still processing the previous input')
    const nativeSessionId = String(run.launch.agentNativeSessionId || '').trim()
    if (run.launch.agentId === 'claude-code') {
      if (!nativeSessionId) throw new Error('Claude Code session has no native session to compact')
      this.startClaudePrintTurn(run, `/compact${args ? ` ${args}` : ''}`, '', [])
      return { started: true }
    }
    if (run.launch.agentId === 'codex') {
      if (String(args || '').trim()) {
        throw new Error('Codex native compaction does not accept arguments')
      }
      if (!nativeSessionId) throw new Error('Codex session has no native thread to compact')
      return compactCodexThread({
        command: run.launch.command,
        env: {
          ...process.env,
          ...(run.launch.env || {}),
        },
        workspaceDir: run.launch.workspaceDir,
      }, nativeSessionId)
    }
    if (run.launch.agentId === 'grok') {
      if (!nativeSessionId) throw new Error('Grok session has no native session to compact')
      this.startGrokPrintTurn(run, `/compact${args ? ` ${args}` : ''}`, '', [])
      return { started: true }
    }
    throw new Error(`Native /compact is not supported for ${run.launch.agentId}`)
  }

  getPiSessionStats(sessionId: string): Promise<PiNativeSessionStats> {
    const run = this.requirePiRpcRun(sessionId)
    return this.requestPiRpc<PiNativeSessionStats>(run, { type: 'get_session_stats' })
  }

  getPiSessionState(sessionId: string): Promise<PiNativeSessionState> {
    const run = this.requirePiRpcRun(sessionId)
    return this.requestPiRpc<PiNativeSessionState>(run, { type: 'get_state' })
  }

  stop(sessionId: string, options: { reportClosed?: boolean } = {}): boolean {
    const run = this.getBySession(sessionId)
    if (!run) return false
    if (options.reportClosed === false) run.stoppedByUser = true
    this.cleanupRun(run, { kill: true, reportClosed: options.reportClosed ?? true })
    return true
  }

  async interruptForQueueInsertion(
    sessionId: string,
    expectedRunId?: string,
  ): Promise<CodingAgentQueueInsertionInterruptResult> {
    const run = this.getBySession(sessionId)
    if (!run || run.exited) return { status: 'not_found' }
    if (expectedRunId && run.id !== expectedRunId) return { status: 'run_mismatch' }
    const isRunning = run.launch.agentId === 'pi'
      ? run.turnActive === true
      : childIsRunning(run.currentChild)
    if (!isRunning) return { status: 'not_running' }

    const responseId = String(run.printResponseId || run.runMarker || run.id)
    // The current CLI invocation is intentionally disposable. Stop it before
    // releasing the queued run so the next one can resume the native session
    // without overlapping the old process.
    run.stoppedByUser = true
    const interruptedChild = run.currentChild
    const childClosed = waitForChildProcessClose(interruptedChild)
    this.cleanupRun(run, { kill: true, reportClosed: false })
    await childClosed
    for (const message of run.state.messages) {
      if (
        message.runMarker === run.runMarker
        && message.role === 'assistant'
        && message.finish_reason == null
      ) {
        message.finish_reason = 'interrupted'
      }
    }
    run.assistantMessageId = this.persistTerminalResponse(run)
    const workspaceRunChange = this.completeWorkspaceRunDiff(run)
    const queueRemaining = run.state.queue.length
    this.emitToChat(sessionId, 'run.failed', {
      event: 'run.failed',
      run_id: responseId,
      response_id: responseId,
      error: 'Interrupted to insert a queued message',
      interrupted: true,
      stop_reason: 'queue_insertion',
      interruption_mode: 'immediate',
      ...(run.assistantMessageId ? { message_id: run.assistantMessageId } : {}),
      ...(queueRemaining > 0 ? { queue_remaining: queueRemaining } : {}),
      workspace_run_change: workspaceRunChange,
    })
    this.markChatRunCompleted(sessionId, 'run.failed')
    return { status: 'interrupted', runId: run.id, responseId }
  }

  stopMatching(
    predicate: (launch: CodingAgentRunLaunch) => boolean,
    options: { reportClosed?: boolean } = {},
  ): number {
    let stopped = 0
    for (const run of [...this.runs.values()]) {
      if (!predicate(run.launch)) continue
      this.cleanupRun(run, { kill: true, reportClosed: options.reportClosed ?? true })
      stopped += 1
    }
    return stopped
  }

  invalidateMatching(predicate: (launch: CodingAgentRunLaunch) => boolean): {
    invalidated: number
    deferred: number
  } {
    let invalidated = 0
    let deferred = 0
    for (const run of [...this.runs.values()]) {
      if (!predicate(run.launch)) continue
      invalidated += 1
      if (run.state.isWorking || run.turnActive || run.pendingChatCompletionEvent) {
        run.disposeAfterTurn = true
        deferred += 1
        continue
      }
      this.cleanupRun(run, { kill: true, reportClosed: false })
    }
    return { invalidated, deferred }
  }

  resolveApproval(sessionId: string, approvalId: string, choice = 'deny'): { handled: boolean; resolved: boolean } {
    const run = this.getBySession(sessionId)
    const request = run?.piUiRequests?.get(approvalId)
    if (!run || !request) return { handled: false, resolved: false }
    const normalizedChoice = String(choice || 'deny').trim().toLowerCase()
    if (!['once', 'deny'].includes(normalizedChoice) || request.method !== 'confirm') {
      return { handled: true, resolved: false }
    }
    const response: Record<string, unknown> = { type: 'extension_ui_response', id: approvalId }
    response.confirmed = normalizedChoice === 'once'
    try {
      this.writePiRpcCommand(run, response)
    } catch {
      return { handled: true, resolved: false }
    }
    if (request.timeoutTimer) clearTimeout(request.timeoutTimer)
    run.piUiRequests?.delete(approvalId)
    return { handled: true, resolved: true }
  }

  resolveClarification(sessionId: string, clarifyId: string, responseValue = ''): { handled: boolean; resolved: boolean } {
    const run = this.getBySession(sessionId)
    const request = run?.piUiRequests?.get(clarifyId)
    if (!run || !request || !['select', 'input', 'editor'].includes(request.method)) {
      return { handled: Boolean(run && request), resolved: false }
    }
    const value = String(responseValue ?? '').slice(0, 20_000)
    if (request.method === 'select') {
      const options = Array.isArray(request.options) ? request.options.map((item: unknown) => String(item)) : []
      if (value && !options.includes(value)) return { handled: true, resolved: false }
    }
    try {
      this.writePiRpcCommand(run, {
        type: 'extension_ui_response',
        id: clarifyId,
        ...(request.method === 'select' && !value ? { cancelled: true } : { value }),
      })
    } catch {
      return { handled: true, resolved: false }
    }
    if (request.timeoutTimer) clearTimeout(request.timeoutTimer)
    run.piUiRequests?.delete(clarifyId)
    return { handled: true, resolved: true }
  }

  touchByAgentSession(agentSessionId?: string | null) {
    if (!agentSessionId) return
    const run = this.runs.get(agentSessionId)
    if (run) this.touch(run)
  }

  handleProxyUsageEvent(agentSessionId: string | undefined, event: CanonicalResponsesEvent) {
    if (!agentSessionId || event.type !== 'response.completed') return
    const run = this.runs.get(agentSessionId)
    if (!run || run.launch.mode !== 'scoped') return
    const final = (event.data as any).response || event.data
    if (!final?.usage) return
    const usage = normalizeTokenUsage(final.usage, {}, {
      inputIncludesCache: run.launch.apiMode !== 'anthropic_messages',
    })
    if (usage.isEstimated) {
      logger.warn({
        runId: run.id,
        sessionId: run.launch.sessionId,
        responseId: final?.id,
        provider: run.launch.provider,
        model: final?.model || run.launch.model,
      }, '[coding-agent-run] scoped proxy response omitted token usage')
      return
    }
    recordSessionUsage({
      sessionId: run.launch.sessionId,
      runId: final?.id,
      source: 'coding_agent',
      agent: usageCodingAgent(run.launch.agentId),
      usageScope: 'model_call',
      apiCalls: 1,
      usage,
      profile: run.launch.profile,
      model: final?.model || run.launch.model,
      provider: run.launch.provider,
      isEstimated: false,
    })
  }

  handleResponseEvent(agentSessionId: string | undefined, event: CanonicalResponsesEvent) {
    if (!agentSessionId) return
    const run = this.runs.get(agentSessionId)
    if (!run) return
    const responseEvent = this.normalizeCodexChatTextEvent(run, event)
    if (!responseEvent) return
    const storageSafeResponseEvent = truncateCodingAgentToolOutputEvent(responseEvent)
    if (run.launch.agentId === 'pi' && !run.acceptingPrintEvent) {
      // Pi RPC is the authoritative stream. The scoped provider proxy is used
      // for transport and usage accounting only.
      return
    }
    if ((run.launch.agentId === 'opencode' || run.launch.agentId === 'dsh') && !run.acceptingPrintEvent) {
      // Native JSON/ACP stdout is the authoritative turn stream. A single
      // turn can contain several provider requests, so treating each
      // proxy response.completed event as the turn boundary duplicates output
      // and can repeatedly persist partial assistant responses.
      return
    }
    if (run.launch.agentId === 'claude-code' && !run.acceptingPrintEvent) {
      if (run.terminalEventHandled) return
      // Claude's stream-json process reports tool_use/tool_result itself.
      // Proxy Responses events describe the same calls with different ids and
      // may omit the matching function_call_output, so accepting both sources
      // creates duplicate tool cards that remain pending until run completion.
      if (run.currentChild) return
    }
    if (
      run.launch.agentId === 'codex' &&
      !run.acceptingPrintEvent &&
      isProxyToolEvent(storageSafeResponseEvent)
    ) {
      // Keep proxy text deltas for responsive streaming, but use Codex JSONL as
      // the sole source of tool lifecycle events. The two streams use different
      // ids for the same call, so combining them creates duplicate tool cards.
      return
    }
    if (storageSafeResponseEvent.type === 'response.created') {
      if (run.responseStartEmitted) return
      run.responseStartEmitted = true
    }
    const isTerminalEvent = storageSafeResponseEvent.type === 'response.completed' || storageSafeResponseEvent.type === 'response.failed'
    const deferCodexProxyTerminal = storageSafeResponseEvent.type === 'response.completed' ||
      (storageSafeResponseEvent.type === 'response.failed' && !run.acceptingPrintEvent)
    if (
      run.launch.agentId === 'codex' &&
      deferCodexProxyTerminal &&
      childIsRunning(run.currentChild)
    ) {
      if (storageSafeResponseEvent.type === 'response.completed') {
        const final = (storageSafeResponseEvent.data as any).response || storageSafeResponseEvent.data
        run.codexPendingUsage = final?.usage ?? run.codexPendingUsage
      }
      return
    }
    if (isTerminalEvent) {
      if (run.terminalEventHandled) return
      run.terminalEventHandled = true
    }
    this.touch(run)
    this.ensureDbSession(run)
    if (!run.runMarker) run.runMarker = `coding_agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    run.state.isWorking = true
    run.state.profile = run.launch.profile
    run.state.source = run.launch.sessionSource === 'group_chat'
      ? 'group_chat'
      : run.launch.sessionSource === 'workflow'
        ? 'workflow'
        : 'coding_agent'
    run.state.runId = run.id
    const mapped = applyResponseStreamEvent(run.state, run.launch.sessionId, run.runMarker, storageSafeResponseEvent.type, storageSafeResponseEvent.data)
    if (mapped) {
      this.emitToChat(run.launch.sessionId, mapped.event, mapped.payload)
    }
    if (isTerminalEvent) {
      run.assistantMessageId = this.persistTerminalResponse(run)
      const final = (storageSafeResponseEvent.data as any).response || storageSafeResponseEvent.data
      if (run.launch.mode !== 'scoped' && !['opencode', 'pi'].includes(run.launch.agentId)) {
        const rows = (run.nativeUsage || new NativeTurnUsage()).rows(run.launch.agentId, final?.usage, final?.model || run.launch.model)
        this.recordNativeUsage(run, rows, final?.id || run.printResponseId || run.runMarker || run.id)
      }
      const deferPiUsageRefresh = run.launch.agentId === 'pi'
      run.terminalUsageRefresh = deferPiUsageRefresh
        ? undefined
        : this.refreshCodingAgentUsage(run)
      const finalText = extractResponseText(final)
      const terminalError = storageSafeResponseEvent.type === 'response.failed'
        ? responseErrorMessage(final?.error || (responseEvent.data as any).error) || 'Coding agent run failed'
        : run.launch.agentId === 'claude-code' && run.acceptingPrintEvent
          ? null
          : codingAgentGatewayErrorMessage(finalText)
      const chatCompletionEvent = terminalError ? 'run.failed' : 'run.completed'
      const chatCompletionPayload: Record<string, unknown> = {
        event: chatCompletionEvent,
        run_id: final?.id,
        response_id: final?.id,
        output: finalText,
        error: terminalError || undefined,
      }
      if (childIsRunning(run.currentChild)) {
        run.pendingChatCompletionEvent = chatCompletionEvent
        run.pendingChatCompletionPayload = chatCompletionPayload
        if (run.launch.agentId === 'pi') this.closePiRpcProcessAfterTurn(run)
      } else {
        void this.emitAndMarkPrintChatRunCompletedAfterUsage(run, chatCompletionEvent, chatCompletionPayload)
        if (deferPiUsageRefresh) this.schedulePiTerminalUsageRefresh(run)
      }
    }
  }

  private persistTerminalResponse(run: ManagedCodingAgentRun): string | undefined {
    const assistantMessageId = flushResponseRunToDb(run.state, run.launch.sessionId)
    run.state.responseRun = undefined
    updateSessionStats(run.launch.sessionId)
    return assistantMessageId
  }

  private recordNativeUsage(run: ManagedCodingAgentRun, rows: NativeUsageRow[], responseId: string) {
    for (const row of rows) {
      recordSessionUsage({
        sessionId: run.launch.sessionId,
        runId: `${responseId}:${row.id}`,
        source: 'coding_agent',
        agent: usageCodingAgent(run.launch.agentId),
        usageScope: row.scope,
        apiCalls: row.apiCalls,
        usage: row.usage,
        profile: run.launch.profile,
        model: row.model,
        provider: row.provider || run.launch.provider,
        isEstimated: false,
      })
    }
  }

  private schedulePiTerminalUsageRefresh(run: ManagedCodingAgentRun) {
    // Pi RPC's agent_settled event is the authoritative lifecycle boundary.
    // Tokenizer/provider initialization can be CPU-heavy on a cold host and
    // must not delay run.completed/run.failed or keep the chat UI spinning.
    setImmediate(() => {
      void this.refreshCodingAgentUsage(run).catch((err) => {
        logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[coding-agent-run] deferred Pi usage refresh failed')
      })
    })
  }

  private async refreshCodingAgentUsage(run: ManagedCodingAgentRun) {
    const emitUsage = (event: string, payload: any) => {
      this.emitToChat(run.launch.sessionId, event, payload)
    }
    const usage = await calcAndUpdateUsage(run.launch.sessionId, run.state, emitUsage, {
      nativeSource: 'coding_agent',
    })
    const contextTokens = usage.contextInputTokens != null || usage.contextOutputTokens != null
      ? (usage.contextInputTokens || 0) + (usage.contextOutputTokens || 0)
      : undefined
    if (contextTokens != null && contextTokens > 0) {
      updateContextTokenUsage(run.launch.sessionId, run.state, emitUsage, contextTokens, usage)
    }
  }

  private normalizeCodexChatTextEvent(run: ManagedCodingAgentRun, event: CanonicalResponsesEvent): CanonicalResponsesEvent | null {
    if (run.launch.agentId !== 'codex' || event.type !== 'response.output_text.delta') return event
    const data: any = event.data || {}
    const text = typeof data.delta === 'string'
      ? data.delta
      : typeof data.text === 'string'
        ? data.text
        : ''
    if (!text) return event
    const existing = run.codexChatText || ''
    const baseline = existing || (run.acceptingPrintEvent ? '' : run.printText || '')
    const delta = text.length >= 16 ? appendedTextDelta(baseline, text) : text
    if (!delta) return null
    run.codexChatText = `${baseline}${delta}`
    if (delta === text) return event
    return {
      ...event,
      data: {
        ...data,
        delta,
        text: typeof data.text === 'string' ? delta : data.text,
      },
    }
  }

  shutdown() {
    for (const run of [...this.runs.values()]) this.cleanupRun(run, { kill: true })
    for (const child of this.memoryExportChildren) forceKillChildProcess(child)
    this.memoryExportChildren.clear()
  }

  private getBySession(sessionId: string): ManagedCodingAgentRun | null {
    const runId = this.sessionIndex.get(sessionId)
    return runId ? this.runs.get(runId) || null : null
  }

  private ensureDbSession(run: ManagedCodingAgentRun) {
    if (getSession(run.launch.sessionId)) return
    const source = run.launch.sessionSource === 'global_agent'
      ? 'global_agent'
      : run.launch.sessionSource === 'group_chat'
        ? 'group_chat'
      : run.launch.sessionSource === 'workflow'
        ? 'workflow'
        : 'coding_agent'
    createSession({
      id: run.launch.sessionId,
      profile: run.launch.profile,
      source,
      agent: persistedCodingAgent(run.launch.agentId),
      agent_session_id: run.id,
      agent_native_session_id: run.launch.agentNativeSessionId,
      model: run.launch.model,
      provider: run.launch.provider,
      api_mode: run.launch.apiMode || '',
      reasoning_effort: run.launch.reasoningEffort || '',
      agent_preset: run.launch.agentPreset || '',
      title: '',
      workspace: run.launch.workspaceDir,
    })
  }

  private addUserMessage(run: ManagedCodingAgentRun, content: string) {
    const timestamp = nowSeconds()
    run.state.messages.push({
      id: run.state.messages.length + 1,
      session_id: run.launch.sessionId,
      runMarker: run.runMarker,
      role: 'user',
      content,
      timestamp,
    })
    const id = addMessage({
      session_id: run.launch.sessionId,
      role: 'user',
      content,
      run_marker: run.runMarker ?? null,
      timestamp,
    })
    logger.debug({ runId: run.id, sessionId: run.launch.sessionId, messageId: id }, '[coding-agent-run] recorded user message')
    return id
  }

  private touch(run: ManagedCodingAgentRun) {
    noteAgentActivity(run.launch.agentId)
    run.lastActiveAt = Date.now()
    if (run.idleTimer) clearTimeout(run.idleTimer)
    run.idleTimer = setTimeout(() => {
      const current = this.runs.get(run.id)
      if (!current) return
      const remaining = this.idleMs - (Date.now() - current.lastActiveAt)
      if (current.turnActive) {
        this.touch(current)
        return
      }
      if (remaining > 0) {
        this.touch(current)
        return
      }
      logger.info({ runId: current.id, sessionId: current.launch.sessionId, idleMs: this.idleMs }, '[coding-agent-run] closing idle hidden session')
      this.cleanupRun(current, { kill: true })
    }, this.idleMs)
  }

  private cleanupRun(run: ManagedCodingAgentRun, options: { kill: boolean; reportClosed?: boolean }) {
    const shouldReportClosed = options.reportClosed !== false && (run.state.isWorking || Boolean(run.currentChild && !run.currentChild.killed))
    if (run.idleTimer) clearTimeout(run.idleTimer)
    if (run.currentChildKillTimer) clearTimeout(run.currentChildKillTimer)
    run.dshTurn?.cancel()
    run.dshTurn?.dispose()
    run.piDetachJsonl?.()
    run.piDetachJsonl = undefined
    for (const request of run.piRpcRequests?.values() || []) {
      clearTimeout(request.timeoutTimer)
      request.reject(new Error('Pi RPC process closed before the command completed'))
    }
    run.piRpcRequests?.clear()
    for (const [requestId, request] of run.piUiRequests || []) {
      if (request.timeoutTimer) clearTimeout(request.timeoutTimer)
      const isConfirmation = request.method === 'confirm'
      this.emitToChat(run.launch.sessionId, isConfirmation ? 'approval.resolved' : 'clarify.resolved', {
        event: isConfirmation ? 'approval.resolved' : 'clarify.resolved',
        session_id: run.launch.sessionId,
        ...(isConfirmation ? { approval_id: requestId, choice: 'deny' } : { clarify_id: requestId }),
        resolved: true,
        reason: 'Coding agent session closed',
      })
    }
    run.piUiRequests?.clear()
    this.flushTerminalOutput(run)
    if (run.terminalFlushTimer) clearTimeout(run.terminalFlushTimer)
    this.runs.delete(run.id)
    if (this.sessionIndex.get(run.launch.sessionId) === run.id) this.sessionIndex.delete(run.launch.sessionId)
    if (options.kill && !run.exited) {
      if (run.launch.agentId === 'pi' && run.turnActive && childIsRunning(run.currentChild)) {
        this.writePiRpcCommand(run, { id: `abort_${Date.now()}`, type: 'abort' })
      }
      if (run.pty) {
        try { killOwnedProcessTree(run.pty.pid, () => run.pty?.kill()) } catch {}
      }
      terminateChildProcess(run.currentChild)
      if (childIsRunning(run.currentChild)) {
        run.currentChildKillTimer = setTimeout(() => forceKillChildProcess(run.currentChild), 1500)
      }
    }
    run.exited = true
    run.state.isWorking = false
    run.turnActive = false
    if (shouldReportClosed) {
      const workspaceRunChange = this.completeWorkspaceRunDiff(run)
      this.emitToChat(run.launch.sessionId, 'run.failed', {
        event: 'run.failed',
        error: 'Coding agent session closed',
        workspace_run_change: workspaceRunChange,
      })
      this.markChatRunCompleted(run.launch.sessionId, 'run.failed')
    }
  }

  private startPiRpcProcess(run: ManagedCodingAgentRun) {
    const child = spawnCodingAgentChild(run.launch.command, run.launch.args, {
      cwd: existsSync(run.launch.workspaceDir) ? run.launch.workspaceDir : homedir(),
      env: run.launch.mode === 'global'
        ? { ...process.env, ...(run.launch.env || {}) }
        : isolatedCodingAgentChildEnv(run.launch.env),
      pipeStdin: true,
    })
    run.currentChild = child
    run.currentChildStderr = ''
    run.piToolBlocks = new Map()
    run.piUiRequests = new Map()
    run.piRpcRequests = new Map()
    run.piDetachJsonl = child.stdout
      ? attachPiJsonlReader(
          child.stdout,
          event => this.handlePiRpcEvent(run, event),
          line => logger.debug({ runId: run.id, line: sanitizeCodingAgentTerminalOutput(line) }, '[coding-agent-run] ignored invalid Pi RPC line'),
        )
      : undefined

    child.stderr?.on('data', (chunk: Buffer) => {
      this.touch(run)
      const text = appendChildStderr(run, chunk)
      if (text) logger.debug({ runId: run.id, sessionId: run.launch.sessionId, text }, '[coding-agent-run] Pi RPC stderr')
    })
    child.stdin?.on('error', (err) => {
      logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[coding-agent-run] Pi RPC stdin failed')
    })
    child.on('error', (err) => {
      logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[coding-agent-run] Pi RPC failed to start')
      if (!run.printCompleted) this.failClaudePrintTurn(run, childProcessErrorMessage(err))
    })
    child.on('close', (code) => {
      if (run.currentChildKillTimer) clearTimeout(run.currentChildKillTimer)
      run.currentChildKillTimer = undefined
      run.dshTurn?.cancel()
    run.dshTurn?.dispose()
    run.piDetachJsonl?.()
      run.piDetachJsonl = undefined
      run.currentChild = undefined
      if (run.exited || run.stoppedByUser) return
      if (run.pendingChatCompletionEvent) {
        void this.emitAndMarkPrintChatRunCompletedAfterUsage(run, run.pendingChatCompletionEvent, run.pendingChatCompletionPayload)
        this.schedulePiTerminalUsageRefresh(run)
        return
      }
      const message = exitErrorMessage('Pi', code, run.currentChildStderr)
      logger.info({ runId: run.id, sessionId: run.launch.sessionId, code }, '[coding-agent-run] Pi RPC exited')
      if (run.state.isWorking && !run.printCompleted) this.failClaudePrintTurn(run, message)
      this.cleanupRun(run, { kill: false, reportClosed: false })
    })
  }

  private closePiRpcProcessAfterTurn(run: ManagedCodingAgentRun) {
    const child = run.currentChild
    if (!childIsRunning(child)) return
    run.turnActive = false
    terminateChildProcess(child)
    if (!childIsRunning(child)) return
    run.currentChildKillTimer = setTimeout(() => forceKillChildProcess(child), 1500)
    run.currentChildKillTimer.unref?.()
  }

  private writePiRpcCommand(run: ManagedCodingAgentRun, command: Record<string, unknown>) {
    const stdin = run.currentChild?.stdin
    if (!stdin || !childIsRunning(run.currentChild)) throw new Error('Pi RPC process is not available')
    stdin.write(`${JSON.stringify(command)}\n`)
  }

  private requirePiRpcRun(sessionId: string): ManagedCodingAgentRun {
    const run = this.getBySession(sessionId)
    if (!run) throw new Error('Coding agent session not found')
    if (run.launch.agentId !== 'pi') throw new Error(`Pi RPC command is not supported for ${run.launch.agentId}`)
    if (!childIsRunning(run.currentChild)) throw new Error('Pi RPC process is not available')
    return run
  }

  private requestPiRpc<T>(
    run: ManagedCodingAgentRun,
    command: Record<string, unknown> & { type: string },
    timeoutMs = PI_RPC_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const requestId = `pi_rpc_${makeId()}`
    return new Promise<T>((resolve, reject) => {
      const timeoutTimer = setTimeout(() => {
        run.piRpcRequests?.delete(requestId)
        reject(new Error(`Pi RPC ${command.type} timed out after ${Math.round(timeoutMs / 1000)} seconds`))
      }, timeoutMs)
      timeoutTimer.unref?.()
      run.piRpcRequests ??= new Map()
      run.piRpcRequests.set(requestId, {
        command: command.type,
        resolve,
        reject,
        timeoutTimer,
      })
      try {
        this.writePiRpcCommand(run, { ...command, id: requestId })
      } catch (err) {
        clearTimeout(timeoutTimer)
        run.piRpcRequests.delete(requestId)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private startPiRpcTurn(
    run: ManagedCodingAgentRun,
    input: string,
    systemPrompt = '',
    images: CodingAgentImageInput[] = [],
  ) {
    if (!childIsRunning(run.currentChild)) throw new Error('Pi RPC process is not running')
    if (run.printResponseId && !run.printCompleted) throw new Error('Pi is still processing the previous input')

    const responseId = `resp_${Date.now()}`
    run.printResponseId = responseId
    run.printMessageId = `msg_${responseId}`
    run.printTextStarted = false
    run.printText = ''
    run.printCompleted = false
    run.responseStartEmitted = false
    run.terminalEventHandled = false
    run.runMarker = undefined
    run.memoryExportStarted = false
    run.piToolBlocks = new Map()
    run.piPendingError = undefined
    run.piWillRetry = false
    run.piFinalText = undefined
    run.piFinishReason = undefined
    run.piTextBuffer = ''
    run.piCurrentMessageText = ''

    this.handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: {
        type: 'response.created',
        response: { id: responseId, object: 'response', status: 'in_progress', model: run.launch.model, output: [] },
      },
    })

    const rpcImages = images.map(image => ({
      type: 'image',
      data: readFileSync(image.path).toString('base64'),
      mimeType: normalizedImageMediaType(image),
    }))
    const thinkingLevel = normalizePiThinkingLevel(run.launch.reasoningEffort)
    if (thinkingLevel) {
      this.writePiRpcCommand(run, {
        id: `thinking_${responseId}`,
        type: 'set_thinking_level',
        level: thinkingLevel,
      })
    }
    const dynamicPromptPath = String(run.launch.env?.HERMES_PI_DYNAMIC_PROMPT_FILE || '').trim()
    if (dynamicPromptPath) writeFileSync(dynamicPromptPath, systemPrompt, 'utf8')
    run.turnActive = true
    this.writePiRpcCommand(run, {
      id: `prompt_${responseId}`,
      type: 'prompt',
      message: input,
      ...(rpcImages.length ? { images: rpcImages } : {}),
    })
  }

  private handlePiRpcEvent(run: ManagedCodingAgentRun, event: any) {
    this.touch(run)
    if (!event || typeof event !== 'object') return

    if (event.type === 'response') {
      const requestId = String(event.id || '').trim()
      const request = requestId ? run.piRpcRequests?.get(requestId) : undefined
      if (request) {
        clearTimeout(request.timeoutTimer)
        run.piRpcRequests?.delete(requestId)
        if (event.success === false) {
          request.reject(new Error(String(event.error || `Pi RPC ${request.command} failed`)))
        } else {
          request.resolve(event.data)
        }
        return
      }
      if (event.success === false && event.command === 'prompt' && !run.printCompleted) {
        this.failClaudePrintTurn(run, String(event.error || 'Pi rejected the prompt'))
      }
      if (event.success === false && event.command === 'set_thinking_level') {
        logger.warn({
          runId: run.id,
          sessionId: run.launch.sessionId,
          level: run.launch.reasoningEffort,
          error: event.error,
        }, '[coding-agent-run] Pi rejected requested thinking level')
      }
      return
    }

    if (event.type === 'extension_ui_request') {
      if (event.method === 'notify' || event.method === 'setStatus' || event.method === 'setWidget'
        || event.method === 'setTitle' || event.method === 'set_editor_text') return
      const approvalId = String(event.id || '').trim()
      if (!approvalId) return
      if (!['confirm', 'select', 'input', 'editor'].includes(event.method)) {
        try {
          this.writePiRpcCommand(run, { type: 'extension_ui_response', id: approvalId, cancelled: true })
        } catch {}
        return
      }
      run.piUiRequests ??= new Map()
      const timeoutMs = Number(event.timeout)
      const request = { ...event } as any
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        request.timeoutTimer = setTimeout(() => {
          if (run.piUiRequests?.get(approvalId) !== request) return
          run.piUiRequests?.delete(approvalId)
          const isConfirmation = request.method === 'confirm'
          this.emitToChat(run.launch.sessionId, isConfirmation ? 'approval.resolved' : 'clarify.resolved', {
            event: isConfirmation ? 'approval.resolved' : 'clarify.resolved',
            session_id: run.launch.sessionId,
            ...(isConfirmation ? { approval_id: approvalId, choice: 'deny' } : { clarify_id: approvalId }),
            resolved: true,
            reason: 'Pi UI request expired',
          })
        }, timeoutMs)
        request.timeoutTimer.unref?.()
      }
      run.piUiRequests.set(approvalId, request)
      const requestedAt = Date.now()
      if (event.method === 'confirm') {
        this.emitToChat(run.launch.sessionId, 'approval.requested', {
          event: 'approval.requested',
          session_id: run.launch.sessionId,
          approval_id: approvalId,
          title: String(event.title || 'Pi approval required'),
          description: String(event.message || ''),
          choices: ['once', 'deny'],
          source: 'pi',
          ...(timeoutMs > 0 ? { timeout_ms: timeoutMs } : {}),
          ...(timeoutMs > 0 ? { remaining_timeout_ms: timeoutMs, requested_at: requestedAt } : {}),
        })
      } else {
        const options = event.method === 'select' && Array.isArray(event.options)
          ? event.options.map((value: unknown) => String(value))
          : null
        this.emitToChat(run.launch.sessionId, 'clarify.requested', {
          event: 'clarify.requested',
          session_id: run.launch.sessionId,
          clarify_id: approvalId,
          question: String(event.title || event.placeholder || 'Pi input required'),
          choices: options,
          initial_response: event.method === 'editor' ? String(event.prefill || '').slice(0, 20_000) : '',
          response_mode: event.method,
          ...(timeoutMs > 0 ? { timeout_ms: timeoutMs } : {}),
          ...(timeoutMs > 0 ? { remaining_timeout_ms: timeoutMs, requested_at: requestedAt } : {}),
          source: 'pi',
        })
      }
      return
    }

    if (run.printCompleted) return
    if (run.launch.mode === 'global') {
      const row = run.nativeUsage?.observePi(event)
      if (row) this.recordNativeUsage(run, [row], run.printResponseId || run.id)
    }
    if (event.type === 'auto_retry_start') {
      run.piWillRetry = true
      return
    }
    if (event.type === 'auto_retry_end') {
      run.piWillRetry = false
      if (event.success === false && event.finalError) run.piPendingError = String(event.finalError)
      return
    }
    if (event.type === 'agent_end') {
      run.piWillRetry = event.willRetry === true
      return
    }
    if (event.type === 'message_end') {
      const message = event.message || {}
      if (message.role === 'assistant') {
        const finalText = piAssistantMessageText(message)
        if (finalText) {
          const currentMessageText = run.piCurrentMessageText || ''
          const missingDelta = appendedTextDelta(currentMessageText, finalText)
          if (missingDelta) {
            run.piTextBuffer = `${run.piTextBuffer || ''}${missingDelta}`
            this.ensureClaudePrintText(run)
            run.printText = `${run.printText || ''}${missingDelta}`
            this.handleClaudePrintResponseEvent(run, {
              type: 'response.output_text.delta',
              data: {
                type: 'response.output_text.delta',
                item_id: run.printMessageId,
                output_index: 0,
                content_index: 0,
                delta: missingDelta,
              },
            })
          }
          run.piFinalText = `${run.piFinalText || ''}${finalText}`
          run.piCurrentMessageText = ''
        }
        run.piFinishReason = String(message.stopReason || '')
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          run.piPendingError = String(message.errorMessage || `Pi run ${message.stopReason}`)
        } else {
          run.piPendingError = undefined
        }
      }
      return
    }
    if (event.type === 'message_update') {
      const delta = event.assistantMessageEvent || {}
      if (delta.type === 'text_delta' && delta.delta) {
        const text = String(delta.delta)
        run.piTextBuffer = `${run.piTextBuffer || ''}${text}`
        run.piCurrentMessageText = `${run.piCurrentMessageText || ''}${text}`
        this.ensureClaudePrintText(run)
        run.printText = `${run.printText || ''}${text}`
        this.handleClaudePrintResponseEvent(run, {
          type: 'response.output_text.delta',
          data: {
            type: 'response.output_text.delta',
            item_id: run.printMessageId,
            output_index: 0,
            content_index: 0,
            delta: text,
          },
        })
      } else if (delta.type === 'thinking_delta' && delta.delta) {
        this.handleClaudePrintResponseEvent(run, {
          type: 'response.reasoning.delta',
          data: {
            type: 'response.reasoning.delta',
            item_id: run.printMessageId,
            output_index: 0,
            delta: String(delta.delta),
          },
        })
      }
      return
    }

    if (event.type === 'tool_execution_start') {
      const id = String(event.toolCallId || `pi_tool_${Date.now()}`)
      const block = {
        id,
        name: String(event.toolName || 'tool'),
        arguments: JSON.stringify(event.args ?? {}),
        done: false,
      }
      run.piToolBlocks?.set(id, block)
      this.handleClaudePrintResponseEvent(run, {
        type: 'response.output_item.added',
        data: {
          type: 'response.output_item.added',
          output_index: run.piToolBlocks?.size || 0,
          item: { type: 'function_call', id, call_id: id, name: block.name, arguments: block.arguments },
        },
      })
      this.handleClaudePrintResponseEvent(run, {
        type: 'response.output_item.done',
        data: {
          type: 'response.output_item.done',
          output_index: run.piToolBlocks?.size || 0,
          item: { type: 'function_call', id, call_id: id, name: block.name, arguments: block.arguments },
        },
      })
      return
    }

    if (event.type === 'tool_execution_end') {
      const id = String(event.toolCallId || '')
      const block = run.piToolBlocks?.get(id)
      if (block) block.done = true
      this.handleClaudePrintResponseEvent(run, {
        type: 'response.output_item.done',
        data: {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'function_call_output',
            id,
            call_id: id,
            output: truncateCodingAgentToolOutputForStorage(event.result),
            ...(event.isError ? { status: 'failed' } : {}),
          },
        },
      })
      return
    }

    if (event.type === 'agent_settled') {
      if (run.piWillRetry) return
      if (run.piPendingError) {
        this.failClaudePrintTurn(run, run.piPendingError)
        return
      }
      const finalText = run.piTextBuffer || run.piFinalText || ''
      if (finalText) {
        const existing = run.printText || ''
        if (finalText !== existing) {
          const delta = appendedTextDelta(existing, finalText)
          if (delta) {
            this.ensureClaudePrintText(run)
            run.printText = `${existing}${delta}`
            this.handleClaudePrintResponseEvent(run, {
              type: 'response.output_text.delta',
              data: {
                type: 'response.output_text.delta',
                item_id: run.printMessageId,
                output_index: 0,
                content_index: 0,
                delta,
              },
            })
          }
        }
      }
      if (run.piFinishReason === 'length') {
        const assistantMessage = [...run.state.messages]
          .reverse()
          .find(message => message.runMarker === run.runMarker && message.role === 'assistant' && !message.tool_calls?.length)
        if (assistantMessage) assistantMessage.finish_reason = 'length'
      }
      const dynamicPromptPath = String(run.launch.env?.HERMES_PI_DYNAMIC_PROMPT_FILE || '').trim()
      if (dynamicPromptPath) {
        try { writeFileSync(dynamicPromptPath, '', 'utf8') } catch {}
      }
      this.completeClaudePrintTurn(run)
    }
  }

  private startClaudePrintTurn(
    run: ManagedCodingAgentRun,
    input: string,
    systemPrompt = '',
    images: CodingAgentImageInput[] = [],
  ) {
    if (childIsRunning(run.currentChild)) {
      throw new Error('Claude Code is still processing the previous input')
    }

    const responseId = `resp_${Date.now()}`
    run.printResponseId = responseId
    run.printMessageId = `msg_${responseId}`
    run.printTextStarted = false
    run.printText = ''
    run.printCompleted = false
    run.responseStartEmitted = false
    run.terminalEventHandled = false
    run.printToolBlocks = new Map()
    run.currentChildStderr = ''
    run.runMarker = undefined
    run.memoryExportStarted = false

    this.handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: {
        type: 'response.created',
        response: { id: responseId, object: 'response', status: 'in_progress', model: run.launch.model, output: [] },
      },
    })

    const nativeSessionArgs = run.launch.agentNativeSessionId
      ? (run.nativeResumeReady
          ? ['--resume', run.launch.agentNativeSessionId]
          : ['--session-id', run.launch.agentNativeSessionId])
      : []
    if (run.launch.promptFile) updateManagedPromptFileSync(run.launch.promptFile, systemPrompt)
    const promptArgument = hasArg(run.launch.args, '--append-system-prompt-file')
      ? ''
      : normalizeCliPromptArgument(systemPrompt)
    const inputFormat = images.length > 0 ? 'stream-json' : 'text'
    const stdinInput = images.length > 0 ? buildClaudeStreamJsonInput(input, images) : input
    const args = [
      ...run.launch.args,
      ...nativeSessionArgs,
      ...(promptArgument ? ['--append-system-prompt', promptArgument] : []),
      '-p',
      '--input-format',
      inputFormat,
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
    ]
    const child = spawnCodingAgentChild(run.launch.command, args, {
      cwd: existsSync(run.launch.workspaceDir) ? run.launch.workspaceDir : homedir(),
      env: run.launch.mode === 'global'
        ? { ...process.env, ...(run.launch.env || {}) }
        : isolatedCodingAgentChildEnv(run.launch.env),
      pipeStdin: true,
    })
    run.currentChild = child

    let stdoutBuffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      this.touch(run)
      stdoutBuffer += chunk.toString('utf8')
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() || ''
      for (const line of lines) this.handleClaudePrintLine(run, line)
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      this.touch(run)
      const text = appendChildStderr(run, chunk)
      if (text) logger.debug({ runId: run.id, sessionId: run.launch.sessionId, text }, '[coding-agent-run] claude print stderr')
    })

    if (child.stdin) {
      child.stdin.on('error', (err) => {
        logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[coding-agent-run] claude stdin input failed')
      })
      child.stdin.end(`${stdinInput}\n`)
    }

    child.on('error', (err) => {
      if (run.currentChildKillTimer) clearTimeout(run.currentChildKillTimer)
      run.currentChildKillTimer = undefined
      run.currentChild = undefined
      logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[coding-agent-run] claude print failed to start')
      this.handleClaudePrintResponseEvent(run, {
        type: 'response.failed',
        data: {
          type: 'response.failed',
          response: {
            id: run.printResponseId,
            object: 'response',
            status: 'failed',
            model: run.launch.model,
            error: { message: childProcessErrorMessage(err) },
            output: [],
          },
        },
      })
    })

    // `exit` can fire before stdout has closed, allowing a zero exit to win
    // over a final structured `isApiErrorMessage` record still in the pipe.
    // `close` fires only after the stdio streams are closed and drained.
    child.on('close', (code) => {
      if (stdoutBuffer.trim()) this.handleClaudePrintLine(run, stdoutBuffer)
      if (run.currentChildKillTimer) clearTimeout(run.currentChildKillTimer)
      run.currentChildKillTimer = undefined
      run.currentChild = undefined
      logger.info({ runId: run.id, sessionId: run.launch.sessionId, code }, '[coding-agent-run] claude print exited')
      if (run.stoppedByUser) return
      if (run.pendingChatCompletionEvent) {
        void this.emitAndMarkPrintChatRunCompletedAfterUsage(run, run.pendingChatCompletionEvent, run.pendingChatCompletionPayload)
        return
      }
      if (code === 0) {
        this.completeClaudePrintTurn(run)
        return
      }
      this.handleClaudePrintResponseEvent(run, {
        type: 'response.failed',
        data: {
          type: 'response.failed',
          response: {
            id: run.printResponseId,
            object: 'response',
            status: 'failed',
            model: run.launch.model,
            error: { message: exitErrorMessage('Claude Code', code, run.currentChildStderr) },
            output: [],
          },
        },
      })
    })
  }

  private handleClaudePrintResponseEvent(run: ManagedCodingAgentRun, event: CanonicalResponsesEvent) {
    run.acceptingPrintEvent = true
    try {
      this.handleResponseEvent(run.id, event)
    } finally {
      run.acceptingPrintEvent = false
    }
  }

  private handleClaudePrintLine(run: ManagedCodingAgentRun, line: string) {
    const trimmed = line.trim()
    if (!trimmed) return
    let event: any
    try {
      event = JSON.parse(trimmed)
    } catch {
      logger.debug({ runId: run.id, line: sanitizeCodingAgentTerminalOutput(trimmed) }, '[coding-agent-run] ignored non-json Claude print line')
      return
    }

    if (typeof event.session_id === 'string' && event.session_id.trim()) {
      this.recordClaudeNativeSessionId(run, event.session_id.trim())
    }

    if (run.printCompleted) return
    if (run.launch.mode === 'global') run.nativeUsage?.observeClaude(event)

    if (event.type === 'stream_event' && event.event) {
      this.handleClaudeAnthropicStreamEvent(run, event.event)
      return
    }

    if (event.type === 'assistant' && event.isApiErrorMessage === true) {
      const errorText = claudeContentToText(event.message?.content).trim() || responseErrorMessage(event.error) || 'Claude Code API error'
      this.failClaudePrintTurn(run, errorText)
      return
    }

    if ((event.type === 'assistant' || event.type === 'user') && event.message) {
      this.handleClaudeTopLevelMessage(run, event.message)
      return
    }

    if (event.type === 'system' && event.subtype === 'compact_boundary') {
      const metadata = event.compact_metadata || event.compactMetadata || {}
      const preTokens = compactTokenNumber(metadata.pre_tokens)
      const postTokens = compactTokenNumber(metadata.post_tokens)
      const trigger = String(metadata.trigger || 'manual')
      const summary = [
        `Compaction completed (${trigger}).`,
        preTokens != null ? `Before: ${preTokens} tokens.` : '',
        postTokens != null ? `After: ${postTokens} tokens.` : '',
      ].filter(Boolean).join(' ')
      if (summary) {
        this.ensureClaudePrintText(run)
        run.printText = `${run.printText || ''}${summary}`
        this.handleClaudePrintResponseEvent(run, {
          type: 'response.output_text.delta',
          data: {
            type: 'response.output_text.delta',
            item_id: run.printMessageId,
            output_index: 0,
            content_index: 0,
            delta: summary,
          },
        })
      }
      return
    }

    if (event.type === 'result') {
      if (run.printCompleted) return
      const resultText = String(event.result || '')
      if (resultText && !run.printTextStarted) {
        this.ensureClaudePrintText(run)
        run.printText = `${run.printText || ''}${resultText}`
        this.handleClaudePrintResponseEvent(run, {
          type: 'response.output_text.delta',
          data: {
            type: 'response.output_text.delta',
            item_id: run.printMessageId,
            output_index: 0,
            content_index: 0,
            delta: resultText,
          },
        })
      }
      this.completeClaudePrintTurn(run, event.usage)
    }
  }

  private recordClaudeNativeSessionId(run: ManagedCodingAgentRun, nativeSessionId: string) {
    if (!nativeSessionId) return
    if (run.launch.agentNativeSessionId === nativeSessionId && run.nativeResumeReady) return
    run.launch.agentNativeSessionId = nativeSessionId
    run.nativeResumeReady = true
    try {
      updateSession(run.launch.sessionId, { agent_native_session_id: nativeSessionId })
    } catch (err) {
      logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[coding-agent-run] failed to persist Claude native session id')
    }
  }

  private handleClaudeTopLevelMessage(run: ManagedCodingAgentRun, message: any) {
    const role = String(message?.role || '')
    const content = Array.isArray(message?.content) ? message.content : []
    if (!content.length) return

    if (role === 'assistant') {
      for (const [index, block] of content.entries()) {
        if (block?.type !== 'tool_use') continue
        const toolBlock = {
          id: String(block.id || `toolu_${index}`),
          name: String(block.name || 'tool'),
          arguments: JSON.stringify(block.input || {}),
          done: false,
        }
        run.printToolBlocks?.set(index, toolBlock)
        this.handleClaudePrintResponseEvent(run, {
          type: 'response.output_item.added',
          data: {
            type: 'response.output_item.added',
            output_index: index,
            item: {
              type: 'function_call',
              id: toolBlock.id,
              call_id: toolBlock.id,
              name: toolBlock.name,
              arguments: toolBlock.arguments,
            },
          },
        })
        this.handleClaudePrintResponseEvent(run, {
          type: 'response.output_item.done',
          data: {
            type: 'response.output_item.done',
            output_index: index,
            item: {
              type: 'function_call',
              id: toolBlock.id,
              call_id: toolBlock.id,
              name: toolBlock.name,
              arguments: toolBlock.arguments,
            },
          },
        })
      }
      return
    }
    if (role === 'user') {
      for (const [index, block] of content.entries()) {
        if (block?.type !== 'tool_result') continue
        const callId = String(block.tool_use_id || block.id || `toolu_${index}`)
        const output = claudeContentToText(block.content)
        this.handleClaudePrintResponseEvent(run, {
          type: 'response.output_item.done',
          data: {
            type: 'response.output_item.done',
            output_index: index,
            item: {
              type: 'function_call_output',
              id: callId,
              call_id: callId,
              output,
            },
          },
        })
      }
    }
  }

  private handleClaudeAnthropicStreamEvent(run: ManagedCodingAgentRun, event: any) {
    const type = String(event?.type || '')
    if (type === 'message_start') {
      const id = String(event?.message?.id || run.printResponseId || `resp_${Date.now()}`)
      run.printResponseId = id
      run.printMessageId = `msg_${id}`
      return
    }

    if (type === 'content_block_start') {
      const index = Number(event.index || 0)
      const block = event.content_block || {}
      if (block.type === 'text') {
        this.ensureClaudePrintText(run)
        return
      }
      if (block.type === 'tool_use') {
        const toolBlock = {
          id: String(block.id || `toolu_${index}`),
          name: String(block.name || 'tool'),
          arguments: block.input ? JSON.stringify(block.input) : '',
          done: false,
        }
        run.printToolBlocks?.set(index, toolBlock)
        this.handleClaudePrintResponseEvent(run, {
          type: 'response.output_item.added',
          data: {
            type: 'response.output_item.added',
            output_index: index,
            item: {
              type: 'function_call',
              id: toolBlock.id,
              call_id: toolBlock.id,
              name: toolBlock.name,
              arguments: toolBlock.arguments,
            },
          },
        })
      }
      return
    }

    if (type === 'content_block_delta') {
      const index = Number(event.index || 0)
      const delta = event.delta || {}
      if (delta.type === 'thinking_delta' && delta.thinking) {
        this.handleClaudePrintResponseEvent(run, {
          type: 'response.reasoning.delta',
          data: {
            type: 'response.reasoning.delta',
            item_id: run.printMessageId,
            output_index: index,
            delta: String(delta.thinking),
          },
        })
        return
      }
      if (delta.type === 'text_delta' && delta.text) {
        this.ensureClaudePrintText(run)
        const text = String(delta.text)
        run.printText = `${run.printText || ''}${text}`
        this.handleClaudePrintResponseEvent(run, {
          type: 'response.output_text.delta',
          data: {
            type: 'response.output_text.delta',
            item_id: run.printMessageId,
            output_index: 0,
            content_index: 0,
            delta: text,
          },
        })
        return
      }
      if (delta.type === 'input_json_delta' && delta.partial_json) {
        let toolBlock = run.printToolBlocks?.get(index)
        if (!toolBlock) {
          toolBlock = { id: `toolu_${index}`, name: 'tool', arguments: '', done: false }
          run.printToolBlocks?.set(index, toolBlock)
        }
        const argsDelta = String(delta.partial_json)
        toolBlock.arguments += argsDelta
        this.handleClaudePrintResponseEvent(run, {
          type: 'response.function_call_arguments.delta',
          data: {
            type: 'response.function_call_arguments.delta',
            item_id: toolBlock.id,
            output_index: index,
            delta: argsDelta,
          },
        })
      }
      return
    }

    if (type === 'content_block_stop') {
      const index = Number(event.index || 0)
      const toolBlock = run.printToolBlocks?.get(index)
      if (!toolBlock || toolBlock.done) return
      toolBlock.done = true
      this.handleClaudePrintResponseEvent(run, {
        type: 'response.output_item.done',
        data: {
          type: 'response.output_item.done',
          output_index: index,
          item: {
            type: 'function_call',
            id: toolBlock.id,
            call_id: toolBlock.id,
            name: toolBlock.name,
            arguments: toolBlock.arguments || '{}',
          },
        },
      })
    }
  }

  private ensureClaudePrintText(run: ManagedCodingAgentRun) {
    if (run.printTextStarted) return
    run.printTextStarted = true
    const item = { type: 'message', id: run.printMessageId, status: 'in_progress', role: 'assistant', content: [] }
    this.handleClaudePrintResponseEvent(run, {
      type: 'response.output_item.added',
      data: { type: 'response.output_item.added', output_index: 0, item },
    })
    this.handleClaudePrintResponseEvent(run, {
      type: 'response.content_part.added',
      data: {
        type: 'response.content_part.added',
        item_id: run.printMessageId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
    })
  }

  private failClaudePrintTurn(run: ManagedCodingAgentRun, errorText: string) {
    if (run.printCompleted) return
    run.printCompleted = true
    const existingText = run.printText || ''
    const appendedError = appendedTextDelta(existingText, errorText)
    const delta = !existingText
      ? errorText
      : existingText === errorText
        ? ''
        : appendedError || `\n\n${errorText}`
    if (delta) {
      this.ensureClaudePrintText(run)
      run.printText = `${existingText}${delta}`
      this.handleClaudePrintResponseEvent(run, {
        type: 'response.output_text.delta',
        data: {
          type: 'response.output_text.delta',
          item_id: run.printMessageId,
          output_index: 0,
          content_index: 0,
          delta,
        },
      })
    }
    const assistantMessage = [...run.state.messages]
      .reverse()
      .find(message => message.runMarker === run.runMarker && message.role === 'assistant' && !message.tool_calls?.length)
    if (assistantMessage) assistantMessage.finish_reason = 'error'
    this.handleClaudePrintResponseEvent(run, {
      type: 'response.failed',
      data: {
        type: 'response.failed',
        response: {
          id: run.printResponseId,
          object: 'response',
          status: 'failed',
          model: run.launch.model,
          error: { message: errorText },
          output: [],
        },
      },
    })
  }

  private completeClaudePrintTurn(run: ManagedCodingAgentRun, usage?: any) {
    if (run.printCompleted) return
    run.printCompleted = true
    const text = run.printText || ''
    const output = run.printTextStarted
      ? [{
          type: 'message',
          id: run.printMessageId,
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [] }],
        }]
      : []
    if (run.printTextStarted) {
      this.handleClaudePrintResponseEvent(run, {
        type: 'response.output_text.done',
        data: {
          type: 'response.output_text.done',
          item_id: run.printMessageId,
          output_index: 0,
          content_index: 0,
          text,
        },
      })
      this.handleClaudePrintResponseEvent(run, {
        type: 'response.output_item.done',
        data: {
          type: 'response.output_item.done',
          output_index: 0,
          item: output[0],
        },
      })
    }
    this.handleClaudePrintResponseEvent(run, {
      type: 'response.completed',
      data: {
        type: 'response.completed',
        response: {
          id: run.printResponseId,
          object: 'response',
          status: 'completed',
          model: run.nativeUsage?.model || run.launch.model,
          output,
          usage,
        },
      },
    })
  }

  private startDshTurn(run: ManagedCodingAgentRun, input: string, systemPrompt: string, images: CodingAgentImageInput[]) {
    startDshChatTurn(run, input, systemPrompt, images, {
      spawn: spawnCodingAgentChild, isRunning: childIsRunning,
      terminate: terminateChildProcess, forceKill: forceKillChildProcess,
      processError: childProcessErrorMessage, exitError: (code, stderr) => exitErrorMessage('DSH', code, stderr),
      stderr: chunk => { appendChildStderr(run, chunk) }, touch: () => this.touch(run),
      response: event => this.handleClaudePrintResponseEvent(run, event),
      text: (text, live) => this.appendCodexText(run, text, live), reasoning: text => this.appendCodexReasoning(run, text),
      toolStarted: item => this.handleCodexItemStarted(run, item), toolCompleted: item => this.handleCodexItemCompleted(run, item),
      emit: (event, payload) => this.emitToChat(run.launch.sessionId, event, payload),
      completeAfterUsage: (event, payload) => this.emitAndMarkPrintChatRunCompletedAfterUsage(run, event, payload),
      complete: () => this.completeClaudePrintTurn(run), fail: message => this.failClaudePrintTurn(run, message),
    })
  }

  private startGrokPrintTurn(
    run: ManagedCodingAgentRun,
    input: string,
    systemPrompt = '',
    images: CodingAgentImageInput[] = [],
  ) {
    if (childIsRunning(run.currentChild)) throw new Error('Grok is still processing the previous input')

    const responseId = `resp_${Date.now()}`
    run.printResponseId = responseId
    run.printMessageId = `msg_${responseId}`
    run.printTextStarted = false
    run.printText = ''
    run.printCompleted = false
    run.responseStartEmitted = false
    run.terminalEventHandled = false
    run.codexToolBlocks = new Map()
    run.codexPendingUsage = undefined
    run.codexPendingError = undefined
    run.currentChildStderr = ''
    run.runMarker = undefined
    run.memoryExportStarted = false

    this.handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: {
        type: 'response.created',
        response: { id: responseId, object: 'response', status: 'in_progress', model: run.launch.model, output: [] },
      },
    })
    if (run.launch.promptFile) updateManagedPromptFileSync(run.launch.promptFile, systemPrompt)

    const rootDir = String(run.launch.env?.GROK_HOME || '').trim()
    if (!rootDir) throw new Error('Grok runtime home is missing')
    const workspaceDir = existsSync(run.launch.workspaceDir) ? run.launch.workspaceDir : homedir()
    const nativeSessionId = String(run.launch.agentNativeSessionId || '')
    if (!run.nativeResumeReady && grokSessionExists(rootDir, workspaceDir, nativeSessionId)) {
      run.nativeResumeReady = true
    }
    const child = startGrokTurnProcess({
      command: run.launch.command,
      baseArgs: run.launch.args,
      rootDir,
      workspaceDir,
      env: run.launch.mode === 'global'
        ? { ...process.env, ...(run.launch.env || {}) }
        : isolatedCodingAgentChildEnv(run.launch.env),
      nativeSessionId,
      resume: run.nativeResumeReady === true,
      input,
      images,
      onEvent: (event) => {
        this.touch(run)
        if (run.launch.mode === 'global') run.nativeUsage?.observeGrok(event)
        applyGrokStreamEvent(event, {
          text: value => this.appendCodexText(run, value),
          thought: value => this.appendCodexReasoning(run, value),
          toolStarted: value => this.handleCodexItemStarted(run, {
            type: 'mcp_tool_call',
            id: value.id,
            tool: value.name,
            arguments: value.input,
          }),
          toolCompleted: value => this.handleCodexItemCompleted(run, {
            type: 'mcp_tool_call',
            id: value.id,
            output: value.output,
            ...(value.failed ? { error: { message: this.codexToolOutput({ output: value.output }) } } : {}),
          }),
          usage: value => { run.codexPendingUsage = value },
          session: sessionId => this.recordGrokNativeSessionId(run, sessionId),
          complete: usage => {
            if (!run.printCompleted) this.completeClaudePrintTurn(run, usage || run.codexPendingUsage)
          },
          error: (message, usage) => {
            run.codexPendingUsage = usage || run.codexPendingUsage
            this.failCodexExecTurn(run, message, run.codexPendingUsage)
          },
          status: message => this.emitTerminalStatus(run, message),
        })
      },
      onStderr: (chunk) => {
        this.touch(run)
        const text = appendChildStderr(run, chunk)
        if (text) logger.debug({ runId: run.id, sessionId: run.launch.sessionId, text }, '[coding-agent-run] grok stderr')
      },
      onError: (err) => {
        run.currentChild = undefined
        logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[coding-agent-run] grok failed to start')
        if (!run.printCompleted) this.failCodexExecTurn(run, childProcessErrorMessage(err))
      },
      onClose: (code) => {
        run.currentChild = undefined
        logger.info({ runId: run.id, sessionId: run.launch.sessionId, code }, '[coding-agent-run] grok exited')
        if (run.stoppedByUser) return
        if (run.pendingChatCompletionEvent) {
          void this.emitAndMarkPrintChatRunCompletedAfterUsage(run, run.pendingChatCompletionEvent, run.pendingChatCompletionPayload)
          return
        }
        if (run.printCompleted) return
        if (code === 0) this.completeClaudePrintTurn(run, run.codexPendingUsage)
        else this.failCodexExecTurn(run, run.codexPendingError || exitErrorMessage('Grok', code, run.currentChildStderr), run.codexPendingUsage)
      },
    })
    run.currentChild = child
  }

  private recordGrokNativeSessionId(run: ManagedCodingAgentRun, nativeSessionId: string) {
    if (!nativeSessionId) return
    run.launch.agentNativeSessionId = nativeSessionId
    run.nativeResumeReady = true
    try {
      updateSession(run.launch.sessionId, { agent_native_session_id: nativeSessionId })
    } catch (err) {
      logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[coding-agent-run] failed to persist Grok native session id')
    }
  }

  private startOpenCodeTurn(
    run: ManagedCodingAgentRun,
    input: string,
    systemPrompt = '',
    images: CodingAgentImageInput[] = [],
  ) {
    if (childIsRunning(run.currentChild)) {
      throw new Error('OpenCode is still processing the previous input')
    }

    const responseId = `resp_${Date.now()}`
    run.printResponseId = responseId
    run.printMessageId = `msg_${responseId}`
    run.printTextStarted = false
    run.printText = ''
    run.printCompleted = false
    run.responseStartEmitted = false
    run.terminalEventHandled = false
    run.currentChildStderr = ''
    run.runMarker = undefined
    run.memoryExportStarted = false

    this.handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: {
        type: 'response.created',
        response: { id: responseId, object: 'response', status: 'in_progress', model: run.launch.model, output: [] },
      },
    })

    if (run.launch.promptFile) updateManagedPromptFileSync(run.launch.promptFile, systemPrompt)
    const args = [
      'run',
      '--format', 'json',
      '--agent', 'build',
      '--auto',
      '--thinking',
      ...run.launch.args,
      ...(run.launch.agentNativeSessionId && run.nativeResumeReady
        ? ['--session', run.launch.agentNativeSessionId]
        : []),
      ...images.flatMap(image => ['--file', image.path]),
      // --file consumes an array; terminate options before the message.
      '--',
      input,
    ]
    const child = spawnCodingAgentChild(run.launch.command, args, {
      cwd: existsSync(run.launch.workspaceDir) ? run.launch.workspaceDir : homedir(),
      env: run.launch.mode === 'global'
        ? { ...process.env, ...(run.launch.env || {}) }
        : isolatedCodingAgentChildEnv(run.launch.env),
    })
    run.currentChild = child

    let stdoutBuffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      this.touch(run)
      stdoutBuffer += chunk.toString('utf8')
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() || ''
      for (const line of lines) this.handleOpenCodeLine(run, line)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.touch(run)
      const text = appendChildStderr(run, chunk)
      if (text) logger.debug({ runId: run.id, sessionId: run.launch.sessionId, text }, '[coding-agent-run] opencode stderr')
    })
    child.on('error', (err) => {
      run.currentChild = undefined
      logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[coding-agent-run] opencode failed to start')
      if (!run.printCompleted) this.failClaudePrintTurn(run, childProcessErrorMessage(err))
    })
    child.on('close', (code) => {
      if (stdoutBuffer.trim()) this.handleOpenCodeLine(run, stdoutBuffer)
      run.currentChild = undefined
      logger.info({ runId: run.id, sessionId: run.launch.sessionId, code }, '[coding-agent-run] opencode exited')
      if (run.stoppedByUser) return
      if (run.pendingChatCompletionEvent) {
        void this.emitAndMarkPrintChatRunCompletedAfterUsage(run, run.pendingChatCompletionEvent, run.pendingChatCompletionPayload)
        return
      }
      if (run.printCompleted) return
      if (code === 0) this.completeClaudePrintTurn(run)
      else this.failClaudePrintTurn(run, exitErrorMessage('OpenCode', code, run.currentChildStderr))
    })
  }

  private handleOpenCodeLine(run: ManagedCodingAgentRun, line: string) {
    const trimmed = line.trim()
    if (!trimmed || run.printCompleted) return
    let event: any
    try {
      event = JSON.parse(trimmed)
    } catch {
      logger.debug({ runId: run.id, line: sanitizeCodingAgentTerminalOutput(trimmed) }, '[coding-agent-run] ignored non-json OpenCode line')
      return
    }
    const nativeSessionId = String(event.sessionID || event.session_id || '').trim()
    if (nativeSessionId) this.recordOpenCodeNativeSessionId(run, nativeSessionId)
    if (event.type === 'error') {
      this.failClaudePrintTurn(run, responseErrorMessage(event.error) || 'OpenCode run failed')
      return
    }
    const part = event.part
    if (!part || typeof part !== 'object') return
    if (event.type === 'step_finish' && part.type === 'step-finish') {
      // Scoped runs already record each provider call through the proxy.
      // Native global runs report usage only in their completed step parts.
      if (run.launch.mode === 'global' && part.id && part.tokens) {
        const tokens = part.tokens
        const usage = normalizeTokenUsage({
          inputTokens: tokens.input,
          // OpenCode separates reasoning from output; Studio includes it.
          outputTokens: typeof tokens.output === 'number'
            ? tokens.output + (Number(tokens.reasoning) || 0)
            : undefined,
          cacheReadTokens: tokens.cache?.read,
          cacheWriteTokens: tokens.cache?.write,
          reasoningTokens: tokens.reasoning,
        })
        if (!usage.isEstimated) {
          const nativeModel = readOpenCodeMessageModel(run.launch.env?.OPENCODE_DB, nativeSessionId || run.launch.agentNativeSessionId || '', String(part.messageID || ''))
          if (nativeModel && run.nativeUsage) Object.assign(run.nativeUsage, nativeModel)
          recordSessionUsage({
            sessionId: run.launch.sessionId,
            runId: String(part.id),
            source: 'coding_agent',
            agent: 'opencode',
            usageScope: 'model_call',
            apiCalls: 1,
            usage,
            profile: run.launch.profile,
            model: nativeModel?.model || run.launch.model,
            provider: nativeModel?.provider || run.launch.provider,
            isEstimated: false,
          })
        }
      }
      return
    }
    if (event.type === 'text' && part.type === 'text') {
      const text = String(part.text || '')
      if (!text) return
      this.ensureClaudePrintText(run)
      const delta = appendedTextDelta(run.printText || '', text)
      if (!delta) return
      run.printText = `${run.printText || ''}${delta}`
      this.handleClaudePrintResponseEvent(run, {
        type: 'response.output_text.delta',
        data: {
          type: 'response.output_text.delta',
          item_id: run.printMessageId,
          output_index: 0,
          content_index: 0,
          delta,
        },
      })
      return
    }
    if (event.type === 'reasoning' && part.type === 'reasoning' && part.text) {
      this.handleClaudePrintResponseEvent(run, {
        type: 'response.reasoning.delta',
        data: {
          type: 'response.reasoning.delta',
          item_id: run.printMessageId,
          output_index: 0,
          delta: String(part.text),
        },
      })
      return
    }
    if (event.type !== 'tool_use' || part.type !== 'tool') return
    const state = part.state || {}
    const callId = String(part.callID || part.callId || part.id || `opencode_tool_${Date.now()}`)
    const name = String(part.tool || 'tool')
    const argumentsJson = JSON.stringify(state.input || {})
    this.handleClaudePrintResponseEvent(run, {
      type: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'function_call', id: callId, call_id: callId, name, arguments: argumentsJson },
      },
    })
    this.handleClaudePrintResponseEvent(run, {
      type: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'function_call_output',
          id: callId,
          call_id: callId,
          output: truncateCodingAgentToolOutputForStorage(state.output || state.error || ''),
          ...(state.status === 'error' ? { status: 'failed' } : {}),
        },
      },
    })
  }

  private recordOpenCodeNativeSessionId(run: ManagedCodingAgentRun, nativeSessionId: string) {
    if (!nativeSessionId) return
    run.launch.agentNativeSessionId = nativeSessionId
    run.nativeResumeReady = true
    try {
      updateSession(run.launch.sessionId, { agent_native_session_id: nativeSessionId })
    } catch (err) {
      logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[coding-agent-run] failed to persist OpenCode session id')
    }
  }

  private startCodexExecTurn(
    run: ManagedCodingAgentRun,
    input: string,
    systemPrompt = '',
    images: CodingAgentImageInput[] = [],
  ) {
    if (childIsRunning(run.currentChild)) {
      throw new Error('Codex is still processing the previous input')
    }

    const responseId = `resp_${Date.now()}`
    run.printResponseId = responseId
    run.printMessageId = `msg_${responseId}`
    run.printTextStarted = false
    run.printText = ''
    run.codexPendingError = undefined
    run.codexTurnFailed = false
    run.printCompleted = false
    run.responseStartEmitted = false
    run.terminalEventHandled = false
    run.codexToolBlocks = new Map()
    run.codexChatText = ''
    run.codexPendingUsage = undefined
    run.currentChildStderr = ''
    run.runMarker = undefined
    run.memoryExportStarted = false

    this.handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: {
        type: 'response.created',
        response: { id: responseId, object: 'response', status: 'in_progress', model: run.launch.model, output: [] },
      },
    })

    if (run.launch.promptFile) updateManagedPromptFileSync(run.launch.promptFile, systemPrompt)
    const promptArgument = run.launch.mode === 'scoped' || run.launch.promptFile
      ? ''
      : normalizeCliPromptArgument(systemPrompt)
    const commonArgs = [
      '--json',
      ...CODEX_REASONING_SUMMARY_ARGS,
      ...(promptArgument ? ['-c', `developer_instructions=${JSON.stringify(promptArgument)}`] : []),
      ...run.launch.args,
      ...codexImageArgs(images),
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
    ]
    const args = run.launch.agentNativeSessionId && run.nativeResumeReady
      ? ['exec', 'resume', ...commonArgs, run.launch.agentNativeSessionId, '-']
      : ['exec', ...commonArgs, '--cd', run.launch.workspaceDir, '-']

    const child = spawnCodingAgentChild(run.launch.command, args, {
      cwd: existsSync(run.launch.workspaceDir) ? run.launch.workspaceDir : homedir(),
      env: run.launch.mode === 'global'
        ? { ...process.env, ...(run.launch.env || {}) }
        : isolatedCodingAgentChildEnv(run.launch.env),
      pipeStdin: true,
    })
    run.currentChild = child

    let stdoutBuffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      this.touch(run)
      stdoutBuffer += chunk.toString('utf8')
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() || ''
      for (const line of lines) this.handleCodexExecLine(run, line)
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      this.touch(run)
      const text = appendChildStderr(run, chunk)
      if (text) logger.debug({ runId: run.id, sessionId: run.launch.sessionId, text }, '[coding-agent-run] codex exec stderr')
    })

    if (child.stdin) {
      child.stdin.on('error', (err) => {
        logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[coding-agent-run] codex stdin input failed')
      })
      child.stdin.end(`${input}\n`)
    }

    child.on('error', (err) => {
      if (run.currentChildKillTimer) clearTimeout(run.currentChildKillTimer)
      run.currentChildKillTimer = undefined
      run.currentChild = undefined
      logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[coding-agent-run] codex exec failed to start')
      this.handleClaudePrintResponseEvent(run, {
        type: 'response.failed',
        data: {
          type: 'response.failed',
          response: {
            id: run.printResponseId,
            object: 'response',
            status: 'failed',
            model: run.launch.model,
            error: { message: childProcessErrorMessage(err) },
            output: [],
          },
        },
      })
    })

    // Native stdout owns global usage. Drain it before final accounting and
    // model lookup; `exit` can precede the last JSONL bytes.
    child.on(run.launch.mode === 'global' ? 'close' : 'exit', (code: number | null) => {
      if (stdoutBuffer.trim()) this.handleCodexExecLine(run, stdoutBuffer)
      if (run.currentChildKillTimer) clearTimeout(run.currentChildKillTimer)
      run.currentChildKillTimer = undefined
      run.currentChild = undefined
      logger.info({ runId: run.id, sessionId: run.launch.sessionId, code }, '[coding-agent-run] codex exec exited')
      const nativeSessionId = run.launch.agentNativeSessionId
      if (run.launch.mode === 'global' && nativeSessionId && run.nativeTurnStartedAt) {
        const home = run.launch.env?.CODEX_HOME || process.env.CODEX_HOME || join(getCodingAgentGlobalHome(), '.codex')
        run.nativeCompletionPending = true
        void readCodexTurnModel(home, nativeSessionId, run.nativeTurnStartedAt).then(metadata => {
          run.nativeCompletionPending = false
          if (run.exited || run.stoppedByUser) return
          if (metadata && run.nativeUsage) Object.assign(run.nativeUsage, metadata)
          this.finishCodexExecTurn(run, code)
        }).catch(err => {
          run.nativeCompletionPending = false
          logger.warn({ err, runId: run.id }, '[coding-agent-run] failed to read native model metadata')
          if (!run.exited && !run.stoppedByUser) this.finishCodexExecTurn(run, code)
        })
      } else this.finishCodexExecTurn(run, code)
    })
  }

  private finishCodexExecTurn(run: ManagedCodingAgentRun, code: number | null) {
    if (run.stoppedByUser) return
    if (run.pendingChatCompletionEvent) {
      void this.emitAndMarkPrintChatRunCompletedAfterUsage(run, run.pendingChatCompletionEvent, run.pendingChatCompletionPayload)
      return
    }
    if (code === 0 && !run.codexTurnFailed) {
      this.completeCodexExecTurn(run, run.codexPendingUsage)
      return
    }
    this.handleClaudePrintResponseEvent(run, {
      type: 'response.failed',
      data: {
        type: 'response.failed',
        response: {
          id: run.printResponseId,
          object: 'response',
          status: 'failed',
          model: run.launch.model,
          error: { message: run.codexPendingError || exitErrorMessage('Codex', code, run.currentChildStderr) },
          output: [],
          usage: run.codexPendingUsage,
        },
      },
    })
  }

  private handleCodexExecLine(run: ManagedCodingAgentRun, line: string) {
    const trimmed = line.trim()
    if (!trimmed) return
    let event: any
    try {
      event = JSON.parse(trimmed)
    } catch {
      logger.debug({ runId: run.id, line: sanitizeCodingAgentTerminalOutput(trimmed) }, '[coding-agent-run] ignored non-json Codex exec line')
      return
    }

    this.recordCodexNativeSessionId(run, this.codexNativeSessionIdFrom(event))

    const method = String(event.method || '').trim()
    if (method) {
      this.handleCodexProtocolEvent(run, method, event.params || {})
      return
    }

    const msg = event.msg || event.message
    if (msg && (typeof msg.content === 'string' || typeof msg.text === 'string')) {
      this.appendCodexFinalText(run, String(msg.content || msg.text || ''))
      return
    }

    const type = String(event.type || '').trim()
    if (type === 'thread.started') {
      this.recordCodexNativeSessionId(run, String(event.thread_id || event.threadId || '').trim())
      return
    }
    if (type === 'item.started') {
      this.handleCodexItemStarted(run, event.item || event)
      return
    }
    if (type === 'item.completed') {
      this.handleCodexItemCompleted(run, event.item || event)
      return
    }
    if (type === 'response_item') {
      this.handleCodexResponseItem(run, event.payload || event.item || event)
      return
    }
    if (type === 'turn.completed') {
      run.codexPendingUsage = event.usage
      return
    }
    if (type === 'turn.failed') {
      run.codexTurnFailed = true
      run.codexPendingUsage = event.usage ?? run.codexPendingUsage
      const message = event.error?.message || event.message || 'Codex run failed'
      if (run.launch.mode === 'global') this.deferCodexExecError(run, message)
      else this.failCodexExecTurn(run, message, run.codexPendingUsage)
      return
    }
    if (type === 'error') {
      this.deferCodexExecError(run, event.error?.message || event.message || 'Codex run failed')
    }
  }

  private handleCodexProtocolEvent(run: ManagedCodingAgentRun, method: string, params: any) {
    this.recordCodexNativeSessionId(run, this.codexNativeSessionIdFrom(params))
    if (method === 'thread/started') {
      this.recordCodexNativeSessionId(run, String(params.thread_id || params.threadId || '').trim())
      return
    }
    if (method === 'item/agentMessage/delta' || method === 'item/assistantMessage/delta') {
      this.appendCodexText(run, String(params.delta || params.text || ''))
      return
    }
    if (
      method === 'item/reasoning/delta' ||
      method === 'item/reasoningText/delta' ||
      method === 'item/reasoningSummary/delta' ||
      method === 'item/thinking/delta'
    ) {
      this.appendCodexReasoning(run, this.codexReasoningText(params))
      return
    }
    if (method === 'item/started') {
      this.handleCodexItemStarted(run, params.item || params)
      return
    }
    if (method === 'item/completed') {
      this.handleCodexItemCompleted(run, params.item || params)
      return
    }
    if (method === 'turn/completed') {
      run.codexPendingUsage = params.usage
      return
    }
    if (method === 'turn/failed') {
      run.codexTurnFailed = true
      run.codexPendingUsage = params.usage ?? run.codexPendingUsage
      const message = params.error?.message || params.message || 'Codex run failed'
      if (run.launch.mode === 'global') this.deferCodexExecError(run, message)
      else this.failCodexExecTurn(run, message, run.codexPendingUsage)
      return
    }
    if (method === 'error') {
      this.deferCodexExecError(run, params.error?.message || params.message || 'Codex run failed')
    }
  }

  private deferCodexExecError(run: ManagedCodingAgentRun, message: string) {
    // Codex emits broad `error` events for recoverable stream retries as well as
    // failures. Let the native process exit status arbitrate the turn: exit 0
    // discards this provisional error, while a non-zero exit reports it.
    if (childIsRunning(run.currentChild) || (run.launch.mode === 'global' && run.currentChild)) {
      run.codexPendingError = message
      return
    }
    this.failCodexExecTurn(run, message, run.codexPendingUsage)
  }

  private failCodexExecTurn(run: ManagedCodingAgentRun, message: string, usage?: unknown) {
    this.handleClaudePrintResponseEvent(run, {
      type: 'response.failed',
      data: {
        type: 'response.failed',
        response: {
          id: run.printResponseId,
          object: 'response',
          status: 'failed',
          model: run.launch.model,
          error: { message },
          output: [],
          usage,
        },
      },
    })
  }

  private handleCodexItemStarted(run: ManagedCodingAgentRun, item: any) {
    const itemType = this.codexItemType(item)
    if (!this.isCodexToolItem(itemType)) return
    if (this.isRedundantCodexExecToolItem(item, itemType)) return
    const toolBlock = this.codexToolBlock(item, itemType)
    run.codexToolBlocks?.set(toolBlock.id, toolBlock)
    this.handleClaudePrintResponseEvent(run, {
      type: 'response.output_item.added',
      data: {
        type: 'response.output_item.added',
        output_index: run.codexToolBlocks?.size || 0,
        item: {
          type: 'function_call',
          id: toolBlock.id,
          call_id: toolBlock.id,
          name: toolBlock.name,
          arguments: toolBlock.arguments,
        },
      },
    })
  }

  private handleCodexItemCompleted(run: ManagedCodingAgentRun, item: any) {
    const itemType = this.codexItemType(item)
    if (this.isCodexReasoningItem(itemType)) {
      this.appendCodexReasoning(run, this.codexReasoningText(item))
      return
    }
    if (
      itemType === 'agent_message' ||
      itemType === 'assistant_message' ||
      itemType === 'agentMessage' ||
      itemType === 'assistantMessage'
    ) {
      this.appendCodexFinalText(run, String(item.text || item.message || item.content || ''))
      return
    }
    if (!this.isCodexToolItem(itemType)) return
    if (this.isRedundantCodexExecToolItem(item, itemType)) return
    let toolBlock = run.codexToolBlocks?.get(String(item.id || item.call_id || item.callId || itemType))
    if (!toolBlock) {
      toolBlock = this.codexToolBlock(item, itemType)
      run.codexToolBlocks?.set(toolBlock.id, toolBlock)
      this.handleClaudePrintResponseEvent(run, {
        type: 'response.output_item.added',
        data: {
          type: 'response.output_item.added',
          output_index: run.codexToolBlocks?.size || 0,
          item: {
            type: 'function_call',
            id: toolBlock.id,
            call_id: toolBlock.id,
            name: toolBlock.name,
            arguments: toolBlock.arguments,
          },
        },
      })
    }
    if (toolBlock.done) return
    toolBlock.done = true
    this.handleClaudePrintResponseEvent(run, {
      type: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        output_index: run.codexToolBlocks?.size || 0,
        item: {
          type: 'function_call',
          id: toolBlock.id,
          call_id: toolBlock.id,
          name: toolBlock.name,
          arguments: toolBlock.arguments,
        },
      },
    })
    this.handleClaudePrintResponseEvent(run, {
      type: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        output_index: run.codexToolBlocks?.size || 0,
        item: {
          type: 'function_call_output',
          id: toolBlock.id,
          call_id: toolBlock.id,
          output: this.codexToolOutput(item),
          ...(item.error ? { status: 'failed' } : {}),
        },
      },
    })
  }

  private handleCodexResponseItem(run: ManagedCodingAgentRun, item: any) {
    const itemType = this.codexItemType(item)
    if (this.isCodexReasoningItem(itemType)) {
      this.appendCodexReasoning(run, this.codexReasoningText(item))
      return
    }
    if (
      itemType === 'agent_message' ||
      itemType === 'assistant_message' ||
      itemType === 'agentMessage' ||
      itemType === 'assistantMessage' ||
      itemType === 'message'
    ) {
      this.appendCodexFinalText(run, String(item.text || item.message || item.content || ''))
    }
  }

  private codexItemType(item: any): string {
    return String(item?.type || item?.item_type || item?.itemType || '').trim()
  }

  private isCodexToolItem(itemType: string): boolean {
    return itemType === 'command_execution' ||
      itemType === 'mcp_tool_call' ||
      itemType === 'web_search' ||
      itemType === 'file_change'
  }

  private isCodexReasoningItem(itemType: string): boolean {
    return itemType === 'reasoning' ||
      itemType === 'reasoning_text' ||
      itemType === 'reasoning_summary' ||
      itemType === 'thinking'
  }

  private codexReasoningText(item: any): string {
    if (typeof item?.delta === 'string') return item.delta
    if (typeof item?.text === 'string') return item.text
    if (typeof item?.summary === 'string') return item.summary
    if (typeof item?.reasoning === 'string') return item.reasoning
    if (Array.isArray(item?.summary)) {
      return item.summary
        .map((part: any) => typeof part?.text === 'string' ? part.text : typeof part === 'string' ? part : '')
        .filter(Boolean)
        .join('')
    }
    return ''
  }

  private isRedundantCodexExecToolItem(item: any, itemType: string): boolean {
    if (itemType !== 'mcp_tool_call') return false
    const name = String(item.tool || item.name || item.function?.name || '').trim()
    return name === 'exec_command' || name === 'functions.exec_command'
  }

  private codexToolBlock(item: any, itemType: string): { id: string; name: string; arguments: string; done: boolean } {
    const id = String(item.id || item.call_id || item.callId || `codex_${itemType}_${Date.now()}`)
    const name = itemType === 'command_execution'
      ? 'Command'
      : itemType === 'mcp_tool_call'
        ? String(item.tool || item.name || 'MCP Tool')
        : itemType === 'web_search'
          ? 'Web Search'
          : 'File Change'
    const args = itemType === 'command_execution'
      ? { command: item.command || item.cmd || '' }
      : itemType === 'mcp_tool_call'
        ? { server: item.server, tool: item.tool || item.name, arguments: item.arguments || item.input }
        : itemType === 'web_search'
          ? { query: item.query || item.text || '' }
          : { path: item.path || item.file || '', action: item.action || item.change || '' }
    return { id, name, arguments: JSON.stringify(args), done: false }
  }

  private codexToolOutput(item: any): string {
    const value = item.aggregated_output ?? item.output ?? item.result ?? item.error?.message ?? ''
    if (typeof value === 'string') return value
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }

  private appendCodexFinalText(run: ManagedCodingAgentRun, text: string) {
    if (!text) return
    const streamedText = run.codexChatText || ''
    const streamedTrimmed = streamedText.trimEnd()
    const finalTrimmed = text.trimEnd()
    if (streamedTrimmed) {
      if (
        finalTrimmed === streamedTrimmed ||
        streamedTrimmed.endsWith(finalTrimmed) ||
        streamedTrimmed.startsWith(finalTrimmed)
      ) return
      if (finalTrimmed.startsWith(streamedTrimmed)) {
        run.printText = streamedText
        this.appendCodexText(run, text)
        return
      }
    }
    const existing = run.printText || ''
    if (!existing) {
      this.appendCodexText(run, text)
      return
    }
    if (text === existing) return
    if (text.startsWith(existing)) {
      this.appendCodexText(run, text.slice(existing.length))
      return
    }
    const existingTrimmed = existing.trimEnd()
    const textTrimmed = text.trimEnd()
    if (textTrimmed === existingTrimmed || existingTrimmed.endsWith(textTrimmed)) return
    if (textTrimmed.startsWith(existingTrimmed)) {
      this.appendCodexText(run, text.slice(existingTrimmed.length))
      return
    }
    if (this.codexLastRunMessageIsToolBoundary(run)) {
      this.appendCodexText(run, text)
    }
  }

  private codexLastRunMessageIsToolBoundary(run: ManagedCodingAgentRun): boolean {
    const marker = run.runMarker
    if (!marker) return false
    for (let index = run.state.messages.length - 1; index >= 0; index--) {
      const message = run.state.messages[index]
      if (message.runMarker !== marker) continue
      return message.role === 'tool' || Boolean(message.tool_calls?.length)
    }
    return false
  }

  private appendCodexText(run: ManagedCodingAgentRun, text: string, exactDelta = false) {
    if (!text) return
    const existing = run.printText || ''
    const delta = !exactDelta && text.length >= 16 ? appendedTextDelta(existing, text) : text
    if (!delta) return
    this.ensureClaudePrintText(run)
    run.printText = `${existing}${delta}`
    this.handleClaudePrintResponseEvent(run, {
      type: 'response.output_text.delta',
      data: {
        type: 'response.output_text.delta',
        item_id: run.printMessageId,
        output_index: 0,
        content_index: 0,
        delta,
      },
    })
  }

  private appendCodexReasoning(run: ManagedCodingAgentRun, text: string) {
    if (!text) return
    this.handleClaudePrintResponseEvent(run, {
      type: 'response.reasoning.delta',
      data: {
        type: 'response.reasoning.delta',
        item_id: run.printMessageId,
        output_index: 0,
        delta: text,
      },
    })
  }

  private completeCodexExecTurn(run: ManagedCodingAgentRun, usage?: any) {
    this.completeClaudePrintTurn(run, usage)
  }

  private async emitAndMarkPrintChatRunCompletedAfterUsage(
    run: ManagedCodingAgentRun,
    event: 'run.completed' | 'run.failed',
    payload?: Record<string, unknown>,
  ) {
    const usageRefresh = run.terminalUsageRefresh
    run.terminalUsageRefresh = undefined
    if (usageRefresh) {
      let settled = false
      const guardedRefresh = usageRefresh
        .then(() => {
          settled = true
        })
        .catch((err) => {
          settled = true
          logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[coding-agent-run] terminal usage refresh failed before completion')
        })
      let timeout: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        guardedRefresh,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, TERMINAL_USAGE_WAIT_MS)
          timeout.unref?.()
        }),
      ])
      if (timeout) clearTimeout(timeout)
      if (!settled) {
        logger.debug({
          runId: run.id,
          sessionId: run.launch.sessionId,
          waitMs: TERMINAL_USAGE_WAIT_MS,
        }, '[coding-agent-run] terminal completion proceeding before usage refresh finishes')
      }
    }
    this.emitAndMarkPrintChatRunCompleted(run, event, payload)
  }

  private emitAndMarkPrintChatRunCompleted(run: ManagedCodingAgentRun, event: 'run.completed' | 'run.failed', payload?: Record<string, unknown>) {
    run.pendingChatCompletionEvent = undefined
    run.pendingChatCompletionPayload = undefined
    const queueRemaining = run.state.queue.length
    const workspaceRunChange = this.completeWorkspaceRunDiff(run)
    this.emitToChat(run.launch.sessionId, event, {
      ...(payload || { event }),
      run_id: typeof payload?.run_id === 'string' && payload.run_id ? payload.run_id : run.id,
      ...(run.assistantMessageId ? { message_id: run.assistantMessageId } : {}),
      ...(queueRemaining > 0 ? { queue_remaining: queueRemaining } : {}),
      workspace_run_change: workspaceRunChange,
    })
    if (queueRemaining === 0) {
      try {
        updateSession(run.launch.sessionId, {
          ended_at: nowSeconds(),
          end_reason: event === 'run.failed' ? 'error' : 'complete',
        })
      } catch (err) {
        logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[coding-agent-run] failed to write coding-agent session end marker')
      }
    }
    run.state.isWorking = false
    run.turnActive = false
    run.state.runId = undefined
    run.state.abortController = undefined
    run.state.activeRunMarker = undefined
    run.state.events = []
    if (event === 'run.completed') this.startCodingAgentMemoryExport(run)
    run.runMarker = undefined
    if (run.launch.agentId === 'pi' || run.disposeAfterTurn) {
      this.cleanupRun(run, { kill: true, reportClosed: false })
    }
    // Completion can synchronously release a queued run. Dispose the stale or
    // turn-scoped runtime first so the queued turn prepares fresh provider data.
    this.markChatRunCompleted(run.launch.sessionId, event)
  }

  private startCodingAgentMemoryExport(run: ManagedCodingAgentRun) {
    if (run.memoryExportStarted) return
    const agentId = run.launch.agentId
    const source = agentId === 'codex'
      ? 'codex'
      : agentId === 'claude-code'
        ? 'claude-code'
        : agentId === 'pi'
          ? 'pi'
          : ''
    if (!source) return
    const nativeSessionId = String(run.launch.agentNativeSessionId || '').trim()
    if (!nativeSessionId) {
      logger.debug({ runId: run.id, sessionId: run.launch.sessionId, agentId }, '[coding-agent-run] memory export skipped: missing native session id')
      return
    }
    run.memoryExportStarted = true

    const args = ['threads', 'save', '--from', source, '--truncate', '--session-id', nativeSessionId]
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (source === 'codex') {
      const codexHome = run.launch.env?.CODEX_HOME || process.env.CODEX_HOME
      if (codexHome) env.CODEX_HOME = codexHome
    } else if (source === 'pi') {
      const piHome = run.launch.env?.PI_CODING_AGENT_DIR || process.env.PI_CODING_AGENT_DIR
      const piSessionDir = run.launch.env?.PI_CODING_AGENT_SESSION_DIR || process.env.PI_CODING_AGENT_SESSION_DIR
      if (piHome) env.PI_CODING_AGENT_DIR = piHome
      if (piSessionDir) env.PI_CODING_AGENT_SESSION_DIR = piSessionDir
    }

    let child: ChildProcess
    try {
      child = spawnCodingAgentChild('nmem', args, {
        cwd: existsSync(run.launch.workspaceDir) ? run.launch.workspaceDir : homedir(),
        env,
      })
    } catch (err) {
      logger.debug({ err, runId: run.id, sessionId: run.launch.sessionId, agentId, nativeSessionId }, '[coding-agent-run] memory export failed to start')
      return
    }
    this.memoryExportChildren.add(child)

    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      forceKillChildProcess(child)
    }, 60_000)
    timeout.unref?.()
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString('utf8')}`.slice(-4000)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000)
    })
    child.on('error', (err) => {
      clearTimeout(timeout)
      this.memoryExportChildren.delete(child)
      logger.debug({ err, runId: run.id, sessionId: run.launch.sessionId, agentId, nativeSessionId }, '[coding-agent-run] memory export process error')
    })
    child.on('exit', (code) => {
      clearTimeout(timeout)
      this.memoryExportChildren.delete(child)
      if (code === 0) {
        logger.info({ runId: run.id, sessionId: run.launch.sessionId, agentId, nativeSessionId }, '[coding-agent-run] memory export completed')
      } else {
        logger.debug({
          runId: run.id,
          sessionId: run.launch.sessionId,
          agentId,
          nativeSessionId,
          code,
          stdout: stdout.slice(0, 1000),
          stderr: stderr.slice(0, 1000),
        }, '[coding-agent-run] memory export failed')
      }
    })
  }

  private codexNativeSessionIdFrom(value: any): string {
    if (!value || typeof value !== 'object') return ''
    const direct = value.thread_id || value.threadId || value.session_id || value.sessionId || value.conversation_id || value.conversationId
    if (typeof direct === 'string' && direct.trim()) return direct.trim()
    const nested = value.thread || value.session || value.conversation || value.params || value.msg || value.message
    if (nested && nested !== value) return this.codexNativeSessionIdFrom(nested)
    return ''
  }

  private recordCodexNativeSessionId(run: ManagedCodingAgentRun, nativeSessionId: string) {
    if (!nativeSessionId) return
    if (run.launch.agentNativeSessionId === nativeSessionId && run.nativeResumeReady) return
    run.launch.agentNativeSessionId = nativeSessionId
    run.nativeResumeReady = true
    try {
      updateSession(run.launch.sessionId, { agent_native_session_id: nativeSessionId })
      logger.info({ runId: run.id, sessionId: run.launch.sessionId, nativeSessionId }, '[coding-agent-run] recorded Codex native session id')
    } catch (err) {
      logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[coding-agent-run] failed to persist Codex native session id')
    }
  }

  private startWorkspaceRunDiff(run: ManagedCodingAgentRun) {
    try {
      startWorkspaceRunCheckpoint({
        sessionId: run.launch.sessionId,
        runId: run.id,
        workspace: run.launch.workspaceDir,
      })
    } catch (err) {
      logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[workspace-diff] failed to start coding agent run checkpoint')
    }
  }

  private completeWorkspaceRunDiff(run: ManagedCodingAgentRun) {
    try {
      const change = completeWorkspaceRunCheckpoint({
        sessionId: run.launch.sessionId,
        runId: run.id,
        workspace: run.launch.workspaceDir,
        assistantMessageId: run.assistantMessageId,
      })
      if (!change) return null
      this.emitToChat(run.launch.sessionId, 'workspace.diff.completed', {
        event: 'workspace.diff.completed',
        run_id: run.id,
        change_id: change.change_id,
        change,
      })
      return change
    } catch (err) {
      logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[workspace-diff] failed to complete coding agent run checkpoint')
      return null
    }
  }

  private emitToChat(sessionId: string, event: string, payload: any) {
    try {
      getChatRunServer()?.emitExternalEvent?.(sessionId, event, payload)
    } catch {}
  }

  private emitTerminalStatus(run: ManagedCodingAgentRun, text: string) {
    logger.debug({ runId: run.id, sessionId: run.launch.sessionId, text }, '[coding-agent-run] status')
  }

  private bufferTerminalOutput(run: ManagedCodingAgentRun, chunk: string) {
    const sanitized = sanitizeCodingAgentTerminalOutput(chunk)
    if (!sanitized.trim()) return
    run.terminalBuffer = `${run.terminalBuffer || ''}${sanitized}`
    if (run.terminalBuffer.length > MAX_TERMINAL_EVENT_CHARS * 2) {
      run.terminalBuffer = run.terminalBuffer.slice(-MAX_TERMINAL_EVENT_CHARS * 2)
    }
    if (run.terminalFlushTimer) return
    run.terminalFlushTimer = setTimeout(() => {
      run.terminalFlushTimer = undefined
      this.flushTerminalOutput(run)
    }, TERMINAL_OUTPUT_FLUSH_MS)
  }

  private maybeAnswerClaudeApiKeyPrompt(run: ManagedCodingAgentRun, chunk: string) {
    if (run.launch.agentId !== 'claude-code' || run.apiKeyPromptAnswered) return
    const text = sanitizeCodingAgentTerminalOutput(`${run.terminalBuffer || ''}${chunk}`).toLowerCase()
    if (!text.includes('detected a custom api key') && !text.includes('detectedacustomapikey')) return
    if (!text.includes('do you want to use this api key') && !text.includes('doyouwanttousethisapikey')) return
    run.apiKeyPromptAnswered = true
    this.emitTerminalStatus(run, 'Confirmed scoped Claude Code API key.')
    try {
      run.pty?.write('1\r')
    } catch (err) {
      logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[coding-agent-run] failed to confirm Claude Code API key prompt')
    }
  }

  private flushTerminalOutput(run: ManagedCodingAgentRun) {
    run.terminalBuffer = ''
  }

  private markChatRunCompleted(sessionId: string, event: string) {
    try {
      getChatRunServer()?.markExternalRunCompleted?.(sessionId, event)
    } catch {}
  }
}

export const codingAgentRunManager = new CodingAgentRunManager()
