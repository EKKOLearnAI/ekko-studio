import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { AGENT_EVENT_BATCH_CAPABILITY, AGENT_EVENT_BATCH_BYTES, AGENT_EVENT_BATCH_COUNT, OutboundRelayEventSink, supportsAgentEventBatching, type RelayAgentEvent } from './agent-relay-event-sink'
import type { Server, Socket as ServerSocket } from 'socket.io'
import { io, type Socket as ClientSocket } from 'socket.io-client'
import { config } from '../../public/config'
import { groupAgentSocketAuth, normalizeCloudAgentMachineId } from './cloud-agent-auth'
import { logger } from '../../public/logging'
import {
  createGroupPrimaryAgentBridge,
  respondToGroupEkkoClarification,
  respondToGroupEkkoToolApproval,
} from '../../public/group-chat-agent-runtime'
import {
  AgentClient,
  type AgentConfig,
  type GroupAgentExecutor,
  type GroupChatRunService,
  type MentionMessage,
  type StructuredMentionEntry,
  type WorkspaceDiffBroadcaster,
} from './agent-clients'
import { defaultGroupChatWorkspace } from './workspace-files'
import type { GroupChatRuntimeServer } from './runtime'
import type { GroupRuntimeContext } from './room-summary'
import { getGroupChatAttachmentDir } from './attachments'
import { isPathWithin } from '../files/path'
import { isReservedMentionName } from './mention-routing'
import {
  authenticateGroupAgentConnector,
  claimGroupAgentPairingTicket,
  completeGroupAgentPairing,
  countActiveGuestAgentLinks,
  getGroupAgentConnector,
  releaseGroupAgentPairingClaim,
  revokeGroupAgentConnector,
  subscribeGroupAgentConnectorRevocations,
  touchGroupAgentConnector,
  normalizeRemoteGroupAgentDescriptor,
  type GroupAgentConnector,
  type RemoteGroupAgentDescriptor,
} from './agent-relay-store'
import {
  issueRemoteWorkspaceGrant,
  revokeRemoteWorkspaceGrantsForRun,
  waitForRemoteWorkspaceGrantOperations,
} from './remote-workspace-auth'
import {
  completeWorkspaceRunCheckpointDraft,
  discardWorkspaceRunCheckpoint,
  startWorkspaceRunCheckpoint,
} from '../chat-run/workspace-diff-tracker'

// Version 2 adds Pi to the remote Agent descriptor. Bumping the protocol keeps
// older Studio builds from accepting a descriptor they cannot validate.
export const GROUP_AGENT_RELAY_PROTOCOL_VERSION = 2
const RELAY_ACCEPT_TIMEOUT_MS = 10_000
const RELAY_RUN_TIMEOUT_MS = 150_000
const RELAY_INTERACTION_TIMEOUT_MS = 330_000
const RELAY_AGENT_CONFIG_UPDATE_INTERVAL_MS = 1_000
const RELAY_ATTACHMENT_CHUNK_BYTES = 256 * 1024
const RELAY_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024
const RELAY_RUN_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024
const OUTBOUND_LINKS_FILE = join(config.appHome, 'group-chat', 'group-chat-agent-links.json')
const OUTBOUND_ATTACHMENTS_DIR = join(config.appHome, 'group-chat-agent-relay', 'attachments')
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type RelayAttachment = {
  id: string
  type: 'image' | 'file'
  name: string
  mediaType: string
  size: number
}

type RelayAttachmentSource = RelayAttachment & {
  filePath: string
  device: number
  inode: number
}

type RelayRunRequest = {
  protocolVersion: 2
  runId: string
  room: { id: string; name: string; summaryProfile?: string }
  members: Array<{ userId?: string; id?: string; name: string; description?: string }>
  agents: Array<{ agentId?: string; id?: string; name: string; description?: string }>
  message: MentionMessage
  runtimeContext: GroupRuntimeContext
  attachments: RelayAttachment[]
  workspaceApi?: {
    token: string
    access: 'read-write'
  }
}

type PendingRelayRun = {
  runId: string
  roomId: string
  message: MentionMessage
  lastSeq: number
  accepted: boolean
  acceptedTimer: ReturnType<typeof setTimeout>
  runTimer: ReturnType<typeof setTimeout>
  attachments: Map<string, RelayAttachmentSource>
  messageIds: Map<string, string>
  approvalIds: Map<string, string>
  clarifyIds: Map<string, string>
  result: {
    parentMessageId?: string
    responseRunId?: string
  }
  resolve: () => void
  reject: (error: Error) => void
}

type WorkspaceDiffTerminalStatus = 'completed' | 'failed' | 'aborted'

function relayError(message: string, code = 'GROUP_AGENT_RELAY_ERROR'): Error {
  const error = new Error(message) as Error & { code?: string; data?: { code: string } }
  error.code = code
  error.data = { code }
  return error
}

function isTerminalOutboundCredentialError(error: unknown): boolean {
  const candidate = error as { code?: unknown; data?: { code?: unknown }; message?: unknown } | null
  const code = String(candidate?.code || candidate?.data?.code || '')
  if (code === 'GROUP_AGENT_CREDENTIAL_INVALID' || code === 'GROUP_AGENT_REGISTRATION_MISSING') return true
  const message = String(candidate?.message || error || '')
  return message.includes('Invalid or revoked reconnect credential')
    || message.includes('Remote Agent registration no longer exists')
}

function normalizeOrigin(value: unknown): string {
  const raw = String(value || '').trim()
  const url = new URL(raw)
  if (url.username || url.password || url.search || url.hash) throw new Error('Connection URL must not contain credentials, query, or fragment')
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('Connection URL must be an origin without a path')
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Connection URL must use HTTP or HTTPS')
  return url.origin
}

function boundedRelayText(value: unknown, maxLength: number, field: string, required = false): string {
  if (typeof value !== 'string') throw relayError(`Invalid Relay ${field}`, 'GROUP_AGENT_RUN_INVALID')
  const text = value.trim()
  if ((required && !text) || text.length > maxLength) {
    throw relayError(`Invalid Relay ${field}`, 'GROUP_AGENT_RUN_INVALID')
  }
  return text
}

export function redactRelaySecrets(value: unknown, secrets: string[], depth = 0): unknown {
  if (depth > 20) return '[REDACTED:DEPTH]'
  const activeSecrets = secrets.filter(secret => secret.length >= 16)
  if (!activeSecrets.length) return value
  if (typeof value === 'string') {
    return activeSecrets.reduce(
      (text, secret) => text.split(secret).join('[REDACTED]'),
      value,
    )
  }
  if (Array.isArray(value)) {
    return value.map(item => redactRelaySecrets(item, activeSecrets, depth + 1))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      String(redactRelaySecrets(key, activeSecrets, depth + 1)),
      redactRelaySecrets(item, activeSecrets, depth + 1),
    ]))
  }
  return value
}

export function relayRoomWorkspace(
  room: { id: string; summaryProfile?: string },
  fallbackProfile = 'default',
): string {
  const roomId = boundedRelayText(room?.id, 160, 'room id', true)
  if (roomId === '.' || roomId === '..' || !/^[a-zA-Z0-9_-]+$/.test(roomId)) {
    throw relayError('Invalid Relay room id', 'GROUP_AGENT_RUN_INVALID')
  }
  const summaryProfile = boundedRelayText(
    room?.summaryProfile || fallbackProfile || 'default',
    120,
    'room summary profile',
    true,
  )
  if (summaryProfile === '.' || summaryProfile === '..') {
    throw relayError('Invalid Relay room summary profile', 'GROUP_AGENT_RUN_INVALID')
  }
  const workspaceRoot = join(config.appHome, 'group-chat')
  const workspace = defaultGroupChatWorkspace(summaryProfile, roomId)
  if (!isPathWithin(workspace, workspaceRoot) || resolve(workspace) === resolve(workspaceRoot)) {
    throw relayError('Invalid Relay room workspace', 'GROUP_AGENT_RUN_INVALID')
  }
  return workspace
}

