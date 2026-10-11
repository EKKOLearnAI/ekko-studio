import { existsSync, statSync } from 'fs'
import { open } from 'fs/promises'
import { join } from 'path'
import {
  getEkkoLogSource,
  listPrimaryAgentLogFiles,
  readPrimaryAgentLogs,
  type AgentLogLevel,
  type AgentLogRecord,
} from '../public/agent-logs'
import { config } from '../public/config'
import { isHermesAgentAvailable } from '../public/agent-status-registry'

const WEBUI_LOG_FILE = join(config.appHome, 'logs', 'server.log')
const BRIDGE_LOG_FILE = join(config.appHome, 'logs', 'bridge.log')

interface LogEntry {
  timestamp: string; level: string; logger: string; message: string; raw?: string
}

const DEFAULT_LOG_LINES = 100
const MAX_LOG_LINES = 500
const MAX_TAIL_BYTES = 2 * 1024 * 1024

type SinceValue = { date: Date; cliValue: string; future: boolean }
type LogCursor = { sortKey: string; occurrence: number }

function parseSince(value: unknown): SinceValue | null {
  const input = String(value ?? '').trim()
  if (!input) return null
  const relative = input.match(/^(\d+(?:\.\d+)?)([smhdw])$/i)
  const now = Date.now()
  if (relative) {
    const amount = Number(relative[1])
    const unitMs: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }
    return { date: new Date(now - amount * unitMs[relative[2].toLowerCase()]), cliValue: input, future: false }
  }
  const timestamp = Date.parse(input)
  if (!Number.isFinite(timestamp)) return null
  if (timestamp > now) return { date: new Date(timestamp), cliValue: '1s', future: true }
  const seconds = Math.max(1, Math.ceil((now - timestamp) / 1000))
  return { date: new Date(timestamp), cliValue: `${seconds}s`, future: false }
}

function requestedLines(value: unknown): number {
  const parsed = value === undefined ? DEFAULT_LOG_LINES : Number.parseInt(String(value), 10)
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_LOG_LINES) : DEFAULT_LOG_LINES
}

function response(entries: LogEntry[], truncated = false, nextCursor?: string) {
  return { entries, count: entries.length, truncated, ...(nextCursor ? { next_cursor: nextCursor } : {}) }
}

function recordSortKey(record: AgentLogRecord): string {
  return [
    new Date(record.timestamp).toISOString(),
    record.category,
    record.event,
    record.sessionId || '',
    record.runId || '',
    record.turnId || '',
  ].join('\u0000')
}

function encodeCursor(sortKey: string, occurrence: number): string {
  return Buffer.from(JSON.stringify({ sortKey, occurrence }), 'utf8').toString('base64url')
}

function decodeCursor(value: string | undefined): LogCursor | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<LogCursor>
    const occurrence = parsed.occurrence
    return typeof parsed.sortKey === 'string' && typeof occurrence === 'number' && Number.isInteger(occurrence) && occurrence >= 0
      ? { sortKey: parsed.sortKey, occurrence }
      : null
  } catch {
    return null
  }
}

function filterBeforeCursor(records: AgentLogRecord[], cursor: LogCursor | null): AgentLogRecord[] {
  if (!cursor) return records
  const seen = new Map<string, number>()
  return records.filter(record => {
    const sortKey = recordSortKey(record)
    const occurrence = seen.get(sortKey) || 0
    seen.set(sortKey, occurrence + 1)
    return sortKey < cursor.sortKey || (sortKey === cursor.sortKey && occurrence < cursor.occurrence)
  })
}

function filterSince(entries: LogEntry[], since: SinceValue | null): LogEntry[] {
  if (!since) return entries
  if (since.future) return []
  return entries.filter(entry => {
    const timestamp = Date.parse(entry.timestamp)
    return !Number.isFinite(timestamp) || timestamp >= since.date.getTime()
  })
}

function appendPinoContext(message: string, obj: any): string {
  const parts: string[] = []
  const runtime = obj.runtime && typeof obj.runtime === 'object' ? obj.runtime : null
  if (runtime) {
    if (runtime.profile) parts.push(`profile=${runtime.profile}`)
    if (runtime.cwd) parts.push(`cwd=${runtime.cwd}`)
    if (runtime.profile_dir) parts.push(`profile_dir=${runtime.profile_dir}`)
    if (runtime.config_path) parts.push(`config=${runtime.config_path}`)
  } else if (obj.profile) {
    parts.push(`profile=${obj.profile}`)
  }
  if (obj.request?.action) parts.push(`action=${obj.request.action}`)
  if (obj.err?.message) parts.push(`error=${obj.err.message}`)
  if (obj.sessionId) parts.push(`session=${obj.sessionId}`)
  if (obj.runId) parts.push(`run=${obj.runId}`)
  if (obj.status) parts.push(`status=${obj.status}`)
  return parts.length > 0 ? `${message} ${parts.join(' ')}` : message
}

