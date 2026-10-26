import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { BrowserDownloadHistory } from '../../packages/desktop/src/main/browser/browser-download-history'
import type { DesktopBrowserDownload } from '../../packages/desktop/src/main/browser/browser-types'
const roots: string[] = []
function setup() { const root = mkdtempSync(join(tmpdir(), 'download-history-')); roots.push(root); return { root, store: new BrowserDownloadHistory(root) } }
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
const record: DesktopBrowserDownload = { id: 'd1', profileId: 'p1', fileName: 'report.zip', sourceUrl: 'https://test/report.zip', savePath: join(tmpdir(), 'report.zip'), receivedBytes: 20, totalBytes: 20, state: 'completed', startedAt: '2026-10-25T10:00:00Z' }
const identity = { dev: 1, ino: 2, size: 20, mtimeMs: 1234 }
it('restores history and original file identity after a new store is created', () => {
  const { root, store } = setup()
  store.save([record], new Map([['d1', identity]]))
  expect(new BrowserDownloadHistory(root).load(new Set(['p1']))).toEqual([{ download: record, identity }])
  if (process.platform !== 'win32') expect(statSync(join(root, 'download-history.json')).mode & 0o777).toBe(0o600)
})
it('isolates device roots and filters unknown/deleted profiles', () => {
  const a = setup(), b = setup()
  a.store.save([record, { ...record, id: 'd2', profileId: 'p2' }], new Map())
  expect(b.store.load(new Set(['p1']))).toEqual([])
  expect(a.store.load(new Set(['p1'])).map(r => r.download.id)).toEqual(['d1'])
  expect(a.store.load(new Set())).toEqual([])
})
it('marks interrupted transfers on restart and never grants file actions without an original identity', () => {
  const { store } = setup()
  store.save([record, { ...record, id: 'active', state: 'progressing' }], new Map())
  const loaded = store.load(new Set(['p1']))
  expect(loaded[0].download.fileAvailable).toBe(false)
  expect(loaded[1].download.state).toBe('interrupted')
})
it('persists clearing without touching a downloaded file', () => {
  const { root, store } = setup(), file = join(root, 'kept.zip')
  writeFileSync(file, 'kept')
  store.save([{ ...record, savePath: file }], new Map([['d1', identity]]))
  store.save([], new Map())
  expect(new BrowserDownloadHistory(root).load(new Set(['p1']))).toEqual([])
  expect(readFileSync(file, 'utf8')).toBe('kept')
})
it('rejects corrupt/oversized/invalid records, duplicate ids and relative paths', () => {
  const { root, store } = setup(), file = join(root, 'download-history.json')
  writeFileSync(file, '{')
  expect(store.load(new Set(['p1']))).toEqual([])
  writeFileSync(file, JSON.stringify({ schema: 1, records: [
    { download: { ...record, savePath: 'relative' } }, { download: { ...record, totalBytes: -1 } },
    { download: record, identity }, { download: record, identity },
  ] }))
  expect(store.load(new Set(['p1']))).toHaveLength(1)
  writeFileSync(file, 'x'.repeat(8 * 1024 * 1024 + 1))
  expect(store.load(new Set(['p1']))).toEqual([])
})