export function validateRelayRunRequest(value: unknown): asserts value is RelayRunRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw relayError('Invalid Relay run request', 'GROUP_AGENT_RUN_INVALID')
  }
  const request = value as RelayRunRequest
  if (request.protocolVersion !== GROUP_AGENT_RELAY_PROTOCOL_VERSION) {
    throw relayError('Invalid Relay protocol version', 'GROUP_AGENT_RUN_INVALID')
  }
  if (!UUID_PATTERN.test(String(request.runId || ''))) {
    throw relayError('Invalid Relay run id', 'GROUP_AGENT_RUN_INVALID')
  }
  boundedRelayText(request.room?.id, 160, 'room id', true)
  boundedRelayText(request.room?.name, 120, 'room name', true)
  if (request.room?.summaryProfile !== undefined) {
    boundedRelayText(request.room.summaryProfile, 120, 'room summary profile', true)
  }
  relayRoomWorkspace(request.room)
  if (!Array.isArray(request.members) || request.members.length > 500) {
    throw relayError('Invalid Relay member roster', 'GROUP_AGENT_RUN_INVALID')
  }
  for (const member of request.members) {
    if (!member || typeof member !== 'object') throw relayError('Invalid Relay member', 'GROUP_AGENT_RUN_INVALID')
    boundedRelayText(member.name, 120, 'member name', true)
    if (member.description !== undefined) boundedRelayText(member.description, 2_000, 'member description')
    const memberId = member.userId ?? member.id
    if (memberId !== undefined) boundedRelayText(memberId, 240, 'member id')
  }
  if (!Array.isArray(request.agents) || request.agents.length > 100) {
    throw relayError('Invalid Relay Agent roster', 'GROUP_AGENT_RUN_INVALID')
  }
  for (const agent of request.agents) {
    if (!agent || typeof agent !== 'object') throw relayError('Invalid Relay Agent', 'GROUP_AGENT_RUN_INVALID')
    boundedRelayText(agent.name, 120, 'Agent name', true)
    if (agent.description !== undefined) boundedRelayText(agent.description, 2_000, 'Agent description')
    const agentId = agent.agentId ?? agent.id
    if (agentId !== undefined) boundedRelayText(agentId, 240, 'Agent id')
  }
  const message = request.message
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw relayError('Invalid Relay message', 'GROUP_AGENT_RUN_INVALID')
  }
  if (message.messageId !== undefined) boundedRelayText(message.messageId, 240, 'message id')
  boundedRelayText(message.content, 1_000_000, 'message content')
  boundedRelayText(message.senderName, 120, 'message sender name', true)
  boundedRelayText(message.senderId, 240, 'message sender id', true)
  if (message.targetOwnerMemberId !== undefined) {
    boundedRelayText(message.targetOwnerMemberId, 240, 'target Agent owner member id', true)
  }
  if (!Number.isFinite(message.timestamp)) throw relayError('Invalid Relay message timestamp', 'GROUP_AGENT_RUN_INVALID')
  if (
    message.mentionDepth !== undefined
    && (!Number.isSafeInteger(message.mentionDepth) || message.mentionDepth < 0)
  ) {
    throw relayError('Invalid Relay mention depth', 'GROUP_AGENT_RUN_INVALID')
  }
  if (typeof message.input === 'string') {
    boundedRelayText(message.input, 1_000_000, 'message input')
  } else if (message.input !== undefined) {
    if (!Array.isArray(message.input) || message.input.length > 32) {
      throw relayError('Invalid Relay message blocks', 'GROUP_AGENT_RUN_INVALID')
    }
    for (const block of message.input as any[]) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) {
        throw relayError('Invalid Relay message block', 'GROUP_AGENT_RUN_INVALID')
      }
      if (block.type === 'text') {
        boundedRelayText(block.text, 1_000_000, 'message text')
        continue
      }
      if (block.type !== 'image' && block.type !== 'file') {
        throw relayError('Invalid Relay message block type', 'GROUP_AGENT_RUN_INVALID')
      }
      if (block.path !== '') throw relayError('Relay message paths must be opaque', 'GROUP_AGENT_RUN_INVALID')
      boundedRelayText(block.name, 255, 'attachment name', true)
      if (block.media_type !== undefined) boundedRelayText(block.media_type, 200, 'attachment media type')
      if (block.context !== undefined) boundedRelayText(block.context, 20_000, 'attachment context')
      boundedRelayText(block.relay_attachment_id, 80, 'attachment id', true)
    }
  }
  const runtimeContext = request.runtimeContext
  if (!runtimeContext || typeof runtimeContext !== 'object' || Array.isArray(runtimeContext)) {
    throw relayError('Invalid Relay runtime context', 'GROUP_AGENT_RUN_INVALID')
  }
  boundedRelayText(runtimeContext.summary, 1_000_000, 'runtime summary')
  if (!Array.isArray(runtimeContext.history) || runtimeContext.history.length > 600) {
    throw relayError('Invalid Relay runtime history', 'GROUP_AGENT_RUN_INVALID')
  }
  for (const history of runtimeContext.history) {
    if (!history || typeof history !== 'object') throw relayError('Invalid Relay history item', 'GROUP_AGENT_RUN_INVALID')
    boundedRelayText(history.id, 240, 'history id')
    boundedRelayText(history.senderName, 120, 'history sender name', true)
    boundedRelayText(history.content, 1_000_000, 'history content')
    if (history.role !== 'user' && history.role !== 'assistant') {
      throw relayError('Invalid Relay history role', 'GROUP_AGENT_RUN_INVALID')
    }
    if (!Number.isFinite(history.timestamp)) throw relayError('Invalid Relay history timestamp', 'GROUP_AGENT_RUN_INVALID')
  }
  if (!Array.isArray(request.attachments) || request.attachments.length > 32) {
    throw relayError('Invalid Relay attachment manifest', 'GROUP_AGENT_RUN_INVALID')
  }
  const attachmentIds = new Set<string>()
  for (const attachment of request.attachments) {
    if (
      !attachment
      || typeof attachment !== 'object'
      || !UUID_PATTERN.test(String(attachment.id || ''))
      || attachmentIds.has(attachment.id)
      || (attachment.type !== 'image' && attachment.type !== 'file')
      || !Number.isSafeInteger(attachment.size)
      || attachment.size < 0
      || attachment.size > RELAY_ATTACHMENT_MAX_BYTES
    ) {
      throw relayError('Invalid Relay attachment manifest', 'GROUP_AGENT_RUN_INVALID')
    }
    attachmentIds.add(attachment.id)
    boundedRelayText(attachment.name, 255, 'attachment name', true)
    boundedRelayText(attachment.mediaType, 200, 'attachment media type')
  }
  if (request.workspaceApi !== undefined) {
    if (
      !request.workspaceApi
      || typeof request.workspaceApi !== 'object'
      || request.workspaceApi.access !== 'read-write'
      || !/^[a-zA-Z0-9_-]{43}$/.test(String(request.workspaceApi.token || ''))
    ) {
      throw relayError('Invalid Relay workspace API grant', 'GROUP_AGENT_RUN_INVALID')
    }
  }
  let serialized = ''
  try {
    serialized = JSON.stringify(request)
  } catch {
    throw relayError('Invalid Relay run serialization', 'GROUP_AGENT_RUN_INVALID')
  }
  if (serialized.length > 8_000_000) {
    throw relayError('Relay run request is too large', 'GROUP_AGENT_RUN_INVALID')
  }
}

