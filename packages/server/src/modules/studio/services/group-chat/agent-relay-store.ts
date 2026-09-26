import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { getDb } from '../../infrastructure/database'

export const GROUP_AGENT_PAIRING_REQUEST_TTL_MS = 10 * 60_000
export const GROUP_AGENT_PAIRING_TICKET_TTL_MS = 2 * 60_000

export type RemoteGroupAgentDescriptor = {
  agent: 'hermes' | 'ekko' | 'codex' | 'claude' | 'pi' | 'grok' | 'opencode' | 'dsh' | 'cursor'
  agentMode: 'scoped' | 'global'
  priorAgentMode?: 'scoped' | 'global' | ''
  profile: string
  provider: string
  model: string
  apiMode: string
  agentPreset?: string
  reasoningEffort: string
  name: string
  description: string
  avatar: string
}

const REMOTE_AGENT_TYPES = new Set<RemoteGroupAgentDescriptor['agent']>(['hermes', 'ekko', 'codex', 'claude', 'pi', 'grok', 'opencode', 'dsh', 'cursor'])
const REMOTE_AGENT_API_MODES = new Set(['', 'chat_completions', 'codex_responses', 'anthropic_messages'])
const REMOTE_AGENT_REASONING_EFFORTS = new Set(['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const REMOTE_GLOBAL_MODE_AGENTS = new Set<RemoteGroupAgentDescriptor['agent']>(['codex', 'claude', 'pi', 'grok', 'opencode', 'dsh', 'cursor'])
const PAIRING_AUDIT_RETENTION_MS = 7 * 24 * 60 * 60_000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function boundedText(value: unknown, maxLength: number, field: string, required = false): string {
  const text = String(value || '').trim()
  if ((required && !text) || text.length > maxLength) throw new Error(`Invalid remote Agent ${field}`)
  return text
}

export function normalizeRemoteGroupAgentDescriptor(
  value: unknown,
  source?: 'connection request' | 'relay confirmation',
): RemoteGroupAgentDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid remote Agent${source ? ` in ${source}` : ''}`)
  }
  const input = value as Record<string, unknown>
  const agent = String(input.agent || 'hermes').trim() as RemoteGroupAgentDescriptor['agent']
  if (!REMOTE_AGENT_TYPES.has(agent)) throw new Error('Invalid remote Agent type')
  const agentMode = agent === 'cursor' ? 'global' : input.agentMode === 'global' ? 'global' : 'scoped'
  if (agentMode === 'global' && !REMOTE_GLOBAL_MODE_AGENTS.has(agent)) {
    throw new Error('Remote Agent global mode is only available for Claude, Codex, Pi, Grok, and OpenCode')
  }
  const profile = boundedText(input.profile, 120, 'profile', true)
  const name = boundedText(input.name || profile, 120, 'name', true)
  const apiMode = agent === 'hermes' || agentMode === 'global' ? '' : boundedText(input.apiMode, 64, 'API mode')
  const reasoningEffort = agentMode === 'global' ? '' : boundedText(input.reasoningEffort, 32, 'reasoning effort')
  if (!REMOTE_AGENT_API_MODES.has(apiMode)) throw new Error('Invalid remote Agent API mode')
  if (!REMOTE_AGENT_REASONING_EFFORTS.has(reasoningEffort)) throw new Error('Invalid remote Agent reasoning effort')
  const avatar = boundedText(input.avatar, 1_500_000, 'avatar')
  if (avatar) {
    let parsed: any
    try {
      parsed = JSON.parse(avatar)
    } catch {
      throw new Error('Invalid remote Agent avatar')
    }
    const generated = parsed?.type === 'generated' && typeof parsed.seed === 'string' && parsed.seed.trim().length <= 200
    const image = parsed?.type === 'image'
      && typeof parsed.dataUrl === 'string'
      && /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(parsed.dataUrl)
      && parsed.dataUrl.length <= 1_500_000
    if (!generated && !image) throw new Error('Invalid remote Agent avatar')
  }
  const priorAgentMode = input.priorAgentMode === 'global' || input.priorAgentMode === 'scoped' ? input.priorAgentMode : undefined
  return {
    agent,
    agentMode,
    ...(priorAgentMode ? { priorAgentMode } : {}),
    profile,
    provider: agentMode === 'global' ? '' : boundedText(input.provider, 240, 'provider'),
    model: agentMode === 'global' ? '' : boundedText(input.model, 500, 'model'),
    apiMode,
    reasoningEffort,
    agentPreset: boundedText(input.agentPreset, 200, 'agentPreset') || undefined,
    name,
    description: boundedText(input.description, 2_000, 'description'),
    avatar,
  }
}

export function normalizeGroupAgentTargetOrigin(value: unknown): string {
  const url = new URL(String(value || '').trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Target URL must use HTTP or HTTPS')
  if (url.username || url.password || url.search || url.hash) throw new Error('Target URL must not contain credentials, query, or fragment')
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('Target URL must be an origin without a path')
  return url.origin
}

export type GroupAgentPairingRequest = {
  id: string
  roomId: string
  ownerMemberId: string
  ownerName: string
  targetOrigin: string
  agent: RemoteGroupAgentDescriptor
  status: 'draft' | 'pending' | 'approved' | 'connecting' | 'consumed' | 'rejected' | 'expired' | 'failed'
  createdAt: number
  expiresAt: number
  approvedAt: number | null
  ticketExpiresAt: number | null
  consumedAt: number | null
  failureReason: string
}

export type GroupAgentConnector = {
  id: string
  roomId: string
  roomAgentId: string
  agentId: string
  ownerMemberId: string
  targetOrigin: string
  status: 'online' | 'offline' | 'revoked'
  createdAt: number
  lastSeenAt: number
  revokedAt: number | null
}

type GroupAgentConnectorRevocationListener = (connector: GroupAgentConnector) => void

const connectorRevocationListeners = new Set<GroupAgentConnectorRevocationListener>()

export function subscribeGroupAgentConnectorRevocations(
  listener: GroupAgentConnectorRevocationListener,
): () => void {
  connectorRevocationListeners.add(listener)
  return () => connectorRevocationListeners.delete(listener)
}

type PairingRow = Omit<GroupAgentPairingRequest, 'agent'> & {
  agentJson: string
  requesterSecretHash: string
  pairingTicketHash: string
}

const DRAFT_AGENT: RemoteGroupAgentDescriptor = {
  agent: 'hermes',
  agentMode: 'scoped',
  profile: '',
  provider: '',
  model: '',
  apiMode: '',
  reasoningEffort: '',
  name: '',
  description: '',
  avatar: '',
}

function secret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function equalDigest(expected: string, value: string): boolean {
  try {
    const left = Buffer.from(expected, 'hex')
    const right = Buffer.from(digest(value), 'hex')
    return left.length === right.length && timingSafeEqual(left, right)
  } catch {
    return false
  }
}

function parseAgent(value: string): RemoteGroupAgentDescriptor {
  return JSON.parse(value) as RemoteGroupAgentDescriptor
}

function pairingRequest(row: PairingRow): GroupAgentPairingRequest {
  return {
    id: row.id,
    roomId: row.roomId,
    ownerMemberId: row.ownerMemberId,
    ownerName: row.ownerName,
    targetOrigin: row.targetOrigin,
    agent: parseAgent(row.agentJson),
    status: row.status,
    createdAt: Number(row.createdAt),
    expiresAt: Number(row.expiresAt),
    approvedAt: row.approvedAt == null ? null : Number(row.approvedAt),
    ticketExpiresAt: row.ticketExpiresAt == null ? null : Number(row.ticketExpiresAt),
    consumedAt: row.consumedAt == null ? null : Number(row.consumedAt),
    failureReason: String(row.failureReason || ''),
  }
}

function pairingRowById(id: string): PairingRow | null {
  return (getDb()?.prepare(
    `SELECT id, roomId, ownerMemberId, ownerName, requesterSecretHash, pairingTicketHash,
            targetOrigin, agentJson, status, createdAt, expiresAt, approvedAt,
            ticketExpiresAt, consumedAt, failureReason
     FROM gc_agent_pairing_requests WHERE id = ?`,
  ).get(id) as PairingRow | undefined) || null
}

function pairingRowByTicket(ticket: string): PairingRow | null {
  return (getDb()?.prepare(
    `SELECT id, roomId, ownerMemberId, ownerName, requesterSecretHash, pairingTicketHash,
            targetOrigin, agentJson, status, createdAt, expiresAt, approvedAt,
            ticketExpiresAt, consumedAt, failureReason
     FROM gc_agent_pairing_requests WHERE pairingTicketHash = ?`,
  ).get(digest(ticket)) as PairingRow | undefined) || null
}

function expirePairingRequests(now: number, roomId?: string): void {
  const roomFilter = roomId ? ' AND roomId = ?' : ''
  const params = roomId ? [now, now, roomId] : [now, now]
  getDb()?.prepare(
    `UPDATE gc_agent_pairing_requests
     SET status = 'expired'
     WHERE (
       (status IN ('draft', 'pending') AND expiresAt <= ?)
       OR (status IN ('approved', 'connecting') AND ticketExpiresAt IS NOT NULL AND ticketExpiresAt <= ?)
     )${roomFilter}`,
  ).run(...params)
}

export function createGroupAgentPairingRequest(input: {
  roomId: string
  ownerMemberId: string
  ownerName: string
  targetOrigin: string
  agent: RemoteGroupAgentDescriptor
  now?: number
}): {
  request: GroupAgentPairingRequest
  requestSecret: string
  pairingTicket: string
} {
  const now = input.now ?? Date.now()
  const requestId = randomUUID()
  const requestSecret = secret()
  const pairingTicket = secret()
  expirePairingRequests(now, input.roomId)
  getDb()?.prepare(
    `DELETE FROM gc_agent_pairing_requests
     WHERE createdAt < ? AND status IN ('consumed', 'rejected', 'expired')`,
  ).run(now - PAIRING_AUDIT_RETENTION_MS)
  getDb()?.prepare(
    `INSERT INTO gc_agent_pairing_requests (
       id, roomId, ownerMemberId, ownerName, requesterSecretHash, pairingTicketHash,
       targetOrigin, agentJson, status, createdAt, expiresAt
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    requestId,
    input.roomId,
    input.ownerMemberId,
    input.ownerName,
    digest(requestSecret),
    digest(pairingTicket),
    input.targetOrigin,
    JSON.stringify(input.agent),
    now,
    now + GROUP_AGENT_PAIRING_REQUEST_TTL_MS,
  )
  return {
    request: pairingRequest(pairingRowById(requestId)!),
    requestSecret,
    pairingTicket,
  }
}

function validClientSecret(value: string): boolean {
  return /^[A-Za-z0-9_-]{32,200}$/.test(value)
}

export function createGroupAgentPairingHandoff(input: {
  requestId: string
  requestSecret: string
  pairingTicket: string
  roomId: string
  ownerMemberId: string
  ownerName: string
  targetOrigin: string
  now?: number
}): GroupAgentPairingRequest {
  const now = input.now ?? Date.now()
  if (!UUID_PATTERN.test(input.requestId)) throw new Error('Invalid handoff request id')
  if (!validClientSecret(input.requestSecret) || !validClientSecret(input.pairingTicket)) {
    throw new Error('Invalid handoff secret')
  }
  expirePairingRequests(now, input.roomId)
  getDb()?.prepare(
    `DELETE FROM gc_agent_pairing_requests
     WHERE createdAt < ? AND status IN ('consumed', 'rejected', 'expired', 'failed')`,
  ).run(now - PAIRING_AUDIT_RETENTION_MS)
  getDb()?.prepare(
    `INSERT INTO gc_agent_pairing_requests (
       id, roomId, ownerMemberId, ownerName, requesterSecretHash, pairingTicketHash,
       targetOrigin, agentJson, status, createdAt, expiresAt
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
  ).run(
    input.requestId,
    input.roomId,
    input.ownerMemberId,
    input.ownerName,
    digest(input.requestSecret),
    digest(input.pairingTicket),
    input.targetOrigin,
    JSON.stringify(DRAFT_AGENT),
    now,
    now + GROUP_AGENT_PAIRING_REQUEST_TTL_MS,
  )
  return pairingRequest(pairingRowById(input.requestId)!)
}

export function submitGroupAgentPairingHandoff(
  requestId: string,
  requestSecret: string,
  agent: RemoteGroupAgentDescriptor,
  now = Date.now(),
): GroupAgentPairingRequest | null {
  expirePairingRequests(now)
  const row = pairingRowById(requestId)
  if (!row || !equalDigest(row.requesterSecretHash, requestSecret) || row.expiresAt <= now) return null
  const agentJson = JSON.stringify(agent)
  if (row.status === 'pending') {
    return row.agentJson === agentJson ? pairingRequest(row) : null
  }
  if (row.status !== 'draft') return null
  const updated = getDb()?.prepare(
    `UPDATE gc_agent_pairing_requests
     SET agentJson = ?, status = 'pending'
     WHERE id = ? AND status = 'draft' AND expiresAt > ?`,
  ).run(agentJson, requestId, now)
  return updated?.changes ? pairingRequest(pairingRowById(requestId)!) : null
}

export function failGroupAgentPairingRequestForRequester(
  requestId: string,
  requestSecret: string,
  reason: string,
): GroupAgentPairingRequest | null {
  const row = pairingRowById(requestId)
  if (!row || !equalDigest(row.requesterSecretHash, requestSecret)) return null
  const failureReason = String(reason || 'Agent connection failed').replace(/\s+/g, ' ').trim().slice(0, 240)
  const updated = getDb()?.prepare(
    `UPDATE gc_agent_pairing_requests
     SET status = 'failed', failureReason = ?
     WHERE id = ? AND status IN ('draft', 'pending', 'approved', 'connecting')`,
  ).run(failureReason, requestId)
  return updated?.changes ? pairingRequest(pairingRowById(requestId)!) : pairingRequest(row)
}

export function getGroupAgentPairingRequestForRequester(
  requestId: string,
  requestSecret: string,
  now = Date.now(),
): GroupAgentPairingRequest | null {
  expirePairingRequests(now)
  const row = pairingRowById(requestId)
  if (!row || !equalDigest(row.requesterSecretHash, requestSecret)) return null
  return pairingRequest(pairingRowById(requestId) || row)
}

export function listPendingGroupAgentPairingRequests(roomId: string, now = Date.now()): GroupAgentPairingRequest[] {
  expirePairingRequests(now, roomId)
  const rows = (getDb()?.prepare(
    `SELECT id, roomId, ownerMemberId, ownerName, requesterSecretHash, pairingTicketHash,
            targetOrigin, agentJson, status, createdAt, expiresAt, approvedAt,
            ticketExpiresAt, consumedAt, failureReason
     FROM gc_agent_pairing_requests
     WHERE roomId = ? AND status = 'pending'
     ORDER BY createdAt ASC`,
  ).all(roomId) || []) as PairingRow[]
  return rows.map(pairingRequest)
}

export function getGroupAgentPairingRequest(requestId: string): GroupAgentPairingRequest | null {
  const row = pairingRowById(requestId)
  return row ? pairingRequest(row) : null
}

export function decideGroupAgentPairingRequest(
  requestId: string,
  approved: boolean,
  authUserId: number,
  now = Date.now(),
): GroupAgentPairingRequest | null {
  const result = approved
    ? getDb()?.prepare(
      `UPDATE gc_agent_pairing_requests
       SET status = 'approved', approvedAt = ?, ticketExpiresAt = ?, decidedByAuthUserId = ?
       WHERE id = ? AND status = 'pending' AND expiresAt > ?`,
    ).run(now, now + GROUP_AGENT_PAIRING_TICKET_TTL_MS, authUserId, requestId, now)
    : getDb()?.prepare(
      `UPDATE gc_agent_pairing_requests
       SET status = 'rejected', decidedByAuthUserId = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(authUserId, requestId)
  if (!result?.changes) return null
  return pairingRequest(pairingRowById(requestId)!)
}

export function claimGroupAgentPairingTicket(ticket: string, now = Date.now()): GroupAgentPairingRequest | null {
  expirePairingRequests(now)
  const row = pairingRowByTicket(ticket)
  if (!row || row.status !== 'approved' || !row.ticketExpiresAt || row.ticketExpiresAt <= now) return null
  const result = getDb()?.prepare(
    `UPDATE gc_agent_pairing_requests
     SET status = 'connecting'
     WHERE id = ? AND status = 'approved' AND ticketExpiresAt > ?`,
  ).run(row.id, now)
  if (!result?.changes) return null
  row.status = 'connecting'
  return pairingRequest(row)
}

export function releaseGroupAgentPairingClaim(requestId: string, now = Date.now()): void {
  getDb()?.prepare(
    `UPDATE gc_agent_pairing_requests
     SET status = CASE WHEN ticketExpiresAt > ? THEN 'approved' ELSE 'expired' END
     WHERE id = ? AND status = 'connecting'`,
  ).run(now, requestId)
}

export function completeGroupAgentPairing(input: {
  requestId: string
  roomAgentId: string
  agentId: string
  now?: number
}): { connector: GroupAgentConnector; credential: string } | null {
  const db = getDb()
  if (!db) return null
  const row = pairingRowById(input.requestId)
  if (!row || row.status !== 'connecting') return null
  const now = input.now ?? Date.now()
  const connectorId = randomUUID()
  const credential = secret()
  db.exec('BEGIN IMMEDIATE')
  try {
    const roomPolicy = db.prepare(
      `SELECT allowGuestAgents, maxGuestAgentsPerMember FROM gc_rooms WHERE id = ?`,
    ).get(row.roomId) as { allowGuestAgents?: number; maxGuestAgentsPerMember?: number } | undefined
    if (!roomPolicy?.allowGuestAgents) throw new Error('Guest Agent connections are disabled for this room')
    const activeLinks = db.prepare(
      `SELECT COUNT(*) AS count FROM gc_agent_connectors
       WHERE roomId = ? AND ownerMemberId = ? AND status != 'revoked'`,
    ).get(row.roomId, row.ownerMemberId) as { count?: number } | undefined
    if (Number(activeLinks?.count || 0) >= Math.max(1, Number(roomPolicy.maxGuestAgentsPerMember || 1))) {
      throw new Error('Guest Agent limit reached for this member')
    }
    db.prepare(
      `INSERT INTO gc_agent_connectors (
         id, roomId, roomAgentId, agentId, ownerMemberId, targetOrigin,
         credentialHash, status, createdAt, lastSeenAt
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'online', ?, ?)`,
    ).run(
      connectorId,
      row.roomId,
      input.roomAgentId,
      input.agentId,
      row.ownerMemberId,
      row.targetOrigin,
      digest(credential),
      now,
      now,
    )
    const updated = db.prepare(
      `UPDATE gc_agent_pairing_requests
       SET status = 'consumed', consumedAt = ?
       WHERE id = ? AND status = 'connecting'`,
    ).run(now, row.id)
    if (!updated.changes) throw new Error('Pairing ticket was already consumed')
    db.exec('COMMIT')
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
  return {
    connector: getGroupAgentConnector(connectorId)!,
    credential,
  }
}

export function getGroupAgentConnector(connectorId: string): GroupAgentConnector | null {
  return (getDb()?.prepare(
    `SELECT id, roomId, roomAgentId, agentId, ownerMemberId, targetOrigin,
            status, createdAt, lastSeenAt, revokedAt
     FROM gc_agent_connectors WHERE id = ?`,
  ).get(connectorId) as GroupAgentConnector | undefined) || null
}

export function authenticateGroupAgentConnector(
  connectorId: string,
  credential: string,
): GroupAgentConnector | null {
  const row = getDb()?.prepare(
    `SELECT id, roomId, roomAgentId, agentId, ownerMemberId, targetOrigin,
            credentialHash, status, createdAt, lastSeenAt, revokedAt
     FROM gc_agent_connectors WHERE id = ?`,
  ).get(connectorId) as (GroupAgentConnector & { credentialHash: string }) | undefined
  if (!row || row.status === 'revoked' || !equalDigest(row.credentialHash, credential)) return null
  const { credentialHash: _credentialHash, ...connector } = row
  return connector
}

export function touchGroupAgentConnector(connectorId: string, status: 'online' | 'offline', now = Date.now()): void {
  getDb()?.prepare(
    `UPDATE gc_agent_connectors SET status = ?, lastSeenAt = ?
     WHERE id = ? AND status != 'revoked'`,
  ).run(status, now, connectorId)
}

export function revokeGroupAgentConnector(
  connectorId: string,
  now = Date.now(),
  options: { notify?: boolean } = {},
): GroupAgentConnector | null {
  const db = getDb()
  if (!db) return null
  const connector = getGroupAgentConnector(connectorId)
  if (!connector) return null
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `UPDATE gc_agent_connectors SET status = 'revoked', revokedAt = ?, lastSeenAt = ?
       WHERE id = ? AND status != 'revoked'`,
    ).run(now, now, connectorId)
    db.prepare(
      `UPDATE gc_room_agents
       SET removedAt = CASE WHEN removedAt = 0 THEN ? ELSE removedAt END
       WHERE roomId = ? AND id = ? AND executorType = 'remote'`,
    ).run(now, connector.roomId, connector.roomAgentId)
    db.exec('COMMIT')
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
  const revoked = getGroupAgentConnector(connectorId)
  if (revoked && options.notify !== false) {
    for (const listener of connectorRevocationListeners) {
      try { listener(revoked) } catch { /* A notification failure must not roll back revocation. */ }
    }
  }
  return revoked
}

export function countActiveGuestAgentLinks(roomId: string, ownerMemberId: string): number {
  const row = getDb()?.prepare(
    `SELECT COUNT(*) AS count
     FROM gc_agent_connectors
     WHERE roomId = ? AND ownerMemberId = ? AND status != 'revoked'`,
  ).get(roomId, ownerMemberId) as { count?: number } | undefined
  return Number(row?.count || 0)
}

export function countRecentGuestAgentPairingRequests(
  roomId: string,
  ownerMemberId: string,
  since = Date.now() - 60_000,
): number {
  const row = getDb()?.prepare(
    `SELECT COUNT(*) AS count
     FROM gc_agent_pairing_requests
     WHERE roomId = ? AND ownerMemberId = ? AND createdAt >= ?`,
  ).get(roomId, ownerMemberId, since) as { count?: number } | undefined
  return Number(row?.count || 0)
}
