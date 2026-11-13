import type { Context } from 'koa'
import { normalizeCloudAgentMachineId } from '../services/group-chat/cloud-agent-auth'
import { listProfileNamesFromDisk } from '../public/profile-config'
import { canManageGroupChatRoom } from '../services/group-chat/access'
import {
  countActiveGuestAgentLinks,
  countRecentGuestAgentPairingRequests,
  createGroupAgentPairingHandoff,
  createGroupAgentPairingRequest,
  decideGroupAgentPairingRequest,
  failGroupAgentPairingRequestForRequester,
  getGroupAgentConnector,
  getGroupAgentPairingRequest,
  getGroupAgentPairingRequestForRequester,
  GROUP_AGENT_PAIRING_REQUEST_TTL_MS,
  listPendingGroupAgentPairingRequests,
  normalizeGroupAgentTargetOrigin,
  normalizeRemoteGroupAgentDescriptor,
  revokeGroupAgentConnector,
  submitGroupAgentPairingHandoff,
} from '../services/group-chat/agent-relay-store'
import {
  getGroupAgentOutboundRelayManager,
  GROUP_AGENT_RELAY_PROTOCOL_VERSION,
} from '../services/group-chat/agent-relay'
import { getGroupChatRuntimeServer } from '../services/group-chat/runtime'
import { isReservedMentionName } from '../services/group-chat/mention-routing'
import { assertAgentAvailable } from '../services/agent-availability'

function serverOrUnavailable(ctx: Context) {
  const server = getGroupChatRuntimeServer()
  if (!server) {
    ctx.status = 503
    ctx.body = { error: 'Group chat not initialized' }
    return null
  }
  return server
}

function publicPairingRequest(request: any) {
  return {
    id: request.id,
    roomId: request.roomId,
    ownerMemberId: request.ownerMemberId,
    ownerName: request.ownerName,
    targetOrigin: request.targetOrigin,
    agent: request.agent,
    status: request.status,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    approvedAt: request.approvedAt,
    ticketExpiresAt: request.ticketExpiresAt,
    consumedAt: request.consumedAt,
    failureReason: request.failureReason,
  }
}

const MAX_CLOUD_RESPONSE_BYTES = 256_000
const HANDOFF_EXPIRY_CLOCK_SKEW_MS = 30_000
const MAX_LOCAL_HANDOFF_JOBS = 32
const MAX_LOCAL_HANDOFF_JOBS_PER_PRINCIPAL = 4
const MAX_LOCAL_HANDOFF_JOBS_PER_ORIGIN = 8

type LocalHandoffJob = {
  cloudOrigin: string
  principal: string
  promise: Promise<void> | null
}

const localHandoffJobs = new Map<string, LocalHandoffJob>()
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

class LocalHandoffLimitError extends Error {
  readonly code = 'GROUP_AGENT_HANDOFF_LIMIT'
}

function boundedCredential(value: unknown, field: string): string {
  const text = String(value || '').trim()
  if (!/^[A-Za-z0-9_-]{32,200}$/.test(text)) throw new Error(`${field} is invalid`)
  return text
}

function boundedRequestId(value: unknown): string {
  const text = String(value || '').trim()
  if (!UUID_PATTERN.test(text)) throw new Error('requestId is invalid')
  return text
}

function boundedInviteCode(value: unknown): string {
  const text = String(value || '').trim()
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(text)) throw new Error('inviteCode is invalid')
  return text
}

async function limitedResponseText(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > MAX_CLOUD_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error('Remote group chat response is too large')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8')
}

async function cloudJson(
  url: string,
  options: RequestInit,
): Promise<{ response: Response; body: Record<string, any> }> {
  const response = await fetch(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  const declaredLength = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CLOUD_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('Remote group chat response is too large')
  }
  const text = await limitedResponseText(response)
  let body: Record<string, any> = {}
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error('Remote group chat returned an invalid response')
    }
  }
  return { response, body }
}