function sameRemoteAgent(
  left: RemoteGroupAgentDescriptor,
  right: RemoteGroupAgentDescriptor,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

class RelayGroupAgentExecutor implements GroupAgentExecutor {
  readonly agentId: string
  agent: 'hermes' | 'ekko' | 'codex' | 'claude' | 'pi' | 'grok' | 'opencode' | 'dsh' | 'cursor'
  agentMode: 'scoped' | 'global'
  profile: string
  provider: string
  model: string
  apiMode: string
  agentPreset?: string
  reasoningEffort: string
  name: string
  description: string
  avatar: string
  readonly ownerMemberId: string
  private activeSessions = new Map<string, string>()
  private pendingRun: PendingRelayRun | null = null
  private reservedInvocations = 0
  private detached = false
  private eventQueue: Promise<void> = Promise.resolve()
  private workspaceDiffBroadcaster: WorkspaceDiffBroadcaster | null = null

  constructor(
    private readonly relaySocket: ServerSocket,
    private readonly proxy: AgentClient,
    private readonly connector: GroupAgentConnector,
    agent: any,
    private readonly storage: any,
    private readonly expirePendingInteractions: (
      roomId: string,
      agentName: string,
      approvalIds: string[],
      clarifyIds: string[],
      reason: string,
    ) => void,
  ) {
    this.agentId = String(agent.agentId)
    this.agent = agent.agent || 'hermes'
    this.agentMode = agent.agentMode === 'global' ? 'global' : 'scoped'
    this.profile = String(agent.profile || 'default')
    this.provider = String(agent.provider || '')
    this.model = String(agent.model || '')
    this.apiMode = String(agent.apiMode || '')
    this.reasoningEffort = String(agent.reasoningEffort || '')
    this.agentPreset = agent.agentPreset
    this.name = String(agent.name || this.profile)
    this.description = String(agent.description || '')
    this.avatar = String(agent.avatar || '')
    this.ownerMemberId = String(agent.ownerMemberId || '')
  }

  get connected(): boolean {
    return !this.detached && this.relaySocket.connected
  }

  get busy(): boolean {
    return this.pendingRun !== null || this.reservedInvocations > 0
  }

  reserveInvocation(): void {
    this.reservedInvocations += 1
  }

  releaseInvocation(): void {
    this.reservedInvocations = Math.max(0, this.reservedInvocations - 1)
  }

  updateConfiguration(agent: any): void {
    this.agent = agent.agent || 'hermes'
    this.agentMode = agent.agentMode === 'global' ? 'global' : 'scoped'
    this.profile = String(agent.profile || 'default')
    this.provider = String(agent.provider || '')
    this.model = String(agent.model || '')
    this.apiMode = String(agent.apiMode || '')
    this.reasoningEffort = String(agent.reasoningEffort || '')
    this.agentPreset = agent.agentPreset
    this.name = String(agent.name || this.profile)
    this.description = String(agent.description || '')
    this.avatar = String(agent.avatar || '')
  }

  setStorage(_storage: any): void {}
  setWorkspaceDiffBroadcaster(broadcaster: WorkspaceDiffBroadcaster | null): void {
    this.workspaceDiffBroadcaster = broadcaster
  }
  setChatRunService(_service: GroupChatRunService | null): void {}

  sendMessage(
    roomId: string,
    content: string,
    messageId?: string,
    extra?: Record<string, unknown>,
    agentSessionId?: string,
  ): Promise<string> {
    return this.proxy.sendMessage(roomId, content, messageId, extra, agentSessionId)
  }

  getActiveSessionId(roomId: string): string | undefined {
    return this.activeSessions.get(roomId)
  }

  isActiveSession(roomId: string, sessionId: string): boolean {
    return this.activeSessions.get(roomId) === sessionId
  }

  async replyToMention(
    roomId: string,
    message: MentionMessage,
    runtimeContext: GroupRuntimeContext = { summary: '', history: [] },
    onStatus?: (status: 'compressing' | 'replying' | 'ready', extra?: Record<string, unknown>) => void,
  ): Promise<void> {
    if (!this.connected) throw relayError(`Remote Agent "${this.name}" is offline`, 'GROUP_AGENT_OFFLINE')
    if (this.pendingRun) throw relayError(`Remote Agent "${this.name}" is already running`, 'GROUP_AGENT_BUSY')
    const room = this.storage.getRoom(roomId)
    if (!room) throw relayError('Room no longer exists', 'GROUP_AGENT_ROOM_MISSING')
    const runId = randomUUID()
    const prepared = await this.prepareMessageAttachments(roomId, message)
    const sharedWorkspace = Number(room.allowRemoteWorkspaceAccess || 0) === 1
      ? String(room.workspace || '').trim()
      : ''
    if (sharedWorkspace) await mkdir(sharedWorkspace, { recursive: true, mode: 0o700 })
    const workspaceGrant = sharedWorkspace
      ? issueRemoteWorkspaceGrant({
          runId,
          roomId,
          agentId: this.agentId,
          workspace: sharedWorkspace,
          agentSnapshot: {
            name: this.name,
            agent: this.agent,
            agentMode: this.agentMode,
            profile: this.profile,
            provider: this.provider,
            model: this.model,
            description: this.description,
            avatar: this.avatar,
            ownerMemberId: this.ownerMemberId,
          },
        })
      : null
    const request: RelayRunRequest = {
      protocolVersion: GROUP_AGENT_RELAY_PROTOCOL_VERSION,
      runId,
      room: {
        id: roomId,
        name: String(room.name || roomId),
        summaryProfile: String(room.summaryProfile || 'default'),
      },
      members: this.storage.getRoomMembers(roomId),
      agents: (
        this.storage.getMentionableRoomAgents?.(roomId)
        ?? this.storage.getRoomAgents(roomId)
      ).map((item: any) => ({
        agentId: item.agentId,
        name: item.name,
        description: item.description,
      })),
      message: prepared.message,
      runtimeContext,
      attachments: prepared.attachments.map(attachment => ({
        id: attachment.id,
        type: attachment.type,
        name: attachment.name,
        mediaType: attachment.mediaType,
        size: attachment.size,
      })),
      ...(workspaceGrant
        ? {
            workspaceApi: {
              token: workspaceGrant.token,
              access: workspaceGrant.grant.access,
            },
          }
        : {}),
    }
    onStatus?.('replying')
    const workspaceSessionId = `group-relay:${this.connector.id}`
    let workspaceCheckpointStarted = false
    let workspaceDiffStatus: WorkspaceDiffTerminalStatus = 'completed'
    const relayResult: PendingRelayRun['result'] = {}
    try {
      if (workspaceGrant) {
        try {
          startWorkspaceRunCheckpoint({
            sessionId: workspaceSessionId,
            runId,
            workspace: workspaceGrant.grant.workspace,
          })
          workspaceCheckpointStarted = true
        } catch (error) {
          logger.warn(
            { error, roomId, runId, agentId: this.agentId },
            '[GroupChat] failed to start remote workspace diff checkpoint',
          )
        }
      }
      await new Promise<void>((resolve, reject) => {
        const acceptedTimer = setTimeout(() => {
          this.finishRun(runId, relayError('Remote Agent did not accept the run in time', 'GROUP_AGENT_ACCEPT_TIMEOUT'))
        }, RELAY_ACCEPT_TIMEOUT_MS)
        const runTimer = setTimeout(() => {
          this.relaySocket.emit('run.interrupt', { runId, reason: 'Remote Agent run timed out' })
          this.finishRun(runId, relayError('Remote Agent run timed out', 'GROUP_AGENT_RUN_TIMEOUT'))
        }, RELAY_RUN_TIMEOUT_MS)
        this.pendingRun = {
          runId,
          roomId,
          message: prepared.message,
          lastSeq: 0,
          accepted: false,
          acceptedTimer,
          runTimer,
          attachments: new Map(prepared.attachments.map(attachment => [attachment.id, attachment])),
          messageIds: new Map(),
          approvalIds: new Map(),
          clarifyIds: new Map(),
          result: relayResult,
          resolve,
          reject,
        }
        this.relaySocket.emit('run.request', request)
      })
    } catch (error: any) {
      workspaceDiffStatus = error?.code === 'GROUP_AGENT_INTERRUPTED' ? 'aborted' : 'failed'
      throw error
    } finally {
      revokeRemoteWorkspaceGrantsForRun(runId)
      await waitForRemoteWorkspaceGrantOperations(runId)
      if (workspaceCheckpointStarted && workspaceGrant) {
        this.finalizeRemoteWorkspaceDiff({
          roomId,
          sessionId: workspaceSessionId,
          runId,
          workspace: workspaceGrant.grant.workspace,
          status: workspaceDiffStatus,
          responseRunId: relayResult.responseRunId || runId,
          parentMessageId: relayResult.parentMessageId || null,
        })
      }
      onStatus?.(
        'ready',
        relayResult.responseRunId ? { runId: relayResult.responseRunId } : undefined,
      )
    }
  }

  private finalizeRemoteWorkspaceDiff(args: {
    roomId: string
    sessionId: string
    runId: string
    workspace: string
    status: WorkspaceDiffTerminalStatus
    responseRunId: string
    parentMessageId: string | null
  }): void {
    const currentRoom = this.storage.getRoom(args.roomId)
    if (!currentRoom || String(currentRoom.workspace || '').trim() !== args.workspace) {
      discardWorkspaceRunCheckpoint({
        sessionId: args.sessionId,
        runId: args.runId,
      })
      return
    }
    let draft
    try {
      draft = completeWorkspaceRunCheckpointDraft({
        sessionId: args.sessionId,
        runId: args.runId,
        workspace: args.workspace,
      })
    } catch (error) {
      logger.warn(
        { error, roomId: args.roomId, runId: args.runId, agentId: this.agentId },
        '[GroupChat] failed to complete remote workspace diff draft',
      )
      return
    }
    if (!draft) return
    try {
      const saved = this.storage.saveWorkspaceDiffMessageForRun?.({
        roomId: args.roomId,
        senderId: this.agentId,
        senderName: this.name,
        sessionId: args.sessionId,
        runId: args.runId,
        responseRunId: args.responseRunId,
        status: args.status,
        workspace: args.workspace,
        draft,
        parentMessageId: args.parentMessageId,
      })
      if (saved?.message) {
        this.workspaceDiffBroadcaster?.(args.roomId, saved.message, saved.totalTokens)
      }
    } catch (error) {
      logger.warn(
        { error, roomId: args.roomId, runId: args.runId, agentId: this.agentId },
        '[GroupChat] failed to persist remote workspace diff message',
      )
    }
  }

  async readAttachmentChunk(
    runId: string,
    attachmentId: string,
    offset: number,
  ): Promise<{ chunk: string; nextOffset: number; done: boolean; size: number }> {
    const pending = this.pendingRun
    if (!pending || pending.runId !== runId) {
      throw relayError('Unknown or stale relay run', 'GROUP_AGENT_STALE_RUN')
    }
    const attachment = pending.attachments.get(attachmentId)
    if (!attachment || !Number.isSafeInteger(offset) || offset < 0 || offset > attachment.size) {
      throw relayError('Invalid relay attachment request', 'GROUP_AGENT_ATTACHMENT_INVALID')
    }
    const length = Math.min(RELAY_ATTACHMENT_CHUNK_BYTES, attachment.size - offset)
    if (length === 0) return { chunk: '', nextOffset: offset, done: true, size: attachment.size }
    const file = await open(
      attachment.filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
    )
    try {
      const current = await file.stat()
      if (
        !current.isFile()
        || current.size !== attachment.size
        || Number(current.dev) !== attachment.device
        || Number(current.ino) !== attachment.inode
      ) {
        throw relayError('Group chat relay attachment changed during transfer', 'GROUP_AGENT_ATTACHMENT_INVALID')
      }
      const buffer = Buffer.allocUnsafe(length)
      const { bytesRead } = await file.read(buffer, 0, length, offset)
      const nextOffset = offset + bytesRead
      return {
        chunk: buffer.subarray(0, bytesRead).toString('base64'),
        nextOffset,
        done: nextOffset >= attachment.size,
        size: attachment.size,
      }
    } finally {
      await file.close()
    }
  }

  private async prepareMessageAttachments(
    roomId: string,
    message: MentionMessage,
  ): Promise<{ message: MentionMessage; attachments: RelayAttachmentSource[] }> {
    if (!Array.isArray(message.input)) return { message, attachments: [] }
    if (message.input.length > 32) {
      throw relayError('Too many group chat relay attachments', 'GROUP_AGENT_ATTACHMENT_INVALID')
    }
    const roomDir = getGroupChatAttachmentDir(roomId)
    const attachments: RelayAttachmentSource[] = []
    const input = []
    for (const rawBlock of message.input) {
      if (rawBlock.type !== 'image' && rawBlock.type !== 'file') {
        input.push(rawBlock)
        continue
      }
      const filePath = resolve(String(rawBlock.path || ''))
      const info = await lstat(filePath).catch(() => null)
      if (
        !isPathWithin(filePath, roomDir)
        || !info?.isFile()
        || info.isSymbolicLink()
        || info.size > RELAY_ATTACHMENT_MAX_BYTES
      ) {
        throw relayError('Invalid group chat relay attachment', 'GROUP_AGENT_ATTACHMENT_INVALID')
      }
      const id = randomUUID()
      const attachment: RelayAttachmentSource = {
        id,
        type: rawBlock.type,
        name: basename(String(rawBlock.name || filePath)).slice(0, 255),
        mediaType: String(rawBlock.media_type || 'application/octet-stream').slice(0, 200),
        size: info.size,
        filePath,
        device: Number(info.dev),
        inode: Number(info.ino),
      }
      attachments.push(attachment)
      input.push({
        ...rawBlock,
        path: '',
        relay_attachment_id: id,
      })
    }
    return {
      message: { ...message, input: input as MentionMessage['input'] },
      attachments,
    }
  }

  acceptRun(runId: string): void {
    if (this.pendingRun?.runId !== runId) return
    this.pendingRun.accepted = true
    clearTimeout(this.pendingRun.acceptedTimer)
  }

  private refreshRunTimeout(pending: PendingRelayRun, timeoutMs = RELAY_RUN_TIMEOUT_MS): void {
    clearTimeout(pending.runTimer)
    pending.runTimer = setTimeout(() => {
      this.relaySocket.emit('run.interrupt', { runId: pending.runId, reason: 'Remote Agent run timed out' })
      this.finishRun(pending.runId, relayError('Remote Agent run timed out', 'GROUP_AGENT_RUN_TIMEOUT'))
    }, timeoutMs)
    pending.runTimer.unref?.()
  }

  completeRun(runId: string, error?: string): void {
    const task = this.eventQueue.then(() => {
      this.finishRun(runId, error ? relayError(error, 'GROUP_AGENT_REMOTE_RUN_FAILED') : undefined)
    })
    this.eventQueue = task.catch(() => undefined)
  }

  acceptEvent(event: RelayAgentEvent): Promise<void> {
    const task = this.eventQueue
      .then(() => this.applyEvent(event))
      .catch((error) => {
        const relayEventError = error instanceof Error ? error : relayError('Invalid relay event')
        this.finishRun(event.runId, relayEventError)
        throw relayEventError
      })
    this.eventQueue = task.catch(() => undefined)
    return task
  }

  async acceptBatch(value: unknown): Promise<void> {
    const events = (value as any)?.events
    if (!Array.isArray(events) || !events.length || events.length > AGENT_EVENT_BATCH_COUNT
      || Buffer.byteLength(JSON.stringify(value)) > AGENT_EVENT_BATCH_BYTES
      || events.some(event => !event || typeof event !== 'object' || Array.isArray(event)
        || typeof event.runId !== 'string' || !Number.isSafeInteger(event.seq))) {
      throw relayError('Invalid remote Agent event batch', 'GROUP_AGENT_EVENT_INVALID')
    }
    // Enqueue the whole batch synchronously; run.completed must follow it.
    await Promise.all(events.map(event => this.acceptEvent(event)))
  }

  private async applyEvent(event: RelayAgentEvent): Promise<void> {
    const pending = this.pendingRun
    if (!pending || event.runId !== pending.runId) throw relayError('Unknown or stale relay run', 'GROUP_AGENT_STALE_RUN')
    if (!Number.isSafeInteger(event.seq) || event.seq !== pending.lastSeq + 1) {
      throw relayError(`Out-of-order relay event (expected ${pending.lastSeq + 1}, received ${String(event.seq)}, event ${String(event.event).slice(0, 80)})`, 'GROUP_AGENT_EVENT_SEQUENCE')
    }
    const data = event.data || {}
    const sessionId = typeof data.agentSessionId === 'string' ? data.agentSessionId.trim() : ''
    if (sessionId.length > 240) throw relayError('Invalid remote Agent session id', 'GROUP_AGENT_EVENT_INVALID')
    if (sessionId) this.activeSessions.set(pending.roomId, sessionId)
    switch (event.event) {
      case 'message': {
        const content = String(data.content || '')
        if (content.length > 1_000_000) throw relayError('Remote Agent message is too large', 'GROUP_AGENT_EVENT_INVALID')
        const messageId = this.remoteMessageId(pending, data.id, true)
        const extra = this.sanitizeRemoteMessageExtra(data.extra)
        if (extra.role === 'assistant') {
          // Relay events are untrusted. Bind chained-routing metadata only
          // from the server-issued invocation that created this pending run.
          extra.mentionDepth = Math.min(
            Number.MAX_SAFE_INTEGER,
            Math.max(0, Number(pending.message.mentionDepth || 0)) + 1,
          )
          extra.handoffChainId = pending.message.handoffChainId || pending.message.messageId || ''
          extra.continuationAttemptId = pending.message.continuationAttemptId || ''
        }
        const persistedMessageId = await this.proxy.sendMessage(
          pending.roomId,
          content,
          messageId,
          extra,
          sessionId || undefined,
        )
        if (extra.role === 'assistant') {
          pending.result.parentMessageId = persistedMessageId || messageId
          if (typeof extra.run_id === 'string' && extra.run_id) {
            pending.result.responseRunId = extra.run_id
          }
        }
        break
      }
      case 'typing':
        this.proxy.startTyping(pending.roomId)
        break
      case 'stop_typing':
        this.proxy.stopTyping(pending.roomId)
        break
      case 'context_status':
        if (typeof data.runId === 'string' && data.runId.trim()) {
          pending.result.responseRunId = data.runId.slice(0, 500)
        }
        this.proxy.emitContextStatus(
          pending.roomId,
          data.status === 'compressing' || data.status === 'ready' ? data.status : 'replying',
          typeof data.runId === 'string' && data.runId.trim()
            ? { runId: data.runId.slice(0, 500) }
            : undefined,
          sessionId || undefined,
        )
        break
      case 'message_stream_start':
        if (typeof data.run_id === 'string' && data.run_id.trim()) {
          pending.result.responseRunId = data.run_id.slice(0, 500)
        }
        this.proxy.emitMessageStreamStart(
          pending.roomId,
          this.remoteMessageId(pending, data.id, true),
          sessionId || undefined,
          typeof data.run_id === 'string' ? data.run_id.slice(0, 500) : undefined,
        )
        break
      case 'message_stream_delta':
        this.proxy.emitMessageStreamDelta(
          pending.roomId,
          this.remoteMessageId(pending, data.id, false),
          this.remoteDelta(data.delta),
          sessionId || undefined,
        )
        break
      case 'message_reasoning_delta':
        this.proxy.emitMessageReasoningDelta(
          pending.roomId,
          this.remoteMessageId(pending, data.id, false),
          this.remoteDelta(data.delta),
          sessionId || undefined,
        )
        break
      case 'message_stream_end':
        this.proxy.emitMessageStreamEnd(
          pending.roomId,
          this.remoteMessageId(pending, data.id, false),
          sessionId || undefined,
        )
        break
      case 'approval.requested': {
        const remoteApprovalId = String(data.approval_id || '').trim()
        if (!remoteApprovalId || remoteApprovalId.length > 240) {
          throw relayError('Invalid remote approval id', 'GROUP_AGENT_EVENT_INVALID')
        }
        const cloudApprovalId = `gca_${randomUUID().replace(/-/g, '')}`
        pending.approvalIds.set(cloudApprovalId, remoteApprovalId)
        this.refreshRunTimeout(pending, Math.max(
          RELAY_INTERACTION_TIMEOUT_MS,
          this.remoteInteractionTimeout(data.timeout_ms) + RELAY_ACCEPT_TIMEOUT_MS,
        ))
        this.proxy.emitApprovalRequested(pending.roomId, {
          ...this.sanitizeApprovalEvent(data),
          approval_id: cloudApprovalId,
          agentSessionId: sessionId,
        })
        break
      }
      case 'approval.resolved': {
        const remoteApprovalId = String(data.approval_id || '').trim()
        const entry = [...pending.approvalIds.entries()].find(([, remote]) => remote === remoteApprovalId)
        if (!entry) throw relayError('Unknown remote approval id', 'GROUP_AGENT_EVENT_INVALID')
        pending.approvalIds.delete(entry[0])
        this.proxy.emitApprovalResolved(pending.roomId, {
          approval_id: entry[0],
          choice: String(data.choice || '').slice(0, 32),
          agentSessionId: sessionId,
        })
        if (pending.approvalIds.size === 0 && pending.clarifyIds.size === 0) {
          this.refreshRunTimeout(pending)
        }
        break
      }
      case 'clarify.requested': {
        const remoteClarifyId = String(data.clarify_id || '').trim()
        if (!remoteClarifyId || remoteClarifyId.length > 240) {
          throw relayError('Invalid remote clarification id', 'GROUP_AGENT_EVENT_INVALID')
        }
        const cloudClarifyId = `gcc_${randomUUID().replace(/-/g, '')}`
        pending.clarifyIds.set(cloudClarifyId, remoteClarifyId)
        this.refreshRunTimeout(pending, Math.max(
          RELAY_INTERACTION_TIMEOUT_MS,
          this.remoteInteractionTimeout(data.timeout_ms) + RELAY_ACCEPT_TIMEOUT_MS,
        ))
        this.proxy.emitClarifyRequested(pending.roomId, {
          ...this.sanitizeClarifyEvent(data),
          clarify_id: cloudClarifyId,
          agentSessionId: sessionId,
        })
        break
      }
      case 'clarify.resolved': {
        const remoteClarifyId = String(data.clarify_id || '').trim()
        const entry = [...pending.clarifyIds.entries()].find(([, remote]) => remote === remoteClarifyId)
        if (!entry) throw relayError('Unknown remote clarification id', 'GROUP_AGENT_EVENT_INVALID')
        pending.clarifyIds.delete(entry[0])
        this.proxy.emitClarifyResolved(pending.roomId, {
          clarify_id: entry[0],
          resolved: data.resolved !== false,
          reason: String(data.reason || '').slice(0, 500),
          agentSessionId: sessionId,
        })
        if (pending.approvalIds.size === 0 && pending.clarifyIds.size === 0) {
          this.refreshRunTimeout(pending)
        }
        break
      }
      default:
        throw relayError('Unsupported relay event', 'GROUP_AGENT_EVENT_UNSUPPORTED')
    }
    pending.lastSeq = event.seq
  }

  async interrupt(roomId: string): Promise<boolean> {
    const pending = this.pendingRun
    if (!pending || pending.roomId !== roomId) return true
    this.relaySocket.emit('run.interrupt', { runId: pending.runId, reason: 'Interrupted by group chat owner' })
    this.finishRun(pending.runId, relayError('Remote Agent run interrupted', 'GROUP_AGENT_INTERRUPTED'))
    return true
  }

  respondApproval(approvalId: string, choice: string): Promise<boolean> {
    if (!this.connected) return Promise.reject(relayError('Remote Agent is offline', 'GROUP_AGENT_OFFLINE'))
    const remoteApprovalId = this.pendingRun?.approvalIds.get(approvalId)
    if (!remoteApprovalId) return Promise.reject(relayError('Remote approval is no longer pending'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(relayError('Remote approval response timed out')), RELAY_ACCEPT_TIMEOUT_MS)
      this.relaySocket.emit('approval.respond', { approvalId: remoteApprovalId, choice }, (response: { resolved?: boolean; error?: string }) => {
        clearTimeout(timer)
        if (response?.error) reject(relayError(response.error))
        else resolve(response?.resolved === true)
      })
    })
  }

  respondClarify(clarifyId: string, response: string): Promise<boolean> {
    if (!this.connected) return Promise.reject(relayError('Remote Agent is offline', 'GROUP_AGENT_OFFLINE'))
    const remoteClarifyId = this.pendingRun?.clarifyIds.get(clarifyId)
    if (!remoteClarifyId) return Promise.reject(relayError('Remote clarification is no longer pending'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(relayError('Remote clarification response timed out')), RELAY_ACCEPT_TIMEOUT_MS)
      this.relaySocket.emit('clarify.respond', {
        clarifyId: remoteClarifyId,
        response: String(response).slice(0, 20_000),
      }, (result: { resolved?: boolean; error?: string }) => {
        clearTimeout(timer)
        if (result?.error) reject(relayError(result.error))
        else resolve(result?.resolved === true)
      })
    })
  }

  private remoteMessageId(pending: PendingRelayRun, value: unknown, create: boolean): string {
    const remoteId = String(value || '').trim()
    if (!remoteId || remoteId.length > 240) throw relayError('Invalid remote message id', 'GROUP_AGENT_EVENT_INVALID')
    const existing = pending.messageIds.get(remoteId)
    if (existing) return existing
    if (!create || pending.messageIds.size >= 100) {
      throw relayError('Unknown remote message id', 'GROUP_AGENT_EVENT_INVALID')
    }
    const cloudId = `gcr_${randomUUID().replace(/-/g, '')}`
    pending.messageIds.set(remoteId, cloudId)
    return cloudId
  }

  private remoteDelta(value: unknown): string {
    const delta = String(value || '')
    if (delta.length > 256_000) throw relayError('Remote Agent stream delta is too large', 'GROUP_AGENT_EVENT_INVALID')
    return delta
  }

  private sanitizeRemoteMessageExtra(value: unknown): Record<string, unknown> {
    const input = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
    const role = input.role === 'tool' ? 'tool' : 'assistant'
    const output: Record<string, unknown> = { role }
    for (const field of ['run_id', 'tool_call_id', 'tool_name', 'finish_reason'] as const) {
      if (typeof input[field] === 'string') output[field] = input[field].slice(0, 500)
    }
    for (const field of ['reasoning', 'reasoning_details', 'reasoning_content'] as const) {
      if (typeof input[field] === 'string') output[field] = input[field].slice(0, 1_000_000)
    }
    if (Array.isArray(input.tool_calls)) {
      const serialized = JSON.stringify(input.tool_calls)
      if (serialized.length > 1_000_000) throw relayError('Remote tool calls are too large', 'GROUP_AGENT_EVENT_INVALID')
      output.tool_calls = input.tool_calls
    }
    const mentions = this.sanitizeRemoteMentions(input.mentions)
    if (mentions !== undefined) output.mentions = mentions
    return output
  }

  private sanitizeApprovalEvent(data: Record<string, unknown>): Record<string, unknown> {
    const choices = Array.isArray(data.choices)
      ? data.choices.filter(choice => ['once', 'session', 'always', 'deny'].includes(String(choice))).slice(0, 4)
      : []
    return {
      command: String(data.command || '').slice(0, 20_000),
      description: String(data.description || '').slice(0, 2_000),
      choices,
      allow_permanent: data.allow_permanent === true,
      timeout_ms: this.remoteInteractionTimeout(data.timeout_ms),
    }
  }

  private sanitizeClarifyEvent(data: Record<string, unknown>): Record<string, unknown> {
    return {
      question: String(data.question || '').slice(0, 20_000),
      choices: Array.isArray(data.choices)
        ? data.choices.map(choice => String(choice).slice(0, 2_000)).slice(0, 20)
        : null,
      initial_response: String(data.initial_response || '').slice(0, 20_000),
      response_mode: ['select', 'input', 'editor'].includes(String(data.response_mode || ''))
        ? String(data.response_mode)
        : '',
      timeout_ms: this.remoteInteractionTimeout(data.timeout_ms),
    }
  }

  private remoteInteractionTimeout(value: unknown): number {
    const timeoutMs = Number(value)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return 300_000
    return Math.min(600_000, Math.max(1_000, Math.trunc(timeoutMs)))
  }

  private sanitizeRemoteMentions(value: unknown): StructuredMentionEntry[] | undefined {
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.length > 64) {
      throw relayError('Invalid remote structured mentions', 'GROUP_AGENT_EVENT_INVALID')
    }
    const participantIds = new Set<string>()
    let allSeen = false
    return value.map((rawMention) => {
      if (!rawMention || typeof rawMention !== 'object' || Array.isArray(rawMention)) {
        throw relayError('Invalid remote structured mentions', 'GROUP_AGENT_EVENT_INVALID')
      }
      const mention = rawMention as Record<string, unknown>
      if (mention.type === 'all') {
        if (allSeen || value.length !== 1 || mention.displayName !== 'all') {
          throw relayError('Invalid remote structured mentions', 'GROUP_AGENT_EVENT_INVALID')
        }
        allSeen = true
        return { type: 'all' as const, displayName: 'all' as const }
      }
      const participantId = typeof mention.participantId === 'string' ? mention.participantId.trim() : ''
      const displayName = typeof mention.displayName === 'string' ? mention.displayName.trim() : ''
      if (
        mention.type !== 'agent'
        || allSeen
        || !participantId
        || participantId.length > 240
        || participantIds.has(participantId)
        || !displayName
        || displayName.length > 120
      ) {
        throw relayError('Invalid remote structured mentions', 'GROUP_AGENT_EVENT_INVALID')
      }
      participantIds.add(participantId)
      return { type: 'agent' as const, participantId, displayName }
    })
  }

  disconnect(): void {
    if (this.detached) return
    this.detached = true
    if (this.pendingRun) this.finishRun(this.pendingRun.runId, relayError('Remote Agent disconnected', 'GROUP_AGENT_OFFLINE'))
    this.activeSessions.clear()
    this.proxy.disconnect()
    if (this.relaySocket.connected) this.relaySocket.disconnect(true)
  }

  private finishRun(runId: string, error?: Error): void {
    const pending = this.pendingRun
    if (!pending || pending.runId !== runId) return
    clearTimeout(pending.acceptedTimer)
    clearTimeout(pending.runTimer)
    if (pending.approvalIds.size > 0 || pending.clarifyIds.size > 0) {
      this.expirePendingInteractions(
        pending.roomId,
        this.name,
        [...pending.approvalIds.keys()],
        [...pending.clarifyIds.keys()],
        error?.message || 'Remote Agent run ended',
      )
      pending.approvalIds.clear()
      pending.clarifyIds.clear()
    }
    this.pendingRun = null
    this.activeSessions.delete(pending.roomId)
    if (error) {
      const relayFailure = error as Error & { code?: string; outcomeUnknown?: boolean }
      // A run.failed event is an authoritative remote terminal result. Every
      // other source-side termination after run.request was emitted (timeout,
      // disconnect, interrupt without acknowledgement, invalid/missing event)
      // cannot prove that the remote invocation stopped.
      if (relayFailure.code !== 'GROUP_AGENT_REMOTE_RUN_FAILED') {
        relayFailure.outcomeUnknown = true
      }
      pending.reject(relayFailure)
    }
    else pending.resolve()
  }
}

