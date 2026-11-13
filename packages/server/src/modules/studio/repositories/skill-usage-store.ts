import { getDb } from '../infrastructure/database'
import { SKILL_USAGE_EVENTS_TABLE, SKILL_USAGE_SYNC_TABLE } from '../infrastructure/database/schemas'
import type { ExternalSkillUsageEvent, LocalSkillUsageStatsResult, SkillUsageStats } from '../contracts/skills'

type StudioDb = NonNullable<ReturnType<typeof getDb>>
type SkillAction = 'view' | 'manage'

interface SkillMessageInput {
  session_id: string
  role: string
  content: string
  tool_call_id?: string | null
  tool_calls?: any[] | null
  tool_name?: string | null
  run_marker?: string | null
  timestamp?: number
}

interface SkillEvent {
  messageId: number
  sessionId: string
  runId: string
  profile: string
  agent: string
  skill: string
  action: SkillAction
  timestamp: number
}

function emptyStats(days: number): SkillUsageStats {
  return {
    period_days: days,
    summary: {
      total_skill_loads: 0,
      total_skill_edits: 0,
      total_skill_actions: 0,
      distinct_skills_used: 0,
    },
    by_day: [],
    top_skills: [],
  }
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function toolCallIds(record: Record<string, unknown>): string[] {
  const fn = parseObject(record.function) || {}
  return [record.id, record.call_id, record.tool_call_id, fn.call_id]
    .filter((value): value is string => typeof value === 'string' && Boolean(value))
}

function skillNameFromPathText(value: string): string {
  const normalized = value.replace(/\\\\/g, '/').replace(/\\/g, '/')
  return normalized.match(/(?:^|\/)skills\/([^/\s"']+)\/SKILL\.md(?:$|[\s"'])/i)?.[1]?.trim() || ''
}

function stringValues(value: unknown, output: string[] = []): string[] {
  if (typeof value === 'string') output.push(value)
  else if (Array.isArray(value)) value.forEach(item => stringValues(item, output))
  else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(item => stringValues(item, output))
  return output
}

function observedSkillCall(nameValue: unknown, argumentsValue: unknown): { action: SkillAction; skill: string } | null {
  const name = String(nameValue || '').trim().toLowerCase()
  const args = parseObject(argumentsValue) || {}
  if (name === 'skill_view' || name === 'skill_manage' || name === 'skill') {
    const rawSkill = args.name ?? args.skill ?? args.skill_name
    const skill = typeof rawSkill === 'string' ? rawSkill.trim() : ''
    if (skill) return { action: name === 'skill_manage' ? 'manage' : 'view', skill }
  }

  const skill = stringValues(args).map(skillNameFromPathText).find(Boolean) || ''
  if (!skill) return null
  const action: SkillAction = /(manage|write|edit|patch|apply|create|delete|remove)/.test(name) ? 'manage' : 'view'
  return { action, skill }
}

function assistantToolCallLookup(rows: Array<Record<string, unknown>>): Map<string, { action: SkillAction; skill: string }> {
  const lookup = new Map<string, { action: SkillAction; skill: string }>()
  for (const row of rows) {
    const sessionId = String(row.session_id || '')
    if (!sessionId || typeof row.tool_calls !== 'string') continue
    let parsed: unknown
    try { parsed = JSON.parse(row.tool_calls) } catch { continue }
    for (const value of Array.isArray(parsed) ? parsed : [parsed]) {
      const call = parseObject(value)
      if (!call) continue
      const fn = parseObject(call.function) || {}
      const observed = observedSkillCall(fn.name ?? call.name, fn.arguments ?? call.arguments)
      if (!observed) continue
      for (const id of toolCallIds(call)) lookup.set(`${sessionId}\0${id}`, observed)
    }
  }
  return lookup
}

function skillFromContent(content: string, action: SkillAction): string {
  if (action === 'view') {
    const bracket = content.match(/^\[skill_view\]\s+name=(.+?)(?:\s+\(|\s*$)/)
    if (bracket?.[1]) return bracket[1].trim()
    const parsed = parseObject(content)
    if (typeof parsed?.name === 'string') return parsed.name.trim()
    const jsonName = content.match(/"name"\s*:\s*"((?:\\.|[^"\\])*)"/)
    if (jsonName?.[1]) {
      try { return JSON.parse(`"${jsonName[1]}"`).trim() } catch { return jsonName[1].trim() }
    }
    return skillNameFromPathText(content)
  }

  const bracket = content.match(/^\[skill_manage\]\s+name=(.+?)(?:\s+|\(|$)/)
  if (bracket?.[1]) return bracket[1].trim()
  const parsed = parseObject(content)
  const message = typeof parsed?.message === 'string' ? parsed.message : content
  return message.match(/skill ['"]([^'"]+)['"]/i)?.[1]?.trim()
    || message.match(/\bname=([^\s)]+)/i)?.[1]?.trim()
    || skillNameFromPathText(message)
}

function eventFromRow(
  row: Record<string, unknown>,
  assistantCalls: Map<string, { action: SkillAction; skill: string }>,
): SkillEvent | null {
  const sessionId = String(row.session_id || '')
  const content = String(row.content || '')
  const toolName = String(row.tool_name || '')
  let action: SkillAction | null = toolName === 'skill_view' || content.startsWith('[skill_view]')
    ? 'view'
    : toolName === 'skill_manage' || content.startsWith('[skill_manage]')
      ? 'manage'
      : null
  let skill = action ? skillFromContent(content, action) : ''
  if ((!action || !skill) && row.tool_call_id) {
    const observed = assistantCalls.get(`${sessionId}\0${String(row.tool_call_id)}`)
    if (observed) {
      action = observed.action
      skill = observed.skill
    }
  }
  const messageId = Number(row.message_id)
  const timestamp = Number(row.timestamp)
  if (!Number.isFinite(messageId) || !sessionId || !action || !skill) return null
  return {
    messageId,
    sessionId,
    runId: String(row.run_marker || ''),
    profile: String(row.profile || 'default'),
    agent: String(row.agent || row.source || 'studio'),
    skill,
    action,
    timestamp: Number.isFinite(timestamp) ? timestamp : Math.floor(Date.now() / 1000),
  }
}

function insertEvent(db: StudioDb, event: SkillEvent): void {
  db.prepare(`
    INSERT OR IGNORE INTO ${SKILL_USAGE_EVENTS_TABLE}
      (source, message_id, session_id, run_id, profile, agent, skill, action, timestamp)
    VALUES ('studio', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(event.messageId, event.sessionId, event.runId, event.profile, event.agent, event.skill, event.action, event.timestamp)
}

function matchingAssistantRows(db: StudioDb, sessionIds: string[]): Array<Record<string, unknown>> {
  if (sessionIds.length === 0) return []
  return db.prepare(`
    SELECT session_id, tool_calls
    FROM messages
    WHERE role = 'assistant'
      AND tool_calls IS NOT NULL
      AND session_id IN (SELECT value FROM json_each(?))
      AND (tool_calls LIKE '%skill%' OR tool_calls LIKE '%SKILL.md%')
  `).all(JSON.stringify(sessionIds)) as Array<Record<string, unknown>>
}

/** Record a newly persisted, evidence-backed skill tool event. */
export function recordSkillUsageMessage(messageId: number, message: SkillMessageInput): void {
  if (message.role !== 'tool' || !Number.isFinite(messageId)) return
  const db = getDb()
  if (!db) return
  try {
    const session = db.prepare('SELECT profile, source, agent FROM sessions WHERE id = ?').get(message.session_id) as Record<string, unknown> | undefined
    if (!session) return
    const lookup = assistantToolCallLookup(message.tool_call_id ? matchingAssistantRows(db, [message.session_id]) : [])
    const event = eventFromRow({
      message_id: messageId,
      ...message,
      profile: session.profile,
      source: session.source,
      agent: session.agent,
    }, lookup)
    if (event) insertEvent(db, event)
  } catch {
    // Analytics must never make message persistence fail.
  }
}

/** One-time historical backfill plus an incremental high-water cursor. */
function syncHistoricalSkillUsageEvents(db: StudioDb): void {
  const cursor = db.prepare(`SELECT last_message_id FROM ${SKILL_USAGE_SYNC_TABLE} WHERE source = 'studio'`).get() as { last_message_id?: number } | undefined
  const lastMessageId = Number(cursor?.last_message_id || 0)
  const maxRow = db.prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM messages').get() as { max_id?: number } | undefined
  const maxMessageId = Number(maxRow?.max_id || 0)
  if (maxMessageId <= lastMessageId) return

  const rows = db.prepare(`
    SELECT m.id AS message_id, m.session_id, m.tool_name, m.tool_call_id, m.run_marker,
      SUBSTR(m.content, 1, 500) AS content, COALESCE(m.timestamp, s.started_at) AS timestamp,
      s.profile, s.source, s.agent
    FROM messages m
    JOIN sessions s ON s.id = m.session_id
    WHERE m.id > ? AND m.id <= ? AND m.role = 'tool'
      AND (
        LOWER(COALESCE(m.tool_name, '')) IN ('skill_view', 'skill_manage', 'skill')
        OR COALESCE(m.content, '') LIKE '[skill_view]%'
        OR COALESCE(m.content, '') LIKE '[skill_manage]%'
        OR m.tool_call_id IS NOT NULL
      )
  `).all(lastMessageId, maxMessageId) as Array<Record<string, unknown>>
  const sessionIds = [...new Set(rows.map(row => String(row.session_id || '')).filter(Boolean))]
  const lookup = assistantToolCallLookup(matchingAssistantRows(db, sessionIds))
  db.exec('BEGIN')
  try {
    for (const row of rows) {
      const event = eventFromRow(row, lookup)
      if (event) insertEvent(db, event)
    }
    db.prepare(`
      INSERT INTO ${SKILL_USAGE_SYNC_TABLE} (source, last_message_id, updated_at)
      VALUES ('studio', ?, ?)
      ON CONFLICT(source) DO UPDATE SET last_message_id = excluded.last_message_id, updated_at = excluded.updated_at
    `).run(maxMessageId, Math.floor(Date.now() / 1000))
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function getSkillUsageSyncCursor(source: string): number {
  const db = getDb()
  if (!db) return 0
  const row = db.prepare(`SELECT last_message_id FROM ${SKILL_USAGE_SYNC_TABLE} WHERE source = ?`).get(source) as { last_message_id?: number } | undefined
  return Number(row?.last_message_id || 0)
}

export function syncExternalSkillUsageEvents(
  source: string,
  profile: string,
  events: ExternalSkillUsageEvent[],
  cursor: number,
  reset = false,
): void {
  const db = getDb()
  if (!db) return
  db.exec('BEGIN')
  try {
    if (reset) {
      db.prepare(`DELETE FROM ${SKILL_USAGE_EVENTS_TABLE} WHERE source = ? AND profile = ?`).run(source, profile)
    }
    const insert = db.prepare(`
      INSERT OR IGNORE INTO ${SKILL_USAGE_EVENTS_TABLE}
        (source, message_id, session_id, run_id, profile, agent, skill, action, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const event of events) {
      insert.run(
        source,
        event.messageId,
        event.sessionId,
        event.runId || '',
        profile,
        source,
        event.skill,
        event.action,
        event.timestamp,
      )
    }
    const cursorKey = `${source}:${profile}`
    db.prepare(`
      INSERT INTO ${SKILL_USAGE_SYNC_TABLE} (source, last_message_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET last_message_id = excluded.last_message_id, updated_at = excluded.updated_at
    `).run(cursorKey, cursor, Math.floor(Date.now() / 1000))
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function getLocalSkillUsageStats(
  days = 7,
  nowSeconds = Math.floor(Date.now() / 1000),
  profile = 'default',
  includeHermes = false,
): LocalSkillUsageStatsResult {
  const safeDays = Math.max(1, Math.floor(Number.isFinite(days) ? days : 7))
  const db = getDb()
  if (!db) return { stats: emptyStats(safeDays), sessionIds: [] }
  try {
    syncHistoricalSkillUsageEvents(db)
  } catch {
    return { stats: emptyStats(safeDays), sessionIds: [] }
  }

  const since = nowSeconds - safeDays * 24 * 60 * 60
  const sourceClause = includeHermes ? '' : " AND source = 'studio'"
  const topRows = db.prepare(`
    SELECT skill,
      SUM(CASE WHEN action = 'view' THEN 1 ELSE 0 END) AS view_count,
      SUM(CASE WHEN action = 'manage' THEN 1 ELSE 0 END) AS manage_count,
      COUNT(*) AS total_count,
      MAX(timestamp) AS last_used_at
    FROM ${SKILL_USAGE_EVENTS_TABLE}
    WHERE profile = ? AND timestamp > ?${sourceClause}
    GROUP BY skill
  `).all(profile, since) as Array<Record<string, unknown>>
  const dailyRows = db.prepare(`
    SELECT date(timestamp, 'unixepoch') AS date, skill,
      SUM(CASE WHEN action = 'view' THEN 1 ELSE 0 END) AS view_count,
      SUM(CASE WHEN action = 'manage' THEN 1 ELSE 0 END) AS manage_count,
      COUNT(*) AS total_count
    FROM ${SKILL_USAGE_EVENTS_TABLE}
    WHERE profile = ? AND timestamp > ?${sourceClause}
    GROUP BY date(timestamp, 'unixepoch'), skill
    ORDER BY date ASC
  `).all(profile, since) as Array<Record<string, unknown>>
  const sessionRows = db.prepare(`
    SELECT DISTINCT session_id FROM ${SKILL_USAGE_EVENTS_TABLE}
    WHERE profile = ? AND timestamp > ?${sourceClause}
  `).all(profile, since) as Array<{ session_id?: string }>

  const total = topRows.reduce((sum, row) => sum + Number(row.total_count || 0), 0)
  const dayMap = new Map<string, { date: string; view_count: number; manage_count: number; skills: Array<{ skill: string; view_count: number; manage_count: number; total_count: number }> }>()
  for (const row of dailyRows) {
    const date = String(row.date || '')
    if (!date) continue
    const day = dayMap.get(date) || { date, view_count: 0, manage_count: 0, skills: [] }
    const skill = {
      skill: String(row.skill || ''),
      view_count: Number(row.view_count || 0),
      manage_count: Number(row.manage_count || 0),
      total_count: Number(row.total_count || 0),
    }
    day.view_count += skill.view_count
    day.manage_count += skill.manage_count
    day.skills.push(skill)
    dayMap.set(date, day)
  }
  const topSkills = topRows.map(row => ({
    skill: String(row.skill || ''),
    view_count: Number(row.view_count || 0),
    manage_count: Number(row.manage_count || 0),
    total_count: Number(row.total_count || 0),
    percentage: total > 0 ? Number(row.total_count || 0) / total * 100 : 0,
    last_used_at: row.last_used_at == null ? null : Number(row.last_used_at),
  })).sort((a, b) =>
    b.total_count - a.total_count
    || b.view_count - a.view_count
    || b.manage_count - a.manage_count
    || (b.last_used_at || 0) - (a.last_used_at || 0)
    || a.skill.localeCompare(b.skill),
  )

  return {
    stats: {
      period_days: safeDays,
      summary: {
        total_skill_loads: topSkills.reduce((sum, row) => sum + row.view_count, 0),
        total_skill_edits: topSkills.reduce((sum, row) => sum + row.manage_count, 0),
        total_skill_actions: total,
        distinct_skills_used: topSkills.length,
      },
      by_day: [...dayMap.values()].map(day => ({
        ...day,
        total_count: day.view_count + day.manage_count,
        skills: day.skills.sort((a, b) => b.total_count - a.total_count || a.skill.localeCompare(b.skill)),
      })),
      top_skills: topSkills,
    },
    sessionIds: sessionRows.map(row => String(row.session_id || '')).filter(Boolean),
  }
}
