import { getSessionMessageTimestampAtOffset } from '../../repositories/session-store'
import { listVisibleSessionNotifications, type SessionNotificationRecord } from '../../repositories/session-notification-store'

/**
 * Report of one invocation of an enrolled script wrapper. The invocation id is the wrapper's own
 * identity; there is no native execution id and no claim that the invocation was scheduled.
 */
export interface StudioNoticeView {
  kind: 'script_report'
  notification_id: number
  disposition: string
  identity_kind: 'wrapper_invocation'
  job_id: string
  job_name: string
  invocation_id: string
  outcome: string
  exit_code: number | null
  signal: number | null
  reason: string | null
  truncated: boolean
}

export interface StudioNoticeMessage {
  id: string
  session_id: string
  role: 'system'
  display_role: 'system'
  content: string
  timestamp: number
  studio_notice: StudioNoticeView
}

/** Timeline view of a passive notice. It is never a `messages` row, so it never enters model history. */
export function noticeToMessage(record: SessionNotificationRecord): StudioNoticeMessage {
  const payload = record.payload
  const text = (value: unknown) => typeof value === 'string' ? value : ''
  const number = (value: unknown) => typeof value === 'number' ? value : null
  return {
    id: `studio-notice-${record.id}`,
    session_id: record.session_id,
    role: 'system',
    display_role: 'system',
    content: text(payload.content),
    timestamp: Math.floor(record.created_at / 1000),
    studio_notice: {
      kind: 'script_report',
      notification_id: record.id,
      disposition: record.disposition,
      identity_kind: 'wrapper_invocation',
      job_id: text(payload.job_id),
      job_name: text(payload.job_name) || text(payload.job_id),
      invocation_id: text(payload.invocation_id),
      outcome: text(payload.outcome),
      exit_code: number(payload.exit_code),
      signal: number(payload.signal),
      reason: typeof payload.reason === 'string' ? payload.reason : null,
      truncated: payload.truncated === true,
    },
  }
}

/**
 * Merge passive notices into one page of stored messages. Pages are database pages (`id DESC`,
 * `offset`, `storedCount` rows); a notice belongs to the page whose interval
 * (timestamp of the next older stored row, timestamp of the page's newest stored row] contains it,
 * the newest page has no upper bound and the oldest page no lower bound. Adjacent pages therefore
 * share boundaries exactly (equal timestamps go to the older side) and stored-row offsets are
 * unaffected: callers must count only stored rows.
 */
export function withSessionNotices<T extends { timestamp?: unknown }>(
  sessionId: string,
  messages: T[],
  page: { offset: number; storedCount: number },
): Array<T | StudioNoticeMessage> {
  let notices: SessionNotificationRecord[]
  try {
    notices = listVisibleSessionNotifications(sessionId)
  } catch {
    return messages
  }
  if (!notices.length) return messages
  const upper = page.offset > 0
    ? getSessionMessageTimestampAtOffset(sessionId, page.offset) ?? Number.POSITIVE_INFINITY
    : Number.POSITIVE_INFINITY
  const lower = getSessionMessageTimestampAtOffset(sessionId, page.offset + page.storedCount) ?? Number.NEGATIVE_INFINITY
  const selected = notices.map(noticeToMessage).filter(notice => notice.timestamp > lower && notice.timestamp <= upper)
  if (!selected.length) return messages
  // Stable: a notice sorts after stored rows with the same timestamp.
  return [...messages, ...selected].sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
}
