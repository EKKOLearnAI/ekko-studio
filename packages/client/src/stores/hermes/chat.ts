import { mergeTaskPlanMessages, type TaskPlanSnapshot } from '@/utils/task-plan'
import { startRunViaSocket, resumeSession, registerSessionHandlers, unregisterSessionHandlers, getChatRunSocket, respondToolApproval, onPeerUserMessage, onSessionCommand, onSessionTitleUpdated, onSessionWorkspaceUpdated, onSessionSettingsUpdated, respondClarify, type ChatRunTransport, type RunEvent, type ResumeSessionPayload, type StartRunRequest, type ContentBlock as ContentBlockImport } from '@/api/studio/chat'
import { archiveSession as archiveSessionApi, deleteSession as deleteSessionApi, fetchSessionMessagesPage, fetchSessions, fetchWorkspaceRunChangeFile, setSessionModel, setSessionPushEnabled as persistSessionPushEnabled, setSessionReasoningEffort as persistSessionReasoningEffort, type HermesMessage, type SessionSummary, type WorkspaceRunChangeFileDetail, type WorkspaceRunChangeSummary } from '@/api/studio/sessions'
import { getActiveProfileName } from '@/api/client'
import { onAuthInvalidated } from '@/api/auth-invalidation'
import { inferCodingAgentApiMode, normalizeCodingAgentApiMode, type ChatCodingAgentId } from '@/api/coding-agents'
import { getDownloadUrl } from '@/api/studio/download'
import type { ProviderApiMode } from '@/api/studio/provider-api-mode'
import { defineStore } from 'pinia'
import { ref, computed, onScopeDispose } from 'vue'
import { observeBackgroundStatus } from '@/api/studio/background-status'
import { useAppStore } from './app'
import { useProfilesStore } from './profiles'
import { useSettingsStore } from './settings'
import { primeCompletionSound, playCompletionSound } from '@/utils/completion-sound'
import { showCompletionNotification } from '@/utils/completion-notification'
import { detectThinkingBoundary } from '@/utils/thinking-parser'
import { isKnownBridgeSessionCommand } from '@/utils/hermes/bridge-session-commands'
import { responseErrorMessage } from '@/utils/http-error'
import {
  isPendingInteractionExpiredError,
  notifyPendingInteractionExpired,
  pendingInteractionDeadline,
  type PendingInteractionSubmitResult,
} from '@/utils/pending-interaction'

// Re-export ContentBlock for convenience
export type ContentBlock = ContentBlockImport

export const LIVE_CHAT_MESSAGE_PAGE_SIZE = 150
export const LIVE_CHAT_MAX_LOADED_MESSAGES = 300
const LEGACY_WORKSPACE_RUN_CHANGE_MESSAGE_PREFIX = 'workspace-run-change:'
type ChatAgentId = 'hermes' | 'claude' | 'codex' | 'pi' | 'grok' | 'opencode' | 'dsh' | 'ekko-agent'

function agentToCodingAgentId(agent?: string): ChatCodingAgentId | undefined {
  if (agent === 'codex') return 'codex'
  if (agent === 'pi') return 'pi'
  if (agent === 'grok') return 'grok'
  if (agent === 'dsh') return 'dsh'
  if (agent === 'opencode') return 'opencode'
  if (agent === 'claude') return 'claude-code'
  if (agent === 'ekko-agent') return 'ekko-agent'
  return undefined
}

function codingAgentIdToAgent(id?: ChatCodingAgentId): ChatAgentId | undefined {
  if (id === 'codex') return 'codex'
  if (id === 'pi') return 'pi'
  if (id === 'grok') return 'grok'
  if (id === 'dsh') return 'dsh'
  if (id === 'opencode') return 'opencode'
  if (id === 'claude-code') return 'claude'
  if (id === 'ekko-agent') return 'ekko-agent'
  return undefined
}

function moaReferenceLabel(evt: RunEvent): string {
  const label = typeof evt.label === 'string' && evt.label.trim()
    ? evt.label.trim()
    : 'reference'
  const index = Number.isFinite(Number(evt.index)) ? Number(evt.index) : undefined
  const count = Number.isFinite(Number(evt.count)) ? Number(evt.count) : undefined
  return index != null && count != null
    ? `${index}/${count} ${label}`
    : label
}

export interface Attachment {
  id: string
  name: string
  type: string
  size: number
  url: string
  file?: File
  /** Structured context sent to the model but rendered collapsed in the UI. */
  context?: string
  /** Original video attachment id when this file is a model-only representative frame. */
  videoFrameFor?: string
}

export interface Message {
  taskPlan?: TaskPlanSnapshot
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool' | 'command'
  content: string
  timestamp: number
  toolName?: string
  toolCallId?: string
  toolPreview?: string
  toolArgs?: unknown
  toolResult?: unknown
  toolStatus?: 'running' | 'done' | 'error'
  toolDuration?: number  // 工具执行时长（秒）
  workspaceChanges?: WorkspaceRunChangeSummary[]
  isStreaming?: boolean
  attachments?: Attachment[]
  // 思考/推理文本。两条来源：
  //   1) 历史消息：来自 HermesMessage.reasoning 字段
  //   2) 流式：由 reasoning.delta / thinking.delta / reasoning.available 事件累加
  // 不含 <think> 包裹标签；内容自身可以为多段纯文本。
  reasoning?: string
  queued?: boolean
  systemType?: 'command' | 'error' | 'fork-divider' | 'tool-run'
  commandAction?: string
  commandData?: Record<string, unknown>
  finishReason?: string | null
  runMarker?: string | null
  toolRunId?: string
  toolMessages?: Message[]
}

export type SubagentStreamStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'error'
  | 'cancelled'
  | 'interrupted'

export interface SubagentStreamEntry {
  id: string
  kind: 'text' | 'thinking' | 'tool' | 'status'
  timestamp: number
  text?: string
  reasoning?: string
  reasoningEntryId?: string
  toolName?: string
  toolArgs?: unknown
  status?: SubagentStreamStatus | 'started'
}

export interface SubagentStream {
  sessionId: string
  subagentId: string
  taskIndex: number
  taskCount: number
  goal?: string
  model?: string
  status: SubagentStreamStatus
  startedAt: number
  updatedAt: number
  completedAt?: number
  durationSeconds?: number
  toolCount?: number
  apiCalls?: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  summary?: string
  lastBackgroundSeq?: number
  entries: SubagentStreamEntry[]
}

const SUBAGENT_STREAM_ENTRY_LIMIT = 200
const SUBAGENT_STREAM_TEXT_LIMIT = 80_000
let subagentStreamEntrySequence = 0

function subagentEventTimestamp(value: unknown): number {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return Date.now()
  return timestamp < 1_000_000_000_000 ? Math.round(timestamp * 1000) : Math.round(timestamp)
}

function subagentStatus(value: unknown, fallback: SubagentStreamStatus = 'running'): SubagentStreamStatus {
  const status = String(value || '').trim().toLowerCase()
  if (status === 'completed' || status === 'failed' || status === 'error' || status === 'cancelled' || status === 'interrupted') {
    return status
  }
  return fallback
}

function subagentEntryId(eventName: string, evt: RunEvent): string {
  const backgroundSequence = Number((evt as any).background_seq)
  if (Number.isFinite(backgroundSequence)) return `${eventName}:${backgroundSequence}`
  if ((evt as any).background_snapshot) return `snapshot:${eventName}`
  subagentStreamEntrySequence += 1
  return `${eventName}:${subagentStreamEntrySequence}`
}

function trimSubagentEntries(entries: SubagentStreamEntry[]): SubagentStreamEntry[] {
  return entries.length > SUBAGENT_STREAM_ENTRY_LIMIT
    ? entries.slice(entries.length - SUBAGENT_STREAM_ENTRY_LIMIT)
    : entries
}

function appendSubagentText(
  entries: SubagentStreamEntry[],
  entry: SubagentStreamEntry,
): SubagentStreamEntry[] {
  const previous = entries[entries.length - 1]
  if (previous?.kind === entry.kind && entry.text) {
    const previousText = previous.text || ''
    const nextText = entry.text.startsWith(previousText)
      ? entry.text
      : `${previousText}${entry.text}`
    entries[entries.length - 1] = {
      ...previous,
      text: nextText.slice(-SUBAGENT_STREAM_TEXT_LIMIT),
      timestamp: entry.timestamp,
    }
    return entries
  }
  entries.push({
    ...entry,
    text: entry.text?.slice(-SUBAGENT_STREAM_TEXT_LIMIT),
  })
  return trimSubagentEntries(entries)
}

function subagentReasoningSinceLastTool(
  entries: SubagentStreamEntry[],
): { id: string; text: string } | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry.kind === 'tool') return null
    if (entry.kind === 'thinking' && entry.text?.trim()) {
      return { id: entry.id, text: entry.text }
    }
  }
  return null
}

export function reduceSubagentStream(
  current: SubagentStream | undefined,
  sessionId: string,
  evt: RunEvent,
): SubagentStream {
  const eventName = String(evt.event || '')
  const subagentId = String((evt as any).subagent_id || evt.delegation_id || `${(evt as any).task_index ?? 0}`)
  const timestamp = subagentEventTimestamp(evt.timestamp || (evt as any).updated_at)
  const backgroundSequence = Number((evt as any).background_seq)
  if (
    current
    && Number.isFinite(backgroundSequence)
    && current.lastBackgroundSeq != null
    && backgroundSequence <= current.lastBackgroundSeq
  ) {
    return current
  }

  const incomingTaskIndex = Number((evt as any).task_index)
  const incomingTaskCount = Number((evt as any).task_count)
  const goal = String((evt as any).goal || '').trim()
  const model = String((evt as any).model || '').trim()
  const summary = String((evt as any).summary || '').trim()
  const rawText = String(evt.text || evt.preview || '')
  const text = rawText.trim()
  const toolName = String((evt as any).tool || (evt as any).name || '').trim()
  const durationSeconds = Number((evt as any).duration_seconds ?? (evt as any).duration)
  const toolCount = Number((evt as any).tool_count)
  const apiCalls = Number((evt as any).api_calls)
  const inputTokens = Number((evt as any).input_tokens)
  const outputTokens = Number((evt as any).output_tokens)
  const costUsd = Number((evt as any).cost_usd)
  const isTerminal = eventName === 'subagent.complete'
    || (eventName === 'delegation.updated' && ['completed', 'failed', 'error', 'cancelled', 'interrupted'].includes(String((evt as any).status || '').toLowerCase()))
  if (current && current.status !== 'running' && !isTerminal) return current
  const nextStatus = isTerminal
    ? subagentStatus((evt as any).status, 'completed')
    : 'running'
  const entries = current ? [...current.entries] : []
  const entryId = subagentEntryId(eventName, evt)

  if (eventName === 'subagent.start') {
    if (!entries.some(entry => entry.kind === 'status' && entry.status === 'started')) {
      entries.push({ id: entryId, kind: 'status', status: 'started', timestamp, text: goal || undefined })
    }
  } else if (eventName === 'subagent.text' && rawText) {
    const reasoning = subagentReasoningSinceLastTool(entries)
    appendSubagentText(entries, {
      id: entryId,
      kind: 'text',
      timestamp,
      text: rawText,
      reasoning: reasoning?.text,
      reasoningEntryId: reasoning?.id,
    })
  } else if (eventName === 'subagent.thinking' && rawText) {
    appendSubagentText(entries, { id: entryId, kind: 'thinking', timestamp, text: rawText })
  } else if (eventName === 'subagent.tool') {
    const reasoning = subagentReasoningSinceLastTool(entries)
    if (reasoning) {
      // A tool boundary is the final owner for this reasoning segment. Text
      // deltas can arrive before the tool call is announced, so revoke their
      // provisional ownership to avoid rendering the same reasoning twice.
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]
        if (entry.kind !== 'text' || entry.reasoningEntryId !== reasoning.id) continue
        const {
          reasoning: _reasoning,
          reasoningEntryId: _reasoningEntryId,
          ...textEntry
        } = entry
        entries[i] = textEntry
      }
    }
    entries.push({
      id: entryId,
      kind: 'tool',
      timestamp,
      text: text || undefined,
      reasoning: reasoning?.text,
      reasoningEntryId: reasoning?.id,
      toolName: toolName || undefined,
      toolArgs: (evt as any).arguments,
    })
  } else if (eventName === 'subagent.progress' && text) {
    const previous = entries[entries.length - 1]
    const progressEntry: SubagentStreamEntry = {
      id: entryId,
      kind: 'status',
      status: 'running',
      timestamp,
      text,
    }
    if (previous?.kind === 'status' && previous.status === 'running') entries[entries.length - 1] = progressEntry
    else entries.push(progressEntry)
  }

  if (isTerminal) {
    const finalText = summary || text
    const previousTextEntry = [...entries].reverse().find(entry => entry.kind === 'text')
    const previousText = previousTextEntry?.text?.trim()
    if (finalText && previousText !== finalText) {
      const activeReasoning = subagentReasoningSinceLastTool(entries)
      const reasoning = activeReasoning?.id === previousTextEntry?.reasoningEntryId
        ? null
        : activeReasoning
      entries.push({
        id: `${entryId}:summary`,
        kind: 'text',
        timestamp,
        text: finalText,
        reasoning: reasoning?.text,
        reasoningEntryId: reasoning?.id,
      })
    }
    const previous = entries[entries.length - 1]
    const terminalEntry: SubagentStreamEntry = {
      id: entryId,
      kind: 'status',
      status: nextStatus,
      timestamp,
    }
    if (previous?.kind === 'status' && previous.status !== 'started') entries[entries.length - 1] = terminalEntry
    else entries.push(terminalEntry)
  }

  return {
    sessionId,
    subagentId,
    taskIndex: Number.isFinite(incomingTaskIndex) ? incomingTaskIndex : current?.taskIndex || 0,
    taskCount: Number.isFinite(incomingTaskCount) && incomingTaskCount > 0 ? incomingTaskCount : current?.taskCount || 1,
    goal: goal || current?.goal,
    model: model || current?.model,
    status: nextStatus,
    startedAt: current?.startedAt || subagentEventTimestamp((evt as any).started_at || timestamp),
    updatedAt: timestamp,
    completedAt: isTerminal ? subagentEventTimestamp((evt as any).completed_at || timestamp) : current?.completedAt,
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : current?.durationSeconds,
    toolCount: Number.isFinite(toolCount) ? toolCount : current?.toolCount,
    apiCalls: Number.isFinite(apiCalls) ? apiCalls : current?.apiCalls,
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : current?.inputTokens,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : current?.outputTokens,
    costUsd: Number.isFinite(costUsd) ? costUsd : current?.costUsd,
    summary: summary || current?.summary,
    lastBackgroundSeq: Number.isFinite(backgroundSequence) ? backgroundSequence : current?.lastBackgroundSeq,
    entries: trimSubagentEntries(entries),
  }
}

export interface MessageReference {
  id: string
  role: 'user' | 'assistant'
  content: string
  sender?: string
  senderId?: string
}

export interface ParsedMessageReference {
  content: string
  reply: string
}

export function parseMessageReference(content: string): ParsedMessageReference | null {
  if (!content.startsWith('<quoted_message')) return null
  const openEnd = content.indexOf('>\n')
  if (openEnd === -1) return null
  const closeMarker = '\n</quoted_message>'
  const closeStart = content.indexOf(closeMarker, openEnd + 2)
  if (closeStart === -1) return null

  return {
    content: content.slice(openEnd + 2, closeStart).trim(),
    reply: content.slice(closeStart + closeMarker.length).trim(),
  }
}

export function formatReferencedContentForDisplay(content: string): string {
  return content
    .trim()
    .split(/\r?\n/)
    .map(line => line ? `> ${line}` : '>')
    .join('\n')
}

export function formatMessageWithReference(reference: MessageReference, content: string): string {
  const sender = reference.sender?.trim()
  const openTag = sender
    ? `<quoted_message sender=${JSON.stringify(sender)}>`
    : '<quoted_message>'
  const quotedContent = reference.content.trim()
  const reply = content.trim()
  const referenceBlock = `${openTag}\n${quotedContent}\n</quoted_message>`
  return reply ? `${referenceBlock}\n\n${reply}` : referenceBlock
}

export interface PendingApproval {
  sessionId: string
  approvalId: string
  command: string
  description: string
  choices: Array<'once' | 'session' | 'always' | 'deny'>
  allowPermanent: boolean
  isMemoryWrite: boolean
  requestedAt: number
  countdownDeadline: number
}

export interface PendingClarify {
  sessionId: string
  clarifyId: string
  question: string
  choices: string[] | null
  initialResponse: string
  responseMode: string
  timeoutMs: number
  requestedAt: number
  countdownDeadline: number
}

export interface QueueInsertionState {
  generation: string
  runId?: string
  queueId: string
  runtime: 'hermes' | 'ekko' | 'claude-code' | 'codex' | 'pi' | 'grok' | 'opencode' | 'dsh'
  phase: 'requesting' | 'waiting_for_tool_batch' | 'stopping_current_turn'
  guarantee: 'strict' | 'immediate'
  requestedAt: number
}

export interface Session {
  id: string
  profile?: string
  title: string
  source?: string
  agent?: string
  agentSessionId?: string
  agentNativeSessionId?: string
  codingAgentId?: ChatCodingAgentId
  codingAgentMode?: 'global' | 'scoped'
  agentPreset?: string
  messages: Message[]
  createdAt: number
  updatedAt: number
  model?: string
  provider?: string
  baseUrl?: string
  apiKey?: string
  apiMode?: ProviderApiMode
  messageCount?: number
  messageTotal?: number
  loadedMessageCount?: number
  hasMoreBefore?: boolean
  isLoadingOlderMessages?: boolean
  inputTokens?: number
  outputTokens?: number
  contextTokens?: number
  endedAt?: number | null
  parentSessionId?: string | null
  forkPointMessageId?: string | null
  parentTitle?: string | null
  parentLastMessage?: string | null
  parentLastMessageRole?: string | null
  lastActiveAt?: number
  isPinned?: boolean
  isArchived?: boolean
  pushEnabled?: boolean
  workspace?: string | null
  categoryId?: number | null
  isLocalOnly?: boolean
  /** Per-session reasoning effort override.
   * Empty string / undefined = use config.yaml default.
   * Values: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' */
  reasoningEffort?: string
}

interface CompressionState {
  compressing: boolean
  messageCount: number
  beforeTokens: number
  afterTokens: number
  compressed: boolean | null
  error?: string
}

interface AbortState {
  aborting: boolean
  synced: boolean | null
  timedOut?: boolean
  message?: string
  error?: string
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

export function alignWorkspaceChangeAssistantMessage(
  messages: Message[],
  change: WorkspaceRunChangeSummary | null | undefined,
  assistantMessageId?: string | null,
): string | null {
  const currentAssistantMessageId = String(assistantMessageId || '').trim()
  const persistedAssistantMessageId = String(change?.assistant_message_id || '').trim()
  if (!persistedAssistantMessageId) return currentAssistantMessageId || null
  if (!currentAssistantMessageId || persistedAssistantMessageId === currentAssistantMessageId) {
    return messages.some(item => item.id === persistedAssistantMessageId)
      ? persistedAssistantMessageId
      : currentAssistantMessageId || null
  }
  const message = messages.find(item => item.id === currentAssistantMessageId)
  const idAlreadyLoaded = messages.some(item => item.id === persistedAssistantMessageId)
  if (message && !idAlreadyLoaded) {
    message.id = persistedAssistantMessageId
    return persistedAssistantMessageId
  }
  return idAlreadyLoaded ? persistedAssistantMessageId : currentAssistantMessageId
}

export function attachWorkspaceChangesToExactTurns(
  messages: Message[],
  changes: WorkspaceRunChangeSummary[],
): void {
  for (const message of messages) message.workspaceChanges = []
  const assistantById = new Map(
    messages
      .filter(message => message.role === 'assistant')
      .map(message => [message.id, message]),
  )
  for (const change of changes) {
    const assistantMessageId = String(change.assistant_message_id || '').trim()
    if (!assistantMessageId) continue
    const target = assistantMessageId ? assistantById.get(assistantMessageId) : undefined
    if (target) target.workspaceChanges!.push(change)
  }
}

function isToolOutputError(output: unknown): boolean {
  if (typeof output !== 'string' || !output.trim()) return false
  try {
    const parsed = JSON.parse(output)
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      if (record.success === false) return true
      if (record.error != null && String(record.error).trim() !== '') return true
    }
  } catch {
    return false
  }
  return false
}

function errorMessageText(error: unknown): string {
  if (typeof error === 'string') return error.trim()
  if (error == null) return ''
  if (typeof error !== 'object') return String(error).trim()

  if (Array.isArray(error)) {
    return error.map(errorMessageText).filter(Boolean).join('\n')
  }

  const record = error as Record<string, unknown>
  for (const key of ['message', 'error', 'detail', 'description', 'code']) {
    const text = errorMessageText(record[key])
    if (text) return text
  }

  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

async function uploadFiles(attachments: Attachment[]): Promise<{ name: string; path: string }[]> {
  if (attachments.length === 0) return []
  const formData = new FormData()
  for (const att of attachments) {
    if (att.file) formData.append('file', att.file, att.name)
  }
  const token = localStorage.getItem('hermes_api_key') || ''
  const profileName = getActiveProfileName()
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (profileName) headers['X-Hermes-Profile'] = profileName
  const res = await fetch('/api/studio/uploads', {
    method: 'POST',
    body: formData,
    headers,
  })
  if (!res.ok) throw new Error(await responseErrorMessage(res, 'Upload failed'))
  const data = await res.json() as { files: { name: string; path: string }[] }
  return data.files
}

export async function buildContentBlocks(
  content: string,
  attachments?: Attachment[],
  uploadedFiles?: { name: string; path: string }[],
  includeContextText = true,
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = []

  // Add text block if content is not empty
  if (content.trim()) {
    blocks.push({ type: 'text', text: content.trim() })
  }

  // Add attachment blocks using uploaded file paths
  if (attachments && attachments.length > 0 && uploadedFiles) {
    for (let i = 0; i < uploadedFiles.length; i++) {
      const uploaded = uploadedFiles[i]
      const attachment = attachments[i]

      // Check if it's an image
      if (attachment?.type.startsWith('image/')) {
        blocks.push({
          type: 'image',
          name: uploaded.name,
          path: uploaded.path,
          media_type: attachment.type,
          ...(attachment.context?.trim() ? { context: attachment.context.trim() } : {}),
          ...(attachment.videoFrameFor ? { video_frame: true } : {}),
        })
      } else {
        // Other files
        blocks.push({
          type: 'file',
          name: uploaded.name,
          path: uploaded.path,
          media_type: attachment?.type,
          ...(attachment?.context?.trim() ? { context: attachment.context.trim() } : {}),
        })
      }
      if (includeContextText && attachment?.context?.trim()) {
        blocks.push({
          type: 'text',
          text: `<browser_selection_context format="json">\n${attachment.context.trim()}\n</browser_selection_context>`,
        })
      }
    }
  }

  return blocks
}

function hasRuntimeToolPayload(value: unknown): boolean {
  return value !== null && value !== undefined && value !== ''
}

function runtimeToolPayloadOrUndefined(value: unknown): unknown | undefined {
  return hasRuntimeToolPayload(value) ? value : undefined
}

function runtimeToolOutputFromEvent(event: unknown): unknown | undefined {
  if (!event || typeof event !== 'object') return undefined
  const record = event as Record<string, unknown>
  return runtimeToolPayloadOrUndefined(
    record.output ?? record.result ?? record.content ?? record.preview,
  )
}

function runtimePayloadText(value: unknown): string {
  if (!hasRuntimeToolPayload(value)) return ''
  if (typeof value === 'string') return value
  try {
    const serialized = JSON.stringify(value)
    if (serialized !== undefined) return serialized
  } catch {
    // Fall through to String(value) for non-serializable runtime payloads.
  }
  return String(value)
}

function runtimeObjectPayload(value: unknown): Record<string, unknown> | null {
  if (!value) return null
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function isBackgroundDelegateToolPayload(toolName: unknown, payload: unknown): boolean {
  if (String(toolName || '') !== 'delegate_task') return false
  return runtimeObjectPayload(payload)?.mode === 'background'
}

const HERMES_BACKGROUND_DELEGATE_ANCHOR_PREFIX = 'background-delegate:'

function backgroundDelegateTaskDescriptors(
  payload: Record<string, unknown>,
  toolArgs: unknown,
): Array<{ taskIndex: number; taskCount: number; goal: string }> {
  const args = runtimeObjectPayload(toolArgs)
  const payloadGoals = Array.isArray(payload.goals)
    ? payload.goals.map(value => String(value || '').trim())
    : []
  const argumentGoals = Array.isArray(args?.goals)
    ? args.goals.map(value => String(value || '').trim())
    : []
  const goals = payloadGoals.length > 0 ? payloadGoals : argumentGoals
  const fallbackGoal = String(payload.goal || args?.goal || '').trim()
  const requestedCount = Number(payload.count ?? payload.task_count)
  const taskCount = Math.max(
    1,
    Number.isFinite(requestedCount) ? requestedCount : 0,
    goals.length,
  )
  return Array.from({ length: taskCount }, (_, taskIndex) => ({
    taskIndex,
    taskCount,
    goal: goals[taskIndex] || (taskIndex === 0 ? fallbackGoal : ''),
  }))
}

function backgroundDelegateAnchorCallId(baseId: string, taskIndex: number): string {
  return `${HERMES_BACKGROUND_DELEGATE_ANCHOR_PREFIX}${baseId}:${taskIndex}`
}

function parsePersistedMoaToolPayload(toolName: string | undefined, value: unknown): { preview?: string; result?: unknown } | null {
  if (toolName !== 'moa_reference' && toolName !== 'moa_aggregating') return null
  const payload = typeof value === 'string'
    ? (() => {
        try {
          return JSON.parse(value)
        } catch {
          return null
        }
      })()
    : value
  if (!payload || typeof payload !== 'object') return null
  const data = payload as Record<string, unknown>
  const preview = typeof data.preview === 'string'
    ? data.preview
    : typeof data.label === 'string'
      ? data.label
      : typeof data.aggregator === 'string'
        ? data.aggregator
        : undefined
  const result = data.text ?? data.result
  return { preview, result }
}

function isPersistedMoaToolDisplay(msg: HermesMessage): boolean {
  return (msg.role === 'moa' || msg.display_role === 'tool')
    && (msg.tool_name === 'moa_reference' || msg.tool_name === 'moa_aggregating')
}

function runtimeToolOutputHasError(value: unknown): boolean {
  return typeof value === 'string' && isToolOutputError(value)
}

function readFinishReason(value: unknown): string | null | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(record, 'finishReason')) {
    return (record as { finishReason?: string | null }).finishReason
  }
  if (Object.prototype.hasOwnProperty.call(record, 'finish_reason')) {
    return (record as { finish_reason?: string | null }).finish_reason
  }
  return undefined
}