export class GroupAgentRelayServer {
  private readonly namespace
  private executors = new Map<string, RelayGroupAgentExecutor>()
  private connectorSockets = new Map<string, ServerSocket>()
  private unsubscribeConnectorRevocations: () => void

  constructor(
    ioServer: Server,
    private readonly groupChatServer: GroupChatRuntimeServer,
  ) {
    this.namespace = ioServer.of('/group-chat-agent-relay')
    this.namespace.use((socket, next) => this.authenticate(socket, next))
    this.namespace.on('connection', socket => void this.onConnection(socket))
    this.unsubscribeConnectorRevocations = subscribeGroupAgentConnectorRevocations(connector => {
      const socket = this.connectorSockets.get(connector.id)
      if (!socket) return
      socket.emit('connector.revoked', {
        connectorId: connector.id,
        roomId: connector.roomId,
      })
      const disconnectTimer = setTimeout(() => socket.disconnect(true), 250)
      disconnectTimer.unref?.()
    })
    logger.info('[GroupAgentRelay] Socket.IO ready at /group-chat-agent-relay')
  }

  shutdown(): void {
    this.unsubscribeConnectorRevocations()
    for (const socket of this.connectorSockets.values()) socket.disconnect(true)
    this.connectorSockets.clear()
    for (const executor of this.executors.values()) executor.disconnect()
    this.executors.clear()
  }