function localHandoffPrincipal(ctx: Context): string {
  const userId = Number(ctx.state.user?.id || 0)
  if (Number.isSafeInteger(userId) && userId > 0) return `auth:${userId}`
  return `ip:${ctx.ip || 'unknown'}`
}

function reserveLocalHandoffJob(jobKey: string, cloudOrigin: string, principal: string): LocalHandoffJob {
  if (
    localHandoffJobs.size >= MAX_LOCAL_HANDOFF_JOBS
    || [...localHandoffJobs.values()].filter(job => job.principal === principal).length >= MAX_LOCAL_HANDOFF_JOBS_PER_PRINCIPAL
    || [...localHandoffJobs.values()].filter(job => job.cloudOrigin === cloudOrigin).length >= MAX_LOCAL_HANDOFF_JOBS_PER_ORIGIN
  ) {
    throw new LocalHandoffLimitError('Too many Agent handoff requests are already in progress')
  }
  const entry: LocalHandoffJob = { cloudOrigin, principal, promise: null }
  localHandoffJobs.set(jobKey, entry)
  return entry
}

function handoffCloudUrl(cloudOrigin: string, inviteCode: string, requestId: string, suffix = ''): string {
  return `${cloudOrigin}/api/studio/group-chat/invites/${encodeURIComponent(inviteCode)}/agent-links/${encodeURIComponent(requestId)}${suffix}`
}

function sanitizedHandoffFailure(reason: unknown): string {
  return String(reason || 'Agent connection failed')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]')
    .replace(/(api[_-]?key|token|secret|password)=([^\s]+)/gi, '$1=[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

async function reportLocalHandoffFailure(input: {
  cloudOrigin: string
  inviteCode: string
  requestId: string
  requestSecret: string
}, reason: string): Promise<void> {
  await cloudJson(handoffCloudUrl(input.cloudOrigin, input.inviteCode, input.requestId, '/failure'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Group-Agent-Request-Secret': input.requestSecret,
    },
    body: JSON.stringify({ reason }),
  }).catch(() => undefined)
}

async function waitForHandoffApproval(input: {
  cloudOrigin: string
  targetOrigin: string
  inviteCode: string
  requestId: string
  requestSecret: string
  pairingTicket: string
  agent: ReturnType<typeof normalizeRemoteGroupAgentDescriptor>
  expiresAt: number
}): Promise<void> {
  const server = getGroupChatRuntimeServer()
  if (!server) throw new Error('Group chat not initialized')
  const manager = getGroupAgentOutboundRelayManager(() => server.getChatRunService())
  while (Date.now() < input.expiresAt) {
    const { response, body } = await cloudJson(
      handoffCloudUrl(input.cloudOrigin, input.inviteCode, input.requestId),
      {
        method: 'GET',
        headers: { 'X-Group-Agent-Request-Secret': input.requestSecret },
      },
    )
    if (!response.ok) throw new Error(String(body.error || `Pairing status failed (${response.status})`))
    const status = String(body.request?.status || '')
    if (status === 'approved') {
      await manager.connect({
        cloudOrigin: input.cloudOrigin,
        targetOrigin: input.targetOrigin,
        pairingTicket: input.pairingTicket,
        agent: input.agent,
      })
      return
    }
    if (status === 'consumed' || status === 'connecting') return
    if (status === 'rejected') throw new Error('The room owner rejected this Agent request')
    if (status === 'expired') throw new Error('The Agent connection request expired')
    if (status === 'failed') throw new Error(String(body.request?.failureReason || 'Agent connection failed'))
    await new Promise(resolve => setTimeout(resolve, 1_200))
  }
  throw new Error('The Agent connection request expired')
}

function exactCapabilityCors(ctx: Context): void {
  const origin = ctx.get('Origin')
  if (origin) {
    try {
      const normalized = new URL(origin).origin
      ctx.set('Access-Control-Allow-Origin', normalized)
      ctx.set('Vary', 'Origin')
    } catch {
      // Invalid origins receive no CORS permission.
    }
  }
  ctx.set('Access-Control-Allow-Methods', 'GET, OPTIONS')
  ctx.set('Access-Control-Allow-Headers', 'Content-Type')
  if (ctx.get('Access-Control-Request-Private-Network') === 'true') {
    ctx.set('Access-Control-Allow-Private-Network', 'true')
  }
}

