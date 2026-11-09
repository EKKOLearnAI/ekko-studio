import { getSessionMessageBoundaryAtOffset } from '../../repositories/session-store'
import { listVisibleSessionNotifications, type SessionNotificationRecord } from '../../repositories/session-notification-store'

/**
 * Report of one invocation of an enrolled script wrapper. The invocation id is the wrapper's own
 * identity; there is no native execution id and no claim that the invocation was scheduled.
 */
export interface ScriptReportNoticeView {
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

/** Result of one scheduled fire of a bound native cron job, by its native execution id. */
export interface CronNoticeView {
  kind: 'cron'
  notification_id: number
  disposition: string
  job_id: string
  job_name: string
  execution_id: string
  status: string
  success: boolean | null
  reason: string | null
  error: string | null
  truncated: boolean
  finished_at: string | null
}

export type StudioNoticeView = ScriptReportNoticeView | CronNoticeView

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
    studio_notice: record.kind === 'cron' ? {
      kind: 'cron',
      notification_id: record.id,
      disposition: record.disposition,
      job_id: text(payload.job_id),
      job_name: text(payload.job_name) || text(payload.job_id),
      execution_id: text(payload.execution_id),
      status: text(payload.status),
      success: typeof payload.success === 'boolean' ? payload.success : null,
      reason: typeof payload.reason === 'string' ? payload.reason : null,
      error: typeof payload.error === 'string' ? payload.error : null,
      truncated: payload.truncated === true,
      finished_at: typeof payload.finished_at === 'string' ? payload.finished_at : null,
    } : {
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
 * (boundary after the page, boundary at the page] contains it, where a boundary is the latest
 * timestamp at or after that offset; the newest page has no upper bound and the oldest page no
 * lower bound. Boundaries never increase with the offset, so every notice is on exactly one page
 * (equal timestamps go to the older side) even for non-monotonic stored timestamps. Stored rows
 * keep their order and offsets: callers must count only stored rows.
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
    ? getSessionMessageBoundaryAtOffset(sessionId, page.offset) ?? Number.POSITIVE_INFINITY
    : Number.POSITIVE_INFINITY
  const lower = getSessionMessageBoundaryAtOffset(sessionId, page.offset + page.storedCount) ?? Number.NEGATIVE_INFINITY
  const selected = notices.map(noticeToMessage).filter(notice => notice.timestamp > lower && notice.timestamp <= upper)
    .sort((a, b) => a.timestamp - b.timestamp)
  if (!selected.length) return messages
  // Insert each notice before the first stored row that is newer; stored rows are never reordered,
  // and a notice goes after stored rows with the same timestamp.
  const merged: Array<T | StudioNoticeMessage> = []
  let next = 0
  for (const message of messages) {
    while (next < selected.length && selected[next].timestamp < Number(message.timestamp || 0)) merged.push(selected[next++])
    merged.push(message)
  }
  return merged.concat(selected.slice(next))
}