  private async authenticate(socket: ServerSocket, next: (error?: Error) => void): Promise<void> {
    try {
      const auth = socket.handshake.auth as Record<string, unknown>
      if (Number(auth.protocolVersion) !== GROUP_AGENT_RELAY_PROTOCOL_VERSION) {
        next(relayError('Unsupported group Agent relay protocol', 'GROUP_AGENT_PROTOCOL_VERSION'))
        return
      }
      const targetOrigin = normalizeOrigin(auth.targetOrigin)
      const pairingTicket = String(auth.pairingTicket || '').trim()
      if (pairingTicket) {
        const request = claimGroupAgentPairingTicket(pairingTicket)
        if (!request) {
          next(relayError('Invalid or expired pairing ticket', 'GROUP_AGENT_PAIRING_TICKET_INVALID'))
          return
        }
        if (request.targetOrigin !== targetOrigin) {
          releaseGroupAgentPairingClaim(request.id)
          next(relayError('Invalid or expired pairing ticket', 'GROUP_AGENT_PAIRING_TICKET_INVALID'))
          return
        }
        socket.data.pairingRequest = request
        next()
        return
      }
      const connectorId = String(auth.connectorId || '').trim()
      const credential = String(auth.credential || '').trim()
      const connector = authenticateGroupAgentConnector(connectorId, credential)
      if (!connector || connector.targetOrigin !== targetOrigin) {
        next(relayError('Invalid or revoked reconnect credential', 'GROUP_AGENT_CREDENTIAL_INVALID'))
        return
      }
      socket.data.connector = connector
      next()
    } catch (error) {
      next(relayError(error instanceof Error ? error.message : 'Invalid relay authentication'))
    }
  }

  private async onConnection(socket: ServerSocket): Promise<void> {
    let connector: GroupAgentConnector | null = socket.data.connector || null
    let roomAgent: any = null
    let proxy: AgentClient | null = null
    let pairingRequestId = ''
    try {
      const storage = this.groupChatServer.getStorage()
      if (socket.data.pairingRequest) {
        const request = socket.data.pairingRequest as ReturnType<typeof claimGroupAgentPairingTicket>
        if (!request) throw relayError('Pairing request is unavailable')
        pairingRequestId = request.id
        const room = storage.getRoom(request.roomId)
        if (!room || !room.allowGuestAgents) throw relayError('Guest Agent connections are disabled for this room')
        if (
          countActiveGuestAgentLinks(request.roomId, request.ownerMemberId)
          >= Math.max(1, Number(room.maxGuestAgentsPerMember || 1))
        ) {
          throw relayError('Guest Agent limit reached for this member', 'GROUP_GUEST_AGENT_LIMIT')
        }
        const agentId = `remote_${randomUUID().replace(/-/g, '')}`
        const descriptor = request.agent
        roomAgent = storage.addRoomAgent(
          request.roomId,
          agentId,
          descriptor.profile,
          descriptor.name,
          descriptor.description,
          1,
          {
            agent: descriptor.agent,
            agentMode: descriptor.agentMode,
            provider: descriptor.provider,
            model: descriptor.model,
            apiMode: descriptor.apiMode,
            reasoningEffort: descriptor.reasoningEffort,
            agentPreset: descriptor.agentPreset,
            avatar: descriptor.avatar,
            executorType: 'remote',
            ownerMemberId: request.ownerMemberId,
            remoteOrigin: request.targetOrigin,
          },
        )
      } else if (connector) {
        roomAgent = storage.getRoomAgent(connector.roomId, connector.roomAgentId)
        if (!roomAgent || roomAgent.executorType !== 'remote' || roomAgent.agentId !== connector.agentId) {
          throw relayError('Remote Agent registration no longer exists', 'GROUP_AGENT_REGISTRATION_MISSING')
        }
      }
      if (!roomAgent) throw relayError('Relay connection is incomplete')
      proxy = new AgentClient({
        agentId: roomAgent.agentId,
        agent: roomAgent.agent,
        agentMode: roomAgent.agentMode,
        profile: roomAgent.profile,
        provider: roomAgent.provider,
        model: roomAgent.model,
        apiMode: roomAgent.apiMode,
        reasoningEffort: roomAgent.reasoningEffort,
        agentPreset: roomAgent.agentPreset,
        name: roomAgent.name,
        description: roomAgent.description,
        invited: 1,
        backgroundDelegationEnabled: false,
      }, {
        onRoomUpdated: (data) => {
          if (String(data?.roomId || '') !== roomAgent?.roomId) return
          const updatedRoom = storage.getRoom(roomAgent.roomId)
          if (!updatedRoom) return
          socket.emit('room.metadata', {
            roomId: updatedRoom.id,
            roomName: updatedRoom.name,
            inviteCode: updatedRoom.inviteCode,
          })
        },
      })
      proxy.setStorage(storage)
      await proxy.connect()
      await proxy.joinRoom(roomAgent.roomId)

      if (pairingRequestId) {
        const completed = completeGroupAgentPairing({
          requestId: pairingRequestId,
          roomAgentId: roomAgent.id,
          agentId: roomAgent.agentId,
        })
        if (!completed) throw relayError('Could not complete group Agent pairing')
        connector = completed.connector
        roomAgent = storage.updateRoomAgentRelayMetadata(roomAgent.roomId, roomAgent.id, {
          connectorId: connector.id,
          remoteOrigin: connector.targetOrigin,
        })
        socket.data.newCredential = completed.credential
      }
      if (!connector) throw relayError('Relay connection is incomplete')
      const relayRoom = storage.getRoom(connector.roomId)
      if (!relayRoom) throw relayError('Remote Agent room no longer exists', 'GROUP_AGENT_REGISTRATION_MISSING')

      const previous = this.executors.get(connector.id)
      previous?.disconnect()
      const previousSocket = this.connectorSockets.get(connector.id)
      if (previousSocket && previousSocket.id !== socket.id) previousSocket.disconnect(true)
      const executor = new RelayGroupAgentExecutor(
        socket,
        proxy,
        connector,
        roomAgent,
        storage,
        (roomId, agentName, approvalIds, clarifyIds, reason) => {
          this.groupChatServer.expirePendingAgentInteractions(
            roomId,
            agentName,
            approvalIds,
            clarifyIds,
            reason,
          )
        },
      )
      this.groupChatServer.agentClients.registerAgentForRoom(connector.roomId, executor)
      this.executors.set(connector.id, executor)
      this.connectorSockets.set(connector.id, socket)
      touchGroupAgentConnector(connector.id, 'online')
      this.groupChatServer.broadcastRoomAgents(connector.roomId)

      socket.data.connector = connector
      socket.data.executor = executor
      socket.emit('relay.ready', {
        capabilities: [AGENT_EVENT_BATCH_CAPABILITY],
        protocolVersion: GROUP_AGENT_RELAY_PROTOCOL_VERSION,
        connectorId: connector.id,
        credential: socket.data.newCredential,
        roomId: connector.roomId,
        roomName: String(relayRoom.name || connector.roomId),
        inviteCode: String(relayRoom.inviteCode || ''),
        agent: {
          agentId: roomAgent.agentId,
          agent: roomAgent.agent,
          agentMode: roomAgent.agentMode,
          profile: roomAgent.profile,
          provider: roomAgent.provider,
          model: roomAgent.model,
          apiMode: roomAgent.apiMode,
          reasoningEffort: roomAgent.reasoningEffort,
          agentPreset: roomAgent.agentPreset,
          name: roomAgent.name,
          description: roomAgent.description,
          avatar: roomAgent.avatar,
        },
      })

      socket.on('agent.events', (batch: unknown, ack?: (response: Record<string, unknown>) => void) => {
        executor.acceptBatch(batch)
          .then(() => ack?.({ ok: true }))
          .catch(error => ack?.({ error: error instanceof Error ? error.message : 'Invalid relay event batch' }))
      })

      let lastAgentConfigUpdateAt = 0
      socket.on('run.accepted', (data: { runId?: string }) => executor.acceptRun(String(data?.runId || '')))
      socket.on('run.completed', (data: { runId?: string }) => executor.completeRun(String(data?.runId || '')))
      socket.on('run.failed', (data: { runId?: string; error?: string }) => {
        executor.completeRun(String(data?.runId || ''), String(data?.error || 'Remote Agent run failed'))
      })
      socket.on('agent.event', (event: RelayAgentEvent, ack?: (response: Record<string, unknown>) => void) => {
        executor.acceptEvent(event)
          .then(() => ack?.({ ok: true }))
          .catch(error => ack?.({ error: error instanceof Error ? error.message : 'Invalid relay event' }))
      })
      socket.on(
        'agent.config.update',
        (value: unknown, ack?: (response: Record<string, unknown>) => void) => {
          try {
            const now = Date.now()
            if (now - lastAgentConfigUpdateAt < RELAY_AGENT_CONFIG_UPDATE_INTERVAL_MS) {
              throw relayError('Agent configuration is being changed too quickly', 'GROUP_AGENT_UPDATE_RATE_LIMIT')
            }
            if (executor.busy) {
              throw relayError('Wait for the current Agent run to finish before changing its configuration', 'GROUP_AGENT_BUSY')
            }
            const descriptor = normalizeRemoteGroupAgentDescriptor(value)
            if (isReservedMentionName(descriptor.name)) {
              throw relayError('This Agent name is reserved', 'GROUP_AGENT_NAME_RESERVED')
            }
            const updated = storage.updateRoomAgent(
              connector!.roomId,
              connector!.roomAgentId,
              descriptor.profile,
              descriptor.name,
              descriptor.description,
              {
                agent: descriptor.agent,
                agentMode: descriptor.agentMode,
                provider: descriptor.provider,
                model: descriptor.model,
                apiMode: descriptor.apiMode,
                reasoningEffort: descriptor.reasoningEffort,
                agentPreset: descriptor.agentPreset,
                avatar: descriptor.avatar,
              },
            )
            if (!updated || updated.executorType !== 'remote' || updated.connectorId !== connector!.id) {
              throw relayError('Remote Agent registration no longer exists', 'GROUP_AGENT_REGISTRATION_MISSING')
            }
            executor.updateConfiguration(updated)
            lastAgentConfigUpdateAt = now
            const agent = normalizeRemoteGroupAgentDescriptor(updated)
            this.groupChatServer.broadcastRoomAgents(connector!.roomId)
            ack?.({ ok: true, agent })
          } catch (error) {
            ack?.({
              code: typeof (error as any)?.code === 'string' ? (error as any).code : undefined,
              error: error instanceof Error ? error.message : 'Could not update remote Agent',
            })
          }
        },
      )
      socket.on(
        'attachment.read',
        (
          data: { runId?: string; attachmentId?: string; offset?: number },
          ack?: (response: Record<string, unknown>) => void,
        ) => {
          executor.readAttachmentChunk(
            String(data?.runId || ''),
            String(data?.attachmentId || ''),
            Number(data?.offset),
          ).then(chunk => ack?.(chunk))
            .catch(error => ack?.({ error: error instanceof Error ? error.message : 'Attachment read failed' }))
        },
      )
      socket.on('connector.revoke', (_data, ack?: (response: Record<string, unknown>) => void) => {
        revokeGroupAgentConnector(connector!.id, Date.now(), { notify: false })
        ack?.({ ok: true })
        queueMicrotask(() => {
          void (async () => {
            await this.groupChatServer.agentClients.removeAgentFromRoom(connector!.roomId, connector!.agentId)
            storage.removeRoomAgent(connector!.roomId, connector!.roomAgentId)
            this.groupChatServer.broadcastRoomAgents(connector!.roomId)
          })()
        })
      })
      socket.on('disconnect', () => { void this.handleDisconnect(connector!.id, connector!.roomId, executor) })
    } catch (error) {
      proxy?.disconnect()
      if (pairingRequestId) releaseGroupAgentPairingClaim(pairingRequestId)
      if (connector && socket.data.newCredential) revokeGroupAgentConnector(connector.id)
      if (roomAgent) {
        this.groupChatServer.getStorage().removeRoomAgent(roomAgent.roomId, roomAgent.id || roomAgent.agentId)
      }
      logger.warn(error, '[GroupAgentRelay] connection setup failed')
      socket.emit('relay.error', {
        code: typeof (error as any)?.code === 'string' ? (error as any).code : undefined,
        error: error instanceof Error ? error.message : 'Relay connection failed',
      })
      socket.disconnect(true)
    }
  }