function normalizeCloudOrigin(value: unknown): string {
  const url = new URL(String(value || '').trim())
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Cloud URL must not contain credentials, query, or fragment')
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('Cloud URL must be an origin without a path')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Cloud URL must use HTTP or HTTPS')
  }
  return url.origin
}

export async function capabilities(ctx: Context): Promise<void> {
  exactCapabilityCors(ctx)
  if (ctx.method === 'OPTIONS') {
    ctx.status = 204
    return
  }
  ctx.set('Cache-Control', 'no-store')
  ctx.body = {
    service: 'hermes-group-chat-link',
    protocolVersion: GROUP_AGENT_RELAY_PROTOCOL_VERSION,
    authorizationPath: '/?groupChatAgentLink=1#/group-chat-link',
    supportsManualPairingCode: true,
    supportsOutboundRelay: true,
  }
}

export async function localAgents(ctx: Context): Promise<void> {
  ctx.set('Cache-Control', 'no-store')
  ctx.body = {
    protocolVersion: GROUP_AGENT_RELAY_PROTOCOL_VERSION,
    agents: listProfileNamesFromDisk().map(profile => ({
      agent: 'hermes',
      agentMode: 'scoped',
      profile,
      provider: '',
      model: '',
      apiMode: '',
      reasoningEffort: '',
      name: profile,
      description: '',
      avatar: JSON.stringify({ type: 'generated', seed: `profile-${profile}` }),
    })),
  }
}

export async function localConnections(ctx: Context): Promise<void> {
  const server = serverOrUnavailable(ctx)
  if (!server) return
  const manager = getGroupAgentOutboundRelayManager(() => server.getChatRunService())
  ctx.set('Cache-Control', 'no-store')
  ctx.body = { connections: await manager.listConnections() }
}

export async function connectLocalAgent(ctx: Context): Promise<void> {
  const server = serverOrUnavailable(ctx)
  if (!server) return
  try {
    const body = (ctx.request.body || {}) as Record<string, unknown>
    const cloudOrigin = normalizeCloudOrigin(body.cloudOrigin)
    const targetOrigin = normalizeGroupAgentTargetOrigin(body.targetOrigin)
    const pairingTicket = String(body.pairingTicket || '').trim()
    const agent = normalizeRemoteGroupAgentDescriptor(body.agent, 'connection request')
    assertAgentAvailable(agent.agent)
    if (!pairingTicket) throw new Error('pairingTicket is required')
    const manager = getGroupAgentOutboundRelayManager(() => server.getChatRunService())
    const connected = await manager.connect({
      cloudOrigin,
      cloudMachineId: normalizeCloudAgentMachineId(body.cloudMachineId),
      targetOrigin,
      pairingTicket,
      agent,
    })
    ctx.body = { ok: true, ...connected }
  } catch (error: any) {
    ctx.status = Number(error?.status || 400)
    ctx.body = {
      code: typeof error?.code === 'string' ? error.code : undefined,
      error: error instanceof Error ? error.message : 'Could not connect local Agent',
    }
  }
}

export async function disconnectLocalAgent(ctx: Context): Promise<void> {
  const server = serverOrUnavailable(ctx)
  if (!server) return
  const connectorId = String((ctx.request.body as any)?.connectorId || '').trim()
  if (!connectorId) {
    ctx.status = 400
    ctx.body = { error: 'connectorId is required' }
    return
  }
  const manager = getGroupAgentOutboundRelayManager(() => server.getChatRunService())
  ctx.body = { ok: await manager.disconnect(connectorId) }
}

