import { request } from '../client'

export interface LogFileInfo {
  name: string
  size: string
  modified: string
}

export interface LogEntry {
  timestamp: string
  level: string
  logger: string
  message: string
  raw: string
}

export async function fetchLogFiles(): Promise<LogFileInfo[]> {
  const res = await request<{ files: LogFileInfo[] }>('/api/studio/logs')
  return res.files
}

export async function fetchLogs(name: string, params?: {
  lines?: number
  level?: string
  session?: string
  since?: string
  run?: string
  category?: string
  event?: string
  text?: string
}): Promise<LogEntry[]> {
  const query = new URLSearchParams()
  if (params?.lines) query.set('lines', String(params.lines))
  if (params?.level) query.set('level', params.level)
  if (params?.session) query.set('session', params.session)
  if (params?.since) query.set('since', params.since)
  if (params?.run) query.set('run', params.run)
  if (params?.category) query.set('category', params.category)
  if (params?.event) query.set('event', params.event)
  if (params?.text) query.set('text', params.text)
  const qs = query.toString()
  const res = await request<{ entries: (LogEntry | null)[] }>(`/api/studio/logs/${name}${qs ? `?${qs}` : ''}`)
  return res.entries.filter((e): e is LogEntry => e !== null)
}