  private async handleDisconnect(connectorId: string, roomId: string, executor: RelayGroupAgentExecutor): Promise<void> {
    const socket = this.connectorSockets.get(connectorId)
    if (socket?.data?.executor === executor) this.connectorSockets.delete(connectorId)
    if (this.executors.get(connectorId) !== executor) return
    this.executors.delete(connectorId)
    touchGroupAgentConnector(connectorId, 'offline')
    await this.groupChatServer.agentClients.removeAgentFromRoom(roomId, executor.agentId)
    this.groupChatServer.broadcastRoomAgents(roomId)
  }
}

type PersistedOutboundLink = {
  cloudOrigin: string
  cloudMachineId?: string
  targetOrigin: string
  connectorId: string
  credential: string
  roomId?: string
  roomName?: string
  roomAlias?: string
  inviteCode?: string
  agent: RemoteGroupAgentDescriptor
}

class OutboundRelayConnection {
  private socket: ClientSocket | null = null
  private runner: AgentClient | null = null
  private sink: OutboundRelayEventSink | null = null
  private activeRequest: RelayRunRequest | null = null

  constructor(
    private readonly manager: GroupAgentOutboundRelayManager,
    readonly key: string,
    private link: PersistedOutboundLink,
    private readonly pairingTicket?: string,
  ) {}

  get connected(): boolean {
    return this.socket?.connected === true
  }