export async function renameLocalRoom(ctx: Context): Promise<void> {
  const server = serverOrUnavailable(ctx)
  if (!server) return
  try {
    const connectorId = String(ctx.params.connectorId || '').trim()
    if (!UUID_PATTERN.test(connectorId)) throw new Error('connectorId is invalid')
    const name = String((ctx.request.body as any)?.name || '').trim()
    const manager = getGroupAgentOutboundRelayManager(() => server.getChatRunService())
    ctx.body = { ok: true, updated: await manager.renameRoom(connectorId, name) }
  } catch (error) {
    ctx.status = 400
    ctx.body = { error: error instanceof Error ? error.message : 'Could not rename local Agent room' }
  }
}

export async function leaveLocalRoom(ctx: Context): Promise<void> {
  const server = serverOrUnavailable(ctx)
  if (!server) return
  try {
    const connectorId = String(ctx.params.connectorId || '').trim()
    if (!UUID_PATTERN.test(connectorId)) throw new Error('connectorId is invalid')
    const manager = getGroupAgentOutboundRelayManager(() => server.getChatRunService())
    const result = await manager.leaveRoom(connectorId)
    ctx.body = { ok: result.removed > 0, ...result }
  } catch (error) {
    ctx.status = 400
    ctx.body = { error: error instanceof Error ? error.message : 'Could not leave remote Agent room' }
  }
}

export async function updateLocalAgent(ctx: Context): Promise<void> {
  const server = serverOrUnavailable(ctx)
  if (!server) return
  try {
    const connectorId = String(ctx.params.connectorId || '').trim()
    if (!UUID_PATTERN.test(connectorId)) throw new Error('connectorId is invalid')
    const agent = normalizeRemoteGroupAgentDescriptor((ctx.request.body as any)?.agent)
    assertAgentAvailable(agent.agent)
    const manager = getGroupAgentOutboundRelayManager(() => server.getChatRunService())
    ctx.body = {
      ok: true,
      connection: await manager.updateConnection(connectorId, agent),
    }
  } catch (error: any) {
    ctx.status = Number(error?.status || (error?.code === 'ROOM_PARTICIPANT_NAME_CONFLICT' ? 409 : 400))
    ctx.body = {
      code: typeof (error as any)?.code === 'string' ? (error as any).code : undefined,
      error: error instanceof Error ? error.message : 'Could not update local Agent',
    }
  }
}

export async function connectLocalAgentHandoff(ctx: Context): Promise<void> {
  const server = serverOrUnavailable(ctx)
  if (!server) return
  try {
    const body = (ctx.request.body || {}) as Record<string, unknown>
    const cloudOrigin = normalizeCloudOrigin(body.cloudOrigin)
    const targetOrigin = normalizeGroupAgentTargetOrigin(body.targetOrigin)
    const inviteCode = boundedInviteCode(body.inviteCode)
    const requestId = boundedRequestId(body.requestId)
    const requestSecret = boundedCredential(body.requestSecret, 'requestSecret')
    const pairingTicket = boundedCredential(body.pairingTicket, 'pairingTicket')
    const agent = normalizeRemoteGroupAgentDescriptor(body.agent)
    assertAgentAvailable(agent.agent)
    const jobKey = `${cloudOrigin}:${requestId}`
    if (localHandoffJobs.has(jobKey)) {
      ctx.status = 202
      ctx.body = { ok: true, accepted: true }
      return
    }
    const jobEntry = reserveLocalHandoffJob(jobKey, cloudOrigin, localHandoffPrincipal(ctx))

    try {
      const submitted = await cloudJson(
        handoffCloudUrl(cloudOrigin, inviteCode, requestId, '/submit'),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Group-Agent-Request-Secret': requestSecret,
          },
          body: JSON.stringify({ targetOrigin, agent }),
        },
      )
      if (!submitted.response.ok) {
        throw new Error(String(submitted.body.error || `Pairing request failed (${submitted.response.status})`))
      }
      const now = Date.now()
      const remoteExpiresAt = Number(submitted.body.request?.expiresAt || 0)
      if (!Number.isSafeInteger(remoteExpiresAt) || remoteExpiresAt <= now) {
        throw new Error('Pairing request is already expired')
      }
      if (remoteExpiresAt > now + GROUP_AGENT_PAIRING_REQUEST_TTL_MS + HANDOFF_EXPIRY_CLOCK_SKEW_MS) {
        throw new Error('Pairing request expiry exceeds the allowed handoff lifetime')
      }
      const input = {
        cloudOrigin,
        targetOrigin,
        inviteCode,
        requestId,
        requestSecret,
        pairingTicket,
        agent,
        expiresAt: Math.min(remoteExpiresAt, now + GROUP_AGENT_PAIRING_REQUEST_TTL_MS),
      }
      const job = waitForHandoffApproval(input)
        .catch(async (error) => {
          const reason = sanitizedHandoffFailure(error instanceof Error ? error.message : error)
          await reportLocalHandoffFailure(input, reason)
        })
        .finally(() => {
          if (localHandoffJobs.get(jobKey) === jobEntry) localHandoffJobs.delete(jobKey)
        })
      jobEntry.promise = job
    } catch (error) {
      if (localHandoffJobs.get(jobKey) === jobEntry) {
        localHandoffJobs.delete(jobKey)
      }
      throw error
    }
    ctx.status = 202
    ctx.body = { ok: true, accepted: true }
  } catch (error: any) {
    const limited = error instanceof LocalHandoffLimitError
    ctx.status = limited ? 429 : Number(error?.status || 400)
    if (limited) ctx.set('Retry-After', '5')
    const message = error instanceof Error ? error.message : 'Could not start Agent handoff'
    ctx.body = limited
      ? { code: error.code, error: message }
      : { code: typeof error?.code === 'string' ? error.code : undefined, error: message }
  }
}

