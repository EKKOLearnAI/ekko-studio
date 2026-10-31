import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { studioInstanceId } from '../../public/session-notifications'
import { getSession, getSessionGeneration } from '../../repositories/session-store'
import {
  sessionNoticePublishersStore,
  type PublicSessionNoticePublisher,
  type SessionNoticePublisherRecord,
} from '../../repositories/session-notice-publishers-store'
import { findUserById, userCanAccessProfile } from '../../repositories/users-store'
import { isExternalNoticeTarget, type ExternalNotice } from './external'

export type { SessionNoticePublisherRecord }

/** Publisher secrets are recognizable by prefix so the auth middleware can confine them to one route. */
export const NOTICE_PUBLISHER_PREFIX = 'esnp_'
export const NOTICE_PUBLISHER_DEFAULT_DAYS = 90
export const NOTICE_PUBLISHER_MAX_DAYS = 180
const MAX_SOURCES = 8
const DAY_MS = 24 * 60 * 60_000
const SOURCE = /^[\x21-\x7e]{1,64}$/

export function hashNoticePublisherToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function isNoticePublisherToken(token: string): boolean {
  return token.startsWith(NOTICE_PUBLISHER_PREFIX)
}

function toPublic(record: SessionNoticePublisherRecord): PublicSessionNoticePublisher {
  const { token_hash: _hash, owner_user_id: _owner, ...rest } = record
  return rest
}

function ownerMayUse(userId: number, profile: string): boolean {
  const user = findUserById(userId)
  return Boolean(user && user.status === 'active' && (user.role === 'super_admin' || userCanAccessProfile(user.id, profile)))
}

export type IssueRequest = { profile: string; expectedGeneration: string; sources: string[]; expiresInDays: number; label: string }

/** The validated issue request, or the first invalid field. */
export function parseIssueRequest(body: unknown): IssueRequest | { invalid: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { invalid: 'body' }
  const input = body as Record<string, unknown>
  const unknown = Object.keys(input).find(key => !['profile', 'expected_session_generation', 'sources', 'expires_in_days', 'label'].includes(key))
  if (unknown) return { invalid: unknown }
  const profile = typeof input.profile === 'string' && /^[\x21-\x7e]{1,128}$/.test(input.profile) ? input.profile : null
  if (!profile) return { invalid: 'profile' }
  const expectedGeneration = typeof input.expected_session_generation === 'string'
    && /^[\x21-\x7e]{1,128}$/.test(input.expected_session_generation) ? input.expected_session_generation : null
  if (!expectedGeneration) return { invalid: 'expected_session_generation' }
  const sources = input.sources
  if (!Array.isArray(sources) || !sources.length || sources.length > MAX_SOURCES
    || sources.some(source => typeof source !== 'string' || !SOURCE.test(source)) || new Set(sources).size !== sources.length) {
    return { invalid: 'sources' }
  }
  const days = input.expires_in_days === undefined ? NOTICE_PUBLISHER_DEFAULT_DAYS : input.expires_in_days
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > NOTICE_PUBLISHER_MAX_DAYS) return { invalid: 'expires_in_days' }
  const label = input.label === undefined ? '' : input.label
  if (typeof label !== 'string' || [...label].length > 120 || /[\u0000-\u001f\u007f]/.test(label)) return { invalid: 'label' }
  return { profile, expectedGeneration, sources: [...sources as string[]], expiresInDays: days, label }
}

export type IssueResult =
  | { status: 'issued'; token: string; publisher: PublicSessionNoticePublisher }
  | { status: 'forbidden' | 'owner_required' | 'not_found' | 'unsupported' | 'generation_mismatch' }

/** Only the session's owning account may issue for it; a legacy session without an owner needs a super admin. */
function ownsSession(userId: number, session: { studio_user_id?: string | number | null }): boolean {
  const owner = session.studio_user_id
  if (owner === null || owner === undefined || owner === '') return findUserById(userId)?.role === 'super_admin'
  return String(owner) === String(userId)
}

/** Issue a grant for one session at its current generation. The secret is returned once and never stored. */
export function issueNoticePublisher(ownerUserId: number, sessionId: string, request: IssueRequest, now = Date.now()): IssueResult {
  if (!ownerMayUse(ownerUserId, request.profile)) return { status: 'forbidden' }
  const session = getSession(sessionId)
  if (!session || (session.profile || 'default') !== request.profile) return { status: 'not_found' }
  if (!ownsSession(ownerUserId, session)) return { status: 'owner_required' }
  if (!isExternalNoticeTarget(session)) return { status: 'unsupported' }
  if (getSessionGeneration(sessionId) !== request.expectedGeneration) return { status: 'generation_mismatch' }
  const token = `${NOTICE_PUBLISHER_PREFIX}${randomBytes(32).toString('base64url')}`
  const record: SessionNoticePublisherRecord = {
    id: `pub_${randomUUID()}`,
    token_hash: hashNoticePublisherToken(token),
    owner_user_id: ownerUserId,
    namespace: studioInstanceId(),
    profile: request.profile,
    session_id: sessionId,
    session_generation: request.expectedGeneration,
    sources: request.sources,
    label: request.label,
    created_at: now,
    expires_at: now + request.expiresInDays * DAY_MS,
    revoked_at: null,
    last_used_at: null,
  }
  sessionNoticePublishersStore.insert(record)
  return { status: 'issued', token, publisher: toPublic(record) }
}

export function listNoticePublishers(ownerUserId: number, sessionId: string): PublicSessionNoticePublisher[] {
  return sessionNoticePublishersStore.listForOwner(ownerUserId, sessionId).map(toPublic)
}

export function revokeNoticePublisher(ownerUserId: number, sessionId: string, id: string, now = Date.now()): boolean {
  return sessionNoticePublishersStore.revoke(ownerUserId, sessionId, id, now)
}

/** A live grant for the token: known hash, not revoked, not expired, same Studio instance, owner still allowed. */
export function authenticateNoticePublisher(token: string, now = Date.now()): SessionNoticePublisherRecord | null {
  if (!isNoticePublisherToken(token)) return null
  const record = sessionNoticePublishersStore.findByHash(hashNoticePublisherToken(token))
  if (!record || record.revoked_at !== null || record.expires_at <= now) return null
  if (record.namespace !== studioInstanceId()) return null
  if (!ownerMayUse(record.owner_user_id, record.profile)) return null
  return record
}

/** Why a notice falls outside the grant's scope, or null when it is inside it. */
export function publisherScopeRefusal(record: SessionNoticePublisherRecord, sessionId: string, notice: ExternalNotice):
  'publisher_scope_mismatch' | 'publisher_source_not_allowed' | null {
  if (record.session_id !== sessionId || record.profile !== notice.profile || record.session_generation !== notice.expectedGeneration) {
    return 'publisher_scope_mismatch'
  }
  if (!record.sources.includes(notice.source)) return 'publisher_source_not_allowed'
  return null
}

export function touchNoticePublisher(id: string, now = Date.now()): void {
  sessionNoticePublishersStore.touch(id, now)
}
