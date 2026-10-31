import { isPrivatePersonSession } from '../../contracts/person-session'
import { studioInstanceId } from '../../public/session-notifications'
import { acceptFencedSessionNotification, type FencedAcceptance } from '../../repositories/session-notification-store'
import { getSession } from '../../repositories/session-store'
import { findUserById, userCanAccessProfile } from '../../repositories/users-store'

export const EXTERNAL_NOTICE_LIMITS = { source: 64, eventId: 128, generation: 128, title: 200, contentBytes: 32 * 1024, url: 2048 }

const FIELDS = new Set(['profile', 'expected_session_generation', 'source', 'event_id', 'title', 'content', 'url'])
/** Identifiers and links are visible ASCII without whitespace. */
const VISIBLE_ASCII = /^[\x21-\x7e]+$/
const CONTROL = /[\u0000-\u001f\u007f]/

export interface ExternalNotice {
  profile: string
  expectedGeneration: string
  source: string
  eventId: string
  title: string
  content: string
  url: string | null
}

function webLink(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > EXTERNAL_NOTICE_LIMITS.url || !VISIBLE_ASCII.test(value)) return undefined
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? value : undefined
  } catch {
    return undefined
  }
}

/** The validated notice, or the first invalid field. Accepted values are stored exactly as sent. */
export function parseExternalNotice(body: unknown): ExternalNotice | { invalid: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { invalid: 'body' }
  const input = body as Record<string, unknown>
  const unknown = Object.keys(input).find(key => !FIELDS.has(key))
  if (unknown) return { invalid: unknown }
  const identifier = (key: string, max: number) => {
    const value = input[key]
    return typeof value === 'string' && value.length <= max && VISIBLE_ASCII.test(value) ? value : null
  }
  const profile = identifier('profile', 128)
  if (!profile) return { invalid: 'profile' }
  const expectedGeneration = identifier('expected_session_generation', EXTERNAL_NOTICE_LIMITS.generation)
  if (!expectedGeneration) return { invalid: 'expected_session_generation' }
  const source = identifier('source', EXTERNAL_NOTICE_LIMITS.source)
  if (!source) return { invalid: 'source' }
  const eventId = identifier('event_id', EXTERNAL_NOTICE_LIMITS.eventId)
  if (!eventId) return { invalid: 'event_id' }
  const { title, content } = input
  if (typeof title !== 'string' || !title.trim() || [...title].length > EXTERNAL_NOTICE_LIMITS.title || CONTROL.test(title)) {
    return { invalid: 'title' }
  }
  if (typeof content !== 'string' || !content.trim() || content.includes('\u0000')
    || Buffer.byteLength(content, 'utf8') > EXTERNAL_NOTICE_LIMITS.contentBytes) {
    return { invalid: 'content' }
  }
  const url = webLink(input.url)
  if (url === undefined) return { invalid: 'url' }
  return { profile, expectedGeneration, source, eventId, title, content, url }
}

/**
 * V1 targets ordinary, locally stored Hermes bridge chats: the runtime whose next intentional
 * question receives the notice projection. Other runtimes and special surfaces are refused.
 */
export function isExternalNoticeTarget(session: { id: string; source?: string | null; agent?: string | null; agent_session_id?: string | null }): boolean {
  return !isPrivatePersonSession(session.id)
    && ['', 'cli', 'api_server'].includes(session.source || '')
    && ['', 'hermes'].includes(session.agent || '')
    && !session.agent_session_id
}

export type ExternalNoticeResult = FencedAcceptance | { status: 'forbidden' | 'not_found' | 'unsupported' }

/**
 * Final account, target and generation checks and the commit run synchronously, so no reset,
 * deletion or account change can interleave between them.
 */
export function acceptExternalNotice(userId: number, sessionId: string, notice: ExternalNotice): ExternalNoticeResult {
  const user = findUserById(userId)
  if (!user || user.status !== 'active' || (user.role !== 'super_admin' && !userCanAccessProfile(user.id, notice.profile))) {
    return { status: 'forbidden' }
  }
  const session = getSession(sessionId)
  if (!session || (session.profile || 'default') !== notice.profile) return { status: 'not_found' }
  if (!isExternalNoticeTarget(session)) return { status: 'unsupported' }
  return acceptFencedSessionNotification({
    namespace: studioInstanceId(),
    profile: notice.profile,
    // Unambiguous identity: account, target generation, producer and its event.
    producerKey: `external:${JSON.stringify([user.id, sessionId, notice.expectedGeneration, notice.source, notice.eventId])}`,
    sessionId,
    expectedGeneration: notice.expectedGeneration,
    kind: 'external',
    payload: { source: notice.source, event_id: notice.eventId, title: notice.title, content: notice.content, url: notice.url },
  })
}