export function resetLocalHandoffJobsForTest(): void {
  localHandoffJobs.clear()
}

export async function createPairingHandoff(ctx: Context): Promise<void> {
  const server = serverOrUnavailable(ctx)
  if (!server) return
  const code = String(ctx.params.code || '').trim()
  const storage = server.getStorage()
  const room = storage.getRoomByInviteCode(code)
  if (!room) {
    ctx.status = 404
    ctx.body = { error: 'Invalid invite code' }
    return
  }
  if (!room.allowGuestAgents) {
    ctx.status = 403
    ctx.body = { code: 'GROUP_GUEST_AGENTS_DISABLED', error: 'Guest Agent connections are disabled for this room' }
    return
  }
  try {
    const body = (ctx.request.body || {}) as Record<string, unknown>
    const ownerMemberId = String(body.ownerMemberId || '').trim()
    const membershipToken = String(body.membershipToken || '').trim()
    const member = ownerMemberId ? storage.getMemberByUserId(room.id, ownerMemberId) : null
    if (!member || !server.authorizeGuestAgentRequestToken(room.id, ownerMemberId, membershipToken)) {
      ctx.status = 403
      ctx.body = { error: 'Join the room before requesting an Agent connection' }
      return
    }
    if (countActiveGuestAgentLinks(room.id, ownerMemberId) >= Math.max(1, Number(room.maxGuestAgentsPerMember || 1))) {
      ctx.status = 409
      ctx.body = { code: 'GROUP_GUEST_AGENT_LIMIT', error: 'Guest Agent limit reached for this member' }
      return
    }
    if (countRecentGuestAgentPairingRequests(room.id, ownerMemberId) >= 5) {
      ctx.status = 429
      ctx.body = { error: 'Too many Agent pairing requests; try again later' }
      return
    }
    const request = createGroupAgentPairingHandoff({
      requestId: boundedRequestId(body.requestId),
      requestSecret: boundedCredential(body.requestSecret, 'requestSecret'),
      pairingTicket: boundedCredential(body.pairingTicket, 'pairingTicket'),
      roomId: room.id,
      ownerMemberId,
      ownerName: member.name,
      targetOrigin: normalizeGroupAgentTargetOrigin(body.targetOrigin),
    })
    ctx.status = 201
    ctx.body = { request: publicPairingRequest(request) }
  } catch (error) {
    ctx.status = 400
    ctx.body = { error: error instanceof Error ? error.message : 'Invalid Agent handoff' }
  }
}

