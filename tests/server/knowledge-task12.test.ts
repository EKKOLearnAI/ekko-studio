/**
 * Task-12 (v0.8.9) server invariants:
 *   - default-vault bootstrap: creates four, idempotent, `off` skips
 *   - addVault: flat 8-vault ceiling + unique root_path (typed 409 codes)
 *   - dir-browser: allowlist enforcement, traversal → ForbiddenPathError
 *   - quota: warn/downgrade/hard thresholds on a synthetic byte count
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { ensureKnowledgeSchema } from '../../packages/server/src/modules/studio/infrastructure/database/knowledge-schema'
import {
  KnowledgeService,
  VaultLimitError,
  VaultPathInUseError,
  MAX_KNOWLEDGE_VAULTS,
} from '../../packages/server/src/modules/studio/services/knowledge/knowledge.service'
import {
  bootstrapDefaultVaults,
  planDefaultVaults,
  resolveDefaultVaultsMode,
} from '../../packages/server/src/modules/studio/services/knowledge/bootstrap'
import { allowedRoots, assertAllowed, ForbiddenPathError, listDirs } from '../../packages/server/src/modules/studio/services/knowledge/dir-browser'
import { computeKnowledgeQuota } from '../../packages/server/src/modules/studio/services/knowledge/quota'

let dir: string
let db: DatabaseSync
let service: KnowledgeService

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kn-task12-'))
  db = new DatabaseSync(join(dir, 'test.db'))
  ensureKnowledgeSchema(db, 4, 'test-model')
  service = {
    db,
    addVault: (rootPath: string, name: string, kind: any = 'manual') => {
      db.prepare('INSERT INTO knowledge_vaults (root_path, name, kind, watch, created_at) VALUES (?, ?, ?, 1, ?)')
        .run(rootPath, name, kind, Date.now())
      return db.prepare('SELECT * FROM knowledge_vaults WHERE root_path = ?').get(rootPath)
    },
    listVaults: () => db.prepare('SELECT * FROM knowledge_vaults ORDER BY id').all(),
  } as unknown as KnowledgeService
})

afterAll(() => {
  try { db.close() } catch { /* ignore */ }
  rmSync(dir, { recursive: true, force: true })
})

describe('default-vault bootstrap', () => {
  const roots = () => ({
    uploadDir: join(dir, 'upload'),
    meetingsDir: join(dir, 'meetings'),
    hermesDataDir: join(dir, 'hermes_data'),
    profile: 'p1',
  })

  it('plan contains exactly the four binding vaults', () => {
    const plans = planDefaultVaults(roots())
    expect(plans.map(p => p.name).sort()).toEqual(
      ['Agent 工作区', '会议记录', '我的上传', '用户笔记'],
    )
  })

  it('mode defaults to auto; off skips', () => {
    expect(resolveDefaultVaultsMode({})).toBe('auto')
    expect(resolveDefaultVaultsMode({ KNOWLEDGE_DEFAULT_VAULTS: 'off' })).toBe('off')
  })

  it('creates all four, mkdir -p for ensureDir paths', () => {
    const res = bootstrapDefaultVaults(service, { roots: roots(), mode: 'auto' })
    expect(res.created).toHaveLength(4)
    expect(res.failed).toHaveLength(0)
    expect((service.listVaults() as any[]).every(v => v.kind === 'auto')).toBe(true)
  })

  it('second run is idempotent (all skipped)', () => {
    const res = bootstrapDefaultVaults(service, { roots: roots(), mode: 'auto' })
    expect(res.created).toHaveLength(0)
    expect(res.skipped).toHaveLength(4)
  })
})

describe('addVault ceiling + unique', () => {
  it('enforces MAX_KNOWLEDGE_VAULTS', () => {
    const d2 = new DatabaseSync(join(dir, 'ceiling.db'))
    ensureKnowledgeSchema(d2, 4, 'test-model')
    const svc = new KnowledgeService(d2, { embedDim: 4, embedModel: 'test-model' } as any)
    try {
      for (let i = 0; i < MAX_KNOWLEDGE_VAULTS; i++) {
        svc.addVault(`/vault/${i}`, `v${i}`, 'manual')
      }
      expect(() => svc.addVault('/vault/overflow', 'over', 'manual')).toThrow(VaultLimitError)
    } finally {
      d2.close()
    }
  })

  it('rejects duplicate root_path with a typed error', () => {
    const d2b = new DatabaseSync(join(dir, 'dup.db'))
    ensureKnowledgeSchema(d2b, 4, 'test-model')
    const svc = new KnowledgeService(d2b, { embedDim: 4, embedModel: 'test-model' } as any)
    try {
      svc.addVault('/vault/x', 'x', 'manual')
      expect(() => svc.addVault('/vault/x', 'dupe', 'manual')).toThrow(VaultPathInUseError)
    } finally {
      d2b.close()
    }
  })
})