  async connect(): Promise<PersistedOutboundLink> {
    const reconnecting = Boolean(this.link.connectorId && this.link.credential)
    this.socket = io(`${this.link.cloudOrigin}/group-chat-agent-relay`, {
      auth: groupAgentSocketAuth({
        protocolVersion: GROUP_AGENT_RELAY_PROTOCOL_VERSION,
        targetOrigin: this.link.targetOrigin,
        ...(reconnecting
          ? { connectorId: this.link.connectorId, credential: this.link.credential }
          : { pairingTicket: this.pairingTicket }),
      }, this.link.cloudMachineId),
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
      timeout: 15_000,
    })
    this.sink = new OutboundRelayEventSink(this.socket, redactRelaySecrets, error => {
      const request = this.activeRequest
      if (!request) return
      this.socket?.emit('run.failed', {
        runId: request.runId,
        error: String(redactRelaySecrets(error.message, request.workspaceApi?.token ? [request.workspaceApi.token] : [])),
      })
      void this.runner?.interrupt(request.room.id).catch(() => undefined)
    })
    this.bindEvents()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(relayError('Timed out connecting to group chat Relay')), 15_000)
      this.socket!.once('relay.ready', (data: any) => {
        clearTimeout(timer)
        try {
          const connectorId = String(data.connectorId || this.link.connectorId).trim()
          const credential = String(data.credential || this.link.credential).trim()
          const roomId = boundedRelayText(data.roomId || this.link.roomId || '', 160, 'room id')
          const roomName = boundedRelayText(data.roomName || this.link.roomName || roomId, 120, 'room name')
          const inviteCode = boundedRelayText(data.inviteCode || this.link.inviteCode || '', 160, 'invite code')
          const relayAgent = normalizeRemoteGroupAgentDescriptor(data.agent, 'relay confirmation')
          if (
            !UUID_PATTERN.test(connectorId)
            || !/^[a-zA-Z0-9_-]{40,128}$/.test(credential)
            || !sameRemoteAgent(this.link.agent, relayAgent)
          ) {
            throw relayError('Relay returned connection data that was not approved')
          }
          this.link = {
            ...this.link,
            connectorId,
            credential,
            ...(roomId ? { roomId } : {}),
            ...(roomName ? { roomName } : {}),
            ...(inviteCode ? { inviteCode } : {}),
            agent: this.link.agent,
          }
          this.socket!.auth = groupAgentSocketAuth({
            protocolVersion: GROUP_AGENT_RELAY_PROTOCOL_VERSION,
            targetOrigin: this.link.targetOrigin,
            connectorId,
            credential,
          }, this.link.cloudMachineId)
          void this.manager.persist(this.link)
            .then(() => resolve(this.link))
            .catch(reject)
        } catch (error) {
          reject(error)
        }
      })
      this.socket!.once('relay.error', (data: any) => {
        clearTimeout(timer)
        reject(relayError(
          String(data?.error || 'Relay connection failed'),
          String(data?.code || 'GROUP_AGENT_RELAY_ERROR'),
        ))
      })
      this.socket!.once('connect_error', error => {
        if (this.socket?.active) return
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  close(): void {
    this.sink?.end(this.activeRequest?.runId || '')
    this.runner?.disconnect()
    this.runner = null
    this.socket?.disconnect()
    this.socket = null
  }

  async revoke(): Promise<boolean> {
    if (!this.socket?.connected) {
      this.close()
      try {
        await this.connect()
      } catch {
        return false
      }
    }
    const socket = this.socket
    if (!socket?.connected) return false
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), RELAY_ACCEPT_TIMEOUT_MS)
      socket.emit('connector.revoke', {}, (response: { ok?: boolean }) => {
        clearTimeout(timer)
        resolve(response?.ok === true)
      })
    })
  }

  async updateAgent(value: RemoteGroupAgentDescriptor): Promise<PersistedOutboundLink> {
    if (this.activeRequest) {
      throw relayError('Wait for the current Agent run to finish before changing its configuration', 'GROUP_AGENT_BUSY')
    }
    if (!this.link.connectorId || !this.link.credential) {
      throw relayError('The Agent Relay connection is incomplete', 'GROUP_AGENT_OFFLINE')
    }
    if (!this.socket?.connected) {
      this.close()
      await this.connect()
    }
    const socket = this.socket
    if (!socket?.connected) throw relayError('The Agent Relay is offline', 'GROUP_AGENT_OFFLINE')
    const agent = normalizeRemoteGroupAgentDescriptor(value)
    const confirmed = await new Promise<RemoteGroupAgentDescriptor>((resolve, reject) => {
      const timer = setTimeout(() => reject(relayError('Timed out updating the remote Agent')), RELAY_ACCEPT_TIMEOUT_MS)
      socket.emit('agent.config.update', agent, (response: Record<string, unknown>) => {
        clearTimeout(timer)
        try {
          if (response?.error) throw relayError(String(response.error), String(response.code || 'GROUP_AGENT_UPDATE_FAILED'))
          const updated = normalizeRemoteGroupAgentDescriptor(response?.agent)
          if (!sameRemoteAgent(agent, updated)) throw relayError('The group chat returned a different Agent configuration')
          resolve(updated)
        } catch (error) {
          reject(error)
        }
      })
    })
    this.link = { ...this.link, agent: confirmed }
    this.runner?.disconnect()
    this.runner = null
    await this.manager.persist(this.link)
    this.close()
    await this.connect()
    return this.link
  }

  private bindEvents(): void {
    const socket = this.socket!
    socket.on('relay.ready', (data: unknown) => {
      this.sink?.setBatching(supportsAgentEventBatching(data, Boolean(this.link.cloudMachineId)))
    })
    socket.on('disconnect', () => this.sink?.abort(new Error('Remote Agent relay disconnected')))
    socket.on('connector.revoked', (data: { connectorId?: string }) => {
      const connectorId = String(data?.connectorId || this.link.connectorId || '').trim()
      if (!connectorId || connectorId !== this.link.connectorId) return
      void this.manager.handleConnectorRevoked(connectorId, this)
    })
    socket.on('room.metadata', (data: Record<string, unknown>) => {
      try {
        const roomId = boundedRelayText(data?.roomId || '', 160, 'room id')
        if (!roomId || (this.link.roomId && this.link.roomId !== roomId)) return
        const roomName = boundedRelayText(data?.roomName || roomId, 120, 'room name')
        const inviteCode = boundedRelayText(data?.inviteCode || '', 160, 'invite code')
        if (
          this.link.roomId === roomId
          && this.link.roomName === roomName
          && String(this.link.inviteCode || '') === inviteCode
        ) return
        this.link = {
          ...this.link,
          roomId,
          roomName,
          ...(inviteCode ? { inviteCode } : {}),
        }
        if (!inviteCode) delete this.link.inviteCode
        void this.manager.persist(this.link)
      } catch {
        // Ignore malformed metadata from the Relay without dropping the connection.
      }
    })
    socket.on('run.request', (request: RelayRunRequest) => void this.handleRun(request))
    socket.on('run.interrupt', (data: { runId?: string }) => {
      const request = this.activeRequest
      if (!request || data?.runId !== request.runId) return
      void this.runner?.interrupt(request.room.id)
    })
    socket.on(
      'approval.respond',
      async (data: { approvalId?: string; choice?: string }, ack?: (response: Record<string, unknown>) => void) => {
        const sessionId = this.activeRequest && this.runner?.getActiveSessionId(this.activeRequest.room.id)
        if (!sessionId || !data?.approvalId) {
          ack?.({ error: 'Approval is not pending for an active remote run' })
          return
        }
        try {
          if (this.link.agent.agent === 'ekko') {
            const result = respondToGroupEkkoToolApproval(sessionId, data.approvalId, data.choice)
            ack?.({ resolved: Boolean(result?.resolved) })
          } else {
            const result = await createGroupPrimaryAgentBridge().approvalRespond(data.approvalId, data.choice || 'deny')
            ack?.({ resolved: Boolean((result as any)?.resolved) })
          }
        } catch (error) {
          ack?.({ error: error instanceof Error ? error.message : 'Approval response failed' })
        }
      },
    )
    socket.on(
      'clarify.respond',
      async (data: { clarifyId?: string; response?: string }, ack?: (response: Record<string, unknown>) => void) => {
        const sessionId = this.activeRequest && this.runner?.getActiveSessionId(this.activeRequest.room.id)
        if (!sessionId || !data?.clarifyId) {
          ack?.({ error: 'Clarification is not pending for an active remote run' })
          return
        }
        try {
          if (this.link.agent.agent === 'ekko') {
            const result = respondToGroupEkkoClarification(sessionId, data.clarifyId, data.response || '')
            ack?.({ resolved: Boolean(result?.resolved) })
          } else {
            const result = await createGroupPrimaryAgentBridge().clarifyRespond(data.clarifyId, data.response || '')
            ack?.({ resolved: Boolean((result as any)?.resolved) })
          }
        } catch (error) {
          ack?.({ error: error instanceof Error ? error.message : 'Clarification response failed' })
        }
      },
    )
  }

  private async handleRun(request: RelayRunRequest): Promise<void> {
    const socket = this.socket
    const sink = this.sink
    if (!socket || !sink || this.activeRequest) {
      socket?.emit('run.failed', { runId: request?.runId, error: 'Remote Agent is already running' })
      return
    }
    try {
      validateRelayRunRequest(request)
    } catch (error) {
      socket.emit('run.failed', {
        runId: typeof request?.runId === 'string' ? request.runId.slice(0, 80) : '',
        error: error instanceof Error ? error.message : 'Invalid Relay run request',
      })
      return
    }
    if (this.link.roomId !== request.room.id || this.link.roomName !== request.room.name) {
      this.link = {
        ...this.link,
        roomId: request.room.id,
        roomName: request.room.name,
      }
      await this.manager.persist(this.link)
    }
    this.activeRequest = request
    sink.begin(request.runId, request.workspaceApi?.token ? [request.workspaceApi.token] : [])
    socket.emit('run.accepted', { runId: request.runId })
    let attachmentRunDir = ''
    try {
      const workspace = relayRoomWorkspace(request.room, this.link.agent.profile)
      await mkdir(workspace, { recursive: true, mode: 0o700 })
      const roomState = {
        room: {
          ...request.room,
          workspace,
          ...(request.workspaceApi
            ? {
                remoteWorkspaceApi: {
                  endpoint: this.link.cloudMachineId
                    ? `${this.link.cloudOrigin}/api/group-agent-relay/${this.link.cloudMachineId}/${this.link.connectorId}/workspace`
                    : `${this.link.cloudOrigin}/api/studio/group-chat/remote-workspace/v1`,
                  token: request.workspaceApi.token,
                  access: request.workspaceApi.access,
                },
              }
            : {}),
        },
        members: request.members,
        agents: request.agents,
      }
      const materialized = await this.materializeAttachments(request)
      attachmentRunDir = materialized.runDir
      if (!this.runner) {
        const agentConfig: AgentConfig = {
          ...this.link.agent,
          invited: 1,
          backgroundDelegationEnabled: false,
        }
        this.runner = new AgentClient(agentConfig, {}, sink)
        this.runner.setChatRunService(this.manager.chatRunService())
        this.runner.setWorkspaceDiffBroadcaster(null)
      }
      this.runner.setStorage({
        getRoom: (roomId: string) => roomId === request.room.id ? roomState.room : undefined,
        getRoomMembers: (roomId: string) => roomId === request.room.id ? roomState.members : [],
        getRoomAgents: (roomId: string) => roomId === request.room.id ? roomState.agents : [],
      })
      await this.runner.replyToMention(request.room.id, materialized.message, request.runtimeContext, (status, extra) => {
        sink.emit('context_status', {
          roomId: request.room.id,
          status,
          ...extra,
        })
      })
      await sink.drain()
      socket.emit('run.completed', { runId: request.runId })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Remote Agent run failed'
      socket.emit('run.failed', {
        runId: request.runId,
        error: String(redactRelaySecrets(
          errorMessage,
          request.workspaceApi?.token ? [request.workspaceApi.token] : [],
        )),
      })
    } finally {
      sink.end(request.runId)
      this.activeRequest = null
      if (attachmentRunDir) await rm(attachmentRunDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async materializeAttachments(
    request: RelayRunRequest,
  ): Promise<{ message: MentionMessage; runDir: string }> {
    const attachments = Array.isArray(request.attachments) ? request.attachments : []
    if (!attachments.length) return { message: request.message, runDir: '' }
    if (!Array.isArray(request.message.input) || attachments.length > 32) {
      throw relayError('Invalid relay attachment manifest', 'GROUP_AGENT_ATTACHMENT_INVALID')
    }
    const totalBytes = attachments.reduce((total, attachment) => total + Number(attachment?.size || 0), 0)
    if (!Number.isSafeInteger(totalBytes) || totalBytes > RELAY_RUN_ATTACHMENT_MAX_BYTES) {
      throw relayError('Relay attachments exceed the per-run limit', 'GROUP_AGENT_ATTACHMENT_INVALID')
    }
    const connectorSegment = this.link.connectorId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'pairing'
    const runSegment = request.runId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
    if (!runSegment) throw relayError('Invalid relay run id', 'GROUP_AGENT_ATTACHMENT_INVALID')
    const runDir = join(OUTBOUND_ATTACHMENTS_DIR, connectorSegment, runSegment)
    await mkdir(runDir, { recursive: true, mode: 0o700 })
    try {
      const localPaths = new Map<string, string>()

      for (const attachment of attachments) {
      if (
        !attachment
        || typeof attachment.id !== 'string'
        || !/^[a-f0-9-]{36}$/i.test(attachment.id)
        || (attachment.type !== 'image' && attachment.type !== 'file')
        || !Number.isSafeInteger(attachment.size)
        || attachment.size < 0
        || attachment.size > RELAY_ATTACHMENT_MAX_BYTES
      ) {
        throw relayError('Invalid relay attachment manifest', 'GROUP_AGENT_ATTACHMENT_INVALID')
      }
      const extension = extname(basename(String(attachment.name || ''))).toLowerCase()
      const safeExtension = /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : ''
      const localPath = join(runDir, `${attachment.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)}${safeExtension}`)
      if (!isPathWithin(localPath, runDir)) {
        throw relayError('Invalid relay attachment path', 'GROUP_AGENT_ATTACHMENT_INVALID')
      }
      const chunks: Buffer[] = []
      let offset = 0
      while (offset < attachment.size) {
        const response = await this.readAttachmentChunk(request.runId, attachment.id, offset)
        if (response.size !== attachment.size) {
          throw relayError('Relay attachment changed during transfer', 'GROUP_AGENT_ATTACHMENT_INVALID')
        }
        if (
          response.chunk.length > Math.ceil(RELAY_ATTACHMENT_CHUNK_BYTES / 3) * 4 + 4
          || !/^[a-zA-Z0-9+/]*={0,2}$/.test(response.chunk)
        ) {
          throw relayError('Invalid relay attachment encoding', 'GROUP_AGENT_ATTACHMENT_INVALID')
        }
        const chunk = Buffer.from(response.chunk, 'base64')
        if (
          !chunk.length
          || chunk.length > RELAY_ATTACHMENT_CHUNK_BYTES
          || response.nextOffset !== offset + chunk.length
          || response.nextOffset > attachment.size
          || response.done !== (response.nextOffset === attachment.size)
        ) {
          throw relayError('Invalid relay attachment chunk', 'GROUP_AGENT_ATTACHMENT_INVALID')
        }
        chunks.push(chunk)
        offset = response.nextOffset
      }
      await writeFile(localPath, Buffer.concat(chunks), { flag: 'wx', mode: 0o600 })
        localPaths.set(attachment.id, localPath)
      }

      const input = request.message.input.map((block: any) => {
        if (block?.type !== 'image' && block?.type !== 'file') return block
        const attachmentId = String(block.relay_attachment_id || '')
        const localPath = localPaths.get(attachmentId)
        if (!localPath) throw relayError('Relay attachment block is missing from the manifest', 'GROUP_AGENT_ATTACHMENT_INVALID')
        const { relay_attachment_id: _relayAttachmentId, ...safeBlock } = block
        return { ...safeBlock, path: localPath }
      })
      return {
        message: { ...request.message, input },
        runDir,
      }
    } catch (error) {
      await rm(runDir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  private readAttachmentChunk(
    runId: string,
    attachmentId: string,
    offset: number,
  ): Promise<{ chunk: string; nextOffset: number; done: boolean; size: number }> {
    const socket = this.socket
    if (!socket?.connected) return Promise.reject(relayError('Relay disconnected during attachment transfer'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(relayError('Relay attachment transfer timed out')),
        RELAY_ACCEPT_TIMEOUT_MS,
      )
      socket.emit(
        'attachment.read',
        { runId, attachmentId, offset },
        (response: { error?: string; chunk?: string; nextOffset?: number; done?: boolean; size?: number }) => {
          clearTimeout(timer)
          if (response?.error) {
            reject(relayError(response.error))
            return
          }
          resolve({
            chunk: String(response?.chunk || ''),
            nextOffset: Number(response?.nextOffset),
            done: response?.done === true,
            size: Number(response?.size),
          })
        },
      )
    })
  }
}

export class GroupAgentOutboundRelayManager {
  private connections = new Map<string, OutboundRelayConnection>()
  private persistenceQueue: Promise<void> = Promise.resolve()

  constructor(private readonly getChatRunService: () => GroupChatRunService | null) {}

  chatRunService(): GroupChatRunService | null {
    return this.getChatRunService()
  }

  async connect(input: {
    cloudOrigin: string
    cloudMachineId?: string
    targetOrigin: string
    pairingTicket: string
    agent: RemoteGroupAgentDescriptor
  }): Promise<{ connectorId: string; roomId?: string; roomName?: string; inviteCode?: string }> {
    const cloudOrigin = normalizeOrigin(input.cloudOrigin)
    const cloudMachineId = normalizeCloudAgentMachineId(input.cloudMachineId)
    const targetOrigin = normalizeOrigin(input.targetOrigin)
    const ticket = String(input.pairingTicket || '').trim()
    if (!ticket) throw new Error('pairingTicket is required')
    const agent = normalizeRemoteGroupAgentDescriptor(input.agent)
    const key = `pairing:${ticket.slice(0, 12)}`
    const connection = new OutboundRelayConnection(this, key, {
      cloudOrigin,
      ...(cloudMachineId ? { cloudMachineId } : {}),
      targetOrigin,
      connectorId: '',
      credential: '',
      agent,
    }, ticket)
    this.connections.get(key)?.close()
    this.connections.set(key, connection)
    try {
      const link = await connection.connect()
      this.connections.delete(key)
      this.connections.set(link.connectorId, connection)
      return {
        connectorId: link.connectorId,
        ...(link.roomId ? { roomId: link.roomId } : {}),
        ...(link.roomName ? { roomName: link.roomName } : {}),
        ...(link.inviteCode ? { inviteCode: link.inviteCode } : {}),
      }
    } catch (error) {
      connection.close()
      this.connections.delete(key)
      throw error
    }
  }

  async restore(): Promise<void> {
    await rm(OUTBOUND_ATTACHMENTS_DIR, { recursive: true, force: true }).catch(() => undefined)
    const links = await this.readPersisted()
    for (const link of links) {
      if (!link.connectorId || !link.credential) continue
      const connection = new OutboundRelayConnection(this, link.connectorId, link)
      this.connections.set(link.connectorId, connection)
      void connection.connect().catch(async error => {
        logger.warn(error, '[GroupAgentRelay] failed to restore outbound connector %s', link.connectorId)
        if (isTerminalOutboundCredentialError(error)) {
          await this.forgetConnection(link.connectorId, connection).catch(cleanupError => {
            logger.warn(cleanupError, '[GroupAgentRelay] failed to remove invalid outbound connector %s', link.connectorId)
          })
        }
      })
    }
  }

  async listConnections(): Promise<Array<{
    connectorId: string
    cloudOrigin: string
    cloudMachineId?: string
    targetOrigin: string
    roomId?: string
    roomName?: string
    roomAlias?: string
    inviteCode?: string
    agent: RemoteGroupAgentDescriptor
    connected: boolean
  }>> {
    return this.withPersistenceLock(async () => {
      const links = await this.readPersisted()
      return links.map(link => ({
        connectorId: link.connectorId,
        cloudOrigin: link.cloudOrigin,
        ...(link.cloudMachineId ? { cloudMachineId: link.cloudMachineId } : {}),
        targetOrigin: link.targetOrigin,
        ...(link.roomId ? { roomId: link.roomId } : {}),
        ...(link.roomName ? { roomName: link.roomName } : {}),
        ...(link.roomAlias ? { roomAlias: link.roomAlias } : {}),
        ...(link.inviteCode ? { inviteCode: link.inviteCode } : {}),
        agent: link.agent,
        connected: this.connections.get(link.connectorId)?.connected === true,
      }))
    })
  }

  async disconnect(connectorId: string): Promise<boolean> {
    const connection = this.connections.get(connectorId)
    if (connection) await connection.revoke().catch(() => false)
    connection?.close()
    this.connections.delete(connectorId)
    return this.withPersistenceLock(async () => {
      const links = await this.readPersisted()
      const next = links.filter(link => link.connectorId !== connectorId)
      if (next.length === links.length && !connection) return false
      await this.writePersisted(next)
      return true
    })
  }

  async renameRoom(connectorId: string, roomAlias: string): Promise<number> {
    const alias = String(roomAlias || '').trim()
    if (!alias || alias.length > 120) throw new Error('Room display name must be between 1 and 120 characters')
    return this.withPersistenceLock(async () => {
      const links = await this.readPersisted()
      const seed = links.find(link => link.connectorId === connectorId)
      if (!seed) throw new Error('Agent room connection not found on this Hermes service')
      let updated = 0
      const next = links.map(link => {
        if (!this.sameRoomLink(link, seed)) return link
        updated += 1
        return { ...link, roomAlias: alias }
      })
      await this.writePersisted(next)
      return updated
    })
  }

  async leaveRoom(connectorId: string): Promise<{ removed: number; notified: number }> {
    const links = await this.withPersistenceLock(async () => this.readPersisted())
    const seed = links.find(link => link.connectorId === connectorId)
    if (!seed) return { removed: 0, notified: 0 }
    const targets = links.filter(link => this.sameRoomLink(link, seed))
    const notices = await Promise.all(targets.map(async link => {
      const connection = this.connections.get(link.connectorId)
      if (!connection) return false
      return connection.revoke().catch(() => false)
    }))

    for (const link of targets) {
      this.connections.get(link.connectorId)?.close()
      this.connections.delete(link.connectorId)
    }
    await this.withPersistenceLock(async () => {
      const current = await this.readPersisted()
      await this.writePersisted(current.filter(link => !this.sameRoomLink(link, seed)))
    })
    return {
      removed: targets.length,
      notified: notices.filter(Boolean).length,
    }
  }

  async updateConnection(
    connectorId: string,
    agent: RemoteGroupAgentDescriptor,
  ): Promise<{
    connectorId: string
    cloudOrigin: string
    targetOrigin: string
    roomId?: string
    roomName?: string
    roomAlias?: string
    inviteCode?: string
    agent: RemoteGroupAgentDescriptor
    connected: boolean
  }> {
    const connection = this.connections.get(connectorId)
    if (!connection) throw new Error('Agent connection not found on this Hermes service')
    let link: PersistedOutboundLink
    try {
      link = await connection.updateAgent(agent)
    } catch (error) {
      if (isTerminalOutboundCredentialError(error)) {
        await this.forgetConnection(connectorId, connection).catch(cleanupError => {
          logger.warn(cleanupError, '[GroupAgentRelay] failed to remove invalid outbound connector %s', connectorId)
        })
      }
      throw error
    }
    return {
      connectorId: link.connectorId,
      cloudOrigin: link.cloudOrigin,
      targetOrigin: link.targetOrigin,
      ...(link.roomId ? { roomId: link.roomId } : {}),
      ...(link.roomName ? { roomName: link.roomName } : {}),
      ...(link.roomAlias ? { roomAlias: link.roomAlias } : {}),
      ...(link.inviteCode ? { inviteCode: link.inviteCode } : {}),
      agent: link.agent,
      connected: connection.connected,
    }
  }

  shutdown(): void {
    for (const connection of this.connections.values()) connection.close()
    this.connections.clear()
  }

  async persist(link: PersistedOutboundLink): Promise<void> {
    await this.withPersistenceLock(async () => {
      const links = await this.readPersisted()
      const next = links.filter(item => item.connectorId !== link.connectorId)
      next.push(link)
      await this.writePersisted(next)
    })
  }

  async handleConnectorRevoked(connectorId: string, connection: unknown): Promise<void> {
    if (!(connection instanceof OutboundRelayConnection)) return
    await this.forgetConnection(connectorId, connection).catch(error => {
      logger.warn(error, '[GroupAgentRelay] failed to remove revoked outbound connector %s', connectorId)
    })
  }

  private async forgetConnection(connectorId: string, connection: OutboundRelayConnection): Promise<void> {
    if (this.connections.get(connectorId) !== connection) return
    connection.close()
    this.connections.delete(connectorId)
    await this.withPersistenceLock(async () => {
      const links = await this.readPersisted()
      await this.writePersisted(links.filter(link => link.connectorId !== connectorId))
    })
  }

  private sameRoomLink(link: PersistedOutboundLink, seed: PersistedOutboundLink): boolean {
    if (!seed.roomId || !link.roomId) return link.connectorId === seed.connectorId
    return link.cloudOrigin === seed.cloudOrigin && link.cloudMachineId === seed.cloudMachineId && link.roomId === seed.roomId
  }

  private async withPersistenceLock<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.persistenceQueue
    let release = () => {}
    this.persistenceQueue = new Promise<void>(resolve => { release = resolve })
    await previous.catch(() => undefined)
    try {
      return await task()
    } finally {
      release()
    }
  }

  private async writePersisted(links: PersistedOutboundLink[]): Promise<void> {
    await mkdir(dirname(OUTBOUND_LINKS_FILE), { recursive: true })
    const tempPath = `${OUTBOUND_LINKS_FILE}.tmp-${process.pid}-${randomUUID()}`
    try {
      await writeFile(
        tempPath,
        `${JSON.stringify(links, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 },
      )
      await rename(tempPath, OUTBOUND_LINKS_FILE)
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined)
    }
  }

  private async readPersisted(): Promise<PersistedOutboundLink[]> {
    let file: Awaited<ReturnType<typeof open>> | null = null
    try {
      const info = await lstat(OUTBOUND_LINKS_FILE)
      if (!info.isFile() || info.isSymbolicLink()) return []
      file = await open(
        OUTBOUND_LINKS_FILE,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
      )
      const current = await file.stat()
      if (
        !current.isFile()
        || Number(current.dev) !== Number(info.dev)
        || Number(current.ino) !== Number(info.ino)
      ) {
        return []
      }
      if ((current.mode & 0o077) !== 0) await file.chmod(0o600)
      const parsed = JSON.parse(await file.readFile('utf8'))
      if (!Array.isArray(parsed)) return []
      const links: PersistedOutboundLink[] = []
      for (const raw of parsed) {
        try {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
          const link = raw as Record<string, unknown>
          const connectorId = String(link.connectorId || '').trim()
          const credential = String(link.credential || '').trim()
          const roomId = typeof link.roomId === 'string' && link.roomId.trim().length <= 160
            ? link.roomId.trim()
            : ''
          const roomName = typeof link.roomName === 'string' && link.roomName.trim().length <= 120
            ? link.roomName.trim()
            : ''
          const roomAlias = typeof link.roomAlias === 'string' && link.roomAlias.trim().length <= 120
            ? link.roomAlias.trim()
            : ''
          const inviteCode = typeof link.inviteCode === 'string' && link.inviteCode.trim().length <= 160
            ? link.inviteCode.trim()
            : ''
          if (!UUID_PATTERN.test(connectorId) || !/^[a-zA-Z0-9_-]{40,128}$/.test(credential)) continue
          links.push({
            cloudOrigin: normalizeOrigin(link.cloudOrigin),
            ...(link.cloudMachineId ? { cloudMachineId: normalizeCloudAgentMachineId(link.cloudMachineId) } : {}),
            targetOrigin: normalizeOrigin(link.targetOrigin),
            connectorId,
            credential,
            ...(roomId ? { roomId } : {}),
            ...(roomName ? { roomName } : {}),
            ...(roomAlias ? { roomAlias } : {}),
            ...(inviteCode ? { inviteCode } : {}),
            agent: normalizeRemoteGroupAgentDescriptor(link.agent),
          })
        } catch {
          // Ignore malformed individual entries without discarding other valid links.
        }
      }
      return links
    } catch {
      return []
    } finally {
      await file?.close().catch(() => undefined)
    }
  }
}

let outboundRelayManager: GroupAgentOutboundRelayManager | null = null

export function getGroupAgentOutboundRelayManager(
  getChatRunService: () => GroupChatRunService | null,
): GroupAgentOutboundRelayManager {
  if (!outboundRelayManager) outboundRelayManager = new GroupAgentOutboundRelayManager(getChatRunService)
  return outboundRelayManager
}