export async function submitPairingHandoff(ctx: Context): Promise<void> {
  const server = serverOrUnavailable(ctx)
  if (!server) return
  const code = String(ctx.params.code || '').trim()
  const requestId = String(ctx.params.requestId || '').trim()
  const requestSecret = ctx.get('X-Group-Agent-Request-Secret').trim()
  const storage = server.getStorage()
  const room = storage.getRoomByInviteCode(code)
  const existing = getGroupAgentPairingRequestForRequester(requestId, requestSecret)
  if (!room || !existing || existing.roomId !== room.id) {
    ctx.status = 404
    ctx.body = { error: 'Agent handoff not found' }
    return
  }
  try {
    if (!room.allowGuestAgents) throw new Error('Guest Agent connections are disabled for this room')
    const member = storage.getMemberByUserId(room.id, existing.ownerMemberId)
    if (!member) throw new Error('The requesting member is no longer in this room')
    const body = (ctx.request.body || {}) as Record<string, unknown>
    const targetOrigin = normalizeGroupAgentTargetOrigin(body.targetOrigin)
    if (targetOrigin !== existing.targetOrigin) throw new Error('Target origin changed during authorization')
    const agent = normalizeRemoteGroupAgentDescriptor(body.agent)
    if (isReservedMentionName(agent.name)) throw new Error('`all` is reserved for @all mentions')
    storage.assertParticipantNameAvailable(room.id, agent.name)
    if (countActiveGuestAgentLinks(room.id, existing.ownerMemberId) >= Math.max(1, Number(room.maxGuestAgentsPerMember || 1))) {
      ctx.status = 409
      ctx.body = { code: 'GROUP_GUEST_AGENT_LIMIT', error: 'Guest Agent limit reached for this member' }
      return
    }
    const submitted = submitGroupAgentPairingHandoff(requestId, requestSecret, agent)
    if (!submitted) {
      ctx.status = 409
      ctx.body = { error: 'Agent handoff is no longer available' }
      return
    }
    server.broadcastAgentPairingRequest(room.id, publicPairingRequest(submitted))
    ctx.status = 202
    ctx.body = { request: publicPairingRequest(submitted) }
  } catch (error) {
    ctx.status = (error as any)?.code === 'ROOM_PARTICIPANT_NAME_CONFLICT' ? 409 : 400
    ctx.body = {
      code: (error as any)?.code,
      error: error instanceof Error ? error.message : 'Invalid Agent handoff submission',
    }
  }
}

export async function failPairingHandoff(ctx: Context): Promise<void> {
  const server = serverOrUnavailable(ctx)
  if (!server) return
  const code = String(ctx.params.code || '').trim()
  const requestId = String(ctx.params.requestId || '').trim()
  const requestSecret = ctx.get('X-Group-Agent-Request-Secret').trim()
  const room = server.getStorage().getRoomByInviteCode(code)
  const existing = getGroupAgentPairingRequestForRequester(requestId, requestSecret)
  if (!room || !existing || existing.roomId !== room.id) {
    ctx.status = 404
    ctx.body = { error: 'Agent handoff not found' }
    return
  }
  const failed = failGroupAgentPairingRequestForRequester(
    requestId,
    requestSecret,
    String((ctx.request.body as any)?.reason || ''),
  )
  if (!failed) {
    ctx.status = 409
    ctx.body = { error: 'Agent handoff is no longer available' }
    return
  }
  server.broadcastAgentPairingUpdated(room.id, publicPairingRequest(failed))
  ctx.body = { request: publicPairingRequest(failed) }
}