function readRunMarker(value: unknown): string | null | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(record, 'runMarker')) {
    return typeof record.runMarker === 'string' || record.runMarker == null
      ? record.runMarker as string | null
      : undefined
  }
  if (Object.prototype.hasOwnProperty.call(record, 'run_marker')) {
    return typeof record.run_marker === 'string' || record.run_marker == null
      ? record.run_marker as string | null
      : undefined
  }
  if (Object.prototype.hasOwnProperty.call(record, 'run_id')) {
    return typeof record.run_id === 'string' || record.run_id == null
      ? record.run_id as string | null
      : undefined
  }
  return undefined
}

function normalizedRunMarker(value: unknown): string | null {
  const runMarker = readRunMarker(value)
  return typeof runMarker === 'string' && runMarker.trim() !== '' ? runMarker.trim() : null
}

function toolInstanceKey(value: unknown, toolCallId: string): string {
  return `${normalizedRunMarker(value) || 'legacy'}\u0000${toolCallId}`
}

function setToolMetadata<T>(map: Map<string, T>, message: unknown, toolCallId: string, value: T) {
  const scopedKey = toolInstanceKey(message, toolCallId)
  const legacyKey = toolInstanceKey(null, toolCallId)
  map.set(scopedKey, value)
  // Some older rows only persisted the run marker on the tool result. Keep a
  // best-effort fallback without allowing it to override an exact scoped key.
  if (!map.has(legacyKey)) map.set(legacyKey, value)
}

function getToolMetadata<T>(map: Map<string, T>, message: unknown, toolCallId: string): T | undefined {
  return map.get(toolInstanceKey(message, toolCallId))
    ?? map.get(toolInstanceKey(null, toolCallId))
}

function isQueueInsertionInterruption(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const event = value as Pick<RunEvent, 'interrupted' | 'stop_reason'>
  return event.interrupted === true && event.stop_reason === 'queue_insertion'
}

function hasAssistantVisibleText(message: Message | null | undefined): boolean {
  if (!message) return false
  return message.content.trim() !== '' || (message.reasoning?.trim() ?? '') !== ''
}

function selectResumedInFlightAssistant(messages: Message[], activeRunMarker?: string | null): Message | null {
  if (messages.length === 0) return null
  const lastMessage = messages[messages.length - 1]
  if (lastMessage?.role !== 'assistant') return null
  const finishReason = readFinishReason(lastMessage)
  const runMarker = readRunMarker(lastMessage)
  const hasMatchingRunMarker = !!activeRunMarker && !!runMarker && runMarker === activeRunMarker
  return finishReason === null || hasMatchingRunMarker ? lastMessage : null
}

function getReplayRunMarker(events?: Array<{ event: string; data: RunEvent }>): string | null {
  if (!Array.isArray(events)) return null
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const runMarker = readRunMarker(events[i]?.data)
    if (typeof runMarker === 'string' && runMarker.trim() !== '') return runMarker
  }
  return null
}

function resolveResumedAssistantState(
  messages: Message[],
  options: {
    previousActiveAssistantMessageId?: string | null
    previousReasoningAssistantMessageId?: string | null
    activeRunMarker?: string | null
  },
): {
  activeAssistant: Message | null
  reasoningAssistant: Message | null
  runMarker: string | null
  hadVisibleText: boolean
} {
  const activeAssistant = options.previousActiveAssistantMessageId
    ? messages.find(m => m.role === 'assistant' && m.id === options.previousActiveAssistantMessageId) || null
    : null
  const selectedActiveAssistant = activeAssistant || selectResumedInFlightAssistant(messages, options.activeRunMarker)
  const reasoningAssistant = options.previousReasoningAssistantMessageId
    ? messages.find(m => m.role === 'assistant' && m.id === options.previousReasoningAssistantMessageId) || null
    : null
  const selectedReasoningAssistant = reasoningAssistant || (selectedActiveAssistant?.reasoning ? selectedActiveAssistant : null)
  const selectedRunMarker = readRunMarker(selectedActiveAssistant) ?? options.activeRunMarker ?? null
  return {
    activeAssistant: selectedActiveAssistant,
    reasoningAssistant: selectedReasoningAssistant,
    runMarker: selectedRunMarker,
    hadVisibleText: hasAssistantVisibleText(selectedActiveAssistant),
  }
}

export function mapHermesMessages(msgs: HermesMessage[], taskPlans: unknown[] = [], previous: Message[] = []): Message[] {
  // Filter out assistant messages with no display content unless they carry tool call metadata
  // needed to name later tool result rows when resuming persisted history.
  const filteredMsgs = msgs.filter(m => {
    if (m.role === 'assistant') {
      return (m.tool_calls?.length || 0) > 0 || runtimePayloadText((m as any).content).trim() !== ''
    }
    return true
  })

  // Build lookups from assistant messages with tool_calls
  const toolNameMap = new Map<string, string>()
  const toolArgsMap = new Map<string, unknown>()
  const toolReasoningMap = new Map<string, string>()
  for (const msg of filteredMsgs) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.id) {
          if (tc.function?.name) setToolMetadata(toolNameMap, msg, tc.id, tc.function.name)
          if (hasRuntimeToolPayload(tc.function?.arguments)) setToolMetadata(toolArgsMap, msg, tc.id, tc.function.arguments)
          if (msg.reasoning?.trim()) setToolMetadata(toolReasoningMap, msg, tc.id, msg.reasoning)
        }
      }
    }
  }

  const result: Message[] = []
  for (const msg of filteredMsgs) {
    // Skip assistant messages that only contain tool_calls (no meaningful content)
    if (msg.role === 'assistant' && msg.tool_calls?.length && !runtimePayloadText((msg as any).content).trim()) {
      // Emit a tool.started message for each tool call
      for (const tc of msg.tool_calls) {
        result.push({
          id: String(msg.id) + '_' + tc.id,
          role: 'tool',
          content: '',
          timestamp: Math.round(msg.timestamp * 1000),
          toolName: tc.function?.name || undefined,
          toolCallId: tc.id,
          toolArgs: runtimeToolPayloadOrUndefined(tc.function?.arguments),
          reasoning: msg.reasoning?.trim() ? msg.reasoning : undefined,
          toolStatus: 'done',
          finishReason: readFinishReason(msg),
          runMarker: readRunMarker(msg),
        })
      }
      continue
    }

    // Tool result messages. MoA display rows are persisted with role "moa"
    // so they can render as tool lines without becoming model-context tool results.
    if (msg.role === 'tool' || isPersistedMoaToolDisplay(msg)) {
      const tcId = msg.tool_call_id || ''
      const exactPlaceholderIdx = result.findIndex(m =>
        m.role === 'tool'
        && m.toolCallId === tcId
        && !m.toolResult
        && normalizedRunMarker(m) === normalizedRunMarker(msg),
      )
      const placeholderIdx = exactPlaceholderIdx !== -1
        ? exactPlaceholderIdx
        : result.findIndex(m =>
            m.role === 'tool'
            && m.toolCallId === tcId
            && !m.toolResult
            && normalizedRunMarker(m) === null,
          )
      const placeholder = placeholderIdx !== -1 ? result[placeholderIdx] : undefined
      const toolName = msg.tool_name || getToolMetadata(toolNameMap, msg, tcId) || placeholder?.toolName || undefined
      const toolArgs = getToolMetadata(toolArgsMap, msg, tcId) ?? placeholder?.toolArgs
      const toolReasoning = getToolMetadata(toolReasoningMap, msg, tcId) || placeholder?.reasoning
      const moaPayload = parsePersistedMoaToolPayload(toolName, (msg as any).content)
      const backgroundDelegate = isBackgroundDelegateToolPayload(toolName, (msg as any).content)
      const delegatePayload = toolName === 'delegate_task'
        ? runtimeObjectPayload(msg.display_content) || runtimeObjectPayload((msg as any).content)
        : null
      // Extract a short preview from the content
      let preview = moaPayload?.preview || ''
      const contentText = runtimePayloadText((msg as any).content)
      if (!preview && contentText) {
        try {
          const parsed = typeof (msg as any).content === 'string'
            ? JSON.parse(contentText)
            : (msg as any).content
          preview = parsed?.url || parsed?.title || parsed?.preview || parsed?.summary || ''
        } catch {
          preview = contentText.slice(0, 80)
        }
      }
      // Remove only the placeholder belonging to this run. Coding-agent CLIs
      // may reuse raw ids such as `item_2` on every resumed turn.
      if (placeholderIdx !== -1) {
        result.splice(placeholderIdx, 1)
      }
      if (delegatePayload?.runtime === 'ekko') {
        const subagentId = String(delegatePayload.subagent_id || '').trim()
        if (!subagentId) continue
        const delegateArgs = runtimeObjectPayload(toolArgs)
        const status = subagentStatus(delegatePayload.status)
        const taskIndex = Number(delegatePayload.task_index ?? 0)
        const taskCount = Math.max(1, Number(delegatePayload.task_count ?? 1) || 1)
        const goal = String(delegatePayload.goal || delegateArgs?.goal || '').trim()
        const summary = String(delegatePayload.summary || delegatePayload.output || '').trim()
        const label = `${Number.isFinite(taskIndex) ? taskIndex + 1 : 1}/${taskCount}`
        const durationMs = Number(delegatePayload.duration_ms)
        const restoredPayload = {
          ...delegatePayload,
          goal,
          duration_seconds: delegatePayload.duration_seconds
            ?? (Number.isFinite(durationMs) ? durationMs / 1000 : undefined),
        }
        result.push({
          id: String(msg.id),
          role: 'tool',
          content: '',
          timestamp: Math.round(msg.timestamp * 1000),
          toolName: 'delegate_task',
          toolCallId: `subagent:${subagentId}`,
          toolArgs,
          toolPreview: `${label}${summary ? ` · ${summary}` : goal ? ` · ${goal}` : ''}`.slice(0, 220),
          toolResult: restoredPayload,
          reasoning: toolReasoning,
          toolStatus: status === 'running' ? 'running' : status === 'completed' ? 'done' : 'error',
          finishReason: readFinishReason(msg),
          runMarker: readRunMarker(msg),
        })
        continue
      }
      if (delegatePayload?.runtime === 'hermes') {
        const persistedTasks = Array.isArray(delegatePayload.tasks)
          ? delegatePayload.tasks.filter(task => task && typeof task === 'object') as Array<Record<string, unknown>>
          : [delegatePayload]
        const restorableTasks = persistedTasks.filter(task => String(task.subagent_id || '').trim())
        if (restorableTasks.length > 0) {
          for (const [index, task] of restorableTasks.entries()) {
            const subagentId = String(task.subagent_id || '').trim()
            const status = subagentStatus(task.status)
            const taskIndex = Number(task.task_index ?? index)
            const taskCount = Math.max(1, Number(task.task_count ?? restorableTasks.length) || 1)
            const goal = String(task.goal || '').trim()
            const summary = String(task.summary || task.output || '').trim()
            const label = `${Number.isFinite(taskIndex) ? taskIndex + 1 : index + 1}/${taskCount}`
            result.push({
              id: `${String(msg.id)}:background:${Number.isFinite(taskIndex) ? taskIndex : index}`,
              role: 'tool',
              content: '',
              timestamp: Math.round(msg.timestamp * 1000),
              toolName: 'delegate_task',
              toolCallId: `subagent:${subagentId}`,
              toolArgs,
              toolPreview: `${label}${summary ? ` · ${summary}` : goal ? ` · ${goal}` : ''}`.slice(0, 220),
              toolResult: task,
              reasoning: toolReasoning,
              toolStatus: status === 'running' ? 'running' : status === 'completed' ? 'done' : 'error',
              finishReason: readFinishReason(msg),
              runMarker: readRunMarker(msg),
            })
          }
          continue
        }
      }
      if (backgroundDelegate && delegatePayload) {
        const baseId = tcId || String(msg.id)
        for (const task of backgroundDelegateTaskDescriptors(delegatePayload, toolArgs)) {
          const label = `${task.taskIndex + 1}/${task.taskCount}`
          result.push({
            id: `${String(msg.id)}:background:${task.taskIndex}`,
            role: 'tool',
            content: '',
            timestamp: Math.round(msg.timestamp * 1000),
            toolName: 'delegate_task',
            toolCallId: backgroundDelegateAnchorCallId(baseId, task.taskIndex),
            toolArgs,
            toolPreview: `${label}${task.goal ? ` · ${task.goal}` : ''}`.slice(0, 220),
            toolResult: {
              ...delegatePayload,
              runtime: 'hermes',
              task_index: task.taskIndex,
              task_count: task.taskCount,
              goal: task.goal,
            },
            reasoning: toolReasoning,
            toolStatus: 'done',
            finishReason: readFinishReason(msg),
            runMarker: readRunMarker(msg),
          })
        }
        continue
      }
      result.push({
        id: String(msg.id),
        role: 'tool',
        content: '',
        timestamp: Math.round(msg.timestamp * 1000),
        toolName,
        toolCallId: tcId || undefined,
        toolArgs,
        toolPreview: typeof preview === 'string' ? preview.slice(0, 100) || undefined : undefined,
        toolResult: moaPayload ? runtimeToolPayloadOrUndefined(moaPayload.result) : runtimeToolPayloadOrUndefined((msg as any).content),
        reasoning: toolReasoning,
        toolStatus: readFinishReason(msg) === 'error' ? 'error' : 'done',
        finishReason: readFinishReason(msg),
        runMarker: readRunMarker(msg),
      })
      continue
    }

    // Normal user/assistant/command messages
    const displayRole = msg.display_role || msg.role
    const displayContent = msg.display_content ?? msg.content
    result.push({
      id: String(msg.id),
      role: displayRole === 'moa' ? 'system' : displayRole,
      content: displayContent || '',
      timestamp: Math.round(msg.timestamp * 1000),
      reasoning: msg.reasoning ? msg.reasoning : undefined,
      systemType: displayRole === 'command' ? 'command' : undefined,
      finishReason: readFinishReason(msg),
      runMarker: readRunMarker(msg),
    })
  }
  const restored = mergeTaskPlanMessages(result, taskPlans)
  const restoredIds = new Set(restored.map(message => message.id))
  return mergeTaskPlanMessages(restored, previous.filter(message => message.taskPlan && restoredIds.has(message.id)).map(message => message.taskPlan))
}

function sessionActivitySeconds(s: SessionSummary): number {
  return Math.max(
    s.started_at || 0,
    s.ended_at || 0,
    s.last_active || 0,
  )
}

function lastVisibleMessage(messages?: Message[] | null): Message | null {
  if (!messages?.length) return null
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'user' && message.role !== 'assistant') continue
    if (!String(message.content || '').trim()) continue
    return message
  }
  return null
}

function lastVisibleMessageContent(messages?: Message[] | null): string | null {
  const message = lastVisibleMessage(messages)
  if (!message) return null
  const content = String(message.content || '').replace(/\s+/g, ' ').trim()
  return content.length > 280 ? `${content.slice(0, 277)}...` : content
}

function lastVisibleMessageRole(messages?: Message[] | null): string | null {
  return lastVisibleMessage(messages)?.role || null
}

function mapHermesSession(s: SessionSummary): Session {
  const codingAgentId = agentToCodingAgentId(s.agent)
  const isCodingAgentSession = s.source === 'coding_agent' || Boolean(codingAgentId)
  const codingAgentMode = isCodingAgentSession
    ? (s.agent_mode === 'global' || s.agent_mode === 'scoped'
        ? s.agent_mode
        : s.provider === 'global' ? 'global' : 'scoped')
    : undefined
  const activitySeconds = sessionActivitySeconds(s)
  return {
    id: s.id,
    profile: s.profile || 'default',
    title: s.title || '',
    source: s.source || undefined,
    agent: s.agent || undefined,
    agentSessionId: s.agent_session_id || undefined,
    agentNativeSessionId: s.agent_native_session_id || undefined,
    codingAgentId,
    codingAgentMode,
    messages: [],
    createdAt: Math.round(s.started_at * 1000),
    updatedAt: Math.round(activitySeconds * 1000),
    model: s.model,
    provider: s.provider || (s as any).billing_provider || '',
    apiMode: s.api_mode,
    agentPreset: s.agent_preset || undefined,
    reasoningEffort: s.reasoning_effort || undefined,
    messageCount: s.message_count,
    messageTotal: s.message_count,
    loadedMessageCount: 0,
    hasMoreBefore: false,
    inputTokens: s.input_tokens,
    outputTokens: s.output_tokens,
    endedAt: s.ended_at != null ? Math.round(s.ended_at * 1000) : null,
    parentSessionId: s.parent_session_id || null,
    forkPointMessageId: (s as any).fork_point_message_id != null ? String((s as any).fork_point_message_id) : null,
    parentTitle: s.parent_title || null,
    parentLastMessage: s.parent_last_message || null,
    parentLastMessageRole: s.parent_last_message_role || null,
    lastActiveAt: s.last_active != null ? Math.round(s.last_active * 1000) : undefined,
    isPinned: Boolean(s.is_pinned),
    isArchived: Boolean(s.is_archived),
    pushEnabled: Boolean(s.push_enabled),
    workspace: s.workspace || null,
    categoryId: s.category_id ?? null,
  }
}

const STORAGE_KEY_PREFIX = 'hermes_active_session_'
type ChatRuntimeMode = 'default' | 'global_agent'
let activeRuntimeMode: ChatRuntimeMode = 'default'
const LEGACY_STORAGE_KEY = 'hermes_active_session'
const SESSION_PROFILE_FILTER_STORAGE_KEY = 'hermes_session_profile_filter_v1'

// 获取当前 profile 名称，用于隔离缓存。
// 从 profiles store 的 activeProfileName（同步 localStorage）读取，
// 避免异步加载导致 chat store 初始化时拿到 null。
function getProfileName(): string {
  try {
    return useProfilesStore().activeProfileName || 'default'
  } catch {
    return 'default'
  }
}

function runtimeStoragePrefix(): string {
  return activeRuntimeMode === 'global_agent' ? `${STORAGE_KEY_PREFIX}global_agent_` : STORAGE_KEY_PREFIX
}

function storageKey(): string { return runtimeStoragePrefix() + getProfileName() }
function legacyStorageKey(): string | null { return activeRuntimeMode === 'default' && getProfileName() === 'default' ? LEGACY_STORAGE_KEY : null }

function isCodingAgentLikeSession(session?: Pick<Session, 'source' | 'agent' | 'codingAgentId'> | null): boolean {
  return session?.source === 'coding_agent' ||
    Boolean(session?.codingAgentId) ||
    Boolean(agentToCodingAgentId(session?.agent))
}

function clearCodingAgentRuntimeCredentials(session?: Session | null) {
  if (!session || !isCodingAgentLikeSession(session)) return
  session.baseUrl = undefined
  session.apiKey = undefined
}

function shouldPreserveRuntimeApiMode(session?: Session | null): boolean {
  return isCodingAgentLikeSession(session) && session?.codingAgentMode !== 'global'
}

function isQuotaExceededError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { name?: string, code?: number }
  return e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014
}

function recoverStorageQuota() {
  try {
    // 清理所有会话相关的旧缓存（已完全废弃）
    const prefixes = [
      'hermes_sessions_cache_v1_',
      'hermes_session_msgs_v1_',
      'hermes_session_pins_v1_',
      'hermes_human_only_v1_',
    ]
    const keysToRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key) continue
      if (key === storageKey() || key === LEGACY_STORAGE_KEY) continue
      if (prefixes.some(prefix => key.startsWith(prefix))) {
        keysToRemove.push(key)
      }
    }
    keysToRemove.forEach(key => removeItem(key))
    if (keysToRemove.length > 0) {
      console.log(`Recovered storage: cleared ${keysToRemove.length} old session cache entries`)
    }
  } catch {
    // ignore
  }
}

function setItemBestEffort(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
    return
  } catch (error) {
    if (!isQuotaExceededError(error)) return
  }

  recoverStorageQuota()

  try {
    localStorage.setItem(key, value)
  } catch {
    // quota exceeded or private mode — ignore, cache is best-effort
  }
}

