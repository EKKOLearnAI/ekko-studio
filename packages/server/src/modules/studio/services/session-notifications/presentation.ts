import {
  listUnprojectedSessionNotifications,
  listVisibleSessionNotifications,
  type SessionNotificationRecord,
} from '../../repositories/session-notification-store'

/** Bounds of the once-only context projection on the next intentional user turn. */
export const NOTICE_PROJECTION_MAX_NOTICES = 3
export const NOTICE_PROJECTION_MAX_CHARS_PER_NOTICE = 4000
export const NOTICE_PROJECTION_MAX_TOTAL_CHARS = 8000

export interface StudioNoticeView {
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
  return {
    id: `studio-notice-${record.id}`,
    session_id: record.session_id,
    role: 'system',
    display_role: 'system',
    content: typeof payload.content === 'string' ? payload.content : '',
    timestamp: Math.floor(record.created_at / 1000),
    studio_notice: {
      kind: 'cron',
      notification_id: record.id,
      disposition: record.disposition,
      job_id: String(payload.job_id || ''),
      job_name: String(payload.job_name || payload.job_id || ''),
      execution_id: String(payload.execution_id || ''),
      status: String(payload.status || ''),
      success: typeof payload.success === 'boolean' ? payload.success : null,
      reason: typeof payload.reason === 'string' ? payload.reason : null,
      error: typeof payload.error === 'string' ? payload.error : null,
      truncated: payload.truncated === true,
      finished_at: typeof payload.finished_at === 'string' ? payload.finished_at : null,
    },
  }
}

/**
 * Merge passive notices into one page of stored messages by time. Older pages include notices
 * inside their own time span; the latest page also includes every newer notice.
 */
export function withSessionNotices<T extends { timestamp?: unknown }>(
  sessionId: string,
  messages: T[],
  isLatestPage: boolean,
): Array<T | StudioNoticeMessage> {
  let notices: SessionNotificationRecord[]
  try {
    notices = listVisibleSessionNotifications(sessionId)
  } catch {
    return messages
  }
  if (!notices.length) return messages
  const times = messages.map(message => Number(message.timestamp || 0)).filter(Number.isFinite)
  const first = times.length ? Math.min(...times) : Number.NEGATIVE_INFINITY
  const last = times.length ? Math.max(...times) : Number.POSITIVE_INFINITY
  const selected = notices.map(noticeToMessage).filter(notice => (
    isLatestPage ? notice.timestamp >= first || !times.length : notice.timestamp >= first && notice.timestamp <= last
  ))
  if (!selected.length) return messages
  return [...messages, ...selected].sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[…truncated]` : text
}

/**
 * The bounded, once-only context block for the user's next intentional question. Passive notices
 * were only displayed; this is the first time the model sees them, and it says so.
 */
export function buildNoticeProjection(sessionId: string): { text: string; ids: number[] } | null {
  let notices: SessionNotificationRecord[]
  try {
    notices = listUnprojectedSessionNotifications(sessionId, NOTICE_PROJECTION_MAX_NOTICES)
  } catch {
    return null
  }
  if (!notices.length) return null
  const sections: string[] = []
  const ids: number[] = []
  let total = 0
  for (const notice of notices) {
    const view = noticeToMessage(notice)
    const meta = view.studio_notice
    const header = `- Scheduled task "${meta.job_name}" (job ${meta.job_id}, execution ${meta.execution_id}, status ${meta.status}`
      + `${meta.success === false ? ', failed' : ''})`
    const body = view.content
      ? clip(view.content, NOTICE_PROJECTION_MAX_CHARS_PER_NOTICE)
      : `(no result text: ${meta.reason || meta.disposition})`
    const section = `${header}:\n${body}`
    if (total + section.length > NOTICE_PROJECTION_MAX_TOTAL_CHARS && sections.length) break
    sections.push(section)
    ids.push(notice.id)
    total += section.length
  }
  return {
    ids,
    text: [
      '[Studio notifications, shown to you once: these scheduled-task results arrived in this conversation'
        + ' while you were idle. The user has seen them; you have not responded to them before.]',
      ...sections,
      '[End of Studio notifications]',
    ].join('\n'),
  }
}