function parseLine(line: string, includeRaw = false): LogEntry {
  try {
    const obj = JSON.parse(line)
    if (obj.level && obj.time) {
      const ts = new Date(obj.time).toISOString()
      const levelMap: Record<number, string> = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' }
      // Pino 日志格式: { level, time, msg, name (logger name), hostname, pid, ... }
      const loggerName = obj.name || obj.logger || 'app'
      const message = obj.msg || (obj.err ? obj.err.message : '')
      const baseMessage = typeof message === 'string' ? message : JSON.stringify(message)
      return { timestamp: ts, level: levelMap[obj.level] || 'INFO', logger: loggerName, message: appendPinoContext(baseMessage, obj), ...(includeRaw ? { raw: line } : {}) }
    }
  } catch {}
  let match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3})\s+(DEBUG|INFO|WARNING|ERROR|CRITICAL)\s+(\S+?):\s(.*)$/)
  if (match) { return { timestamp: match[1], level: match[2], logger: match[3], message: match[4], ...(includeRaw ? { raw: line } : {}) } }
  match = line.match(/^\[(\S+?)\]\s+\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3})\]\s+\[(DEBUG|INFO|WARNING|ERROR|CRITICAL)\]\s(.*)$/)
  if (match) { return { timestamp: match[2], level: match[3], logger: match[1], message: match[4], ...(includeRaw ? { raw: line } : {}) } }
  return { timestamp: '', level: '', logger: '', message: line, ...(includeRaw ? { raw: line } : {}) }
}

function requestedProfile(ctx: any): string {
  return String(ctx.state?.profile?.name || ctx.query?.profile || 'default').trim() || 'default'
}