function getItemBestEffort(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function removeItem(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

// Strip the circular `file: File` reference from attachments before caching —
// File objects don't serialize and we only need name/type/size/url for display.

export const useChatStore = defineStore('chat', () => {
  const runtimeMode = ref<ChatRuntimeMode>(activeRuntimeMode)
  const seenSessionCommandEvents = new WeakSet<RunEvent>()
  const sessions = ref<Session[]>([])
  const activeSessionId = ref<string | null>(null)
  const focusMessageId = ref<string | null>(null)
  const streamStates = ref<Map<string, { abort: () => void }>>(new Map())
  /** sessionId → server-reported isWorking status */
  const serverWorking = ref<Set<string>>(new Set())
  /** Authoritative live delegation counts, never inferred from transcript history. */
  const backgroundPendingBySession = ref<Map<string, number>>(new Map())
  let runtimeGeneration = 0
  const backgroundObservers = new Map<string, () => void>()

  function clearBackgroundObservers() {
    for (const dispose of backgroundObservers.values()) dispose()
    backgroundObservers.clear()
    backgroundPendingBySession.value.clear()
  }

  const unsubscribeAuthInvalidation = onAuthInvalidated(() => {
    runtimeGeneration += 1
    clearBackgroundObservers()
    streamStates.value.clear()
    serverWorking.value.clear()
  })

  onScopeDispose(() => {
    unsubscribeAuthInvalidation()
    runtimeGeneration += 1
    clearBackgroundObservers()
  })

  function setBackgroundPending(sessionId: string, pending: unknown) {
    const count = Number(pending)
    if (Number.isFinite(count) && count > 0) {
      const session = sessions.value.find(s => s.id === sessionId)
      if (!session) return
      backgroundPendingBySession.value.set(sessionId, count)
      if (!backgroundObservers.has(sessionId)) {
        const generation = runtimeGeneration
        backgroundObservers.set(sessionId, observeBackgroundStatus(
          sessionId, session.profile || 'default', runtimeTransport(),
          pending => {
            if (generation === runtimeGeneration) setBackgroundPending(sessionId, pending)
          },
        ))
      }
    } else {
      backgroundPendingBySession.value.delete(sessionId)
      backgroundObservers.get(sessionId)?.()
      backgroundObservers.delete(sessionId)
    }
  }

  function applyBackgroundPendingEvent(sessionId: string, evt: RunEvent) {
    if (evt.background_pending != null || evt.event === 'run.completed' || evt.event === 'run.failed' || evt.event === 'abort.completed') {
      setBackgroundPending(sessionId, evt.background_pending)
    }
  }
  /** sessionIds with a terminal /fork command submitted but not settled yet */
  const pendingForkCommands = ref<Set<string>>(new Set())
  /** Sessions that completed while the user was viewing another session. */
  const completedUnreadSessions = ref<Set<string>>(new Set())
  /** UI-only live streams for Hermes background subagents. Never sent into parent context. */
  const subagentStreams = ref<Map<string, SubagentStream>>(new Map())
  const storedSessionProfileFilter = getItemBestEffort(SESSION_PROFILE_FILTER_STORAGE_KEY)?.trim()
  const sessionProfileFilter = ref<string | null>(
    storedSessionProfileFilter && storedSessionProfileFilter !== '__all__'
      ? storedSessionProfileFilter
      : null,
  )
  /** sessionId → queued message count */
  /**
   * When the run showing in each session began, as the server reported it.
   * A client that opens the page mid-run needs this: without it the thinking
   * timer counts from its own first render and restarts on every navigation.
   */
  const runStartedAt = ref<Map<string, number>>(new Map())

  function setRunStartedAt(sessionId: string, startedAt: number) {
    if (!sessionId || !(startedAt > 0)) return
    if (runStartedAt.value.get(sessionId) === startedAt) return
    runStartedAt.value = new Map(runStartedAt.value).set(sessionId, startedAt)
  }

  function clearRunStartedAt(sessionId: string) {
    if (!sessionId || !runStartedAt.value.has(sessionId)) return
    const next = new Map(runStartedAt.value)
    next.delete(sessionId)
    runStartedAt.value = next
  }

  /**
   * Every resume path has to agree about the run clock, and every terminal path
   * has to forget it — otherwise the next run in the same session inherits the
   * previous run's start and reports a far larger elapsed time.
   */
  function applyResumedRunActivity(sessionId: string, data: { isWorking?: boolean; runStartedAt?: number; backgroundPending?: number }) {
    setBackgroundPending(sessionId, data.backgroundPending)
    const startedAt = Number(data?.runStartedAt) || 0
    if (data?.isWorking && startedAt > 0) setRunStartedAt(sessionId, startedAt)
    else clearRunStartedAt(sessionId)
  }
  const queueLengths = ref<Map<string, number>>(new Map())
  /** sessionId → queued user messages not yet visible in the transcript */
  const queuedUserMessages = ref<Map<string, Message[]>>(new Map())
  /** sessionId → server-owned safe-boundary insertion state */
  const queueInsertionStates = ref<Map<string, QueueInsertionState>>(new Map())
  /** sessionId → queue ids that server reported as dequeued before the peer message arrived */
  const dequeuedQueueIds = ref<Map<string, Set<string>>>(new Map())
  /** sessionId → message selected as the reference for the next user turn */
  const messageReferences = ref<Map<string, MessageReference>>(new Map())
  const activeMessageReference = computed(() => {
    const sid = activeSessionId.value
    return sid ? messageReferences.value.get(sid) || null : null
  })
  const pendingApprovals = ref<Map<string, PendingApproval>>(new Map())
  const pendingApprovalResponseIds = new Map<string, string>()
  const activePendingApproval = computed(() => {
    const sid = activeSessionId.value
    return sid ? pendingApprovals.value.get(sid) || null : null
  })

  const pendingClarifies = ref<Map<string, PendingClarify>>(new Map())
  const pendingClarifyResponseIds = new Map<string, string>()
  const activePendingClarify = computed(() => {
    const sid = activeSessionId.value
    return sid ? pendingClarifies.value.get(sid) || null : null
  })

  function setSessionProfileFilter(profile: string | null) {
    const normalized = profile?.trim()
    sessionProfileFilter.value = normalized && normalized !== '__all__' ? normalized : null
    if (sessionProfileFilter.value) {
      setItemBestEffort(SESSION_PROFILE_FILTER_STORAGE_KEY, sessionProfileFilter.value)
    } else {
      removeItem(SESSION_PROFILE_FILTER_STORAGE_KEY)
    }
  }

  function validateSessionProfileFilter(profileNames: string[]) {
    const current = sessionProfileFilter.value
    if (!current || profileNames.length === 0 || profileNames.includes(current)) return
    setSessionProfileFilter(null)
  }

  // 自动播放语音开关
  const autoPlaySpeechEnabled = ref(false)

  function setAutoPlaySpeech(enabled: boolean) {
    autoPlaySpeechEnabled.value = enabled
  }
  const isStreaming = computed(() => {
    const sid = activeSessionId.value
    if (sid == null) return false
    return streamStates.value.has(sid) || serverWorking.value.has(sid)
  })
  const isForkPending = computed(() => {
    const sid = activeSessionId.value
    return sid != null && pendingForkCommands.value.has(sid)
  })
  const isLoadingSessions = ref(false)
  const sessionsLoaded = ref(false)
  const messageLoadRequests = ref<Map<string, number>>(new Map())
  const isLoadingMessages = computed(() => {
    const sid = activeSessionId.value
    return sid ? messageLoadRequests.value.has(sid) : false
  })
  const isRunActive = computed(() => isStreaming.value)
  let loadSessionsRequestSequence = 0
  let switchSessionRequestSequence = 0
  const olderMessageLoads = new WeakMap<Session, object>()
  let activeSelectionSequence = 0
  const reasoningEffortWriteChains = new Map<string, Promise<boolean>>()
  const reasoningEffortWriteTargets = new Map<string, string | undefined>()
  const reasoningEffortConfirmedValues = new Map<string, string | undefined>()
  const pushEnabledWriteChains = new Map<string, Promise<boolean>>()
  const pushEnabledWriteTargets = new Map<string, boolean>()
  const pushEnabledConfirmedValues = new Map<string, boolean>()

  function beginMessageLoad(sessionId: string, requestSequence: number) {
    const next = new Map(messageLoadRequests.value)
    next.set(sessionId, requestSequence)
    messageLoadRequests.value = next
  }

  function endMessageLoad(sessionId: string, requestSequence: number) {
    if (messageLoadRequests.value.get(sessionId) !== requestSequence) return
    const next = new Map(messageLoadRequests.value)
    next.delete(sessionId)
    messageLoadRequests.value = next
  }

  async function fetchRuntimeSessions(profile?: string | null): Promise<SessionSummary[]> {
    const scopedProfile = profile || undefined
    if (runtimeMode.value === 'global_agent') return fetchSessions('global_agent', undefined, scopedProfile)

    const [localSessions, globalSessions] = await Promise.all([
      fetchSessions(undefined, undefined, scopedProfile),
      fetchSessions('global_agent', undefined, scopedProfile),
    ])
    const byId = new Map<string, SessionSummary>()
    for (const session of [...localSessions, ...globalSessions]) byId.set(session.id, session)
    return [...byId.values()].sort((a, b) =>
      sessionActivitySeconds(b) - sessionActivitySeconds(a),
    )
  }

  function runtimeTransport(): ChatRunTransport {
    return runtimeMode.value === 'global_agent' ? 'global-agent' : 'chat-run'
  }

  function setRuntimeMode(mode: ChatRuntimeMode) {
    if (runtimeMode.value === mode) return
    activeRuntimeMode = mode
    runtimeMode.value = mode
    runtimeGeneration += 1
    clearBackgroundObservers()
    sessions.value = []
    completedUnreadSessions.value = new Set()
    queueLengths.value = new Map()
    queuedUserMessages.value = new Map()
    queueInsertionStates.value = new Map()
    pendingApprovals.value = new Map()
    pendingClarifies.value = new Map()
    pendingApprovalResponseIds.clear()
    pendingClarifyResponseIds.clear()
    streamStates.value = new Map()
    serverWorking.value = new Set()
    pendingForkCommands.value = new Set()
    workspaceRunChangesBySession.value = new Map()
    abortStates.value = new Map()
    sessionsLoaded.value = false
    clearActiveSession()
  }

  // Compression state is scoped per session because sockets can stay joined to
  // background sessions while another chat is active.
  const compressionStates = ref<Map<string, CompressionState>>(new Map())
  const compressionState = computed<CompressionState | null>(() => {
    const sid = activeSessionId.value
    return sid ? compressionStates.value.get(sid) || null : null
  })

  function setCompressionState(sessionId: string | null | undefined, state: CompressionState | null) {
    if (!sessionId) return
    const next = new Map(compressionStates.value)
    if (state) next.set(sessionId, state)
    else next.delete(sessionId)
    compressionStates.value = next
  }

  // Abort state is scoped per session because background sockets remain active
  // while another conversation is selected.
  const abortStates = ref<Map<string, AbortState>>(new Map())

  function setAbortState(sessionId: string | null | undefined, state: AbortState | null) {
    if (!sessionId) return
    const next = new Map(abortStates.value)
    if (state) next.set(sessionId, state)
    else next.delete(sessionId)
    abortStates.value = next
  }

  const abortState = computed<AbortState | null>({
    get: () => {
      const sid = activeSessionId.value
      return sid ? abortStates.value.get(sid) || null : null
    },
    set: state => setAbortState(activeSessionId.value, state),
  })
  const isAborting = computed(() => abortState.value?.aborting === true)

  const activeSession = ref<Session | null>(null)
  const messages = computed<Message[]>(() => activeSession.value?.messages || [])
  const workspaceRunChangesBySession = ref<Map<string, Map<string, WorkspaceRunChangeSummary>>>(new Map())

  function isSessionLive(sessionId: string): boolean {
    return streamStates.value.has(sessionId) || serverWorking.value.has(sessionId)
  }

  // Display activity is broader than foreground execution (send/queue/voice).
  function isSessionWorking(sessionId: string): boolean {
    return isSessionLive(sessionId) || (backgroundPendingBySession.value.get(sessionId) || 0) > 0
  }

  function isSessionCompletedUnread(sessionId: string): boolean {
    return completedUnreadSessions.value.has(sessionId)
  }

  function clearSessionCompletedUnread(sessionId: string) {
    if (!completedUnreadSessions.value.has(sessionId)) return
    const next = new Set(completedUnreadSessions.value)
    next.delete(sessionId)
    completedUnreadSessions.value = next
  }

  function setMessageReference(sessionId: string, reference: MessageReference) {
    const next = new Map(messageReferences.value)
    next.set(sessionId, reference)
    messageReferences.value = next
  }

  function clearMessageReference(sessionId: string) {
    if (!messageReferences.value.has(sessionId)) return
    const next = new Map(messageReferences.value)
    next.delete(sessionId)
    messageReferences.value = next
  }

  function markSessionCompletedUnread(sessionId: string, hasQueue = false) {
    if (hasQueue) {
      return
    }
    if (activeSessionId.value === sessionId) {
      clearSessionCompletedUnread(sessionId)
      return
    }
    const next = new Set(completedUnreadSessions.value)
    next.add(sessionId)
    completedUnreadSessions.value = next
  }

  function pruneCompletedUnreadSessions(existingIds: Set<string>) {
    const next = new Set([...completedUnreadSessions.value].filter(id => existingIds.has(id)))
    if (next.size !== completedUnreadSessions.value.size) completedUnreadSessions.value = next
  }

  function clearActiveSession() {
    activeSelectionSequence++
    const sid = activeSessionId.value
    activeSessionId.value = null
    activeSession.value = null
    focusMessageId.value = null
    setAbortState(sid, null)
    setCompressionState(sid, null)
    removeItem(storageKey())
  }

  function attachWorkspaceChangesToMessages(sessionId: string) {
    const target = sessions.value.find(session => session.id === sessionId)
    if (!target) return
    const changes = workspaceRunChangesBySession.value.get(sessionId)
    target.messages = target.messages.filter(
      message => !message.id.startsWith(LEGACY_WORKSPACE_RUN_CHANGE_MESSAGE_PREFIX),
    )
    if (!changes) {
      for (const message of target.messages) message.workspaceChanges = []
      return
    }
    const runChanges = [...changes.values()].filter(change => change?.source === 'run')
    attachWorkspaceChangesToExactTurns(target.messages, runChanges)
  }

  function setWorkspaceRunChanges(sessionId: string, changes: WorkspaceRunChangeSummary[]) {
    const next = new Map(workspaceRunChangesBySession.value)
    const byChangeId = new Map<string, WorkspaceRunChangeSummary>()
    for (const change of changes) {
      if (change?.change_id) byChangeId.set(change.change_id, change)
    }
    next.set(sessionId, byChangeId)
    workspaceRunChangesBySession.value = next
    attachWorkspaceChangesToMessages(sessionId)
  }

  function mergeWorkspaceRunChanges(sessionId: string, changes: WorkspaceRunChangeSummary[]) {
    const next = new Map(workspaceRunChangesBySession.value)
    const byChangeId = new Map(next.get(sessionId) || [])
    for (const change of changes) {
      if (change?.change_id) byChangeId.set(change.change_id, change)
    }
    next.set(sessionId, byChangeId)
    workspaceRunChangesBySession.value = next
    attachWorkspaceChangesToMessages(sessionId)
  }

  function upsertWorkspaceRunChange(sessionId: string, change: WorkspaceRunChangeSummary | null | undefined) {
    if (!change?.change_id) return
    const next = new Map(workspaceRunChangesBySession.value)
    const current = new Map(next.get(sessionId) || [])
    current.set(change.change_id, change)
    next.set(sessionId, current)
    workspaceRunChangesBySession.value = next
    attachWorkspaceChangesToMessages(sessionId)
  }

  function handleWorkspaceRunChangeEvent(
    sessionId: string,
    evt: any,
    assistantMessageId?: string | null,
  ): string | null {
    const change = evt?.change as WorkspaceRunChangeSummary | undefined
    const target = sessions.value.find(session => session.id === sessionId)
    const alignedAssistantMessageId = target
      ? alignWorkspaceChangeAssistantMessage(target.messages, change, assistantMessageId)
      : assistantMessageId || null
    upsertWorkspaceRunChange(sessionId, change)
    return alignedAssistantMessageId
  }

  function handleTerminalWorkspaceRunChange(
    sessionId: string,
    evt: any,
    assistantMessageId?: string | null,
  ) {
    const change = evt?.workspace_run_change as WorkspaceRunChangeSummary | undefined
    const target = sessions.value.find(session => session.id === sessionId)
    if (target) alignWorkspaceChangeAssistantMessage(target.messages, change, assistantMessageId)
    upsertWorkspaceRunChange(sessionId, change)
  }

  async function loadWorkspaceRunChangeFile(sessionId: string, toolCallId: string, fileId: number): Promise<WorkspaceRunChangeFileDetail | null> {
    return fetchWorkspaceRunChangeFile(sessionId, toolCallId, fileId)
  }

  function ensureSessionLoaded(summary: SessionSummary): Session {
    const existing = sessions.value.find(session => session.id === summary.id)
    const mapped = mapHermesSession(summary)
    if (existing) {
      Object.assign(existing, {
        ...mapped,
        messages: existing.messages,
        contextTokens: existing.contextTokens,
        apiMode: mapped.apiMode || existing.apiMode,
        loadedMessageCount: existing.loadedMessageCount,
        hasMoreBefore: existing.hasMoreBefore,
      })
      return existing
    }
    sessions.value.unshift(mapped)
    return mapped
  }

  async function loadSessions(profile?: string | null, preferredSessionId?: string | null) {
    const requestSequence = ++loadSessionsRequestSequence
    const selectionSequence = activeSelectionSequence
    isLoadingSessions.value = true
    try {
      const list = await fetchRuntimeSessions(profile)
      if (requestSequence !== loadSessionsRequestSequence) return
      const fresh = list.map(mapHermesSession)
      const selectionChanged = selectionSequence !== activeSelectionSequence
      // Search can select a session outside the sidebar's first page. Keep
      // that selection when mounting its route, including title-only hits.
      const preserveSelection = selectionChanged || focusMessageId.value
        || (preferredSessionId && preferredSessionId === activeSessionId.value)
      const explicitlySelectedSession = preserveSelection && activeSessionId.value
        ? sessions.value.find(session => session.id === activeSessionId.value) || activeSession.value
        : null
      // Preserve already-loaded messages for sessions that are still present,
      // so we don't blow away the active session's messages on refresh.
      const runtimeByIdBefore = new Map(sessions.value.map(s => [s.id, {
        messages: s.messages,
        contextTokens: s.contextTokens,
        apiMode: s.apiMode,
      }]))
      for (const s of fresh) {
        const prev = runtimeByIdBefore.get(s.id)
        if (prev?.messages?.length) s.messages = prev.messages
        if (prev?.contextTokens != null) s.contextTokens = prev.contextTokens
        if (!s.apiMode && prev?.apiMode) s.apiMode = prev.apiMode
      }
      const freshIds = new Set(fresh.map(session => session.id))
      const localOnlySessions = sessions.value.filter(session =>
        session.isLocalOnly
        && !freshIds.has(session.id)
        && (!profile || session.profile === profile),
      )
      if (
        explicitlySelectedSession
        && !freshIds.has(explicitlySelectedSession.id)
        && !localOnlySessions.some(session => session.id === explicitlySelectedSession.id)
      ) {
        localOnlySessions.unshift(explicitlySelectedSession)
      }
      sessions.value = [...localOnlySessions, ...fresh]
      pruneCompletedUnreadSessions(new Set(sessions.value.map(s => s.id)))

      // A session load may have started before the user selected or created a
      // different chat. Keep the refreshed list, but do not let that stale
      // continuation take ownership of the active selection.
      if (selectionChanged) {
        activeSession.value = activeSessionId.value
          ? sessions.value.find(session => session.id === activeSessionId.value) || null
          : null
        return
      }

      // Restore route-selected session first (tab-local source of truth),
      // then current in-memory session, then persisted legacy/default choice,
      // then fallback to the most recent session.
      const currentId = activeSessionId.value
      const legacyActiveKey = legacyStorageKey()
      const storedId = getItemBestEffort(storageKey()) || (legacyActiveKey ? getItemBestEffort(LEGACY_STORAGE_KEY) : null)
      const targetId = preferredSessionId && sessions.value.some(s => s.id === preferredSessionId)
        ? preferredSessionId
        : currentId && sessions.value.some(s => s.id === currentId)
          ? currentId
          : storedId && sessions.value.some(s => s.id === storedId)
            ? storedId
            : sessions.value[0]?.id
      if (targetId) {
        await switchSession(targetId, targetId === currentId ? focusMessageId.value : null)
      } else {
        clearActiveSession()
      }
    } catch (err) {
      if (requestSequence === loadSessionsRequestSequence) {
        console.error('Failed to load sessions:', err)
      }
    } finally {
      if (requestSequence === loadSessionsRequestSequence) {
        isLoadingSessions.value = false
        sessionsLoaded.value = true
      }
    }
  }

  // Refresh ONLY the session list metadata (titles, ordering, new/removed
  // sessions) without switching the active session or reloading its messages.
  // Used for live sync so sessions created elsewhere (CLI, Telegram, another
  // device) appear without a manual reload. Skips while streaming to avoid
  // churn.
  //
  // CRITICAL: this MERGES IN-PLACE into the existing session objects instead of
  // replacing the array with `mapHermesSession` clones. `activeSession` is a ref
  // bound to a specific object inside `sessions.value` (see switchSession), and
  // streaming deltas mutate that same object via `sessions.value.find(...)`. If
  // we swapped in fresh objects, `activeSession.value` would point at an orphan
  // and live messages would stop appearing until a manual reload. Mutating the
  // existing objects preserves referential identity so streaming keeps working.
  async function refreshSessionListOnly(profile?: string | null): Promise<void> {
    if (isStreaming.value) return
    if (isLoadingSessions.value) return
    try {
      const list = await fetchRuntimeSessions(profile ?? sessionProfileFilter.value)
      const incoming = list.map(mapHermesSession)
      const existingById = new Map(sessions.value.map(s => [s.id, s]))
      const incomingIds = new Set(incoming.map(s => s.id))

      // Build the next array reusing existing objects (identity-preserving) and
      // inserting genuinely-new sessions as fresh objects.
      const next: Session[] = []
      for (const fresh of incoming) {
        const existing = existingById.get(fresh.id)
        if (existing) {
          // Update scalar metadata in-place; never touch runtime/scroll state
          // (messages, loadedMessageCount, hasMoreBefore, contextTokens).
          existing.title = fresh.title
          existing.source = fresh.source
          existing.updatedAt = fresh.updatedAt
          existing.lastActiveAt = fresh.lastActiveAt
          existing.endedAt = fresh.endedAt
          existing.model = fresh.model
          existing.provider = fresh.provider
          existing.apiMode = fresh.apiMode || existing.apiMode
          existing.reasoningEffort = fresh.reasoningEffort
          if (!pushEnabledWriteTargets.has(existing.id)) existing.pushEnabled = fresh.pushEnabled
          existing.messageCount = fresh.messageCount
          existing.inputTokens = fresh.inputTokens
          existing.outputTokens = fresh.outputTokens
          existing.workspace = fresh.workspace
          existing.isPinned = fresh.isPinned
          existing.categoryId = fresh.categoryId
          existing.isLocalOnly = false
          // messageTotal: keep the larger of server count vs what we've loaded,
          // so we don't shrink below already-rendered messages mid-session.
          if (fresh.messageTotal != null) {
            existing.messageTotal = Math.max(fresh.messageTotal, existing.loadedMessageCount || 0)
          }
          next.push(existing)
        } else {
          next.push(fresh)
        }
      }

      // Keep the active session even if the server no longer lists it (don't
      // pull the rug out from under what the user is viewing).
      const activeId = activeSessionId.value
      if (activeId && !incomingIds.has(activeId)) {
        const keep = existingById.get(activeId)
        if (keep) next.push(keep)
      }

      sessions.value = next
      pruneCompletedUnreadSessions(new Set(next.map(s => s.id)))

      // Defensive: re-bind activeSession to the (same) object now in the array,
      // by id, in case anything above changed array membership.
      if (activeId) {
        const again = sessions.value.find(s => s.id === activeId)
        if (again && activeSession.value !== again) activeSession.value = again
      }
    } catch (err) {
      console.error('Failed to refresh session list:', err)
    }
  }

  // Re-pull active session from server. Used on tab-visible events.
  async function refreshActiveSession(): Promise<boolean> {
    const sid = activeSessionId.value
    if (!sid) return false
    try {
      const target = sessions.value.find(s => s.id === sid)
      if (!target) return false
      const limit = focusMessageId.value
        ? Math.max(target.loadedMessageCount || LIVE_CHAT_MESSAGE_PAGE_SIZE, LIVE_CHAT_MESSAGE_PAGE_SIZE)
        : Math.min(
          Math.max(target.loadedMessageCount || LIVE_CHAT_MESSAGE_PAGE_SIZE, LIVE_CHAT_MESSAGE_PAGE_SIZE),
          LIVE_CHAT_MAX_LOADED_MESSAGES,
        )
      const detail = await fetchSessionMessagesPage(sid, 0, limit, activeSession.value?.profile)
      if (!detail) return false
      const mapped = mapHermesMessages(detail.messages || [], detail.taskPlans, target.messages)
      target.messages = mapped
      restorePersistedSubagentStreams(sid)
      setWorkspaceRunChanges(sid, detail.workspaceRunChanges || [])
      target.loadedMessageCount = detail.messages.length
      target.messageTotal = detail.total
      target.messageCount = detail.total
      target.hasMoreBefore = detail.hasMore
      if (detail.session.title) target.title = detail.session.title
      target.workspace = detail.session.workspace || target.workspace || null
      target.isPinned = Boolean(detail.session.is_pinned)
      target.categoryId = detail.session.category_id ?? null
      if (!pushEnabledWriteTargets.has(sid)) target.pushEnabled = Boolean(detail.session.push_enabled)
      target.isLocalOnly = false
      target.parentSessionId = detail.session.parent_session_id || target.parentSessionId || null
      target.forkPointMessageId = (detail.session as any).fork_point_message_id != null ? String((detail.session as any).fork_point_message_id) : target.forkPointMessageId || null
      target.parentTitle = detail.session.parent_title || target.parentTitle || null
      target.parentLastMessage = detail.session.parent_last_message || target.parentLastMessage || null
      target.parentLastMessageRole = detail.session.parent_last_message_role || target.parentLastMessageRole || null
      return true
    } catch (err) {
      console.error('Failed to refresh active session:', err)
      return false
    }
  }


  function createSession(options: {
    profile?: string
    model?: string
    provider?: string
    source?: 'api_server' | 'cli' | 'coding_agent' | 'global_agent' | 'workflow' | 'group_chat'
    agent?: ChatAgentId
    codingAgentId?: ChatCodingAgentId
    codingAgentMode?: 'global' | 'scoped'
    agentPreset?: string
    workspace?: string | null
    categoryId?: number | null
    baseUrl?: string
    apiKey?: string
    apiMode?: ProviderApiMode
  } = {}): Session {
    const source = runtimeMode.value === 'global_agent' ? 'global_agent' : options.source || 'cli'
    const codingAgentId = options.codingAgentId || agentToCodingAgentId(options.agent)
    const codingAgentMode = codingAgentId ? (options.codingAgentMode || 'scoped') : undefined
    const session: Session = {
      id: uid(),
      profile: options.profile || useProfilesStore().activeProfileName || 'default',
      title: '',
      source,
      agent: options.agent || codingAgentIdToAgent(codingAgentId) || 'hermes',
      codingAgentId,
      codingAgentMode,
      agentPreset: options.agentPreset,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: options.model || undefined,
      provider: options.provider || '',
      workspace: options.workspace || null,
      categoryId: options.categoryId ?? null,
      isLocalOnly: true,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      apiMode: options.apiMode,
    }
    sessions.value.unshift(session)
    return session
  }

  function newCliSession(): Session {
    const now = new Date()
    const ts = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      '_',
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join('')
    const hex = Math.random().toString(16).slice(2, 8)
    const session: Session = {
      id: `${ts}_${hex}`,
      title: '',
      source: runtimeMode.value === 'global_agent' ? 'global_agent' : 'cli',
      agent: 'hermes',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    sessions.value.unshift(session)
    return session
  }

  async function switchSession(sessionId: string, focusId?: string | null) {
    const generation = runtimeGeneration
    activeSelectionSequence++
    const requestSequence = ++switchSessionRequestSequence
    const isCurrentSelection = () => generation === runtimeGeneration
      && activeSessionId.value === sessionId
      && requestSequence === switchSessionRequestSequence
    clearThinkingObservationFor(sessionId)
    activeSessionId.value = sessionId
    focusMessageId.value = focusId ?? null
    setItemBestEffort(storageKey(), sessionId)
    const legacyActiveKey = legacyStorageKey()
    if (legacyActiveKey) removeItem(legacyActiveKey)
    activeSession.value = sessions.value.find(s => s.id === sessionId) || null
    clearSessionCompletedUnread(sessionId)

    if (!activeSession.value) return false

    beginMessageLoad(sessionId, requestSequence)
    let backgroundPendingOnResume = 0

    let loaded = false
    try {
      // Load messages via Socket.IO resume (server loads from DB if not in memory)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('resume timeout')), 15_000)
        resumeSession(sessionId, (data) => {
          clearTimeout(timeout)
          if (
            data.session_id !== sessionId
            || generation !== runtimeGeneration
            || activeSessionId.value !== sessionId
            || requestSequence !== switchSessionRequestSequence
          ) {
            resolve()
            return
          }
          const target = sessions.value.find(s => s.id === sessionId)
          if (!target) {
            resolve()
            return
          }
          if (data.isWorking) {
            serverWorking.value.add(sessionId)
          } else {
            serverWorking.value.delete(sessionId)
          }
          backgroundPendingOnResume = Number(data.backgroundPending || 0)
          if (data.queueLength && data.queueLength > 0) {
            queueLengths.value.set(sessionId, data.queueLength)
          } else {
            queueLengths.value.delete(sessionId)
          }
          if (Array.isArray((data as any).queueMessages)) {
            replaceQueuedUserMessages(sessionId, normalizeQueuedUserMessages((data as any).queueMessages))
          } else if (!data.queueLength) {
            replaceQueuedUserMessages(sessionId, [])
          }
          replaceQueueInsertionState(sessionId, data.queueInsertion)
          applyResumedRunActivity(sessionId, data as any)
          if ((data as any).isAborting) {
            setAbortState(sessionId, { aborting: true, synced: null })
          } else if (!data.isWorking) {
            setAbortState(sessionId, null)
          }
          if (!data.isWorking) setCompressionState(sessionId, null)
          if (data.inputTokens != null) target.inputTokens = data.inputTokens
          if (data.outputTokens != null) target.outputTokens = data.outputTokens
          if ((data as any).contextTokens != null) target.contextTokens = (data as any).contextTokens
          applyResumedSessionSettings(data)
          if (typeof data.workspace === 'string') {
            target.workspace = data.workspace.trim() || null
            target.isLocalOnly = false
          }
          target.parentSessionId = (data as any).parentSessionId || target.parentSessionId || null
          target.forkPointMessageId = (data as any).forkPointMessageId != null ? String((data as any).forkPointMessageId) : target.forkPointMessageId || null
          target.parentTitle = (data as any).parentTitle || target.parentTitle || null
          target.parentLastMessage = (data as any).parentLastMessage || target.parentLastMessage || null
          target.parentLastMessageRole = (data as any).parentLastMessageRole || target.parentLastMessageRole || null
          if (Array.isArray(data.messages)) {
            target.messages = mapHermesMessages(data.messages as any[], data.taskPlans, target.messages)
            restorePersistedSubagentStreams(sessionId)
            setWorkspaceRunChanges(sessionId, data.workspaceRunChanges || [])
            target.loadedMessageCount = data.messageLoadedCount ?? data.messages.length
            target.messageTotal = data.messageTotal ?? target.messageCount ?? target.loadedMessageCount
            target.messageCount = target.messageTotal
            target.hasMoreBefore = data.hasMoreBefore ?? target.loadedMessageCount < target.messageTotal
          }
          if (!target.title) {
            const firstUser = target.messages.find(m => m.role === 'user')
            if (firstUser) {
              const t = firstUser.content.slice(0, 40)
              target.title = t + (firstUser.content.length > 40 ? '...' : '')
            }
          }
          activeSession.value = target
          // Process replayed events (compression state etc.)
          if (data.events?.length) {
            for (const evt of data.events) {
              const e = evt.data as any
              if (e.event === 'compression.started') {
                setCompressionState(sessionId, {
                  compressing: true,
                  messageCount: e.message_count || 0,
                  beforeTokens: e.token_count || 0,
                  afterTokens: 0,
                  compressed: null,
                })
              } else if (e.event === 'compression.completed') {
                const afterTokens = e.contextTokens || e.afterTokens || 0
                setCompressionState(sessionId, {
                  compressing: false,
                  messageCount: e.totalMessages || 0,
                  beforeTokens: e.beforeTokens || 0,
                  afterTokens,
                  compressed: e.compressed ?? false,
                  error: e.error,
                })
                if (e.contextTokens != null) target.contextTokens = e.contextTokens
              } else if (e.event === 'abort.started') {
                setAbortState(sessionId, { aborting: true, synced: null })
              } else if (e.event === 'abort.timeout') {
                setAbortState(sessionId, { aborting: true, synced: false, timedOut: true, message: (e as any).message })
              } else if (e.event === 'abort.completed') {
                setAbortState(sessionId, { aborting: false, synced: e.synced ?? false })
                settleInterruptedSubagents(sessionId)
              } else if (e.event === 'approval.requested') {
                setPendingApproval({ ...e, session_id: sessionId } as RunEvent)
              } else if (e.event === 'approval.resolved') {
                clearPendingApproval({ ...e, session_id: sessionId } as RunEvent)
              } else if (e.event === 'clarify.requested') {
                setPendingClarify({ ...e, session_id: sessionId } as RunEvent)
              } else if (e.event === 'clarify.resolved') {
                clearPendingClarify({ ...e, session_id: sessionId } as RunEvent)
              } else if (e.event === 'run.failed') {
                handleTerminalWorkspaceRunChange(sessionId, e)
                addAgentErrorMessage(sessionId, e.error)
                serverWorking.value.delete(sessionId)
                queueLengths.value.delete(sessionId)
              } else if (e.event === 'plan.updated' || e.event === 'agent.event' || e.event === 'run.reattach_failed') {
                handleAgentEvent(e)
              } else if (e.event === 'workspace.diff.completed') {
                handleWorkspaceRunChangeEvent(sessionId, e)
              } else if (e.event === 'tool.started') {
                handleToolStartedEvent(sessionId, e as RunEvent)
              } else if (e.event === 'tool.completed' || e.event === 'tool.failed') {
                handleToolCompletedEvent(sessionId, e as RunEvent)
              } else if (e.event === 'moa.reference' || e.event === 'moa.aggregating') {
                handleMoaEvent(sessionId, e as RunEvent)
              } else if (String(e.event || '').startsWith('subagent.') || e.event === 'delegation.updated') {
                handleSubagentEvent(sessionId, e as RunEvent)
              }
            }
          }
          if (Array.isArray(data.backgroundTasks)) {
            for (const task of data.backgroundTasks) {
              const lastEvent = String(task.last_event || '')
              const status = String(task.status || '')
              const event = lastEvent.startsWith('subagent.')
                ? lastEvent
                : status === 'running' ? 'subagent.progress' : 'subagent.complete'
              handleSubagentEvent(sessionId, {
                ...task,
                event,
                session_id: sessionId,
                background_snapshot: true,
                subagent_id: task.subagent_id,
                tool: task.last_tool,
                name: task.last_tool,
                text: task.preview,
                duration_seconds: task.duration_seconds,
              } as RunEvent)
            }
          }
          resolve()
        }, activeSession.value?.profile, runtimeTransport())
      })
      // A search hit can be older than both the resume page and the live-chat
      // history cap. Only explicit message navigation may extend that window.
      while (focusId && isCurrentSelection()) {
        const target = activeSession.value
        if (!target || target.messages.some(message => message.id === focusId)) break
        const offset = target.loadedMessageCount || 0
        if (!await loadOlderMessages(sessionId, isCurrentSelection)) break
        if ((target.loadedMessageCount || 0) <= offset) break
      }
      loaded = isCurrentSelection() && (!focusId || !!activeSession.value?.messages.some(message => message.id === focusId))
      if (isCurrentSelection() && !loaded) focusMessageId.value = null
    } catch (err) {
      console.error('Failed to load session messages via resume:', err)
      if (isCurrentSelection()) focusMessageId.value = null
    } finally {
      endMessageLoad(sessionId, requestSequence)
    }

    // Resume in-flight run event listeners if needed
    if (generation === runtimeGeneration && activeSessionId.value === sessionId && requestSequence === switchSessionRequestSequence) {
      resumeServerWorkingRun(sessionId, backgroundPendingOnResume > 0, !serverWorking.value.has(sessionId))
    }
    return loaded
  }

  async function loadOlderMessages(sessionId = activeSessionId.value, searchSelection?: () => boolean): Promise<boolean> {
    if (!sessionId) return false
    const target = sessions.value.find(s => s.id === sessionId)
    if (!target || (!searchSelection && target.isLoadingOlderMessages) || !target.hasMoreBefore) return false
    const offset = target.loadedMessageCount || 0
    if (!searchSelection && offset >= LIVE_CHAT_MAX_LOADED_MESSAGES) return false
    const limit = searchSelection
      ? LIVE_CHAT_MESSAGE_PAGE_SIZE
      : Math.min(LIVE_CHAT_MESSAGE_PAGE_SIZE, LIVE_CHAT_MAX_LOADED_MESSAGES - offset)
    const loadToken = {}
    const previousMessages = target.messages
    olderMessageLoads.set(target, loadToken)
    target.isLoadingOlderMessages = true
    try {
      const page = await fetchSessionMessagesPage(sessionId, offset, limit, target.profile)
      if (olderMessageLoads.get(target) !== loadToken || target.messages !== previousMessages
        || (searchSelection && !searchSelection())) return false
      if (!page) return false
      if (page.messages.length === 0) {
        target.hasMoreBefore = false
        return false
      }

      const existingIds = new Set(target.messages.map(message => message.id))
      const olderMessages = mapHermesMessages(page.messages).filter(message => !existingIds.has(message.id))
      target.messages = mergeTaskPlanMessages([...olderMessages, ...target.messages], page.taskPlans || [], sessionId)
      restorePersistedSubagentStreams(sessionId)
      mergeWorkspaceRunChanges(sessionId, page.workspaceRunChanges || [])
      target.loadedMessageCount = offset + page.messages.length
      target.messageTotal = page.total
      target.messageCount = page.total
      target.hasMoreBefore = page.hasMore
      return olderMessages.length > 0
    } catch (err) {
      console.error('Failed to load older session messages:', err)
      return false
    } finally {
      if (olderMessageLoads.get(target) === loadToken) {
        olderMessageLoads.delete(target)
        target.isLoadingOlderMessages = false
      }
    }
  }

  function newChat(options: {
    profile?: string
    model?: string
    provider?: string
    source?: 'api_server' | 'cli' | 'coding_agent' | 'global_agent' | 'workflow' | 'group_chat'
    agent?: ChatAgentId
    codingAgentId?: ChatCodingAgentId
    codingAgentMode?: 'global' | 'scoped'
    agentPreset?: string
    workspace?: string | null
    categoryId?: number | null
    baseUrl?: string
    apiKey?: string
    apiMode?: ProviderApiMode
  } = {}): Session {
    const appStore = useAppStore()
    const storageSource = runtimeMode.value === 'global_agent' ? 'global_agent' : options.source || 'cli'
    const codingAgentId = options.codingAgentId || agentToCodingAgentId(options.agent)
    const isGlobalCodingAgent = Boolean(codingAgentId) && options.codingAgentMode === 'global'
    const session = createSession({
      profile: options.profile,
      model: isGlobalCodingAgent ? undefined : options.model || appStore.selectedModel || undefined,
      provider: isGlobalCodingAgent ? '' : options.provider || appStore.selectedProvider || '',
      source: storageSource,
      agent: options.agent,
      codingAgentId,
      codingAgentMode: options.codingAgentMode,
      agentPreset: options.agentPreset,
      workspace: options.workspace,
      categoryId: options.categoryId,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      apiMode: options.apiMode,
    })
    void switchSession(session.id)
    return session
  }

  async function switchSessionModel(modelId: string, provider?: string, sessionId?: string, apiMode?: ProviderApiMode): Promise<boolean> {
    const targetId = sessionId || activeSession.value?.id
    if (!targetId) return false
    const target = sessions.value.find(s => s.id === targetId)
    const activeTarget = activeSession.value?.id === targetId ? activeSession.value : null
    const session = target || activeTarget
    if (session?.codingAgentMode === 'global' && isCodingAgentLikeSession(session)) return false
    const previousProvider = String(target?.provider ?? activeTarget?.provider ?? '')
    const nextProvider = provider || ''
    const shouldClearRuntimeCredentials = previousProvider !== nextProvider && (
      isCodingAgentLikeSession(target) || isCodingAgentLikeSession(activeTarget)
    )
    const preservedApiMode = apiMode || (previousProvider === nextProvider
      ? (shouldPreserveRuntimeApiMode(target) ? target?.apiMode : undefined) ||
        (shouldPreserveRuntimeApiMode(activeTarget) ? activeTarget?.apiMode : undefined)
      : undefined)
    const isLocalOnly = target?.isLocalOnly === true || activeTarget?.isLocalOnly === true
    if (!isLocalOnly) {
      await reasoningEffortWriteChains.get(targetId)?.catch(() => false)
      const ok = await setSessionModel(targetId, modelId, provider || '', preservedApiMode)
      if (!ok) return false
    }
    if (target) {
      target.model = modelId
      target.provider = provider || ''
      target.apiMode = preservedApiMode
      target.reasoningEffort = undefined
      if (shouldClearRuntimeCredentials) clearCodingAgentRuntimeCredentials(target)
    }
    if (activeTarget) {
      activeTarget.model = modelId
      activeTarget.provider = provider || ''
      activeTarget.apiMode = preservedApiMode
      activeTarget.reasoningEffort = undefined
      if (shouldClearRuntimeCredentials) clearCodingAgentRuntimeCredentials(activeTarget)
    }
    return true
  }

  async function deleteSession(sessionId: string): Promise<boolean> {
    const target = sessions.value.find(s => s.id === sessionId)
    const ok = await deleteSessionApi(sessionId, target?.profile)
    if (!ok) return false
    setBackgroundPending(sessionId, 0)
    sessions.value = sessions.value.filter(s => s.id !== sessionId)
    clearMessageReference(sessionId)
    setAbortState(sessionId, null)
    if (activeSessionId.value === sessionId) {
      if (sessions.value.length > 0) {
        await switchSession(sessions.value[0].id)
      } else {
        const session = createSession()
        switchSession(session.id)
      }
    }
    return true
  }

  async function archiveSession(sessionId: string): Promise<boolean> {
    const target = sessions.value.find(s => s.id === sessionId)
    const ok = await archiveSessionApi(sessionId)
    if (!ok) return false
    setBackgroundPending(sessionId, 0)
    sessions.value = sessions.value.filter(s => s.id !== sessionId)
    clearMessageReference(sessionId)
    setAbortState(sessionId, null)
    if (completedUnreadSessions.value.has(sessionId)) {
      const next = new Set(completedUnreadSessions.value)
      next.delete(sessionId)
      completedUnreadSessions.value = next
    }
    if (activeSessionId.value === sessionId) {
      if (sessions.value.length > 0) {
        await switchSession(sessions.value[0].id)
      } else {
        clearActiveSession()
      }
    } else if (target) {
      await refreshSessionListOnly(sessionProfileFilter.value)
    }
    return true
  }

  function getSessionMsgs(sessionId: string): Message[] {
    const s = sessions.value.find(s => s.id === sessionId)
    return s?.messages || []
  }

  function isEkkoAgentSession(sessionId: string): boolean {
    const session = sessions.value.find(item => item.id === sessionId)
    return session?.codingAgentId === 'ekko-agent' || session?.agent === 'ekko-agent'
  }

  function addMessage(sessionId: string, msg: Message) {
    const s = sessions.value.find(s => s.id === sessionId)
    if (s) s.messages.push(msg)
  }

  function addMessageInTimelineOrder(sessionId: string, msg: Message) {
    const session = sessions.value.find(item => item.id === sessionId)
    if (!session) return
    const insertAt = session.messages.findIndex(existing => existing.timestamp > msg.timestamp)
    if (insertAt === -1) {
      session.messages.push(msg)
      return
    }
    session.messages.splice(insertAt, 0, msg)
  }

  function addHermesBackgroundDelegateAnchors(
    sessionId: string,
    toolCallId: string | undefined,
    output: unknown,
    toolArgs: unknown,
    runMarker?: string | null,
  ) {
    const payload = runtimeObjectPayload(output)
    if (!payload || payload.mode !== 'background' || payload.runtime === 'ekko') return
    const baseId = toolCallId || String(payload.delegation_id || uid())
    const messages = getSessionMsgs(sessionId)
    for (const task of backgroundDelegateTaskDescriptors(payload, toolArgs)) {
      const anchorCallId = backgroundDelegateAnchorCallId(baseId, task.taskIndex)
      if (messages.some(message =>
        message.toolCallId === anchorCallId
        && normalizedRunMarker(message) === (runMarker || null),
      )) continue
      const label = `${task.taskIndex + 1}/${task.taskCount}`
      addMessage(sessionId, {
        id: uid(),
        role: 'tool',
        content: '',
        timestamp: Date.now(),
        toolName: 'delegate_task',
        toolCallId: anchorCallId,
        toolArgs,
        toolPreview: `${label}${task.goal ? ` · ${task.goal}` : ''}`.slice(0, 220),
        toolResult: {
          ...payload,
          runtime: 'hermes',
          task_index: task.taskIndex,
          task_count: task.taskCount,
          goal: task.goal,
        },
        toolStatus: 'done',
        runMarker,
      })
    }
  }

  function findHermesBackgroundDelegateAnchor(messages: Message[], evt: RunEvent): Message | undefined {
    const taskIndex = Number((evt as any).task_index ?? 0)
    const goal = String((evt as any).goal || '').trim()
    const candidates = messages.filter(message =>
      message.role === 'tool'
      && message.toolCallId?.startsWith(HERMES_BACKGROUND_DELEGATE_ANCHOR_PREFIX)
      && runtimeObjectPayload(message.toolResult)?.runtime === 'hermes',
    )
    return candidates.find(message => {
      const payload = runtimeObjectPayload(message.toolResult)
      return Number(payload?.task_index ?? 0) === taskIndex
        && (!goal || !String(payload?.goal || '').trim() || String(payload?.goal || '').trim() === goal)
    }) || candidates.find(message => Number(runtimeObjectPayload(message.toolResult)?.task_index ?? 0) === taskIndex)
  }

  function addOrUpdateSession(session: Session) {
    const existingIndex = sessions.value.findIndex(s => s.id === session.id)
    if (existingIndex !== -1) {
      // Update existing session
      sessions.value[existingIndex] = session
    } else {
      // Add new session
      sessions.value.push(session)
    }
  }

  function updateMessage(sessionId: string, id: string, update: Partial<Message>) {
    const s = sessions.value.find(s => s.id === sessionId)
    if (!s) return
    const idx = s.messages.findIndex(m => m.id === id)
    if (idx !== -1) {
      s.messages[idx] = { ...s.messages[idx], ...update }
    }
  }

  function findToolMessageForEvent(
    messages: Message[],
    evt: RunEvent,
    toolCallId?: string,
  ): Message | undefined {
    const eventRunMarker = normalizedRunMarker(evt)
    const reversed = [...messages].reverse()
    const hasMatchingId = (message: Message) => !toolCallId || message.toolCallId === toolCallId

    if (eventRunMarker) {
      const exact = reversed.find(message =>
        message.role === 'tool'
        && hasMatchingId(message)
        && normalizedRunMarker(message) === eventRunMarker
        && (toolCallId || message.toolStatus === 'running'),
      )
      if (exact) return exact

      // A legacy started event may not have carried its run marker even when
      // the corresponding completion does. Adopt only an unscoped running row.
      return reversed.find(message =>
        message.role === 'tool'
        && hasMatchingId(message)
        && normalizedRunMarker(message) === null
        && message.toolStatus === 'running',
      )
    }

    // Without a run marker, never revive a finalized historical row. The most
    // recent running match is the only safe legacy fallback.
    return reversed.find(message =>
      message.role === 'tool'
      && hasMatchingId(message)
      && message.toolStatus === 'running',
    )
  }

  function handleToolStartedEvent(sessionId: string, evt: RunEvent, reasoning?: string) {
    const toolName = evt.tool || evt.name
    if (
      isBackgroundDelegateToolPayload(toolName, evt.arguments)
      || (isEkkoAgentSession(sessionId) && toolName === 'delegate_task')
    ) return

    const toolCallId = typeof (evt as any).tool_call_id === 'string'
      ? String((evt as any).tool_call_id)
      : undefined
    const messages = getSessionMsgs(sessionId)
    const existing = toolCallId ? findToolMessageForEvent(messages, evt, toolCallId) : undefined
    const eventRunMarker = normalizedRunMarker(evt)
    if (existing) {
      const isSettled = existing.toolStatus === 'done'
        || existing.toolStatus === 'error'
        || existing.toolResult !== undefined
      updateMessage(sessionId, existing.id, {
        toolName: toolName || existing.toolName,
        runMarker: existing.runMarker || eventRunMarker,
        toolArgs: hasRuntimeToolPayload(evt.arguments) ? evt.arguments : existing.toolArgs,
        toolPreview: evt.preview || existing.toolPreview,
        reasoning: existing.reasoning || reasoning,
        toolStatus: isSettled ? existing.toolStatus : 'running',
      })
      return
    }

    addMessage(sessionId, {
      id: uid(),
      role: 'tool',
      content: '',
      timestamp: Date.now(),
      toolName,
      toolCallId,
      runMarker: eventRunMarker,
      toolPreview: evt.preview,
      toolArgs: runtimeToolPayloadOrUndefined(evt.arguments),
      reasoning,
      toolStatus: 'running',
    })
  }

  function handleToolCompletedEvent(sessionId: string, evt: RunEvent) {
    const toolCallId = typeof (evt as any).tool_call_id === 'string'
      ? String((evt as any).tool_call_id)
      : undefined
    const messages = getSessionMsgs(sessionId)
    const existing = findToolMessageForEvent(messages, evt, toolCallId)
    const output = runtimeToolOutputFromEvent(evt)
    const toolName = evt.tool || evt.name || existing?.toolName
    const eventRunMarker = normalizedRunMarker(evt)

    if (isBackgroundDelegateToolPayload(toolName, output)) {
      const session = sessions.value.find(item => item.id === sessionId)
      if (session && existing) session.messages = session.messages.filter(message => message !== existing)
      addHermesBackgroundDelegateAnchors(
        sessionId,
        toolCallId,
        output,
        existing?.toolArgs,
        eventRunMarker,
      )
      return
    }
    if (
      isEkkoAgentSession(sessionId)
      && toolName === 'delegate_task'
      && runtimeObjectPayload(output)?.runtime === 'ekko'
    ) {
      const session = sessions.value.find(item => item.id === sessionId)
      if (session && existing) session.messages = session.messages.filter(message => message !== existing)
      return
    }

    const hasError = evt.event === 'tool.failed'
      || (evt as any).error === true
      || runtimeToolOutputHasError(output)
    if (existing) {
      updateMessage(sessionId, existing.id, {
        toolName: toolName || existing.toolName,
        runMarker: existing.runMarker || eventRunMarker,
        toolStatus: hasError ? 'error' : 'done',
        toolDuration: (evt as any).duration,
        toolResult: output,
      })
      return
    }

    // Completion can arrive after a reconnect even when the start event was
    // not replayed. Preserve the call instead of silently dropping it.
    addMessage(sessionId, {
      id: uid(),
      role: 'tool',
      content: '',
      timestamp: Date.now(),
      toolName,
      toolCallId,
      runMarker: eventRunMarker,
      toolPreview: evt.preview,
      toolResult: output,
      toolStatus: hasError ? 'error' : 'done',
      toolDuration: (evt as any).duration,
    })
  }

  function settleRunningTools(sessionId: string, status: 'done' | 'error') {
    const msgs = getSessionMsgs(sessionId)
    msgs.forEach((m, i) => {
      if (m.role === 'tool' && m.toolStatus === 'running' && !m.toolCallId?.startsWith('subagent:')) {
        msgs[i] = { ...m, toolStatus: status }
      }
    })
  }

  function settleRuntimeDisplayForCommand(sessionId: string) {
    const msgs = getSessionMsgs(sessionId)
    msgs.forEach((m, i) => {
      if (m.isStreaming) updateMessage(sessionId, m.id, { isStreaming: false })
      if (m.role === 'tool' && m.toolStatus === 'running') {
        msgs[i] = { ...m, toolStatus: 'done' }
      }
    })
  }

  function clearAgentEventMessages(sessionId: string) {
    const s = sessions.value.find(s => s.id === sessionId)
    if (!s) return
    s.messages = s.messages.filter(m => m.commandAction !== 'agent.event')
  }

  function handleSubagentEvent(sessionId: string, evt: RunEvent) {
    const eventName = String(evt.event || '')
    if (!eventName.startsWith('subagent.') && eventName !== 'delegation.updated') return

    if (eventName === 'delegation.updated') {
      const delegationId = String(evt.delegation_id || '').trim()
      const status = subagentStatus((evt as any).status)
      if (status === 'running') return
      const sessionStreams = [...subagentStreams.value.values()].filter(stream =>
        stream.sessionId === sessionId && stream.status === 'running',
      )
      const exactMatch = sessionStreams.find(stream => stream.subagentId === delegationId)
      const targets = exactMatch
        ? [exactMatch]
        : ['failed', 'error', 'cancelled', 'interrupted'].includes(status)
          ? sessionStreams
          : []
      for (const stream of targets) {
        handleSubagentEvent(sessionId, {
          ...evt,
          event: 'subagent.complete',
          subagent_id: stream.subagentId,
          task_index: stream.taskIndex,
          task_count: stream.taskCount,
          goal: stream.goal,
          model: stream.model,
          status,
        })
      }
      return
    }

    const subagentId = String((evt as any).subagent_id || `${(evt as any).task_index ?? 0}`)
    const streamKey = `${sessionId}:${subagentId}`
    const currentStream = subagentStreams.value.get(streamKey)
    const nextStream = reduceSubagentStream(currentStream, sessionId, evt)
    if (nextStream === currentStream) return
    subagentStreams.value.set(streamKey, nextStream)
    const toolCallId = `subagent:${subagentId}`
    const taskIndex = Number((evt as any).task_index ?? 0)
    const taskCount = Number((evt as any).task_count ?? 1)
    const label = `${taskIndex + 1}/${Math.max(1, taskCount || 1)}`
    const toolName = String((evt as any).tool || (evt as any).name || '')
    const toolCount = Number((evt as any).tool_count || 0)
    const goal = String((evt as any).goal || '').trim()
    const rawText = String(evt.text || evt.preview || '')
    const text = rawText.trim()
    const summary = String((evt as any).summary || '').trim()
    const duration = Number((evt as any).duration_seconds ?? (evt as any).duration)

    let preview = `${label}${goal ? ` · ${goal}` : ''}`
    if (eventName === 'subagent.start') {
      preview = `${label}${goal ? ` · ${goal}` : ''}`
    } else if (eventName === 'subagent.tool') {
      preview = `${label}${toolCount ? ` · #${toolCount}` : ''}${toolName ? ` · ${toolName}` : ''}${text ? ` · ${text}` : ''}`
    } else if (eventName === 'subagent.progress' || eventName === 'subagent.text' || eventName === 'subagent.thinking') {
      preview = `${label}${text ? ` · ${text}` : goal ? ` · ${goal}` : ''}`
    } else if (eventName === 'subagent.complete') {
      preview = `${label}${summary ? ` · ${summary}` : text ? ` · ${text}` : ''}`
    }

    const msgs = getSessionMsgs(sessionId)
    const existing = msgs.find(m => m.role === 'tool' && m.toolCallId === toolCallId)
      || findHermesBackgroundDelegateAnchor(msgs, evt)
    const toolStatus = nextStream.status === 'running'
      ? 'running'
      : nextStream.status === 'completed' ? 'done' : 'error'
    const update: Partial<Message> = {
      toolName: 'delegate_task',
      toolCallId,
      toolPreview: preview.slice(0, 220),
      toolArgs: eventName === 'subagent.tool'
        ? runtimeToolPayloadOrUndefined((evt as any).arguments)
        : existing?.toolArgs,
      toolStatus,
      toolDuration: Number.isFinite(duration) ? duration : undefined,
      toolResult: eventName === 'subagent.complete'
        ? JSON.stringify({
            status: (evt as any).status || 'completed',
            summary: summary || text,
            api_calls: (evt as any).api_calls,
            input_tokens: (evt as any).input_tokens,
            output_tokens: (evt as any).output_tokens,
            output_tail: (evt as any).output_tail,
          }, null, 2)
        : existing?.toolResult,
    }

    if (existing) {
      updateMessage(sessionId, existing.id, update)
      return
    }

    addMessageInTimelineOrder(sessionId, {
      id: uid(),
      role: 'tool',
      content: '',
      timestamp: nextStream.startedAt,
      ...update,
    })
  }

  function restorePersistedSubagentStreams(sessionId: string) {
    for (const message of getSessionMsgs(sessionId)) {
      if (message.role !== 'tool' || !message.toolCallId?.startsWith('subagent:')) continue
      const subagentId = message.toolCallId.slice('subagent:'.length).trim()
      if (!subagentId || subagentStreams.value.has(`${sessionId}:${subagentId}`)) continue
      const payload = runtimeObjectPayload(message.toolResult)
      if (!payload) continue
      const status = subagentStatus(payload.status)
      const restoredOutput = String(payload.output || payload.output_tail || payload.summary || '').trim()
      handleSubagentEvent(sessionId, {
        ...payload,
        event: status === 'running' ? 'subagent.start' : 'subagent.complete',
        session_id: sessionId,
        subagent_id: subagentId,
        background: payload.mode === 'background',
        background_snapshot: true,
        summary: restoredOutput || payload.summary,
        timestamp: message.timestamp,
      } as RunEvent)
    }
  }

  function settleInterruptedSubagents(sessionId: string) {
    const runningStreams = [...subagentStreams.value.values()].filter(stream =>
      stream.sessionId === sessionId && stream.status === 'running',
    )
    for (const stream of runningStreams) {
      handleSubagentEvent(sessionId, {
        event: 'subagent.complete',
        session_id: sessionId,
        subagent_id: stream.subagentId,
        task_index: stream.taskIndex,
        task_count: stream.taskCount,
        goal: stream.goal,
        model: stream.model,
        status: 'interrupted',
        timestamp: Date.now(),
      })
    }
  }

  function getSubagentStream(sessionId: string, subagentId: string): SubagentStream | null {
    return subagentStreams.value.get(`${sessionId}:${subagentId}`) || null
  }

  function handleMoaEvent(sessionId: string, evt: RunEvent) {
    const eventName = String(evt.event || '')
    if (eventName !== 'moa.reference' && eventName !== 'moa.aggregating') return

    const msgs = getSessionMsgs(sessionId)
    if (eventName === 'moa.reference') {
      const label = moaReferenceLabel(evt)
      const index = Number.isFinite(Number(evt.index)) ? Number(evt.index) : label
      const toolCallId = `moa:reference:${evt.run_id || 'run'}:${index}`
      const output = typeof evt.text === 'string'
        ? evt.text
        : typeof evt.delta === 'string'
          ? evt.delta
          : ''
      const update: Partial<Message> = {
        toolName: 'moa_reference',
        toolCallId,
        runMarker: readRunMarker(evt),
        toolPreview: label.slice(0, 220),
        toolStatus: 'done',
        toolResult: output,
      }
      const existing = msgs.find(m => m.role === 'tool' && m.toolCallId === toolCallId)
      if (existing) {
        updateMessage(sessionId, existing.id, update)
        return
      }
      addMessage(sessionId, {
        id: uid(),
        role: 'tool',
        content: '',
        timestamp: Date.now(),
        ...update,
      })
      return
    }

    const aggregator = typeof evt.aggregator === 'string' && evt.aggregator.trim()
      ? evt.aggregator.trim()
      : 'aggregator'
    const toolCallId = `moa:aggregating:${evt.run_id || 'run'}`
    const update: Partial<Message> = {
      toolName: 'moa_aggregating',
      toolCallId,
      runMarker: readRunMarker(evt),
      toolPreview: aggregator.slice(0, 220),
      toolStatus: 'running',
      toolArgs: { aggregator },
    }
    const existing = msgs.find(m => m.role === 'tool' && m.toolCallId === toolCallId)
    if (existing) {
      updateMessage(sessionId, existing.id, update)
      return
    }
    addMessage(sessionId, {
      id: uid(),
      role: 'tool',
      content: '',
      timestamp: Date.now(),
      ...update,
    })
  }

  function addAgentErrorMessage(sessionId: string, error?: unknown) {
    const message = errorMessageText(error)
    const content = message ? `Error: ${message}` : 'Run failed'
    const msgs = getSessionMsgs(sessionId)
    const last = msgs[msgs.length - 1]
    if (last?.isStreaming) {
      // If the streaming message already has substantial content (the assistant
      // produced a meaningful reply before the error), don't overwrite it —
      // just close the stream and append a separate error message. Only
      // overwrite when the message is still empty or trivially short, meaning
      // the run failed before producing useful output.
      const hasSubstantialContent = (last.content || '').trim().length > 100
      if (hasSubstantialContent) {
        updateMessage(sessionId, last.id, { isStreaming: false })
        // fall through to append a separate error message
      } else {
        updateMessage(sessionId, last.id, {
          role: 'assistant',
          content,
          isStreaming: false,
          systemType: 'error',
        })
        return
      }
    }
    if (last?.role === 'assistant' && last.systemType === 'error' && last.content === content) return
    addMessage(sessionId, {
      id: uid(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
      systemType: 'error',
    })
  }

  function handleSessionCommandEvent(evt: RunEvent) {
    if (seenSessionCommandEvents.has(evt)) return
    seenSessionCommandEvents.add(evt)

    const sid = evt.session_id
    if (!sid) return
    const target = sessions.value.find(s => s.id === sid)
    const action = (evt as any).action as string | undefined
    const command = String((evt as any).command || '').toLowerCase()
    if ((evt as any).started === true && (evt as any).terminal === false) {
      serverWorking.value.add(sid)
      setRunStartedAt(sid, Date.now())
    }
    if ((evt as any).terminal === true) {
      streamStates.value.delete(sid)
      serverWorking.value.delete(sid)
      clearRunStartedAt(sid)
      pendingForkCommands.value.delete(sid)
      const msgs = getSessionMsgs(sid)
      msgs.forEach((m, i) => {
        if (m.isStreaming) updateMessage(sid, m.id, { isStreaming: false })
        if (m.role === 'tool' && m.toolStatus === 'running') {
          msgs[i] = { ...m, toolStatus: (evt as any).ok === false ? 'error' : 'done' }
        }
      })
    }

    if (action === 'clear' && command === 'clear') {
      if (target) target.messages = []
      queuedUserMessages.value.delete(sid)
      queueLengths.value.delete(sid)
      queueInsertionStates.value.delete(sid)
      clearMessageReference(sid)
      if ((evt as any).clearHistory) {
        const message = String((evt as any).message || '')
        if (message) {
          addMessage(sid, {
            id: uid(),
            role: 'command',
            content: message,
            timestamp: Date.now(),
            systemType: (evt as any).ok === false ? 'error' : 'command',
            commandAction: action,
            commandData: { ...(evt as any) },
          })
        }
      }
      return
    }

    if (action === 'title' && target && typeof (evt as any).title === 'string') {
      target.title = (evt as any).title
      target.updatedAt = Date.now()
    }

    if (action === 'usage' && target) {
      target.inputTokens = (evt as any).inputTokens
      target.outputTokens = (evt as any).outputTokens
      if ((evt as any).contextTokens != null) target.contextTokens = (evt as any).contextTokens
    }

    if (action === 'destroy') {
      streamStates.value.delete(sid)
      serverWorking.value.delete(sid)
      clearRunStartedAt(sid)
      queueLengths.value.delete(sid)
      queuedUserMessages.value.delete(sid)
      queueInsertionStates.value.delete(sid)
      clearMessageReference(sid)
      setAbortState(sid, null)
      const msgs = getSessionMsgs(sid)
      msgs.forEach(m => {
        if (m.isStreaming) updateMessage(sid, m.id, { isStreaming: false })
        if (m.role === 'tool' && m.toolStatus === 'running') m.toolStatus = 'error'
      })
    }

    if (action === 'branch' && (evt as any).ok !== false) {
      const branch = ((evt as any).branchSession || {}) as Record<string, unknown>
      const newSessionId = String((evt as any).newSessionId || branch.id || '').trim()
      if (newSessionId) {
        const existing = sessions.value.find(s => s.id === newSessionId)
        if (!existing) {
          sessions.value.unshift({
            id: newSessionId,
            profile: typeof branch.profile === 'string' ? branch.profile : undefined,
            title: String((evt as any).newSessionTitle || branch.title || 'Branch'),
            source: typeof branch.source === 'string' ? branch.source : 'cli',
            messages: [],
            createdAt: typeof branch.createdAt === 'number' ? branch.createdAt : Date.now(),
            updatedAt: typeof branch.updatedAt === 'number' ? branch.updatedAt : Date.now(),
            model: typeof branch.model === 'string' ? branch.model : undefined,
            provider: typeof branch.provider === 'string' ? branch.provider : undefined,
            messageCount: typeof branch.messageCount === 'number' ? branch.messageCount : undefined,
            messageTotal: typeof branch.messageCount === 'number' ? branch.messageCount : undefined,
            loadedMessageCount: 0,
            hasMoreBefore: false,
            parentSessionId: typeof branch.parentSessionId === 'string'
              ? branch.parentSessionId
              : typeof (evt as any).parentSessionId === 'string' ? (evt as any).parentSessionId : sid,
            forkPointMessageId: branch.forkPointMessageId != null ? String(branch.forkPointMessageId) : null,
            parentTitle: typeof branch.parentTitle === 'string' ? branch.parentTitle : target?.title || null,
            parentLastMessage: typeof branch.parentLastMessage === 'string' ? branch.parentLastMessage : lastVisibleMessageContent(target?.messages),
            parentLastMessageRole: typeof branch.parentLastMessageRole === 'string' ? branch.parentLastMessageRole : lastVisibleMessageRole(target?.messages),
            workspace: typeof branch.workspace === 'string' ? branch.workspace : null,
          })
        }
        void switchSession(newSessionId)
      }
    }

    const message = String((evt as any).message || '')
    if (message) {
      addMessage(sid, {
        id: uid(),
        role: 'command',
        content: message,
        timestamp: Date.now(),
        systemType: (evt as any).ok === false ? 'error' : 'command',
        commandAction: action,
        commandData: { ...(evt as any) },
      })
    }
  }

  function handleAgentEvent(evt: RunEvent) {
    const sid = evt.session_id
    if (!sid) return
    if (evt.event === 'plan.updated') {
      const target = sessions.value.find(session => session.id === sid)
      if (target) target.messages = mergeTaskPlanMessages(target.messages, [evt], sid)
      return
    }
    if ((evt as any).source === 'coding_agent' && (evt as any).kind === 'status') return
    const text = String((evt as any).text || (evt as any).message || '').trim()
    if (!text) return

    const msgs = getSessionMsgs(sid)
    const last = msgs[msgs.length - 1]
    const commandData = { ...(evt as any) }
    if (last?.role === 'system' && last.commandAction === 'agent.event') {
      if (last.content === text) return
      updateMessage(sid, last.id, {
        content: text,
        timestamp: Date.now(),
        commandData,
      })
      return
    }

    addMessage(sid, {
      id: uid(),
      role: 'system',
      content: text,
      timestamp: Date.now(),
      commandAction: 'agent.event',
      commandData,
    })
  }

  function enqueueUserMessage(sessionId: string, message: Message) {
    const queue = queuedUserMessages.value.get(sessionId) || []
    if (queue.some(item => item.id === message.id)) return
    const nextMap = new Map(queuedUserMessages.value)
    nextMap.set(sessionId, [...queue, { ...message, queued: true }])
    queuedUserMessages.value = nextMap
  }

  function updateQueuedUserMessage(sessionId: string, messageId: string, patch: Partial<Message>) {
    const queue = queuedUserMessages.value.get(sessionId)
    if (!queue?.length) return
    const next = queue.map(message => message.id === messageId
      ? { ...message, ...patch, queued: true }
      : message)
    const nextMap = new Map(queuedUserMessages.value)
    nextMap.set(sessionId, next)
    queuedUserMessages.value = nextMap
  }

  function dropQueuedUserMessage(sessionId: string, messageId: string): boolean {
    const queue = queuedUserMessages.value.get(sessionId)
    if (!queue?.length) return false
    const next = queue.filter(message => message.id !== messageId)
    if (next.length === queue.length) return false
    const nextMap = new Map(queuedUserMessages.value)
    if (next.length > 0) {
      nextMap.set(sessionId, next)
      queueLengths.value.set(sessionId, next.length)
    } else {
      nextMap.delete(sessionId)
      queueLengths.value.delete(sessionId)
    }
    queuedUserMessages.value = nextMap
    return true
  }

  function removeQueuedMessage(sessionId: string, messageId: string) {
    if (!dropQueuedUserMessage(sessionId, messageId)) return
    getChatRunSocket(runtimeTransport())?.emit('cancel_queued_run', {
      session_id: sessionId,
      queue_id: messageId,
    })
  }

  function insertQueuedMessage(sessionId: string, messageId: string) {
    if (!(queuedUserMessages.value.get(sessionId) || []).some(message => message.id === messageId)) return
    getChatRunSocket(runtimeTransport())?.emit('insert_queued_run', {
      session_id: sessionId,
      queue_id: messageId,
    })
  }

  function replaceQueueInsertionState(sessionId: string, raw: ResumeSessionPayload['queueInsertion'] | RunEvent | null | undefined) {
    const nextMap = new Map(queueInsertionStates.value)
    const phase = raw?.phase
    const generation = typeof raw?.generation === 'string' ? raw.generation : ''
    const queueId = typeof raw?.queue_id === 'string' ? raw.queue_id : ''
    if (!raw || phase === 'cancelled' || phase === 'starting_queued_message' || !generation || !queueId) {
      nextMap.delete(sessionId)
      queueInsertionStates.value = nextMap
      return
    }
    if (phase !== 'requesting' && phase !== 'waiting_for_tool_batch' && phase !== 'stopping_current_turn') return
    nextMap.set(sessionId, {
      generation,
      runId: typeof raw.run_id === 'string' ? raw.run_id : undefined,
      queueId,
      runtime: raw.runtime === 'ekko'
        || raw.runtime === 'claude-code'
        || raw.runtime === 'codex'
        || raw.runtime === 'pi'
        || raw.runtime === 'grok'
        ? raw.runtime
        : 'hermes',
      phase,
      guarantee: raw.guarantee === 'immediate' ? 'immediate' : 'strict',
      requestedAt: typeof raw.requested_at === 'number' ? raw.requested_at : Date.now(),
    })
    queueInsertionStates.value = nextMap
  }

  function handleQueueInsertionUpdated(evt: RunEvent) {
    const sid = evt.session_id
    if (!sid) return
    replaceQueueInsertionState(sid, evt)
  }

  function normalizeQueuedUserMessages(rawMessages: unknown): Message[] {
    if (!Array.isArray(rawMessages)) return []
    return rawMessages.flatMap((raw) => {
      const peer = raw as NonNullable<RunEvent['queued_messages']>[number]
      const content = typeof peer?.content === 'string' ? peer.content : ''
      const messageId = peer?.id != null ? String(peer.id) : ''
      if (!messageId || !content.trim()) return []
      const timestamp = typeof peer?.timestamp === 'number' && Number.isFinite(peer.timestamp)
        ? Math.round(peer.timestamp * 1000)
        : Date.now()
      const role = peer?.role === 'command' ? 'command' : 'user'
      return [{
        id: messageId,
        role,
        content,
        timestamp,
        queued: true,
        systemType: role === 'command' ? 'command' as const : undefined,
      }]
    })
  }

  function replaceQueuedUserMessages(sessionId: string, messages: Message[]) {
    const existingById = new Map((queuedUserMessages.value.get(sessionId) || []).map(message => [message.id, message]))
    const merged = messages.map(message => ({
      ...(existingById.get(message.id) || {}),
      ...message,
      attachments: existingById.get(message.id)?.attachments || message.attachments,
      queued: true,
    }))
    const nextMap = new Map(queuedUserMessages.value)
    if (merged.length > 0) {
      nextMap.set(sessionId, merged)
    } else {
      nextMap.delete(sessionId)
    }
    queuedUserMessages.value = nextMap
  }

  function markDequeuedQueueId(sessionId: string, messageId: string) {
    const nextMap = new Map(dequeuedQueueIds.value)
    const ids = new Set(nextMap.get(sessionId) || [])
    ids.add(messageId)
    nextMap.set(sessionId, ids)
    dequeuedQueueIds.value = nextMap
  }

  function consumeDequeuedQueueId(sessionId: string, messageId: string): boolean {
    const ids = dequeuedQueueIds.value.get(sessionId)
    if (!ids?.has(messageId)) return false
    const nextIds = new Set(ids)
    nextIds.delete(messageId)
    const nextMap = new Map(dequeuedQueueIds.value)
    if (nextIds.size > 0) nextMap.set(sessionId, nextIds)
    else nextMap.delete(sessionId)
    dequeuedQueueIds.value = nextMap
    return true
  }

  function handleRunQueuedEvent(sessionId: string, evt: RunEvent) {
    const queueLength = Number((evt as any).queue_length || 0)
    if (queueLength > 0) {
      queueLengths.value.set(sessionId, queueLength)
    } else {
      queueLengths.value.delete(sessionId)
    }

    const dequeuedId = (evt as any).dequeued_queue_id != null
      ? String((evt as any).dequeued_queue_id)
      : ''
    if (dequeuedId) {
      const existingQueue = queuedUserMessages.value.get(sessionId) || []
      const dequeued = existingQueue.find(message => message.id === dequeuedId)
      if (Array.isArray((evt as any).queued_messages)) {
        const queued = normalizeQueuedUserMessages((evt as any).queued_messages)
        replaceQueuedUserMessages(sessionId, queued)
      } else {
        const nextQueue = existingQueue.filter(message => message.id !== dequeuedId)
        replaceQueuedUserMessages(sessionId, nextQueue)
      }
      if (dequeued && !getSessionMsgs(sessionId).some(message => message.id === dequeued.id)) {
        addMessage(sessionId, { ...dequeued, queued: false })
        updateSessionTitle(sessionId)
      } else if (!dequeued) {
        markDequeuedQueueId(sessionId, dequeuedId)
      }
      return
    }

    if (Array.isArray((evt as any).queued_messages)) {
      const queued = normalizeQueuedUserMessages((evt as any).queued_messages)
      replaceQueuedUserMessages(sessionId, queued)
      return
    }

    const peer = evt.message
    const content = typeof peer?.content === 'string' ? peer.content : ''
    const messageId = peer?.id != null ? String(peer.id) : ''
    if (!messageId || !content.trim()) return

    if ((queuedUserMessages.value.get(sessionId) || []).some(msg => msg.id === messageId)) return

    const timestamp = typeof peer?.timestamp === 'number' && Number.isFinite(peer.timestamp)
      ? Math.round(peer.timestamp * 1000)
      : Date.now()
    const msgs = getSessionMsgs(sessionId)
    const existingIndex = msgs.findIndex(msg => msg.id === messageId && msg.role === 'user')
    const existing = existingIndex >= 0 ? msgs[existingIndex] : null
    if (existingIndex >= 0) {
      msgs.splice(existingIndex, 1)
    }

    enqueueUserMessage(sessionId, {
      ...(existing || {}),
      id: messageId,
      role: peer?.role === 'command' ? 'command' : 'user',
      content,
      timestamp: existing?.timestamp || timestamp,
      attachments: existing?.attachments,
      queued: true,
      systemType: peer?.role === 'command' ? 'command' : existing?.systemType,
    })
  }

  function setPendingApproval(evt: RunEvent) {
    const sid = evt.session_id
    const approvalId = (evt as any).approval_id as string | undefined
    if (!sid || !approvalId) return
    if (pendingApprovalResponseIds.get(sid) !== approvalId) pendingApprovalResponseIds.delete(sid)
    const description = String((evt as any).description || '')
    const normalizedDescription = description.trim().toLowerCase().replace(/\s+/g, ' ')
    const isMemoryWrite = !Boolean((evt as any).allow_permanent) && (
      normalizedDescription === 'save to memory' ||
      normalizedDescription.startsWith('save to memory:') ||
      normalizedDescription.startsWith('save to memory?')
    )
    const rawChoices = Array.isArray((evt as any).choices) ? (evt as any).choices : ['once', 'session', 'deny']
    const choices = rawChoices
      .filter((choice: unknown): choice is PendingApproval['choices'][number] =>
        choice === 'once' || choice === 'session' || choice === 'always' || choice === 'deny')
    pendingApprovals.value.set(sid, {
      sessionId: sid,
      approvalId,
      command: String((evt as any).command || ''),
      description,
      choices: isMemoryWrite ? ['once', 'deny'] : choices.length ? choices : ['once', 'session', 'deny'],
      allowPermanent: Boolean((evt as any).allow_permanent),
      isMemoryWrite,
      requestedAt: Date.now(),
      countdownDeadline: pendingInteractionDeadline(
        (evt as any).remaining_timeout_ms,
        (evt as any).timeout_ms,
      ),
    })
    pendingApprovals.value = new Map(pendingApprovals.value)
  }

  function clearPendingApproval(evt: RunEvent) {
    const sid = evt.session_id
    if (!sid) return
    const approvalId = String((evt as any).approval_id || '')
    const attempted = Boolean(approvalId && pendingApprovalResponseIds.get(sid) === approvalId)
    if (attempted) pendingApprovalResponseIds.delete(sid)
    const current = pendingApprovals.value.get(sid)
    if (!current) {
      if (attempted && (evt as any).resolved === false && ((evt as any).stale === true || isPendingInteractionExpiredError((evt as any).error || (evt as any).reason))) {
        notifyPendingInteractionExpired()
      }
      return
    }
    if (approvalId && current.approvalId !== approvalId) return
    if ((evt as any).resolved === false) {
      if ((evt as any).stale === true || isPendingInteractionExpiredError((evt as any).error || (evt as any).reason)) {
        dismissPendingApprovalFor(sid, current.approvalId)
        if (attempted) notifyPendingInteractionExpired()
      }
      return
    }
    pendingApprovals.value.delete(sid)
    pendingApprovals.value = new Map(pendingApprovals.value)
  }

  function setPendingClarify(evt: RunEvent) {
    const sid = evt.session_id
    const clarifyId = (evt as any).clarify_id as string | undefined
    if (!sid || !clarifyId) return
    if (pendingClarifyResponseIds.get(sid) !== clarifyId) pendingClarifyResponseIds.delete(sid)
    pendingClarifies.value.set(sid, {
      sessionId: sid,
      clarifyId,
      question: String((evt as any).question || ''),
      choices: Array.isArray((evt as any).choices) ? (evt as any).choices : null,
      initialResponse: String((evt as any).initial_response || ''),
      responseMode: String((evt as any).response_mode || ''),
      timeoutMs: Number((evt as any).timeout_ms) || 300000,
      requestedAt: Date.now(),
      countdownDeadline: pendingInteractionDeadline(
        (evt as any).remaining_timeout_ms,
        (evt as any).timeout_ms,
      ),
    })
    pendingClarifies.value = new Map(pendingClarifies.value)
  }

  function clearPendingClarify(evt: RunEvent) {
    const sid = evt.session_id
    if (!sid) return
    const clarifyId = String((evt as any).clarify_id || '')
    const attempted = Boolean(clarifyId && pendingClarifyResponseIds.get(sid) === clarifyId)
    if (attempted) pendingClarifyResponseIds.delete(sid)
    const current = pendingClarifies.value.get(sid)
    if (!current) {
      if (attempted && (evt as any).resolved === false && ((evt as any).stale === true || isPendingInteractionExpiredError((evt as any).error || (evt as any).reason))) {
        notifyPendingInteractionExpired()
      }
      return
    }
    if (clarifyId && current.clarifyId !== clarifyId) return
    if ((evt as any).resolved === false) {
      if ((evt as any).stale === true || isPendingInteractionExpiredError((evt as any).error || (evt as any).reason)) {
        dismissPendingClarifyFor(sid, current.clarifyId)
        if (attempted) notifyPendingInteractionExpired()
      }
      return
    }
    pendingClarifies.value.delete(sid)
    pendingClarifies.value = new Map(pendingClarifies.value)
  }

  function clearPendingInteractions(sessionId: string) {
    pendingApprovalResponseIds.delete(sessionId)
    pendingClarifyResponseIds.delete(sessionId)
    let changed = false
    if (pendingApprovals.value.has(sessionId)) {
      pendingApprovals.value.delete(sessionId)
      changed = true
    }
    if (pendingClarifies.value.has(sessionId)) {
      pendingClarifies.value.delete(sessionId)
      changed = true
    }
    if (changed) {
      pendingApprovals.value = new Map(pendingApprovals.value)
      pendingClarifies.value = new Map(pendingClarifies.value)
    }
  }

  function dismissPendingApprovalFor(sessionId: string, approvalId: string) {
    const pending = pendingApprovals.value.get(sessionId)
    if (!pending || pending.approvalId !== approvalId) return
    pendingApprovals.value.delete(sessionId)
    pendingApprovals.value = new Map(pendingApprovals.value)
  }

  function dismissPendingClarifyFor(sessionId: string, clarifyId: string) {
    const pending = pendingClarifies.value.get(sessionId)
    if (!pending || pending.clarifyId !== clarifyId) return
    pendingClarifies.value.delete(sessionId)
    pendingClarifies.value = new Map(pendingClarifies.value)
  }

  function respondToClarifyFor(sessionId: string, clarifyId: string, response: string): PendingInteractionSubmitResult {
    const pending = pendingClarifies.value.get(sessionId)
    if (!pending || pending.clarifyId !== clarifyId) return 'missing'
    respondClarify(sessionId, clarifyId, response, runtimeTransport())
    pendingClarifyResponseIds.set(sessionId, clarifyId)
    return 'submitted'
  }

  function respondToClarify(response: string): PendingInteractionSubmitResult {
    const pending = activePendingClarify.value
    if (!pending) return 'missing'
    const result = respondToClarifyFor(pending.sessionId, pending.clarifyId, response)
    if (result === 'submitted') dismissPendingClarifyFor(pending.sessionId, pending.clarifyId)
    return result
  }


  function respondApprovalFor(sessionId: string, approvalId: string, choice: PendingApproval['choices'][number]): PendingInteractionSubmitResult {
    const pending = pendingApprovals.value.get(sessionId)
    if (!pending || pending.approvalId !== approvalId) return 'missing'
    respondToolApproval(sessionId, approvalId, choice, runtimeTransport())
    pendingApprovalResponseIds.set(sessionId, approvalId)
    return 'submitted'
  }

  function respondApproval(choice: PendingApproval['choices'][number]): PendingInteractionSubmitResult {
    const pending = activePendingApproval.value
    if (!pending) return 'missing'
    const result = respondApprovalFor(pending.sessionId, pending.approvalId, choice)
    if (result === 'submitted') dismissPendingApprovalFor(pending.sessionId, pending.approvalId)
    return result
  }

  function updateSessionTitle(sessionId: string) {
    const target = sessions.value.find(s => s.id === sessionId)
    if (!target) return
    if (!target.title) {
      const firstUser = target.messages.find(m => m.role === 'user')
      if (firstUser) {
        const title = firstUser.attachments?.length
          ? firstUser.attachments.map(a => a.name).join(', ')
          : firstUser.content
        target.title = title.slice(0, 40) + (title.length > 40 ? '...' : '')
      }
    }
    target.updatedAt = Date.now()
  }

  function applyGeneratedSessionTitle(evt: RunEvent) {
    const sid = evt.session_id
    const title = typeof (evt as any).title === 'string' ? (evt as any).title.trim() : ''
    if (!sid || !title) return
    const target = sessions.value.find(s => s.id === sid)
    if (target) {
      target.title = title
      target.updatedAt = Date.now()
    }
    if (activeSession.value?.id === sid) {
      activeSession.value.title = title
    }
  }

  function applySessionWorkspaceUpdate(evt: RunEvent) {
    const sid = evt.session_id
    const workspace = typeof evt.workspace === 'string' ? evt.workspace.trim() : ''
    if (!sid || !workspace) return
    const target = sessions.value.find(s => s.id === sid)
    if (target) {
      target.workspace = workspace
      target.isLocalOnly = false
    }
    if (activeSession.value?.id === sid) {
      activeSession.value.workspace = workspace
      activeSession.value.isLocalOnly = false
    }
  }

  function applySessionSettingsUpdate(evt: RunEvent) {
    const sid = evt.session_id
    if (!sid) return
    const targets = [sessions.value.find(s => s.id === sid), activeSession.value?.id === sid ? activeSession.value : null]
      .filter((session): session is Session => Boolean(session))
    for (const target of new Set(targets)) {
      if (typeof evt.model === 'string') target.model = evt.model
      if (typeof evt.provider === 'string') target.provider = evt.provider
      if (typeof evt.api_mode === 'string') target.apiMode = evt.api_mode as ProviderApiMode || undefined
      if (typeof evt.reasoning_effort === 'string') {
        const incomingEffort = evt.reasoning_effort || undefined
        const pendingEffort = reasoningEffortWriteTargets.get(sid)
        if (!reasoningEffortWriteTargets.has(sid) || pendingEffort === incomingEffort) {
          target.reasoningEffort = incomingEffort
        }
      }
      if (typeof evt.push_enabled === 'boolean') {
        const pendingEnabled = pushEnabledWriteTargets.get(sid)
        if (!pushEnabledWriteTargets.has(sid) || pendingEnabled === evt.push_enabled) {
          target.pushEnabled = evt.push_enabled
        }
      }
    }
  }

  function applyResumedSessionSettings(data: ResumeSessionPayload) {
    applySessionSettingsUpdate({
      event: 'session.settings.updated',
      session_id: data.session_id,
      ...(typeof data.model === 'string' ? { model: data.model } : {}),
      ...(typeof data.provider === 'string' ? { provider: data.provider } : {}),
      ...(typeof data.api_mode === 'string' ? { api_mode: data.api_mode || undefined } : {}),
      ...(typeof data.reasoning_effort === 'string' ? { reasoning_effort: data.reasoning_effort } : {}),
      ...(typeof data.push_enabled === 'boolean' ? { push_enabled: data.push_enabled } : {}),
    })
  }

  function primeNotificationSoundIfEnabled() {
    const { display } = useSettingsStore()
    if (display.bell_on_complete || display.approval_bell) {
      primeCompletionSound()
    }
  }

  function playCompletionBellIfEnabled() {
    if (useSettingsStore().display.bell_on_complete) {
      void playCompletionSound()
    }
  }

  function truncateNotificationText(value: string, maxLength: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim()
    if (normalized.length <= maxLength) return normalized
    return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
  }

  function completionNotificationAgent(session: Session): { icon: string } {
    const codingAgentId = session.codingAgentId || agentToCodingAgentId(session.agent)
    if (codingAgentId === 'codex') {
      return { icon: '/coding-agents/codex-openai.png' }
    }
    if (codingAgentId === 'claude-code') {
      return { icon: '/coding-agents/claude-code.svg' }
    }
    if (codingAgentId === 'pi') {
      return { icon: '/coding-agents/pi.svg' }
    }
    if (codingAgentId === 'grok') {
      return { icon: '/coding-agents/grok.svg' }
    }
    if (codingAgentId === 'dsh') return { icon: '/coding-agents/deepseek.svg' }
    if (codingAgentId === 'opencode') {
      return { icon: '/coding-agents/opencode.png' }
    }
    if (codingAgentId === 'ekko-agent') {
      return { icon: '/coding-agents/ekko-agent.png' }
    }
    return { icon: '/coding-agents/hermes.png' }
  }

  function completionNotificationBody(session: Session, message?: Message): string {
    const preview = message?.content || session.title || 'Message complete.'
    return truncateNotificationText(preview, 140)
  }

  function showCompletionNotificationIfEnabled(sessionId: string, messageId?: string | null) {
    const settingsStore = useSettingsStore()
    if (!settingsStore.display.notify_on_complete) return

    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    const message = messageId
      ? session.messages.find(m => m.id === messageId)
      : [...session.messages].reverse().find(m => m.role === 'assistant')

    const agent = completionNotificationAgent(session)
    void showCompletionNotification({
      title: truncateNotificationText(session.title || 'Hermes', 80),
      body: completionNotificationBody(session, message),
      icon: agent.icon,
      tag: `hermes-complete-${sessionId}-${message?.id || Date.now()}`,
    })
  }

  async function sendMessage(content: string, attachments?: Attachment[]) {
    const generation = runtimeGeneration
    if ((!content.trim() && !(attachments && attachments.length > 0))) return

    primeNotificationSoundIfEnabled()

    const trimmedContent = content.trim()

    if (!activeSession.value) {
      const session = createSession()
      switchSession(session.id)
    }

    // Capture session ID at send time — all callbacks use this, not activeSessionId
    const sid = activeSessionId.value!
    const shouldSendInitialSessionConfig = activeSession.value
      ? activeSession.value.messageCount == null || activeSession.value.messageCount === 0
      : false
    const isCodingAgentSession = isCodingAgentLikeSession(activeSession.value)
    const isBridgeSlashCommand = !isCodingAgentSession && isKnownBridgeSessionCommand(trimmedContent)
    const isBridgeCompressCommand = isBridgeSlashCommand && /^\/compress(?:\s|$)/i.test(trimmedContent)
    const isBridgePlanCommand = isBridgeSlashCommand && /^\/plan(?:\s|$)/i.test(trimmedContent)
    const isBridgeSkillCommand = isBridgeSlashCommand && /^\/skill(?:\s|$)/i.test(trimmedContent)
    const isBridgeBundleCommand = isBridgeSlashCommand && /^\/bundles(?:\s|$)/i.test(trimmedContent)
    const isBridgeMoaCommand = isBridgeSlashCommand && /^\/moa(?:\s|$)/i.test(trimmedContent)
    const isBridgeGoalCommand = isBridgeSlashCommand && /^\/goal(?:\s|$)/i.test(trimmedContent)
    const isBridgeForkCommand = isBridgeSlashCommand && /^\/fork(?:\s|$)/i.test(trimmedContent)
    const messageReference = isBridgeSlashCommand ? null : messageReferences.value.get(sid) || null
    const submittedContent = messageReference
      ? formatMessageWithReference(messageReference, trimmedContent)
      : trimmedContent
    const shouldOptimisticallyShowRunStatus = !isCodingAgentSession && !isBridgeForkCommand
    const wasLiveBeforeSend = isSessionLive(sid)
    if (isBridgeForkCommand) {
      if (pendingForkCommands.value.has(sid)) return
      pendingForkCommands.value = new Set(pendingForkCommands.value).add(sid)
    }
    const shouldQueue = wasLiveBeforeSend && (
      !isBridgeSlashCommand ||
      isBridgePlanCommand ||
      isBridgeSkillCommand ||
      isBridgeBundleCommand ||
      isBridgeMoaCommand
    )
    if (isBridgeSlashCommand && !shouldQueue && !wasLiveBeforeSend) {
      settleRuntimeDisplayForCommand(sid)
    }

    const visibleAttachments = attachments?.filter(attachment => !attachment.videoFrameFor)
    const userMsg: Message = {
      id: uid(),
      role: isBridgeSlashCommand ? 'command' : 'user',
      content: submittedContent,
      timestamp: Date.now(),
      attachments: visibleAttachments && visibleAttachments.length > 0 ? visibleAttachments : undefined,
      queued: shouldQueue,
      systemType: isBridgeSlashCommand ? 'command' : undefined,
    }

    if (shouldQueue) {
      enqueueUserMessage(sid, userMsg)
    } else {
      addMessage(sid, userMsg)
      updateSessionTitle(sid)
      if (shouldOptimisticallyShowRunStatus) {
        setRunStartedAt(sid, Date.now())
        serverWorking.value.add(sid)
      }
    }
    clearMessageReference(sid)

    let runSubmitted = false
    try {

      // Build input in Anthropic format
      let input: string | ContentBlock[]
      let displayInput: string | ContentBlock[] | undefined
      if (attachments && attachments.length > 0) {
        // Has attachments: upload first, then build content blocks
        const uploaded = await uploadFiles(attachments)
        if (generation !== runtimeGeneration) return

        // Update attachment URLs on the user message for display
        const urlMap = new Map(uploaded.map(f => {
          return [f.name, getDownloadUrl(f.path, f.name)]
        }))
        if (shouldQueue && userMsg.attachments) {
          userMsg.attachments = userMsg.attachments.map(a => {
            const dl = urlMap.get(a.name)
            return dl ? { ...a, url: dl } : a
          })
          updateQueuedUserMessage(sid, userMsg.id, { attachments: userMsg.attachments })
        } else {
          const msgs = getSessionMsgs(sid)
          const lastUser = msgs.findLast(m => m.id === userMsg.id)
          if (lastUser?.attachments) {
            lastUser.attachments = lastUser.attachments.map(a => {
              const dl = urlMap.get(a.name)
              return dl ? { ...a, url: dl } : a
            })
          }
        }

        // Build content blocks with uploaded file paths
        input = await buildContentBlocks(submittedContent, attachments, uploaded)
        if (generation !== runtimeGeneration) return
        if (attachments.some(attachment => attachment.context?.trim())) {
          displayInput = await buildContentBlocks(submittedContent, attachments, uploaded, false)
          if (generation !== runtimeGeneration) return
        }
      } else {
        // No attachments: use plain text format
        input = submittedContent
      }

      const appStore = useAppStore()
      await appStore.waitForModelsForRun()
      if (generation !== runtimeGeneration) return
      const sessionModel = activeSession.value?.model || appStore.selectedModel
      const sessionProvider = activeSession.value?.provider || appStore.selectedProvider
      const sessionProfile = activeSession.value?.profile || useProfilesStore().activeProfileName || undefined
      const profileModelGroups = sessionProfile
        ? appStore.profileModelGroups.find(entry => entry.profile === sessionProfile)?.groups
        : undefined
      const runModelGroups = profileModelGroups?.length ? profileModelGroups : appStore.modelGroups
      const providerGroup = runModelGroups.find(group => group.provider === sessionProvider)
      const storedSource = activeSession.value?.source
      const sessionSource: StartRunRequest['source'] = storedSource === 'global_agent'
        ? 'global_agent'
        : storedSource === 'workflow'
          ? 'workflow'
        : isCodingAgentSession
          ? 'coding_agent'
          : storedSource === 'api_server'
            ? 'api_server'
            : 'cli'
      const isCodingAgentExecution = sessionSource === 'coding_agent' || (sessionSource === 'workflow' && isCodingAgentSession)
      const codingAgentId: ChatCodingAgentId =
        activeSession.value?.codingAgentId ||
        agentToCodingAgentId(activeSession.value?.agent) ||
        'claude-code'
      const codingAgentMode = activeSession.value?.codingAgentMode || 'scoped'
      const codingAgentApiMode = isCodingAgentExecution && codingAgentMode !== 'global'
        ? normalizeCodingAgentApiMode(
            activeSession.value?.apiMode || providerGroup?.api_mode,
            inferCodingAgentApiMode(
              sessionProvider || providerGroup?.provider,
              activeSession.value?.baseUrl || providerGroup?.base_url,
            ),
          )
        : undefined
      const runPayload: StartRunRequest = {
        input,
        ...(displayInput ? { display_input: displayInput } : {}),
        session_id: sid,
        profile: sessionProfile,
        model: isCodingAgentExecution
          ? (codingAgentMode === 'global' ? undefined : sessionModel || undefined)
          : shouldSendInitialSessionConfig ? sessionModel || undefined : undefined,
        provider: isCodingAgentExecution
          ? (codingAgentMode === 'global' ? undefined : sessionProvider || undefined)
          : shouldSendInitialSessionConfig ? sessionProvider || undefined : undefined,
        model_groups: runModelGroups.map(group => ({
          provider: group.provider,
          models: group.models,
        })),
        queue_id: userMsg.id,
        workspace: activeSession.value?.workspace || undefined,
        category_id: activeSession.value?.categoryId ?? null,
        source: sessionSource,
        ...(runtimeMode.value === 'global_agent' ? { session_source: 'global_agent' as const } : {}),
        ...(sessionSource === 'workflow' ? { session_source: 'workflow' as const } : {}),
        ...(isCodingAgentExecution
          ? {
              coding_agent_id: codingAgentId,
              agent_preset: activeSession.value?.agentPreset,
              mode: codingAgentMode,
              baseUrl: codingAgentMode === 'global' ? undefined : activeSession.value?.baseUrl || providerGroup?.base_url || undefined,
              apiKey: codingAgentMode === 'global' ? undefined : activeSession.value?.apiKey || providerGroup?.api_key || undefined,
              apiMode: codingAgentApiMode,
            }
          : {}),
        // Per-session reasoning effort override. Hermes bridge and scoped coding
        // agents both consume this when the selected provider/API supports it.
        // Global coding-agent mode uses the user's native CLI config, so avoid
        // injecting a per-session override there.
        reasoning_effort: isCodingAgentExecution && codingAgentMode === 'global'
          ? undefined
          : activeSession.value?.reasoningEffort || undefined,
        push_enabled: activeSession.value?.pushEnabled !== false,
      }
      if (shouldSendInitialSessionConfig && activeSession.value) {
        activeSession.value.messageCount = Math.max(activeSession.value.messageCount || 0, 1)
      }

      // Helper to clean up this session's stream state
      const cleanup = () => {
        streamStates.value.delete(sid)
        serverWorking.value.delete(sid)
        // The run is over: its start must not leak into the next one.
        clearRunStartedAt(sid)
      }

      // Per-active-run flags used to detect silently-swallowed errors at run.completed.
      // hermes-agent occasionally emits run.completed with empty output and no
      // usage when the agent layer caught an upstream error (e.g. invalid API
      // key). We need to distinguish: (a) run with assistant text produced,
      // (b) run with only tool activity, (c) run with truly nothing visible.
      // Reset on every run.started because one handler may span multiple queued runs.
      let runProducedAssistantText = false
      let runProducedAssistantContent = false
      let runHadToolActivity = false
      let activeAssistantMessageId: string | null = null
      let reasoningAssistantMessageId: string | null = null
      let activeRunMarker: string | null = null

      const closeStreamingAssistant = () => {
        const msgs = getSessionMsgs(sid)
        msgs.forEach(m => {
          if (m.role === 'assistant' && m.isStreaming) {
            updateMessage(sid, m.id, { isStreaming: false })
          }
        })
        activeAssistantMessageId = null
        reasoningAssistantMessageId = null
        activeRunMarker = null
      }

      const applyReconnectResume = (data: ResumeSessionPayload) => {
        if (generation !== runtimeGeneration || data.session_id !== sid) return
        const target = sessions.value.find(s => s.id === sid)
        if (!target) return

        if (data.isWorking) serverWorking.value.add(sid)
        else serverWorking.value.delete(sid)
        applyResumedRunActivity(sid, data as any)

        if (data.queueLength && data.queueLength > 0) {
          queueLengths.value.set(sid, data.queueLength)
        } else {
          queueLengths.value.delete(sid)
        }

        if (Array.isArray(data.queueMessages)) {
          replaceQueuedUserMessages(sid, normalizeQueuedUserMessages(data.queueMessages))
        } else if (!data.queueLength) {
          replaceQueuedUserMessages(sid, [])
        }
        replaceQueueInsertionState(sid, data.queueInsertion)

        if (data.isAborting) {
          setAbortState(sid, { aborting: true, synced: null })
        } else if (!data.isWorking) {
          setAbortState(sid, null)
        }
        if (!data.isWorking) setCompressionState(sid, null)

        if (data.inputTokens != null) target.inputTokens = data.inputTokens
        if (data.outputTokens != null) target.outputTokens = data.outputTokens
        if (data.contextTokens != null) target.contextTokens = data.contextTokens
        applyResumedSessionSettings(data)

        if (Array.isArray(data.messages)) {
          const previousActiveAssistantMessageId = activeAssistantMessageId
          const previousReasoningAssistantMessageId = reasoningAssistantMessageId
          const replayRunMarker = getReplayRunMarker(data.events) ?? activeRunMarker
          target.messages = mapHermesMessages(data.messages as any[], data.taskPlans, target.messages)
          restorePersistedSubagentStreams(sid)
          setWorkspaceRunChanges(sid, data.workspaceRunChanges || [])
          target.loadedMessageCount = data.messageLoadedCount ?? data.messages.length
          target.messageTotal = data.messageTotal ?? target.messageCount ?? target.loadedMessageCount
          target.messageCount = target.messageTotal
          target.hasMoreBefore = data.hasMoreBefore ?? target.loadedMessageCount < target.messageTotal
          const resumedAssistantState = data.isWorking
            ? resolveResumedAssistantState(target.messages, {
                previousActiveAssistantMessageId,
                previousReasoningAssistantMessageId,
                activeRunMarker: replayRunMarker,
              })
            : {
                activeAssistant: null,
                reasoningAssistant: null,
                runMarker: null,
                hadVisibleText: false,
              }

          const resumedActiveAssistant = resumedAssistantState.activeAssistant
          const resumedReasoningAssistant = resumedAssistantState.reasoningAssistant
          activeRunMarker = resumedAssistantState.runMarker

          if (resumedActiveAssistant) {
            resumedActiveAssistant.isStreaming = true
            activeAssistantMessageId = resumedActiveAssistant.id
            if (resumedAssistantState.hadVisibleText) runProducedAssistantText = true
          } else {
            activeAssistantMessageId = null
          }

          if (resumedReasoningAssistant) {
            reasoningAssistantMessageId = resumedReasoningAssistant.id
            if (resumedReasoningAssistant.reasoning) noteReasoningStart(resumedReasoningAssistant.id)
          } else {
            reasoningAssistantMessageId = null
          }
        }

        if (data.events?.length) {
          for (const evt of data.events) {
            const e = evt.data as RunEvent
            switch (e.event) {
              case 'compression.started':
                setCompressionState(sid, {
                  compressing: true,
                  messageCount: (e as any).message_count || 0,
                  beforeTokens: (e as any).token_count || 0,
                  afterTokens: 0,
                  compressed: null,
                })
                break
              case 'compression.completed': {
                const afterTokens = (e as any).contextTokens || (e as any).afterTokens || 0
                setCompressionState(sid, {
                  compressing: false,
                  messageCount: (e as any).totalMessages || 0,
                  beforeTokens: (e as any).beforeTokens || 0,
                  afterTokens,
                  compressed: (e as any).compressed ?? false,
                  error: (e as any).error,
                })
                if ((e as any).contextTokens != null) target.contextTokens = (e as any).contextTokens
                break
              }
              case 'abort.started':
                setAbortState(sid, { aborting: true, synced: null })
                break
              case 'abort.timeout':
                setAbortState(sid, { aborting: true, synced: false, timedOut: true, message: (e as any).message })
                break
              case 'abort.completed':
                setAbortState(sid, { aborting: false, synced: (e as any).synced ?? false })
                settleInterruptedSubagents(sid)
                break
              case 'approval.requested':
                setPendingApproval({ ...e, session_id: sid })
                break
              case 'approval.resolved':
                clearPendingApproval({ ...e, session_id: sid })
                break
              case 'clarify.requested':
                setPendingClarify({ ...e, session_id: sid })
                break
              case 'clarify.resolved':
                clearPendingClarify({ ...e, session_id: sid })
                break
              case 'run.failed':
                handleTerminalWorkspaceRunChange(sid, e)
                if (!isQueueInsertionInterruption(e)) addAgentErrorMessage(sid, e.error)
                break
              case 'plan.updated':
              case 'agent.event':
                handleAgentEvent(e)
                break
            }
          }
        }

        if (activeSessionId.value === sid) activeSession.value = target
        if (!data.isWorking && !(data.queueLength && data.queueLength > 0)) {
          clearAgentEventMessages(sid)
          cleanup()
          activeAssistantMessageId = null
          updateSessionTitle(sid)
        }
      }

      // Send run via Socket.IO and listen to streamed events — all closures capture `sid`
      const ctrl = startRunViaSocket(
        runPayload,
        // onEvent
        (evt: RunEvent) => {
          if (generation !== runtimeGeneration || (evt.session_id && evt.session_id !== sid)) return
          applyBackgroundPendingEvent(sid, evt)
          const eventRunMarker = readRunMarker(evt)
          if (eventRunMarker) activeRunMarker = eventRunMarker
          switch (evt.event) {
            case 'run.started':
              clearSessionCompletedUnread(sid)
              serverWorking.value.add(sid)
              setRunStartedAt(sid, Date.now())
              clearAgentEventMessages(sid)
              setAbortState(sid, null)
              setCompressionState(sid, null)
              runProducedAssistantText = false
              runProducedAssistantContent = false
              runHadToolActivity = false
              closeStreamingAssistant()
              activeRunMarker = readRunMarker(evt) ?? null
              if ((evt as any).queue_length > 0) {
                queueLengths.value.set(sid, (evt as any).queue_length)
              } else {
                queueLengths.value.delete(sid)
              }
              break

            case 'run.queued': {
              handleRunQueuedEvent(sid, evt)
              break
            }

            case 'run.queue_insertion.updated': {
              handleQueueInsertionUpdated(evt)
              break
            }

            case 'session.command': {
              handleSessionCommandEvent(evt)
              break
            }

            case 'session.workspace.updated': {
              applySessionWorkspaceUpdate(evt)
              break
            }

            case 'session.settings.updated': {
              applySessionSettingsUpdate(evt)
              break
            }

            case 'plan.updated':
            case 'agent.event': {
              handleAgentEvent(evt)
              break
            }

            case 'run.reattach_failed': {
              handleAgentEvent(evt)
              break
            }

            case 'compression.started': {
              setCompressionState(sid, {
                compressing: true,
                messageCount: (evt as any).message_count || 0,
                beforeTokens: (evt as any).token_count || 0,
                afterTokens: 0,
                compressed: null,
              })
              break
            }

            case 'compression.completed': {
              const afterTokens = (evt as any).contextTokens || (evt as any).afterTokens || 0
              setCompressionState(sid, {
                compressing: false,
                messageCount: (evt as any).totalMessages || 0,
                beforeTokens: (evt as any).beforeTokens || 0,
                afterTokens,
                compressed: (evt as any).compressed ?? false,
                error: (evt as any).error,
              })
              if ((evt as any).contextTokens != null) {
                const target = sessions.value.find(s => s.id === sid)
                if (target) target.contextTokens = (evt as any).contextTokens
              }
              // Auto-clear after 5s
              setTimeout(() => {
                const state = compressionStates.value.get(sid)
                if (state && !state.compressing) {
                  setCompressionState(sid, null)
                }
              }, 5000)
              break
            }

            case 'abort.started': {
              setAbortState(sid, { aborting: true, synced: null })
              break
            }

            case 'abort.timeout': {
              setAbortState(sid, { aborting: true, synced: false, timedOut: true, message: (evt as any).message })
              break
            }

            case 'abort.completed': {
              setAbortState(sid, { aborting: false, synced: (evt as any).synced ?? false })
              settleInterruptedSubagents(sid)
              clearPendingInteractions(sid)
              if ((evt as any).queue_length > 0) {
                queueLengths.value.set(sid, (evt as any).queue_length)
                setAbortState(sid, null)
                break
              }
              const msgs = getSessionMsgs(sid)
              const lastMsg = msgs[msgs.length - 1]
              if (lastMsg?.isStreaming) {
                updateMessage(sid, lastMsg.id, { isStreaming: false })
              }
              msgs.forEach((m, i) => {
                if (m.role === 'tool' && m.toolStatus === 'running') {
                  msgs[i] = { ...m, toolStatus: 'done' }
                }
              })
              cleanup()
              setAbortState(sid, null)
              break
            }

            case 'reasoning.delta':
            case 'thinking.delta': {
              const text = evt.text || evt.delta || ''
              if (!text) break
              runProducedAssistantText = true
              const msgs = getSessionMsgs(sid)
              const reasoningTargetId = reasoningAssistantMessageId || activeAssistantMessageId
              const last = reasoningTargetId
                ? msgs.find(m => m.id === reasoningTargetId)
                : null
              if (last?.role === 'assistant') {
                last.reasoning = (last.reasoning || '') + text
                reasoningAssistantMessageId = last.id
                noteReasoningStart(last.id)
              } else {
                const newId = uid()
                addMessage(sid, {
                  id: newId,
                  role: 'assistant',
                  content: '',
                  timestamp: Date.now(),
                  isStreaming: true,
                  reasoning: text,
                })
                activeAssistantMessageId = newId
                reasoningAssistantMessageId = newId
                noteReasoningStart(newId)
              }

              break
            }

            case 'moa.reference': {
              runHadToolActivity = true
              handleMoaEvent(sid, evt)
              break
            }

            case 'moa.aggregating': {
              runHadToolActivity = true
              handleMoaEvent(sid, evt)
              break
            }

            case 'reasoning.available': {
              // Upstream run_agent.py fires reasoning.available with
              // `assistant_message.content[:500]` as the preview — i.e.,
              // the main answer, not real reasoning. Ignore the payload
              // and only use this event as a "thinking ended" signal so
              // the duration counter stops.
              const msgs = getSessionMsgs(sid)
              const last = msgs[msgs.length - 1]
              if (last?.role === 'assistant' && last.isStreaming) {
                // 只有当 reasoning.delta 事件曾经启动过计时，才标记结束；
                // 否则（上游未转发 delta，只发这一次 available）不显示时长。
                noteReasoningEnd(last.id)
              }

              break
            }

            case 'message.delta': {
              if (evt.delta) {
                runProducedAssistantText = true
                runProducedAssistantContent = true
              }
              const msgs = getSessionMsgs(sid)
              const last = activeAssistantMessageId
                ? msgs.find(m => m.id === activeAssistantMessageId)
                : null
              if (last?.role === 'assistant' && last.isStreaming) {
                const prev = last.content
                const next = prev + (evt.delta || '')
                noteThinkingDelta(last.id, prev, next)
                // 若之前有 reasoning 累积，则 content 到达即视为推理结束。
                if (last.reasoning) noteReasoningEnd(last.id)
                last.content = next
              } else {
                const newId = uid()
                const nextContent = evt.delta || ''
                noteThinkingDelta(newId, '', nextContent)
                addMessage(sid, {
                  id: newId,
                  role: 'assistant',
                  content: nextContent,
                  timestamp: Date.now(),
                  isStreaming: true,
                })
                activeAssistantMessageId = newId
              }

              break
            }

            case 'message.interim': {
              const text = String(evt.text || '')
              if (!text.trim()) break
              runProducedAssistantText = true
              runProducedAssistantContent = true
              const msgs = getSessionMsgs(sid)
              const active = activeAssistantMessageId
                ? msgs.find(m => m.id === activeAssistantMessageId)
                : null
              if (active?.role === 'assistant') {
                active.content = text
                active.isStreaming = false
                if (active.reasoning) noteReasoningEnd(active.id)
              } else {
                addMessage(sid, {
                  id: uid(),
                  role: 'assistant',
                  content: text,
                  timestamp: Date.now(),
                  isStreaming: false,
                })
              }
              activeAssistantMessageId = null
              reasoningAssistantMessageId = null

              break
            }

            case 'session.title.updated': {
              applyGeneratedSessionTitle(evt)
              break
            }

            case 'tool.started': {
              runHadToolActivity = true
              const startedToolName = evt.tool || evt.name
              if (
                isBackgroundDelegateToolPayload(startedToolName, evt.arguments)
                || (isEkkoAgentSession(sid) && startedToolName === 'delegate_task')
              ) break
              const msgs = getSessionMsgs(sid)
              const last = activeAssistantMessageId
                ? msgs.find(m => m.id === activeAssistantMessageId)
                : msgs[msgs.length - 1]
              const toolReasoning =
                last?.role === 'assistant' && last.reasoning?.trim()
                  ? last.reasoning
                  : undefined
              if (last?.isStreaming) {
                updateMessage(sid, last.id, { isStreaming: false })
              }
              activeAssistantMessageId = null
              reasoningAssistantMessageId = null
              handleToolStartedEvent(sid, evt, toolReasoning)

              break
            }

            case 'tool.completed':
            case 'tool.failed': {
              runHadToolActivity = true
              handleToolCompletedEvent(sid, evt)

              break
            }

            case 'workspace.diff.completed': {
              activeAssistantMessageId = handleWorkspaceRunChangeEvent(sid, evt, activeAssistantMessageId)
              break
            }

            case 'subagent.start':
            case 'subagent.tool':
            case 'subagent.progress':
            case 'subagent.text':
            case 'subagent.thinking':
            case 'subagent.complete':
            case 'delegation.updated': {
              runHadToolActivity = true
              handleSubagentEvent(sid, evt)
              break
            }

            case 'approval.requested': {
              setPendingApproval(evt)
              break
            }

            case 'approval.resolved': {
              clearPendingApproval(evt)
              break
            }

            case 'clarify.requested': {
              setPendingClarify(evt)
              break
            }

            case 'clarify.resolved': {
              clearPendingClarify(evt)
              break
            }

            case 'run.completed': {
              clearRunStartedAt(sid)
              const msgs = getSessionMsgs(sid)
              const lastMsg = activeAssistantMessageId
                ? msgs.find(m => m.id === activeAssistantMessageId)
                : msgs[msgs.length - 1]
              const completedAssistantMessageId = lastMsg?.role === 'assistant' && lastMsg.isStreaming
                ? lastMsg.id
                : null
              clearAgentEventMessages(sid)
              if (lastMsg?.isStreaming) {
                updateMessage(sid, lastMsg.id, { isStreaming: false })
              }
              settleRunningTools(sid, 'done')
              // Server-computed usage (local countTokens, snapshot-aware)
              if ((evt as any).inputTokens != null) {
                const target = sessions.value.find(s => s.id === sid)
                if (target) {
                  target.inputTokens = (evt as any).inputTokens
                  target.outputTokens = (evt as any).outputTokens
                  if ((evt as any).contextTokens != null) target.contextTokens = (evt as any).contextTokens
                }
              }
              // Belt-and-suspenders: some providers may deliver the final
              // assistant text only via run.completed.output (no message.delta
              // stream). If we never produced assistant text but the gateway
              // reports a non-empty output, fall back to rendering it as a
              // single assistant message so the user actually sees the reply.

              // Check if backend provided parsed content (from stringified array format)
              let finalOutputTrimmed = ''
              if ((evt as any).parsed_content !== undefined) {
                // Backend has parsed stringified array format, update last assistant message
                const msgs = getSessionMsgs(sid)
                const lastAssistant = activeAssistantMessageId
                  ? msgs.find(m => m.id === activeAssistantMessageId)
                  : completedAssistantMessageId
                    ? msgs.find(m => m.id === completedAssistantMessageId)
                    : undefined
                const parsedContent = typeof (evt as any).parsed_content === 'string'
                  ? (evt as any).parsed_content
                  : ''
                const parsedContentTrimmed = parsedContent.trim()
                if (lastAssistant) {
                  const existingContentTrimmed = lastAssistant.content?.trim() ?? ''
                  if (parsedContentTrimmed || !existingContentTrimmed) {
                    updateMessage(sid, lastAssistant.id, {
                      content: parsedContent,
                    })
                    finalOutputTrimmed = parsedContentTrimmed
                    if (parsedContentTrimmed) {
                      runProducedAssistantText = true
                      runProducedAssistantContent = true
                    }
                  } else {
                    finalOutputTrimmed = existingContentTrimmed
                    runProducedAssistantText = true
                  }
                  if ((evt as any).parsed_reasoning) {
                    updateMessage(sid, lastAssistant.id, {
                      reasoning: (evt as any).parsed_reasoning,
                    })
                  }
                } else if (parsedContentTrimmed) {
                  addMessage(sid, {
                    id: uid(),
                    role: 'assistant',
                    content: parsedContent,
                    reasoning: typeof (evt as any).parsed_reasoning === 'string' ? (evt as any).parsed_reasoning : undefined,
                    timestamp: Date.now(),
                  })
                  finalOutputTrimmed = parsedContentTrimmed
                  runProducedAssistantText = true
                  runProducedAssistantContent = true
                }
              } else {
                // Fallback to output field (legacy behavior)
                const finalOutput =
                  typeof evt.output === 'string' ? evt.output : ''
                finalOutputTrimmed = finalOutput.trim()
                if (!runProducedAssistantContent && finalOutputTrimmed !== '') {
                  const activeAssistant = activeAssistantMessageId
                    ? getSessionMsgs(sid).find(message =>
                        message.id === activeAssistantMessageId && message.role === 'assistant')
                    : null
                  if (activeAssistant) {
                    updateMessage(sid, activeAssistant.id, { content: finalOutput })
                  } else {
                    addMessage(sid, {
                      id: uid(),
                      role: 'assistant',
                      content: finalOutput,
                      timestamp: Date.now(),
                    })
                  }
                  runProducedAssistantText = true
                  runProducedAssistantContent = true
                }
              }
              // Workaround for upstream hermes-agent bug: when the agent
              // layer silently swallows an error (e.g. invalid API key,
              // unsupported model), the gateway still emits run.completed
              // with an empty output. Without surfacing it here the chat UI
              // looks frozen / "succeeded with no reply". Detect by the
              // combination of: no assistant text AND no tool activity AND
              // empty final output. Usage being zero is a *supporting*
              // signal but not required, since some providers/local models
              // legitimately omit usage.
              const queueInsertionInterruption = isQueueInsertionInterruption(evt)
              const swallowedError =
                !runProducedAssistantText &&
                !runHadToolActivity &&
                finalOutputTrimmed === '' &&
                !queueInsertionInterruption
              if (swallowedError) {
                addMessage(sid, {
                  id: uid(),
                  role: 'system',
                  content: 'Error: Agent returned no output. The model call may have failed (e.g. invalid API key, model not supported by provider, or context exceeded). Check the hermes-agent logs for details.',
                  timestamp: Date.now(),
                })
              } else {
                playCompletionBellIfEnabled()
                showCompletionNotificationIfEnabled(sid, completedAssistantMessageId)
              }
              const terminalAssistantMessageId = completedAssistantMessageId || [...getSessionMsgs(sid)]
                .reverse()
                .find(message => message.role === 'assistant' && String(message.content || '').trim())
                ?.id
              handleTerminalWorkspaceRunChange(sid, evt, terminalAssistantMessageId)
              attachWorkspaceChangesToMessages(sid)

              // 自动播放语音
              if (autoPlaySpeechEnabled.value && runProducedAssistantContent) {
                const msgs = getSessionMsgs(sid)
                const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant')
                if (lastAssistant?.content) {
                  // 延迟一小会儿再播放，确保 UI 更新完成
                  setTimeout(() => {
                    playMessageSpeech(lastAssistant.id, lastAssistant.content)
                  }, 300)
                }
              }

              const hasQueue = (evt as any).queue_remaining > 0
              markSessionCompletedUnread(sid, hasQueue)
              if (hasQueue) {
                queueLengths.value.set(sid, (evt as any).queue_remaining)
              } else {
                cleanup()
              }
              activeAssistantMessageId = null
              reasoningAssistantMessageId = null
              activeRunMarker = null
              updateSessionTitle(sid)
              break
            }

            case 'run.failed': {
              clearRunStartedAt(sid)
              clearPendingInteractions(sid)
              const failedMessages = getSessionMsgs(sid)
              const failedAssistant = activeAssistantMessageId
                ? failedMessages.find(message => message.id === activeAssistantMessageId)
                : [...failedMessages].reverse().find(message => message.role === 'assistant' && message.isStreaming)
              const queueInsertionInterruption = isQueueInsertionInterruption(evt)
              handleTerminalWorkspaceRunChange(sid, evt, failedAssistant?.id)
              clearAgentEventMessages(sid)
              if ((evt as any).inputTokens != null) {
                const target = sessions.value.find(s => s.id === sid)
                if (target) {
                  target.inputTokens = (evt as any).inputTokens
                  target.outputTokens = (evt as any).outputTokens
                  if ((evt as any).contextTokens != null) target.contextTokens = (evt as any).contextTokens
                }
              }
              if (queueInsertionInterruption) {
                if (failedAssistant?.isStreaming) updateMessage(sid, failedAssistant.id, { isStreaming: false })
                settleRunningTools(sid, 'done')
              } else {
                addAgentErrorMessage(sid, evt.error)
                settleRunningTools(sid, 'error')
              }
              if ((evt as any).queue_remaining > 0) {
                queueLengths.value.set(sid, (evt as any).queue_remaining)
              } else {
                cleanup()
              }
              activeAssistantMessageId = null
              reasoningAssistantMessageId = null
              activeRunMarker = null
              break
            }

            case 'usage.updated': {
              const target = sessions.value.find(s => s.id === sid)
              if (target) {
                target.inputTokens = (evt as any).inputTokens
                target.outputTokens = (evt as any).outputTokens
                if ((evt as any).contextTokens != null) target.contextTokens = (evt as any).contextTokens
              }
              break
            }
          }
        },
        // onDone
        () => {
          const msgs = getSessionMsgs(sid)
          const last = msgs[msgs.length - 1]
          if (last?.isStreaming) {
            updateMessage(sid, last.id, { isStreaming: false })
          }
          cleanup()
          activeAssistantMessageId = null
          reasoningAssistantMessageId = null
          activeRunMarker = null
          updateSessionTitle(sid)
        },
        // onError
        (err) => {
          console.warn('Socket.IO run stream error:', err.message)
          addAgentErrorMessage(sid, err.message)
          const msgs = getSessionMsgs(sid)
          msgs.forEach((m, i) => {
            if (m.role === 'tool' && m.toolStatus === 'running') {
              msgs[i] = { ...m, toolStatus: 'error' }
            }
          })
          cleanup()
          activeAssistantMessageId = null
          reasoningAssistantMessageId = null
          activeRunMarker = null
        },
        undefined,
        { onReconnectResume: applyReconnectResume, transport: runtimeTransport() },
      )
      runSubmitted = true

      if (isCodingAgentSession) {
        serverWorking.value.add(sid)
        streamStates.value.set(sid, ctrl)
      } else if (!isBridgeSlashCommand || isBridgeCompressCommand || isBridgePlanCommand || isBridgeGoalCommand) {
        streamStates.value.set(sid, ctrl)
      }
    } catch (err: any) {
      if (generation !== runtimeGeneration) return
      if (isBridgeForkCommand) {
        const nextPendingForkCommands = new Set(pendingForkCommands.value)
        nextPendingForkCommands.delete(sid)
        pendingForkCommands.value = nextPendingForkCommands
      }
      if (shouldQueue && !runSubmitted) {
        dropQueuedUserMessage(sid, userMsg.id)
      }
      if (!shouldQueue && !runSubmitted) {
        serverWorking.value.delete(sid)
      }
      addMessage(sid, {
        id: uid(),
        role: 'system',
        content: `Error: ${err.message}`,
        timestamp: Date.now(),
      })
    }
  }

  /**
   * Resume an in-flight run after page refresh.
   * Emits 'resume' to join the session room on the server,
   * then sets up event listeners to receive ongoing events.
   */
  function resumeServerWorkingRun(sid: string, force = false, passive = false) {
    const generation = runtimeGeneration
    // Don't register duplicate listeners if already streaming
    if (streamStates.value.has(sid)) return
    // Only set up listeners if the server reported an active run during resume.
    if (!force && !serverWorking.value.has(sid)) return

    let closed = false
    let runProducedAssistantText = false
    let runProducedAssistantContent = false
    let runHadToolActivity = false
    let activeAssistantMessageId: string | null = null
    let reasoningAssistantMessageId: string | null = null
    let activeRunMarker: string | null = null

    const cleanup = () => {
      if (closed) return
      closed = true
      streamStates.value.delete(sid)
      serverWorking.value.delete(sid)
      clearRunStartedAt(sid)
      // Unregister from global session handlers
      unregisterSessionHandlers(sid)
    }

    const markIdleKeepingBackgroundListener = () => {
      streamStates.value.delete(sid)
      serverWorking.value.delete(sid)
      clearRunStartedAt(sid)
    }

    const ensureAbortHandle = () => {
      if (streamStates.value.has(sid)) return
      streamStates.value.set(sid, {
        abort: () => {
          getChatRunSocket(runtimeTransport())?.emit('abort', { session_id: sid })
        },
      })
    }

    const closeStreamingAssistant = () => {
      const msgs = getSessionMsgs(sid)
      msgs.forEach(m => {
        if (m.role === 'assistant' && m.isStreaming) {
          updateMessage(sid, m.id, { isStreaming: false })
        }
      })
      activeAssistantMessageId = null
      reasoningAssistantMessageId = null
      activeRunMarker = null
    }

    const initializeResumedAssistantState = () => {
      const resumedAssistantState = resolveResumedAssistantState(getSessionMsgs(sid), { activeRunMarker })
      activeRunMarker = resumedAssistantState.runMarker
      if (resumedAssistantState.activeAssistant) {
        resumedAssistantState.activeAssistant.isStreaming = true
        activeAssistantMessageId = resumedAssistantState.activeAssistant.id
        if (resumedAssistantState.hadVisibleText) runProducedAssistantText = true
      }
      if (resumedAssistantState.reasoningAssistant) {
        reasoningAssistantMessageId = resumedAssistantState.reasoningAssistant.id
        if (resumedAssistantState.reasoningAssistant.reasoning) {
          noteReasoningStart(resumedAssistantState.reasoningAssistant.id)
        }
      }
    }

    initializeResumedAssistantState()

    // Shared event handler — filters by session_id tag
    function handleEvent(evt: RunEvent) {
      if (closed || generation !== runtimeGeneration) return
      // Filter events for this session (server tags all events with session_id)
      if (evt.session_id && evt.session_id !== sid) return
      applyBackgroundPendingEvent(sid, evt)
      const eventRunMarker = readRunMarker(evt)
      if (eventRunMarker) activeRunMarker = eventRunMarker
      switch (evt.event) {
        case 'run.queued': {
          handleRunQueuedEvent(sid, evt)
          break
        }

        case 'run.queue_insertion.updated': {
          handleQueueInsertionUpdated(evt)
          break
        }

        case 'session.command': {
          handleSessionCommandEvent(evt)
          break
        }

        case 'session.workspace.updated': {
          applySessionWorkspaceUpdate(evt)
          break
        }

        case 'session.settings.updated': {
          applySessionSettingsUpdate(evt)
          break
        }

        case 'plan.updated':
        case 'agent.event': {
          handleAgentEvent(evt)
          break
        }

        case 'run.reattach_failed': {
          handleAgentEvent(evt)
          break
        }

        case 'run.started':
          clearSessionCompletedUnread(sid)
          serverWorking.value.add(sid)
          setRunStartedAt(sid, Date.now())
          ensureAbortHandle()
          clearAgentEventMessages(sid)
          setAbortState(sid, null)
          setCompressionState(sid, null)
          runProducedAssistantText = false
          runProducedAssistantContent = false
          runHadToolActivity = false
          closeStreamingAssistant()
          activeRunMarker = readRunMarker(evt) ?? null
          if ((evt as any).queue_length > 0) {
            queueLengths.value.set(sid, (evt as any).queue_length)
          } else {
            queueLengths.value.delete(sid)
          }
          break

        case 'compression.started': {
          setCompressionState(sid, {
            compressing: true,
            messageCount: (evt as any).message_count || 0,
            beforeTokens: (evt as any).token_count || 0,
            afterTokens: 0,
            compressed: null,
          })
          break
        }

        case 'compression.completed': {
          const afterTokens = (evt as any).contextTokens || (evt as any).afterTokens || 0
          setCompressionState(sid, {
            compressing: false,
            messageCount: (evt as any).totalMessages || 0,
            beforeTokens: (evt as any).beforeTokens || 0,
            afterTokens,
            compressed: (evt as any).compressed ?? false,
            error: (evt as any).error,
          })
          if ((evt as any).contextTokens != null) {
            const target = sessions.value.find(s => s.id === sid)
            if (target) target.contextTokens = (evt as any).contextTokens
          }
          setTimeout(() => {
            const state = compressionStates.value.get(sid)
            if (state && !state.compressing) {
              setCompressionState(sid, null)
            }
          }, 5000)
          break
        }

        case 'abort.started': {
          setAbortState(sid, { aborting: true, synced: null })
          break
        }

        case 'abort.timeout': {
          setAbortState(sid, { aborting: true, synced: false, timedOut: true, message: (evt as any).message })
          break
        }

        case 'abort.completed': {
          setAbortState(sid, { aborting: false, synced: (evt as any).synced ?? false })
          settleInterruptedSubagents(sid)
          clearPendingInteractions(sid)
          if ((evt as any).queue_length > 0) {
            queueLengths.value.set(sid, (evt as any).queue_length)
            setAbortState(sid, null)
            break
          }
          const msgs = getSessionMsgs(sid)
          const lastMsg = msgs[msgs.length - 1]
          if (lastMsg?.isStreaming) {
            updateMessage(sid, lastMsg.id, { isStreaming: false })
          }
          msgs.forEach((m, i) => {
            if (m.role === 'tool' && m.toolStatus === 'running') {
              msgs[i] = { ...m, toolStatus: 'done' }
            }
          })
          cleanup()
          setAbortState(sid, null)
          break
        }

        case 'reasoning.delta':
        case 'thinking.delta': {
          const text = evt.text || evt.delta || ''
          if (!text) break
          runProducedAssistantText = true
          const msgs = getSessionMsgs(sid)
          const reasoningTargetId = reasoningAssistantMessageId || activeAssistantMessageId
          const last = reasoningTargetId
            ? msgs.find(m => m.id === reasoningTargetId)
            : null
          if (last?.role === 'assistant') {
            last.reasoning = (last.reasoning || '') + text
            reasoningAssistantMessageId = last.id
            noteReasoningStart(last.id)
          } else {
            const newId = uid()
            addMessage(sid, {
              id: newId,
              role: 'assistant',
              content: '',
              timestamp: Date.now(),
              isStreaming: true,
              reasoning: text,
            })
            activeAssistantMessageId = newId
            reasoningAssistantMessageId = newId
            noteReasoningStart(newId)
          }

          break
        }

        case 'moa.reference': {
          runHadToolActivity = true
          handleMoaEvent(sid, evt)
          break
        }

        case 'moa.aggregating': {
          runHadToolActivity = true
          handleMoaEvent(sid, evt)
          break
        }

        case 'reasoning.available': {
          const msgs = getSessionMsgs(sid)
          const last = msgs[msgs.length - 1]
          if (last?.role === 'assistant' && last.isStreaming) {
            noteReasoningEnd(last.id)
          }

          break
        }

        case 'message.delta': {
          if (evt.delta) {
            runProducedAssistantText = true
            runProducedAssistantContent = true
          }
          const msgs = getSessionMsgs(sid)
          const last = activeAssistantMessageId
            ? msgs.find(m => m.id === activeAssistantMessageId)
            : null
          if (last?.role === 'assistant' && last.isStreaming) {
            const prev = last.content
            const next = prev + (evt.delta || '')
            noteThinkingDelta(last.id, prev, next)
            if (last.reasoning) noteReasoningEnd(last.id)
            last.content = next
          } else {
            const newId = uid()
            const nextContent = evt.delta || ''
            noteThinkingDelta(newId, '', nextContent)
            addMessage(sid, {
              id: newId,
              role: 'assistant',
              content: nextContent,
              timestamp: Date.now(),
              isStreaming: true,
            })
            activeAssistantMessageId = newId
          }

          break
        }

        case 'message.interim': {
          const text = String(evt.text || '')
          if (!text.trim()) break
          runProducedAssistantText = true
          runProducedAssistantContent = true
          const msgs = getSessionMsgs(sid)
          const active = activeAssistantMessageId
            ? msgs.find(m => m.id === activeAssistantMessageId)
            : null
          if (active?.role === 'assistant') {
            active.content = text
            active.isStreaming = false
            if (active.reasoning) noteReasoningEnd(active.id)
          } else {
            addMessage(sid, {
              id: uid(),
              role: 'assistant',
              content: text,
              timestamp: Date.now(),
              isStreaming: false,
            })
          }
          activeAssistantMessageId = null
          reasoningAssistantMessageId = null

          break
        }

        case 'session.title.updated': {
          applyGeneratedSessionTitle(evt)
          break
        }

        case 'tool.started': {
          runHadToolActivity = true
          const startedToolName = evt.tool || evt.name
          if (
            isBackgroundDelegateToolPayload(startedToolName, evt.arguments)
            || (isEkkoAgentSession(sid) && startedToolName === 'delegate_task')
          ) break
          const msgs = getSessionMsgs(sid)
          const last = activeAssistantMessageId
            ? msgs.find(m => m.id === activeAssistantMessageId)
            : msgs[msgs.length - 1]
          const toolReasoning =
            last?.role === 'assistant' && last.reasoning?.trim()
              ? last.reasoning
              : undefined
          if (last?.isStreaming) {
            updateMessage(sid, last.id, { isStreaming: false })
          }
          activeAssistantMessageId = null
          reasoningAssistantMessageId = null
          handleToolStartedEvent(sid, evt, toolReasoning)

          break
        }

        case 'tool.completed':
        case 'tool.failed': {
          runHadToolActivity = true
          handleToolCompletedEvent(sid, evt)

          break
        }

        case 'workspace.diff.completed': {
          activeAssistantMessageId = handleWorkspaceRunChangeEvent(sid, evt, activeAssistantMessageId)
          break
        }

        case 'subagent.start':
        case 'subagent.tool':
        case 'subagent.progress':
        case 'subagent.text':
        case 'subagent.thinking':
        case 'subagent.complete':
        case 'delegation.updated': {
          runHadToolActivity = true
          handleSubagentEvent(sid, evt)
          break
        }

        case 'approval.requested': {
          setPendingApproval(evt)
          break
        }

        case 'approval.resolved': {
          clearPendingApproval(evt)
          break
        }

        case 'clarify.requested': {
          setPendingClarify(evt)
          break
        }

        case 'clarify.resolved': {
          clearPendingClarify(evt)
          break
        }

        case 'run.completed': {
          clearRunStartedAt(sid)
          clearAgentEventMessages(sid)
          const hasQueue = (evt as any).queue_remaining > 0
          const hasBackground = (evt.background_pending || 0) > 0
          if (hasQueue) {
            queueLengths.value.set(sid, (evt as any).queue_remaining)
          } else {
            queueLengths.value.delete(sid)
          }
          const msgs = getSessionMsgs(sid)
          const lastMsg = activeAssistantMessageId
            ? msgs.find(m => m.id === activeAssistantMessageId)
            : msgs[msgs.length - 1]
          const completedAssistantMessageId = lastMsg?.role === 'assistant' && lastMsg.isStreaming
            ? lastMsg.id
            : null
          if (lastMsg?.isStreaming) {
            updateMessage(sid, lastMsg.id, { isStreaming: false })
          }
          settleRunningTools(sid, 'done')
          // Server-computed usage (local countTokens, snapshot-aware)
          if ((evt as any).inputTokens != null) {
            const target = sessions.value.find(s => s.id === sid)
            if (target) {
              target.inputTokens = (evt as any).inputTokens
              target.outputTokens = (evt as any).outputTokens
              if ((evt as any).contextTokens != null) target.contextTokens = (evt as any).contextTokens
            }
          }
          // Check if backend provided parsed content (from stringified array format)
          let finalOutputTrimmed = ''
          if ((evt as any).parsed_content !== undefined) {
            // Backend has parsed stringified array format, update last assistant message
            const msgs = getSessionMsgs(sid)
            const lastAssistant = activeAssistantMessageId
              ? msgs.find(m => m.id === activeAssistantMessageId)
              : completedAssistantMessageId
                ? msgs.find(m => m.id === completedAssistantMessageId)
                : undefined
            const parsedContent = typeof (evt as any).parsed_content === 'string'
              ? (evt as any).parsed_content
              : ''
            const parsedContentTrimmed = parsedContent.trim()
            if (lastAssistant) {
              const existingContentTrimmed = lastAssistant.content?.trim() ?? ''
              if (parsedContentTrimmed || !existingContentTrimmed) {
                updateMessage(sid, lastAssistant.id, {
                  content: parsedContent,
                })
                finalOutputTrimmed = parsedContentTrimmed
                if (parsedContentTrimmed) {
                  runProducedAssistantText = true
                  runProducedAssistantContent = true
                }
              } else {
                finalOutputTrimmed = existingContentTrimmed
                runProducedAssistantText = true
              }
              if ((evt as any).parsed_reasoning) {
                updateMessage(sid, lastAssistant.id, {
                  reasoning: (evt as any).parsed_reasoning,
                })
              }
            } else if (parsedContentTrimmed) {
              addMessage(sid, {
                id: uid(),
                role: 'assistant',
                content: parsedContent,
                reasoning: typeof (evt as any).parsed_reasoning === 'string' ? (evt as any).parsed_reasoning : undefined,
                timestamp: Date.now(),
              })
              finalOutputTrimmed = parsedContentTrimmed
              runProducedAssistantText = true
              runProducedAssistantContent = true
            }
          } else {
            // Fallback to output field (legacy behavior)
            const finalOutput = typeof evt.output === 'string' ? evt.output : ''
            finalOutputTrimmed = finalOutput.trim()
            if (!runProducedAssistantContent && finalOutputTrimmed !== '') {
              const activeAssistant = activeAssistantMessageId
                ? getSessionMsgs(sid).find(message =>
                    message.id === activeAssistantMessageId && message.role === 'assistant')
                : null
              if (activeAssistant) {
                updateMessage(sid, activeAssistant.id, { content: finalOutput })
              } else {
                addMessage(sid, {
                  id: uid(),
                  role: 'assistant',
                  content: finalOutput,
                  timestamp: Date.now(),
                })
              }
              runProducedAssistantText = true
              runProducedAssistantContent = true
            }
          }
          const queueInsertionInterruption = isQueueInsertionInterruption(evt)
          const swallowedError = !runProducedAssistantText
            && !runHadToolActivity
            && finalOutputTrimmed === ''
            && !queueInsertionInterruption
          if (swallowedError) {
            addMessage(sid, {
              id: uid(),
              role: 'system',
              content: 'Error: Agent returned no output. The model call may have failed (e.g. invalid API key, model not supported by provider, or context exceeded). Check the hermes-agent logs for details.',
              timestamp: Date.now(),
            })
          } else {
            playCompletionBellIfEnabled()
            showCompletionNotificationIfEnabled(sid, completedAssistantMessageId)
          }
          const terminalAssistantMessageId = completedAssistantMessageId || [...getSessionMsgs(sid)]
            .reverse()
            .find(message => message.role === 'assistant' && String(message.content || '').trim())
            ?.id
          handleTerminalWorkspaceRunChange(sid, evt, terminalAssistantMessageId)
          attachWorkspaceChangesToMessages(sid)

          // Auto-play speech for every completed assistant message
          if (autoPlaySpeechEnabled.value && runProducedAssistantContent) {
            const msgs = getSessionMsgs(sid)
            const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant')
            if (lastAssistant?.content) {
              setTimeout(() => {
                playMessageSpeech(lastAssistant.id, lastAssistant.content)
              }, 300)
            }
          }

          if (!hasQueue && !hasBackground) {
            markSessionCompletedUnread(sid)
            cleanup()
            activeAssistantMessageId = null
            reasoningAssistantMessageId = null
            activeRunMarker = null
          } else if (hasQueue) {
            markSessionCompletedUnread(sid, true)
            // More runs pending — reset for next run but don't cleanup
            activeAssistantMessageId = null
            reasoningAssistantMessageId = null
            activeRunMarker = null
          } else {
            markSessionCompletedUnread(sid)
            markIdleKeepingBackgroundListener()
            activeAssistantMessageId = null
            reasoningAssistantMessageId = null
            activeRunMarker = null
          }
          updateSessionTitle(sid)
          break
        }

        case 'run.failed': {
          clearRunStartedAt(sid)
          clearPendingInteractions(sid)
          const failedMessages = getSessionMsgs(sid)
          const failedAssistant = activeAssistantMessageId
            ? failedMessages.find(message => message.id === activeAssistantMessageId)
            : [...failedMessages].reverse().find(message => message.role === 'assistant' && message.isStreaming)
          const queueInsertionInterruption = isQueueInsertionInterruption(evt)
          handleTerminalWorkspaceRunChange(sid, evt, failedAssistant?.id)
          clearAgentEventMessages(sid)
          if ((evt as any).inputTokens != null) {
            const target = sessions.value.find(s => s.id === sid)
            if (target) {
              target.inputTokens = (evt as any).inputTokens
              target.outputTokens = (evt as any).outputTokens
              if ((evt as any).contextTokens != null) target.contextTokens = (evt as any).contextTokens
            }
          }
          const hasQueue = (evt as any).queue_remaining > 0
          const hasBackground = (evt.background_pending || 0) > 0
          if (hasQueue) {
            queueLengths.value.set(sid, (evt as any).queue_remaining)
          } else {
            queueLengths.value.delete(sid)
          }
          if (queueInsertionInterruption) {
            if (failedAssistant?.isStreaming) updateMessage(sid, failedAssistant.id, { isStreaming: false })
            settleRunningTools(sid, 'done')
          } else {
            addAgentErrorMessage(sid, evt.error)
            settleRunningTools(sid, 'error')
          }
          if (!hasQueue && !hasBackground) {
            cleanup()
          } else if (hasBackground && !hasQueue) {
            markIdleKeepingBackgroundListener()
          }
          activeAssistantMessageId = null
          reasoningAssistantMessageId = null
          activeRunMarker = null
          break
        }

        case 'usage.updated': {
          const target = sessions.value.find(s => s.id === sid)
          if (target) {
            target.inputTokens = (evt as any).inputTokens
            target.outputTokens = (evt as any).outputTokens
            if ((evt as any).contextTokens != null) target.contextTokens = (evt as any).contextTokens
          }
          break
        }
      }
    }

    // Register handlers in global session map
    registerSessionHandlers(sid, {
      onMessageDelta: (evt) => handleEvent(evt),
      onMessageInterim: (evt) => handleEvent(evt),
      onReasoningDelta: (evt) => handleEvent(evt),
      onThinkingDelta: (evt) => handleEvent(evt),
      onReasoningAvailable: (evt) => handleEvent(evt),
      onToolStarted: (evt) => handleEvent(evt),
      onToolCompleted: (evt) => handleEvent(evt),
      onWorkspaceDiffCompleted: (evt) => handleEvent(evt),
      onSubagentEvent: (evt) => handleEvent(evt),
      onRunStarted: (evt) => handleEvent(evt),
      onRunCompleted: (evt) => handleEvent(evt),
      onRunFailed: (evt) => handleEvent(evt),
      onCompressionStarted: (evt) => handleEvent(evt),
      onCompressionCompleted: (evt) => handleEvent(evt),
      onAbortStarted: (evt) => handleEvent(evt),
      onAbortTimeout: (evt) => handleEvent(evt),
      onAbortCompleted: (evt) => handleEvent(evt),
      onUsageUpdated: (evt) => handleEvent(evt),
      onAgentEvent: (evt) => handleEvent(evt),
      onSessionCommand: (evt) => handleEvent(evt),
      onSessionWorkspaceUpdated: (evt) => handleEvent(evt),
      onSessionSettingsUpdated: applySessionSettingsUpdate,
      onRunQueued: (evt) => handleEvent(evt),
      onQueueInsertionUpdated: (evt) => handleEvent(evt),
      onClarifyRequested: (evt) => handleEvent(evt),
      onClarifyResolved: (evt) => handleEvent(evt),
    })

    // No need to emit resume here — switchSession already did it.
    // Server already joined room and replayed events.
    // Just set up handlers for ongoing streaming events.

    // A passive listener keeps background subagent telemetry alive without
    // making the parent session look busy. The abort handle is installed when
    // the completion notification starts its autonomous parent turn.
    if (!passive) ensureAbortHandle()
  }

  function handlePeerUserMessage(evt: RunEvent) {
    const sid = evt.session_id
    if (evt.event === 'approval.requested') return setPendingApproval(evt)
    if (evt.event === 'approval.resolved') return clearPendingApproval(evt)
    if (evt.event === 'clarify.requested') return setPendingClarify(evt)
    if (evt.event === 'clarify.resolved') return clearPendingClarify(evt)
    if (!sid || activeSessionId.value !== sid || !activeSession.value) return

    const peer = evt.message
    const content = typeof peer?.content === 'string' ? peer.content : ''
    if (!content.trim()) return

    const messageId = peer?.id != null ? String(peer.id) : ''
    const isPeerCommand = peer?.role === 'command'
    const msgs = getSessionMsgs(sid)
    if (messageId && msgs.some(msg => msg.id === messageId)) {
      serverWorking.value.add(sid)
      resumeServerWorkingRun(sid, true)
      return
    }
    if (messageId && (queuedUserMessages.value.get(sid) || []).some(msg => msg.id === messageId)) {
      if (isPeerCommand && !peer?.queued) {
        dropQueuedUserMessage(sid, messageId)
      } else {
        serverWorking.value.add(sid)
        resumeServerWorkingRun(sid, true)
        return
      }
    }

    const timestamp = typeof peer?.timestamp === 'number' && Number.isFinite(peer.timestamp)
      ? Math.round(peer.timestamp * 1000)
      : Date.now()

    const message: Message = {
      id: messageId || uid(),
      role: isPeerCommand ? 'command' : 'user',
      content,
      timestamp,
      queued: !!peer?.queued,
      systemType: isPeerCommand ? 'command' : undefined,
    }
    const wasDequeued = messageId ? consumeDequeuedQueueId(sid, messageId) : false
    if (peer?.queued || (
      peer?.queued !== false
      && !isPeerCommand
      && !wasDequeued
      && isSessionLive(sid)
    )) {
      enqueueUserMessage(sid, message)
    } else {
      addMessage(sid, message)
      updateSessionTitle(sid)
    }
    serverWorking.value.add(sid)
    resumeServerWorkingRun(sid, true)
  }

  onPeerUserMessage(handlePeerUserMessage)

  function handleGlobalSessionCommand(evt: RunEvent) {
    const sid = evt.session_id
    if (!sid || activeSessionId.value !== sid || !activeSession.value) return
    const shouldAttachToStartedRun = (evt as any).started === true && (evt as any).terminal === false
    handleSessionCommandEvent(evt)
    if (shouldAttachToStartedRun) {
      serverWorking.value.add(sid)
      resumeServerWorkingRun(sid, true)
    }
  }

  onSessionCommand(handleGlobalSessionCommand)

  onSessionTitleUpdated(applyGeneratedSessionTitle)
  onSessionWorkspaceUpdated(applySessionWorkspaceUpdate)
  onSessionSettingsUpdated(applySessionSettingsUpdate)

  function stopStreaming() {
    const sid = activeSessionId.value
    if (!sid) return
    if (isAborting.value) return
    clearPendingInteractions(sid)
    const ctrl = streamStates.value.get(sid)
    if (ctrl) {
      setAbortState(sid, { aborting: true, synced: null })
      ctrl.abort()
      const msgs = getSessionMsgs(sid)
      const lastMsg = msgs[msgs.length - 1]
      if (lastMsg?.isStreaming) {
        updateMessage(sid, lastMsg.id, { isStreaming: false })
      }
      return
    }
    if (serverWorking.value.has(sid)) {
      setAbortState(sid, { aborting: true, synced: null })
      getChatRunSocket(runtimeTransport())?.emit('abort', { session_id: sid })
      const msgs = getSessionMsgs(sid)
      const lastMsg = msgs[msgs.length - 1]
      if (lastMsg?.isStreaming) {
        updateMessage(sid, lastMsg.id, { isStreaming: false })
      }
    }
  }

  // Tab visibility: re-sync when returning to foreground
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !isStreaming.value) {
        // Live-sync the session list so sessions created elsewhere (CLI,
        // Telegram, another device) appear without a manual reload.
        void refreshSessionListOnly()
      }
      if (document.visibilityState === 'visible' && activeSessionId.value && !isStreaming.value) {
        const sid = activeSessionId.value
        if (sid && !streamStates.value.has(sid)) {
          // Re-load messages via resume (server loads from DB)
          const generation = runtimeGeneration
          resumeSession(sid, (data) => {
            if (generation !== runtimeGeneration || data.session_id !== sid || activeSessionId.value !== sid) return
            if (data.isWorking) {
              serverWorking.value.add(sid)
            } else {
              serverWorking.value.delete(sid)
            }
            applyResumedRunActivity(sid, data as any)
            if (data.isAborting) {
              setAbortState(sid, { aborting: true, synced: null })
            } else if (!data.isWorking) {
              setAbortState(sid, null)
            }
            if (!data.isWorking) setCompressionState(sid, null)
            applyResumedSessionSettings(data)
            if (Array.isArray(data.messages) && activeSession.value) {
              if (typeof data.workspace === 'string') {
                activeSession.value.workspace = data.workspace.trim() || null
                activeSession.value.isLocalOnly = false
              }
              activeSession.value.messages = mapHermesMessages(data.messages as any[], data.taskPlans, activeSession.value.messages)
              restorePersistedSubagentStreams(sid)
              setWorkspaceRunChanges(sid, data.workspaceRunChanges || [])
              activeSession.value.loadedMessageCount = data.messageLoadedCount ?? data.messages.length
              activeSession.value.messageTotal = data.messageTotal ?? activeSession.value.messageCount ?? activeSession.value.loadedMessageCount
              activeSession.value.messageCount = activeSession.value.messageTotal
              activeSession.value.hasMoreBefore = data.hasMoreBefore ?? activeSession.value.loadedMessageCount < activeSession.value.messageTotal
            }
            resumeServerWorkingRun(sid, (data.backgroundPending || 0) > 0, !data.isWorking)
          }, activeSession.value?.profile, runtimeTransport())
        }
      }
    })
  }

  // Mild background polling for live session-list sync (covers sessions created
  // on the VM via CLI/Telegram while this client is in the foreground). Only
  // runs when the tab is visible and not streaming, so it's cheap and never
  // disrupts an active run. visibilitychange (above) handles the wake-from-hidden
  // case; this covers the "left it open and watching" case.
  if (typeof window !== 'undefined') {
    window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      if (isStreaming.value) return
      void refreshSessionListOnly()
    }, 12_000)
  }

  // Transient observation of <think> boundaries during active streaming.
  // Not persisted; cleared on session switch. See spec §5.3.
  const thinkingObservation = new Map<string, { startedAt?: number; endedAt?: number }>()

  function getThinkingObservation(messageId: string) {
    return thinkingObservation.get(messageId)
  }

  function noteThinkingDelta(messageId: string, prevContent: string, nextContent: string) {
    const { startedAtBoundary, endedAtBoundary } = detectThinkingBoundary(prevContent, nextContent)
    if (!startedAtBoundary && !endedAtBoundary) return
    const existing = thinkingObservation.get(messageId) || {}
    if (startedAtBoundary && existing.startedAt === undefined) {
      existing.startedAt = Date.now()
    }
    if (endedAtBoundary && existing.endedAt === undefined) {
      existing.endedAt = Date.now()
    }
    thinkingObservation.set(messageId, existing)
  }

  /** 第一次见到某条消息的 reasoning 文本时，标记 startedAt。 */
  function noteReasoningStart(messageId: string) {
    const existing = thinkingObservation.get(messageId) || {}
    if (existing.startedAt === undefined) {
      existing.startedAt = Date.now()
      thinkingObservation.set(messageId, existing)
    }
  }

  /** 内容首次到达（视为推理结束）或显式收到 reasoning.available 时，标记 endedAt。 */
  function noteReasoningEnd(messageId: string) {
    const existing = thinkingObservation.get(messageId)
    if (!existing || existing.startedAt === undefined) return
    if (existing.endedAt === undefined) {
      existing.endedAt = Date.now()
      thinkingObservation.set(messageId, existing)
    }
  }

  function clearProviderFromSessions(provider: string) {
    if (!provider) return
    const target = provider.toLowerCase()
    for (const s of sessions.value) {
      if ((s.provider || '').toLowerCase() === target) {
        s.model = undefined
        s.provider = ''
      }
    }
  }

  async function setSessionReasoningEffort(sessionId: string, effort: string): Promise<boolean> {
    const target = sessions.value.find(s => s.id === sessionId)
    const activeTarget = activeSession.value?.id === sessionId ? activeSession.value : null
    const session = target || activeTarget
    if (!session) return false

    const nextEffort = effort || undefined
    const previousEffort = session.reasoningEffort
    if (target) target.reasoningEffort = nextEffort
    if (activeTarget) activeTarget.reasoningEffort = nextEffort
    if (session.isLocalOnly) return true

    if (!reasoningEffortWriteChains.has(sessionId)) {
      reasoningEffortConfirmedValues.set(sessionId, previousEffort)
    }
    reasoningEffortWriteTargets.set(sessionId, nextEffort)
    const previousWrite = reasoningEffortWriteChains.get(sessionId) || Promise.resolve(true)
    const write: Promise<boolean> = previousWrite
      .catch(() => false)
      .then(() => persistSessionReasoningEffort(sessionId, effort))
      .then((ok) => {
        if (ok) reasoningEffortConfirmedValues.set(sessionId, nextEffort)
        if (!ok && reasoningEffortWriteTargets.get(sessionId) === nextEffort) {
          const confirmedEffort = reasoningEffortConfirmedValues.get(sessionId)
          if (target) target.reasoningEffort = confirmedEffort
          if (activeTarget) activeTarget.reasoningEffort = confirmedEffort
        }
        return ok
      })
      .finally(() => {
        if (reasoningEffortWriteChains.get(sessionId) !== write) return
        reasoningEffortWriteChains.delete(sessionId)
        reasoningEffortWriteTargets.delete(sessionId)
        reasoningEffortConfirmedValues.delete(sessionId)
      })
    reasoningEffortWriteChains.set(sessionId, write)
    return write
  }

  async function setSessionPushEnabled(sessionId: string, enabled: boolean): Promise<boolean> {
    const target = sessions.value.find(s => s.id === sessionId)
    const activeTarget = activeSession.value?.id === sessionId ? activeSession.value : null
    const session = target || activeTarget
    if (!session) return false

    const previousEnabled = Boolean(session.pushEnabled)
    if (target) target.pushEnabled = enabled
    if (activeTarget) activeTarget.pushEnabled = enabled
    if (session.isLocalOnly) return true

    if (!pushEnabledWriteChains.has(sessionId)) {
      pushEnabledConfirmedValues.set(sessionId, previousEnabled)
    }
    pushEnabledWriteTargets.set(sessionId, enabled)
    const previousWrite = pushEnabledWriteChains.get(sessionId) || Promise.resolve(true)
    const write: Promise<boolean> = previousWrite
      .catch(() => false)
      .then(() => persistSessionPushEnabled(sessionId, enabled))
      .then((ok) => {
        if (ok) pushEnabledConfirmedValues.set(sessionId, enabled)
        if (!ok && pushEnabledWriteTargets.get(sessionId) === enabled) {
          const confirmedEnabled = pushEnabledConfirmedValues.get(sessionId) || false
          if (target) target.pushEnabled = confirmedEnabled
          if (activeTarget) activeTarget.pushEnabled = confirmedEnabled
        }
        return ok
      })
      .finally(() => {
        if (pushEnabledWriteChains.get(sessionId) !== write) return
        pushEnabledWriteChains.delete(sessionId)
        pushEnabledWriteTargets.delete(sessionId)
        pushEnabledConfirmedValues.delete(sessionId)
      })
    pushEnabledWriteChains.set(sessionId, write)
    return write
  }

  function clearThinkingObservationFor(_sessionId: string) {
    // messageId 与 sessionId 的关联未单独持有；方案是切会话时一律清空。
    // 这符合 spec 定义：observation 是"当前会话范围内"的 transient 状态。
    thinkingObservation.clear()
  }

  // 播放消息语音
  function playMessageSpeech(messageId: string, content: string) {
    // 触发自定义事件，让 MessageItem 组件处理播放
    const event = new CustomEvent('auto-play-speech', {
      detail: { messageId, content }
    })
    window.dispatchEvent(event)
  }

  return {
    sessions,
    runtimeMode,
    activeSessionId,
    activeSession,
    focusMessageId,
    messages,
    isStreaming,
    isForkPending,
    isRunActive,
    isSessionLive,
    isSessionWorking,
    runStartedAt,
    isSessionCompletedUnread,
    clearSessionCompletedUnread,
    sessionProfileFilter,
    setSessionProfileFilter,
    validateSessionProfileFilter,
    compressionState,
    abortState,
    isAborting,
    queueLengths,
    queuedUserMessages,
    queueInsertionStates,
    activeMessageReference,
    pendingApprovals,
    activePendingApproval,
    pendingClarifies,
    activePendingClarify,
    subagentStreams,
    getSubagentStream,
    removeQueuedMessage,
    insertQueuedMessage,
    setMessageReference,
    clearMessageReference,
    isLoadingSessions,
    sessionsLoaded,
    isLoadingMessages,

    newChat,
    newCliSession,
    switchSession,
    ensureSessionLoaded,
    loadOlderMessages,
    switchSessionModel,
    addOrUpdateSession,
    clearProviderFromSessions,
    deleteSession,
    archiveSession,
    sendMessage,
    stopStreaming,
    respondApproval,
    respondApprovalFor,
    respondToClarify,
    respondToClarifyFor,
    loadSessions,
    refreshSessionListOnly,
    refreshActiveSession,
    getThinkingObservation,
    noteThinkingDelta,
    noteReasoningStart,
    noteReasoningEnd,
    clearThinkingObservationFor,
    setAutoPlaySpeech,
    playMessageSpeech,
    loadWorkspaceRunChangeFile,
    setSessionReasoningEffort,
    setSessionPushEnabled,
    setRuntimeMode,
  }
})