export async function requestPairing(ctx: Context): Promise<void> {
  const server = serverOrUnavailable(ctx)
  if (!server) return
  const code = String(ctx.params.code || '').trim()
  const storage = server.getStorage()
  const room = storage.getRoomByInviteCode(code)
  if (!room) {
    ctx.status = 404
    ctx.body = { error: 'Invalid invite code' }
    return
  }
  if (!room.allowGuestAgents) {
    ctx.status = 403
    ctx.body = { code: 'GROUP_GUEST_AGENTS_DISABLED', error: 'Guest Agent connections are disabled for this room' }
    return
  }
  try {
    const body = (ctx.request.body || {}) as Record<string, unknown>
    const ownerMemberId = String(body.ownerMemberId || '').trim()
    const membershipToken = String(body.membershipToken || '').trim()
    const member = ownerMemberId ? storage.getMemberByUserId(room.id, ownerMemberId) : null
    if (!member || !server.authorizeGuestAgentRequestToken(room.id, ownerMemberId, membershipToken)) {
      ctx.status = 403
      ctx.body = { error: 'Join the room before requesting an Agent connection' }
      return
    }
    const targetOrigin = normalizeGroupAgentTargetOrigin(body.targetOrigin)
    const agent = normalizeRemoteGroupAgentDescriptor(body.agent)
    if (isReservedMentionName(agent.name)) throw new Error('`all` is reserved for @all mentions')
    storage.assertParticipantNameAvailable(room.id, agent.name)
    const activeCount = countActiveGuestAgentLinks(room.id, ownerMemberId)
    if (activeCount >= Math.max(1, Number(room.maxGuestAgentsPerMember || 1))) {
      ctx.status = 409
      ctx.body = { code: 'GROUP_GUEST_AGENT_LIMIT', error: 'Guest Agent limit reached for this member' }
      return
    }
    if (countRecentGuestAgentPairingRequests(room.id, ownerMemberId) >= 5) {
      ctx.status = 429
      ctx.body = { error: 'Too many Agent pairing requests; try again later' }
      return
    }
    const created = createGroupAgentPairingRequest({
      roomId: room.id,
      ownerMemberId,
      ownerName: member.name,
      targetOrigin,
      agent,
    })
    server.broadcastAgentPairingRequest(room.id, publicPairingRequest(created.request))
    ctx.status = 202
    ctx.body = {
      request: publicPairingRequest(created.request),
      requestSecret: created.requestSecret,
      pairingTicket: created.pairingTicket,
    }
  } catch (error) {
    ctx.status = (error as any)?.code === 'ROOM_PARTICIPANT_NAME_CONFLICT' ? 409 : 400
    ctx.body = {
      code: (error as any)?.code,
      error: error instanceof Error ? error.message : 'Invalid Agent pairing request',
    }
  }
}

export async function pairingStatus(ctx: Context): Promise<void> {
  const server = serverOrUnavailable(ctx)
  if (!server) return
  const code = String(ctx.params.code || '').trim()
  const room = server.getStorage().getRoomByInviteCode(code)
  const requestId = String(ctx.params.requestId || '').trim()
  const requestSecret = ctx.get('X-Group-Agent-Request-Secret').trim()
  const request = getGroupAgentPairingRequestForRequester(requestId, requestSecret)
  if (!room || !request || request.roomId !== room.id) {
    ctx.status = 404
    ctx.body = { error: 'Pairing request not found' }
    return
  }
  ctx.set('Cache-Control', 'no-store')
  ctx.body = { request: publicPairingRequest(request) }
}

export async function pendingPairings(ctx: Context): Promise<void> {
  const server = serverOrUnavailable(ctx)
  if (!server) return
  const roomId = String(ctx.params.roomId || '').trim()
  const storage = server.getStorage()
  if (!storage.getRoom(roomId)) {
    ctx.status = 404
    ctx.body = { error: 'Room not found' }
    return
  }
  if (!canManageGroupChatRoom(storage, roomId, ctx.state.user)) {
    ctx.status = 403
    ctx.body = { error: 'Access denied' }
    return
  }
  ctx.body = { requests: listPendingGroupAgentPairingRequests(roomId).map(publicPairingRequest) }
}