function displaySize(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${(bytes / 1024).toFixed(1)}KB`
}

function ekkoLogEntry(record: AgentLogRecord, includeRaw = false): LogEntry {
  const timestamp = new Date(record.timestamp).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
  const level = record.level === 'warn' ? 'WARNING' : record.level.toUpperCase()
  const context = [
    record.sessionId ? `session=${record.sessionId}` : '',
    record.runId ? `run=${record.runId}` : '',
    record.turnId ? `turn=${record.turnId}` : '',
  ].filter(Boolean)
  const data = record.data === undefined ? '' : ` ${JSON.stringify(record.data)}`
  const message = `${record.event}${context.length ? ` ${context.join(' ')}` : ''}${data}`
  return {
    timestamp,
    level,
    logger: `ekko-agent/${record.category}`,
    message,
    ...(includeRaw ? { raw: JSON.stringify(record) } : {}),
  }
}

async function readTailLines(path: string, maxBytes = MAX_TAIL_BYTES): Promise<{ lines: string[]; truncated: boolean }> {
  const file = await open(path, 'r')
  try {
    const stat = await file.stat()
    const size = Math.min(stat.size, maxBytes)
    const buffer = Buffer.alloc(size)
    await file.read(buffer, 0, size, Math.max(0, stat.size - size))
    const lines = buffer.toString('utf8').split('\n')
    if (stat.size > size) lines.shift()
    return { lines, truncated: stat.size > size }
  } finally {
    await file.close()
  }
}

export async function list(ctx: any) {
  const files = isHermesAgentAvailable() ? await listPrimaryAgentLogFiles() : []
  if (existsSync(WEBUI_LOG_FILE)) {
    try {
      const stat = statSync(WEBUI_LOG_FILE)
      const size = stat.size > 1024 * 1024 ? `${(stat.size / 1024 / 1024).toFixed(1)}MB` : `${(stat.size / 1024).toFixed(1)}KB`
      const modified = stat.mtime.toLocaleString()
      files.push({ name: 'webui', size, modified })
    } catch { }
  }
  if (existsSync(BRIDGE_LOG_FILE)) {
    try {
      const stat = statSync(BRIDGE_LOG_FILE)
      const size = stat.size > 1024 * 1024 ? `${(stat.size / 1024 / 1024).toFixed(1)}MB` : `${(stat.size / 1024).toFixed(1)}KB`
      const modified = stat.mtime.toLocaleString()
      files.push({ name: 'bridge', size, modified })
    } catch { }
  }
  const ekkoReader = getEkkoLogSource(requestedProfile(ctx))
  if (ekkoReader && existsSync(ekkoReader.filePath)) {
    try {
      const stat = statSync(ekkoReader.filePath)
      files.push({ name: 'ekko-agent', size: displaySize(stat.size), modified: stat.mtime.toLocaleString() })
    } catch { }
  }
  ctx.body = { files }
}

export async function read(ctx: any) {
  const logName = ctx.params.name
  const lines = requestedLines(ctx.query.lines)
  const level = (ctx.query.level as string) || undefined
  const session = (ctx.query.session as string) || undefined
  const since = (ctx.query.since as string) || undefined
  const cursor = (ctx.query.cursor as string) || undefined
  const parsedSince = since ? parseSince(since) : null
  const parsedCursor = decodeCursor(cursor)
  const includeRaw = ctx.query.raw === '1' || ctx.query.raw === 'true'
  if (since && !parsedSince) {
    ctx.status = 400
    ctx.body = { error: 'Invalid since; use a relative duration such as 1h or a valid ISO timestamp' }
    return
  }

  if (cursor && !parsedCursor) {
    ctx.status = 400
    ctx.body = { error: 'Invalid cursor; use the next_cursor value returned by a previous query' }
    return
  }

  if (logName === 'ekko-agent') {
    try {
      const ekkoReader = getEkkoLogSource(requestedProfile(ctx))
      if (!ekkoReader) { ctx.body = response([]); return }
      if (parsedSince?.future) { ctx.body = response([]); return }
      const normalizedLevel = String(level || '').toLowerCase()
      const records = ekkoReader.query({
        sessionId: session,
        runId: (ctx.query.run as string) || undefined,
        category: (ctx.query.category as any) || undefined,
        level: (['debug', 'info', 'warn', 'error'].includes(normalizedLevel)
          ? normalizedLevel
          : normalizedLevel === 'warning'
            ? 'warn'
            : undefined) as AgentLogLevel | undefined,
        event: (ctx.query.event as string) || undefined,
        text: (ctx.query.text as string) || undefined,
        after: parsedSince?.date.toISOString(),
        limit: 0,
      })
      const visibleRecords = filterBeforeCursor(records, parsedCursor)
      const truncated = visibleRecords.length > lines
      const pageRecords = truncated ? visibleRecords.slice(-lines) : visibleRecords
      const page = pageRecords.map(record => ekkoLogEntry(record, includeRaw)).reverse()
      const boundary = truncated ? pageRecords[0] : undefined
      const boundaryKey = boundary ? recordSortKey(boundary) : ''
      const boundaryOccurrence = boundary
        ? visibleRecords.slice(0, visibleRecords.indexOf(boundary) + 1).filter(record => recordSortKey(record) === boundaryKey).length - 1
        : 0
      const nextCursor = boundary ? encodeCursor(boundaryKey, boundaryOccurrence) : undefined
      ctx.body = response(page, truncated, nextCursor)
    } catch (err: any) {
      ctx.status = 500; ctx.body = { error: err.message }
    }
    return
  }

  if (logName === 'webui') {
    try {
      if (!existsSync(WEBUI_LOG_FILE)) { ctx.body = response([]); return }
      const tail = await readTailLines(WEBUI_LOG_FILE)
      const sliced = tail.lines.slice(-(lines + 1))
      const entries: LogEntry[] = []
      for (const line of sliced) { if (!line.trim()) continue; entries.push(parseLine(line, includeRaw)) }
      const filtered = filterSince(entries, parsedSince)
      const truncated = filtered.length > lines || tail.truncated
      ctx.body = response((truncated ? filtered.slice(-lines) : filtered).reverse(), truncated)
    } catch (err: any) {
      ctx.status = 500; ctx.body = { error: err.message }
    }
    return
  }

  if (logName === 'bridge') {
    try {
      if (!existsSync(BRIDGE_LOG_FILE)) { ctx.body = response([]); return }
      const tail = await readTailLines(BRIDGE_LOG_FILE)
      const sliced = tail.lines.slice(-(lines + 1))
      const entries: LogEntry[] = []
      for (const line of sliced) { if (!line.trim()) continue; entries.push(parseLine(line, includeRaw)) }
      const filtered = filterSince(entries, parsedSince)
      const truncated = filtered.length > lines || tail.truncated
      ctx.body = response((truncated ? filtered.slice(-lines) : filtered).reverse(), truncated)
    } catch (err: any) {
      ctx.status = 500; ctx.body = { error: err.message }
    }
    return
  }

  if (!isHermesAgentAvailable()) {
    ctx.body = response([])
    return
  }

  try {
    if (parsedSince?.future) { ctx.body = response([]); return }
    const content = await readPrimaryAgentLogs(logName, lines + 1, level, session, parsedSince?.cliValue)
    const rawLines = content.split('\n')
    const entries: LogEntry[] = []
    for (const line of rawLines) {
      if (line.startsWith('---') || line.trim() === '') continue
      entries.push(parseLine(line, includeRaw))
    }
    const filtered = filterSince(entries, parsedSince)
    const page = filtered.slice(-lines).reverse()
    ctx.body = response(page, filtered.length > lines)
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
}