describe('dir-browser allowlist', () => {
  const fakeFs = (files: Record<string, string[]>) => ({
    exists: (p: string) => p in files || p === '/home' || p === '/data',
    realpath: (p: string) => p,
    readdir: (p: string) => files[p] ?? [],
    stat: (p: string) => ({
      isDirectory: () => !p.endsWith('.txt'),
      size: 10,
      mtimeMs: 1,
    }),
  })

  it('rejects traversal and out-of-allowlist paths', () => {
    const fsx = fakeFs({})
    const roots = ['/home']
    expect(() => assertAllowed('/etc/passwd', roots, fsx as any)).toThrow(ForbiddenPathError)
    expect(() => assertAllowed('/home/../etc', roots, fsx as any)).toThrow(/traversal/)
    expect(() => assertAllowed('relative/path', roots, fsx as any)).toThrow(/absolute/)
  })

  it('lists dirs within an allowed root, folders first, dotfiles hidden', () => {
    const fsx = fakeFs({ '/home': ['b.txt', 'a_dir', '.hidden'] })
    const listing = listDirs('/home', {
      homeRoot: '/home',
      usbRoots: [],
      fs: fsx as any,
    })
    expect(listing.entries.map(e => e.name)).toEqual(['a_dir', 'b.txt'])
    expect(listing.entries[0].isDir).toBe(true)
  })

  it('extra roots are only allowed when present', () => {
    const fsx = fakeFs({})
    const roots = allowedRoots({}, { homeRoot: '/home', usbRoots: [], fs: fsx as any })
    expect(roots).toContain('/home')
    expect(roots).toContain('/data')      // exists in fakeFs
    expect(roots).not.toContain('/sdcard') // not present
  })
})

describe('quota thresholds', () => {
  it('computes warn/downgrade/hard from chunk bytes against an injected budget', () => {
    const d3 = new DatabaseSync(':memory:')
    ensureKnowledgeSchema(d3, 4, 'test-model')
    d3.prepare("INSERT INTO knowledge_vaults (root_path, name, kind, watch, created_at) VALUES ('/q','q','auto',1,0)").run()
    d3.prepare("INSERT INTO knowledge_documents (source_path, source_hash, vault_id, mime_type, size_bytes, mtime, indexed_at, status) VALUES ('/q/a','h',1,'text/plain',0,0,0,'indexed')").run()
    const unit = 210
    const big = 'x'.repeat(unit)
    const insert = d3.prepare('INSERT INTO knowledge_chunks (document_id, position, content, token_count) VALUES (1, ?, ?, 1)')
    for (let i = 0; i < 4; i++) insert.run(i, big)

    // Measure the baseline byte count against an effectively-unlimited
    // budget, then choose budgets that place the ratio in each band. This
    // is independent of page/dbstat overhead, so it is stable across the
    // SQLite builds (page sizes differ, ratios do not).
    const base = computeKnowledgeQuota(d3, Number.MAX_SAFE_INTEGER).totalBytes
    expect(base).toBeGreaterThan(0)

    const warn = computeKnowledgeQuota(d3, Math.round(base / 0.85))
    expect(warn.warn).toBe(true)
    expect(warn.downgrade).toBe(false)
    expect(warn.hardLimitReached).toBe(false)
    expect(warn.vaultCount).toBe(1)

    const downgrade = computeKnowledgeQuota(d3, Math.round(base / 0.95))
    expect(downgrade.downgrade).toBe(true)
    expect(downgrade.hardLimitReached).toBe(false)

    const hard = computeKnowledgeQuota(d3, Math.round(base / 1.5))
    expect(hard.hardLimitReached).toBe(true)
    d3.close()
  })
})
