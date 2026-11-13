/**
 * Task-12 server: USB scan (fts_only + mount reconcile) and semi-auto
 * task-finalize archive (metadata_only + source stamping + dedup).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { ensureKnowledgeSchema } from '../../packages/server/src/modules/studio/infrastructure/database/knowledge-schema'
import { KnowledgeService } from '../../packages/server/src/modules/studio/services/knowledge/knowledge.service'
import { scanUsbVolume, reconcileUsbMounts, listUsbVolumes } from '../../packages/server/src/modules/studio/services/knowledge/usb-scanner'
import { archiveTaskFiles } from '../../packages/server/src/modules/studio/services/knowledge/task-archive'

let base: string
let home: string
let mountPath: string
let workspace: string
let db: DatabaseSync
let service: KnowledgeService

const SUPPORTED = ['.txt', '.md']

function freshService(): KnowledgeService {
  const d = new DatabaseSync(':memory:')
  ensureKnowledgeSchema(d, 4, 'test-model')
  return new KnowledgeService(d, {
    embedDim: 4, embedModel: 'test-model', supportedExtensions: SUPPORTED,
    maxFileSizeBytes: 10 * 1024 * 1024, chunkSize: 200, chunkOverlap: 20, chunkFallbackSize: 200,
    queueDepth: 100,
  } as any)
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'kn-usb-'))
  home = join(base, 'home')
  mountPath = join(home, 'mnt', 'usb', 'STICK1')
  workspace = join(base, 'workspace')
  mkdirSync(mountPath, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(mountPath, 'notes.txt'), 'hello removable world ' + 'a'.repeat(300), 'utf-8')
  writeFileSync(join(workspace, 'report.md'), '# Task Report\ncontent here', 'utf-8')
  service = freshService()
})

afterAll(() => { rmSync(base, { recursive: true, force: true }) })

describe('usb scanner', () => {
  it('discovers mounted volumes under mnt/usb/<uuid>', () => {
    const vols = listUsbVolumes({}, home)
    expect(vols.map(v => v.uuid)).toContain('STICK1')
  })

  it('scan creates a kind=usb vault and queues fts_only ingest', async () => {
    const vols = listUsbVolumes({}, home)
    const result = scanUsbVolume(service, vols[0], SUPPORTED)
    expect(result.status).toBe('scanning')
    expect(result.documentsQueued).toBeGreaterThanOrEqual(1)
    const vault = service.findVaultByPath(mountPath)
    expect(vault?.kind).toBe('usb')
    // Give the single-writer queue a moment to run ftsOnlyIngest.
    await new Promise(r => setTimeout(r, 300))
    const docs = service.listDocuments(vault!.id)
    expect(docs.length).toBeGreaterThanOrEqual(1)
    expect(docs.every(d => d.status === 'fts_only')).toBe(true)
  })

  it('re-mount after unplug: demote to unmounted, then restore to fts_only', () => {
    const vault = service.findVaultByPath(mountPath)!
    // Simulate an unplug by removing the actual mount directory that the
    // vault root_path points at; reconcile keys on path existence.
    rmSync(mountPath, { recursive: true, force: true })
    const demote = reconcileUsbMounts(service)
    expect(demote.demoted).toBeGreaterThanOrEqual(1)
    expect(service.listDocuments(vault.id).every(d => d.status === 'unmounted')).toBe(true)
    // Re-mount: recreate the directory; restore flips status back, and the
    // persisted chunks mean no re-extraction is required.
    mkdirSync(mountPath, { recursive: true })
    const restore = reconcileUsbMounts(service)
    expect(restore.restored).toBeGreaterThanOrEqual(1)
    expect(service.listDocuments(vault.id).every(d => d.status === 'fts_only')).toBe(true)
  })
})

describe('task archive', () => {
  it('archives task files as metadata_only with source=task-finalize, dedups re-runs', async () => {
    const s = freshService()
    const res1 = await archiveTaskFiles(s, { workspaceRoot: workspace, files: [join(workspace, 'report.md')] })
    expect(res1.archived).toHaveLength(1)
    const docId = res1.archived[0].documentId
    const vault = s.findVaultByPath(workspace)!
    expect(vault.kind).toBe('auto')
    const docs = s.listDocuments(vault.id)
    expect(docs.find(d => d.id === docId)?.status).toBe('metadata_only')
    // dedup: second archive of same path reports skipped(already_recorded)
    const res2 = await archiveTaskFiles(s, { workspaceRoot: workspace, files: [join(workspace, 'report.md')] })
    expect(res2.archived).toHaveLength(0)
    expect(res2.skipped[0]?.reason).toBe('already_recorded')
    // source stamping observable
    const row = (s as any).db.prepare('SELECT source FROM knowledge_documents WHERE id = ?').get(docId)
    expect(row.source).toBe('task-finalize')
  })

  it('skips missing files', async () => {
    const s = freshService()
    const res = await archiveTaskFiles(s, { workspaceRoot: workspace, files: [join(workspace, 'nope.txt')] })
    expect(res.archived).toHaveLength(0)
    expect(res.skipped[0]?.reason).toBe('not_found')
    expect(existsSync(join(workspace, 'nope.txt'))).toBe(false)
  })
})