export async function decidePairing(ctx: Context): Promise<void> {
  const server = serverOrUnavailable(ctx)
  if (!server) return
  const roomId = String(ctx.params.roomId || '').trim()
  const requestId = String(ctx.params.requestId || '').trim()
  const storage = server.getStorage()
  const request = getGroupAgentPairingRequest(requestId)
  if (!request || request.roomId !== roomId) {
    ctx.status = 404
    ctx.body = { error: 'Pairing request not found' }
    return
  }
  if (!canManageGroupChatRoom(storage, roomId, ctx.state.user)) {
    ctx.status = 403
    ctx.body = { error: 'Access denied' }
    return
  }
  const approved = (ctx.request.body as any)?.approved === true
  if (approved) {
    try {
      storage.assertParticipantNameAvailable(roomId, request.agent.name)
    } catch (error) {
      const rejected = decideGroupAgentPairingRequest(requestId, false, Number(ctx.state.user?.id || 0))
      if (rejected) server.broadcastAgentPairingUpdated(roomId, publicPairingRequest(rejected))
      ctx.status = 409
      ctx.body = { code: (error as any)?.code, error: error instanceof Error ? error.message : 'Agent name is unavailable' }
      return
    }
  }
  const decided = decideGroupAgentPairingRequest(requestId, approved, Number(ctx.state.user?.id || 0))
  if (!decided) {
    ctx.status = 409
    ctx.body = { error: 'Pairing request is no longer pending' }
    return
  }
  server.broadcastAgentPairingUpdated(roomId, publicPairingRequest(decided))
  ctx.body = { request: publicPairingRequest(decided) }
}

export async function updateGuestAgentPolicy(ctx: Context): Promise<void> {
  const server = serverOrUnavailable(ctx)
  if (!server) return
  const roomId = String(ctx.params.roomId || '').trim()
  const storage = server.getStorage()
  if (!storage.getRoom(roomId)) {
    ctx.status = 404
    ctx.body = { error: 'Room not found' }
    return
  }
  if (!canManageGroupChatRoom(storage, roomId, ctx.state.user)) {
    ctx.status = 403
    ctx.body = { error: 'Access denied' }
    return
  }
  const body = (ctx.request.body || {}) as Record<string, unknown>
  const maxAgents = Number(body.maxGuestAgentsPerMember ?? 1)
  if (!Number.isSafeInteger(maxAgents) || maxAgents < 1 || maxAgents > 5) {
    ctx.status = 400
    ctx.body = { error: 'maxGuestAgentsPerMember must be between 1 and 5' }
    return
  }
  const room = storage.updateRoomGuestAgentPolicy(roomId, {
    allowGuestAgents: body.allowGuestAgents === true,
    maxGuestAgentsPerMember: maxAgents,
    allowRemoteWorkspaceAccess: body.allowRemoteWorkspaceAccess === true,
  })
  if (!room) {
    ctx.status = 404
    ctx.body = { error: 'Room not found' }
    return
  }
  server.broadcastGuestAgentPolicy(roomId, room)
  ctx.body = {
    policy: {
      allowGuestAgents: Number(room.allowGuestAgents || 0),
      guestAgentApproval: 'owner',
      maxGuestAgentsPerMember: Math.max(1, Number(room.maxGuestAgentsPerMember || 1)),
      allowRemoteWorkspaceAccess: Number(room.allowRemoteWorkspaceAccess || 0),
    },
  }
}

export async function revokeConnector(ctx: Context): Promise<void> {
  const server = serverOrUnavailable(ctx)
  if (!server) return
  const roomId = String(ctx.params.roomId || '').trim()
  const connectorId = String(ctx.params.connectorId || '').trim()
  const storage = server.getStorage()
  const connector = getGroupAgentConnector(connectorId)
  if (!connector || connector.roomId !== roomId) {
    ctx.status = 404
    ctx.body = { error: 'Agent connector not found' }
    return
  }
  if (!canManageGroupChatRoom(storage, roomId, ctx.state.user)) {
    ctx.status = 403
    ctx.body = { error: 'Access denied' }
    return
  }
  revokeGroupAgentConnector(connectorId)
  await server.agentClients.removeAgentFromRoom(roomId, connector.agentId)
  storage.removeRoomAgent(roomId, connector.roomAgentId)
  const agents = server.broadcastRoomAgents(roomId)
  ctx.body = { ok: true, agents }
}
