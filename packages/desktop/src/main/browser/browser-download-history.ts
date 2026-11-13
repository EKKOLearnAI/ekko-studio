import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DesktopBrowserDownload } from './browser-types'

const MAX_RECORDS = 2000
const MAX_BYTES = 8 * 1024 * 1024
export interface DownloadFileIdentity { dev: number; ino: number; size: number; mtimeMs: number }
interface HistoryRecord { download: DesktopBrowserDownload; identity?: DownloadFileIdentity }

/** Local to the Desktop device's browser state root, never the remote Web UI or a shared profile path. */
export class BrowserDownloadHistory {
  private readonly file: string
  constructor(private readonly root: string) { this.file = join(root, 'download-history.json') }

  load(profileIds: Set<string>): HistoryRecord[] {
    let parsed: unknown
    try {
      if (statSync(this.file).size > MAX_BYTES) throw new Error('Download history is too large')
      parsed = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[desktop-browser] unable to read download history:', error)
      return []
    }
    if (!parsed || typeof parsed !== 'object' || (parsed as { schema?: unknown }).schema !== 1
      || !Array.isArray((parsed as { records?: unknown }).records)) return []
    const result: HistoryRecord[] = [], seen = new Set<string>()
    for (const entry of (parsed as { records: unknown[] }).records.slice(0, MAX_RECORDS)) {
      if (!entry || typeof entry !== 'object') continue
      const { download: value, identity } = entry as { download?: unknown; identity?: unknown }
      if (!value || typeof value !== 'object') continue
      const d = value as DesktopBrowserDownload
      if (typeof d.id !== 'string' || !d.id || d.id.length > 200 || seen.has(d.id)
        || !profileIds.has(d.profileId) || typeof d.fileName !== 'string' || d.fileName.length > 4096
        || typeof d.sourceUrl !== 'string' || d.sourceUrl.length > 16384
        || !['blocked', 'progressing', 'completed', 'cancelled', 'interrupted'].includes(d.state)
        || typeof d.startedAt !== 'string' || !Number.isFinite(Date.parse(d.startedAt))
        || !Number.isFinite(d.receivedBytes) || d.receivedBytes < 0 || !Number.isFinite(d.totalBytes) || d.totalBytes < 0
        || (d.savePath !== undefined && (typeof d.savePath !== 'string' || !isAbsolute(d.savePath)))) continue
      const record: HistoryRecord = { download: {
        id: d.id, profileId: d.profileId, fileName: d.fileName, sourceUrl: d.sourceUrl,
        savePath: d.savePath, receivedBytes: d.receivedBytes, totalBytes: d.totalBytes,
        state: d.state === 'progressing' ? 'interrupted' : d.state, startedAt: d.startedAt,
      } }
      const i = identity as DownloadFileIdentity | undefined
      if (i && ['dev', 'ino', 'size', 'mtimeMs'].every(key => typeof i[key as keyof DownloadFileIdentity] === 'number'
        && Number.isFinite(i[key as keyof DownloadFileIdentity]))) {
        record.identity = { dev: i.dev, ino: i.ino, size: i.size, mtimeMs: i.mtimeMs }
      }
      // Without the original completion identity, no persisted path may acquire file-action authority.
      if (record.download.state === 'completed' && !record.identity) record.download.fileAvailable = false
      seen.add(d.id); result.push(record)
    }
    return result
  }

  save(downloads: DesktopBrowserDownload[], identities: Map<string, DownloadFileIdentity>): void {
    const records: HistoryRecord[] = []
    let bytes = 0
    for (const d of downloads.slice(0, MAX_RECORDS)) {
      const identity = identities.get(d.id)
      const record = { download: { ...d }, identity: identity
        ? { dev: identity.dev, ino: identity.ino, size: identity.size, mtimeMs: identity.mtimeMs } : undefined }
      const size = Buffer.byteLength(JSON.stringify(record))
      if (bytes + size > MAX_BYTES - 1024) break
      bytes += size; records.push(record)
    }
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify({ schema: 1, records }), { mode: 0o600 })
      renameSync(temporary, this.file)
      chmodSync(this.file, 0o600)
    } finally { rmSync(temporary, { force: true }) }
  }
}
