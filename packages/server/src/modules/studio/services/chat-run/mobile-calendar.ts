export type MobileCalendarCapability = 'calendar' | 'reminder'
export type MobileCalendarAction = 'list' | 'create' | 'update' | 'complete' | 'delete'

export type MobileCalendarRequest = {
  capability: MobileCalendarCapability
  action: MobileCalendarAction
  purpose: string
  start_ms?: number
  end_ms?: number
  include_completed?: boolean
  limit: number
  item?: Record<string, unknown>
}

export type MobileCalendarResponse = (
  | {
      status: 'success'
      result: {
        capability: MobileCalendarCapability
        action: MobileCalendarAction
        items?: Array<Record<string, unknown>>
        item?: Record<string, unknown>
      }
    }
  | { status: 'denied' }
  | { status: 'error'; error: { code: string } }
) & { device_id?: string }

const DAY_MS = 24 * 60 * 60_000
const MAX_RANGE_MS = 31 * DAY_MS
const MAX_FUTURE_MS = 5 * 365 * DAY_MS
const MIN_TIME_MS = Date.UTC(2001, 0, 1)
const ERROR_CODES = new Set([
  'calendar_permission_denied',
  'calendar_unavailable',
  'calendar_item_not_found',
  'calendar_invalid_request',
  'calendar_failed',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, max: number): string {
  return String(value || '').trim().slice(0, max)
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const normalized = Math.round(Number(value))
  return Number.isFinite(normalized) ? Math.max(min, Math.min(max, normalized)) : fallback
}

function timestamp(value: unknown, fallback: number, now: number): number {
  const normalized = Math.round(Number(value))
  if (!Number.isFinite(normalized)) return fallback
  return Math.max(MIN_TIME_MS, Math.min(now + MAX_FUTURE_MS, normalized))
}

function cleanItem(value: unknown, capability: MobileCalendarCapability, action: MobileCalendarAction): Record<string, unknown> | null {
  if (!isRecord(value)) return null
  if (action === 'delete') {
    if (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 512) return null
    if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 500) return null
    // Require the exact listed occurrence; never invent a time for deletion.
    const start = capability === 'calendar' ? value.start_ms : value.due_ms
    if (capability === 'calendar' && (typeof start !== 'number' || !Number.isFinite(start) || start < MIN_TIME_MS)) return null
    if (capability === 'reminder' && start != null && (typeof start !== 'number' || !Number.isFinite(start))) return null
    return { id: value.id.trim(), title: value.title.trim(), ...(start != null ? { [capability === 'calendar' ? 'start_ms' : 'due_ms']: start } : {}) }
  }
  const now = Date.now()
  const id = text(value.id || value.event_id || value.reminder_id, 512)
  if ((action === 'update' || action === 'complete') && !id) return null
  const item: Record<string, unknown> = {}
  if (id) item.id = id
  if (action !== 'complete') {
    const title = text(value.title, 500)
    if (!title) return null
    item.title = title
  }
  const notes = text(value.notes, 4_000)
  const location = text(value.location, 500)
  if (notes) item.notes = notes
  if (location) item.location = location
  if (capability === 'calendar') {
    const startMs = timestamp(value.start_ms || value.startMs, now + 5 * 60_000, now)
    const requestedEnd = timestamp(value.end_ms || value.endMs, startMs + 60 * 60_000, now)
    item.start_ms = startMs
    item.end_ms = Math.max(startMs + 60_000, Math.min(requestedEnd, startMs + MAX_RANGE_MS))
    item.all_day = value.all_day === true || value.allDay === true
    item.reminder_minutes = integer(value.reminder_minutes || value.reminderMinutes, 0, 0, 30 * 24 * 60)
  } else {
    if (value.due_ms != null || value.dueMs != null) {
      item.due_ms = timestamp(value.due_ms || value.dueMs, now + 60 * 60_000, now)
    }
    item.priority = integer(value.priority, 0, 0, 9)
    if (action === 'complete') item.completed = value.completed !== false
  }
  return item
}

export function normalizeMobileCalendarRequest(value: Record<string, unknown>): MobileCalendarRequest {
  const capability = String(value.capability || '').trim() as MobileCalendarCapability
  if (capability !== 'calendar' && capability !== 'reminder') throw new Error('capability must be calendar or reminder')
  const action = String(value.action || '').trim() as MobileCalendarAction
  const allowed = capability === 'calendar'
    ? new Set<MobileCalendarAction>(['list', 'create', 'update', 'delete'])
    : new Set<MobileCalendarAction>(['list', 'create', 'update', 'complete', 'delete'])
  if (!allowed.has(action)) throw new Error(`Unsupported ${capability} action`)
  const purpose = text(value.purpose, 240)
  if (!purpose) throw new Error('purpose is required')
  const request: MobileCalendarRequest = {
    capability,
    action,
    purpose,
    limit: integer(value.limit, 50, 1, 100),
  }
  if (action === 'list') {
    const now = Date.now()
    const start = timestamp(value.start_ms, capability === 'calendar' ? now : now - DAY_MS, now)
    const end = timestamp(value.end_ms, start + 7 * DAY_MS, now)
    request.start_ms = start
    request.end_ms = Math.max(start + 60_000, Math.min(end, start + MAX_RANGE_MS))
    if (capability === 'reminder') request.include_completed = value.include_completed === true
  } else {
    const item = cleanItem(value.item, capability, action)
    if (!item) throw new Error('A valid item is required')
    request.item = item
  }
  return request
}

function cleanResultItem(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null
  const output: Record<string, unknown> = {}
  for (const key of ['id', 'title', 'notes', 'location']) {
    const normalized = text(value[key], key === 'notes' ? 4_000 : 1_000)
    if (normalized) output[key] = normalized
  }
  for (const key of ['startMs', 'endMs', 'dueMs', 'priority', 'reminderMinutes']) {
    const normalized = Number(value[key])
    if (Number.isFinite(normalized)) output[key] = normalized
  }
  for (const key of ['allDay', 'completed']) {
    if (typeof value[key] === 'boolean') output[key] = value[key]
  }
  return output
}

export function normalizeMobileCalendarResponse(
  value: unknown,
  expected: Pick<MobileCalendarRequest, 'capability' | 'action'> & { item?: Record<string, unknown> },
): MobileCalendarResponse | null {
  if (!isRecord(value)) return null
  const status = String(value.status || '').trim()
  if (status === 'denied') return { status: 'denied' }
  if (status === 'error') {
    const error = isRecord(value.error) ? String(value.error.code || '') : ''
    return { status: 'error', error: { code: ERROR_CODES.has(error) ? error : 'calendar_failed' } }
  }
  if (status !== 'success' || !isRecord(value.result)) return null
  const capability = String(value.result.capability || expected.capability)
  const action = String(value.result.action || expected.action)
  if (capability !== expected.capability || action !== expected.action) return null
  const result: Extract<MobileCalendarResponse, { status: 'success' }>['result'] = {
    capability: expected.capability,
    action: expected.action,
  }
  if (Array.isArray(value.result.items)) {
    result.items = value.result.items.slice(0, 100).map(cleanResultItem).filter(Boolean) as Array<Record<string, unknown>>
  }
  if (expected.action === 'delete') {
    if (!isRecord(value.result.item) || value.result.item.id !== expected.item?.id || value.result.item.deleted !== true) return null
    return { status: 'success', result: { capability: expected.capability, action: 'delete', item: { id: expected.item?.id, deleted: true } } }
  }
  const item = cleanResultItem(value.result.item)
  if (item) result.item = item
  return { status: 'success', result }
}
