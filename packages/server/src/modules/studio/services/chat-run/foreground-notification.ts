/** Payload deliberately excludes prompts, commands, credentials and message text. */
export function foregroundNotification(event: string, value: Record<string, unknown>, now = Date.now()) {
  const sessionId = typeof value.session_id === 'string' ? value.session_id : ''
  if (!sessionId || value.replayed === true || value.restored === true || value.background_snapshot === true) return null
  if (event.endsWith('.resolved') && (value.resolved === false || value.stale === true)) return null
  const requestKind = event.startsWith('approval.') ? 'approval' : event.startsWith('clarify.') ? 'clarify' : ''
  const id = requestKind ? value[`${requestKind}_id`] : value.run_id
  if (typeof id !== 'string' || !id) return null
  if (requestKind && (event.endsWith('.requested') || event.endsWith('.resolved'))) {
    return { id: `${sessionId}:${requestKind}:${id}`, sessionId, kind: 'approval', resolved: event.endsWith('.resolved'), timestamp: now }
  }
  if (!['run.completed', 'run.failed'].includes(event) || Number(value.queue_remaining || 0) > 0
    || value.interrupted === true || value.stop_reason === 'queue_insertion' || value.stop_reason === 'aborted') return null
  return { id: `${sessionId}:run:${id}`, sessionId, kind: event === 'run.failed' ? 'failure' : 'completion', resolved: false, timestamp: now }
}

/** Only short user-visible text; never serialize commands, tool results or raw errors. */
export function foregroundNotificationPreview(
  kind: string,
  session: { title?: string | null; preview?: string | null } | null,
  payload: Record<string, unknown>,
) {
  const plain = (value: unknown, limit: number) => typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) : ''
  return {
    title: plain(session?.title, 120),
    content: kind === 'completion' ? plain(payload.output, 240) : '',
  }
}

/** Stable identity only, never accept an image URL from a notification payload. */
export function foregroundNotificationAgent(value: unknown): string {
  if (typeof value !== 'string') return ''
  const agent = value.toLowerCase().trim()
  if (agent === 'claude' || agent === 'claude-code') return 'claude-code'
  if (agent === 'ekko' || agent === 'ekko-agent') return 'ekko-agent'
  return ['hermes', 'codex', 'pi', 'grok', 'opencode', 'dsh', 'cursor'].includes(agent) ? agent : ''
}
