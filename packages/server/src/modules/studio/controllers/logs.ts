import { existsSync, statSync } from 'fs'
import { readFile } from 'fs/promises'
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
  timestamp: string; level: string; logger: string; message: string; raw: string
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

function parseLine(line: string): LogEntry {
  try {
    const obj = JSON.parse(line)
    if (obj.level && obj.time) {
      const ts = new Date(obj.time).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
      const levelMap: Record<number, string> = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' }
      // Pino 日志格式: { level, time, msg, name (logger name), hostname, pid, ... }
      const loggerName = obj.name || obj.logger || 'app'
      const message = obj.msg || (obj.err ? obj.err.message : '')
      const baseMessage = typeof message === 'string' ? message : JSON.stringify(message)
      return { timestamp: ts, level: levelMap[obj.level] || 'INFO', logger: loggerName, message: appendPinoContext(baseMessage, obj), raw: line }
    }
  } catch {}
  let match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3})\s+(DEBUG|INFO|WARNING|ERROR|CRITICAL)\s+(\S+?):\s(.*)$/)
  if (match) { return { timestamp: match[1], level: match[2], logger: match[3], message: match[4], raw: line } }
  match = line.match(/^\[(\S+?)\]\s+\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3})\]\s+\[(DEBUG|INFO|WARNING|ERROR|CRITICAL)\]\s(.*)$/)
  if (match) { return { timestamp: match[2], level: match[3], logger: match[1], message: match[4], raw: line } }
  return { timestamp: '', level: '', logger: '', message: line, raw: line }
}

function requestedProfile(ctx: any): string {
  return String(ctx.state?.profile?.name || ctx.query?.profile || 'default').trim() || 'default'
}

function displaySize(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${(bytes / 1024).toFixed(1)}KB`
}

function ekkoLogEntry(record: AgentLogRecord): LogEntry {
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
    raw: JSON.stringify(record),
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
  const lines = ctx.query.lines ? parseInt(ctx.query.lines as string, 10) : 100
  const level = (ctx.query.level as string) || undefined
  const session = (ctx.query.session as string) || undefined
  const since = (ctx.query.since as string) || undefined

  if (logName === 'ekko-agent') {
    try {
      const ekkoReader = getEkkoLogSource(requestedProfile(ctx))
      if (!ekkoReader) { ctx.body = { entries: [] }; return }
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
        after: since,
        limit: Number.isFinite(lines) && lines > 0 ? lines : 100,
      })
      ctx.body = { entries: records.map(ekkoLogEntry).reverse() }
    } catch (err: any) {
      ctx.status = 500; ctx.body = { error: err.message }
    }
    return
  }

  if (logName === 'webui') {
    try {
      if (!existsSync(WEBUI_LOG_FILE)) { ctx.body = { entries: [] }; return }
      const content = await readFile(WEBUI_LOG_FILE, 'utf-8')
      const rawLines = content.split('\n')
      const sliced = rawLines.length > lines ? rawLines.slice(-lines) : rawLines
      const entries: LogEntry[] = []
      for (const line of sliced) { if (!line.trim()) continue; entries.push(parseLine(line)) }
      ctx.body = { entries: entries.reverse() }
    } catch (err: any) {
      ctx.status = 500; ctx.body = { error: err.message }
    }
    return
  }

  if (logName === 'bridge') {
    try {
      if (!existsSync(BRIDGE_LOG_FILE)) { ctx.body = { entries: [] }; return }
      const content = await readFile(BRIDGE_LOG_FILE, 'utf-8')
      const rawLines = content.split('\n')
      const sliced = rawLines.length > lines ? rawLines.slice(-lines) : rawLines
      const entries: LogEntry[] = []
      for (const line of sliced) { if (!line.trim()) continue; entries.push(parseLine(line)) }
      ctx.body = { entries: entries.reverse() }
    } catch (err: any) {
      ctx.status = 500; ctx.body = { error: err.message }
    }
    return
  }

  if (!isHermesAgentAvailable()) {
    ctx.body = { entries: [] }
    return
  }

  try {
    const content = await readPrimaryAgentLogs(logName, lines, level, session, since)
    const rawLines = content.split('\n')
    const entries: (LogEntry | null)[] = []
    for (const line of rawLines) {
      if (line.startsWith('---') || line.trim() === '') continue
      entries.push(parseLine(line))
    }
    ctx.body = { entries: entries.reverse() }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
}
