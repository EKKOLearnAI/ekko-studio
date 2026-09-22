import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { SaveWorkspaceRunChangeInput } from '../../packages/server/src/db/hermes/workspace-run-changes-store'

const state = vi.hoisted(() => ({
  db: null as DatabaseSync | null,
  appHome: '',
}))

vi.mock('../../packages/server/src/db/index', () => ({
  getDb: () => state.db,
  isSqliteAvailable: () => Boolean(state.db),
  jsonDelete: vi.fn(),
  jsonGet: vi.fn(),
  jsonGetAll: vi.fn(() => ({})),
  jsonSet: vi.fn(),
}))

vi.mock('../../packages/server/src/config', () => ({
  config: {
    appHome: state.appHome,
  },
}))

// #2404: overlapping runs sharing one workspace attribute the same physical
// change to every concurrently-active run (the run-end diff scans the whole
// shared directory). The store must dedupe directory-diff echoes so a file
// written by session B is recorded only under session B, never under the
// concurrently-running session A.
describe('workspace run-change dedupe (#2404)', () => {
  let root: string

  beforeEach(async () => {
    vi.resetModules()
    root = mkdtempSync(join(tmpdir(), 'hermes-run-change-dedupe-'))
    state.appHome = join(root, 'home')
    state.db = new DatabaseSync(join(root, 'diffs.db'))
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()
  })

  afterEach(() => {
    state.db?.close()
    state.db = null
    rmSync(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const baseChange = (over: Partial<SaveWorkspaceRunChangeInput>): SaveWorkspaceRunChangeInput => ({
    change_id: `run:${Math.random().toString(36).slice(2)}`,
    session_id: 'session-a',
    run_id: 'run-a',
    workspace: '/shared/workspace',
    workspace_kind: 'filesystem',
    started_at: 1000,
    finished_at: 2000,
    files_changed: 1,
    additions: 122,
    deletions: 0,
    total_patch_bytes: 300,
    files: [{
      path: 'notes/migration.md',
      change_type: 'added',
      additions: 122,
      deletions: 0,
      size_before: null,
      size_after: 6197,
      patch_bytes: 300,
      truncated: false,
      binary: false,
    }],
    ...over,
  })

  it('records a unique change normally', async () => {
    const { saveWorkspaceRunChange } = await import('../../packages/server/src/db/hermes/workspace-run-changes-store')
    const saved = saveWorkspaceRunChange(baseChange({}))
    expect(saved).not.toBeNull()
    expect(saved!.files_changed).toBe(1)
    expect(saved!.session_id).toBe('session-a')
  })

  it('drops the second run when the identical physical change is already attributed to another run', async () => {
    const { saveWorkspaceRunChange, listWorkspaceRunChangesForSession } = await import('../../packages/server/src/db/hermes/workspace-run-changes-store')

    // Session B actually wrote the file (its own run recorded it first).
    const first = saveWorkspaceRunChange(baseChange({
      change_id: 'run:b-wrote-the-file',
      session_id: 'session-b',
      run_id: 'run-b',
    }))
    expect(first).not.toBeNull()
    expect(first!.files_changed).toBe(1)

    // Session A ran concurrently over the same workspace; its run-end diff
    // echoes the same physical change. It must NOT be attributed to A.
    const echo = saveWorkspaceRunChange(baseChange({
      change_id: 'run:a-echoed-it',
      session_id: 'session-a',
      run_id: 'run-a',
    }))
    expect(echo).toBeNull()
    expect(listWorkspaceRunChangesForSession('session-a')).toHaveLength(0)
    expect(listWorkspaceRunChangesForSession('session-b')).toHaveLength(1)
  })

  it('keeps non-duplicate files of a partially-echoed run', async () => {
    const { saveWorkspaceRunChange, listWorkspaceRunChangesForSession } = await import('../../packages/server/src/db/hermes/workspace-run-changes-store')

    saveWorkspaceRunChange(baseChange({
      change_id: 'run:b-owns-migration',
      session_id: 'session-b',
      run_id: 'run-b',
    }))

    const partial = saveWorkspaceRunChange(baseChange({
      change_id: 'run:a-partial',
      session_id: 'session-a',
      run_id: 'run-a',
      files: [
        // Echo of B's write — must be dropped.
        {
          path: 'notes/migration.md',
          change_type: 'added',
          additions: 122,
          deletions: 0,
          size_before: null,
          size_after: 6197,
          patch_bytes: 300,
          truncated: false,
          binary: false,
        },
        // A genuinely different file A itself created — must survive.
        {
          path: 'video/ducking.tsx',
          change_type: 'modified',
          additions: 3,
          deletions: 1,
          size_before: 120,
          size_after: 160,
          patch_bytes: 40,
          truncated: false,
          binary: false,
        },
      ],
      files_changed: 2,
      additions: 125,
      deletions: 1,
      total_patch_bytes: 340,
    }))
    expect(partial).not.toBeNull()
    expect(partial!.files_changed).toBe(1)
    expect(partial!.files.map(f => f.path)).toEqual(['video/ducking.tsx'])
    expect(partial!.additions).toBe(3)
    expect(partial!.deletions).toBe(1)

    const aChanges = listWorkspaceRunChangesForSession('session-a')
    expect(aChanges).toHaveLength(1)
    expect(aChanges[0].files.map(f => f.path)).toEqual(['video/ducking.tsx'])
  })

  it('does not dedupe the same file when the sizes differ (real modification, not echo)', async () => {
    const { saveWorkspaceRunChange, listWorkspaceRunChangesForSession } = await import('../../packages/server/src/db/hermes/workspace-run-changes-store')

    saveWorkspaceRunChange(baseChange({
      change_id: 'run:b-first-edit',
      session_id: 'session-b',
      run_id: 'run-b',
      files: [{
        path: 'shared.txt',
        change_type: 'modified',
        additions: 2,
        deletions: 0,
        size_before: 10,
        size_after: 12,
        patch_bytes: 20,
        truncated: false,
        binary: false,
      }],
      additions: 2,
      total_patch_bytes: 20,
    }))

    // A later, genuinely different modification of the same file: same path,
    // different sizes → not an echo, must be recorded.
    const later = saveWorkspaceRunChange(baseChange({
      change_id: 'run:c-second-edit',
      session_id: 'session-c',
      run_id: 'run-c',
      files: [{
        path: 'shared.txt',
        change_type: 'modified',
        additions: 5,
        deletions: 2,
        size_before: 12,
        size_after: 30,
        patch_bytes: 60,
        truncated: false,
        binary: false,
      }],
      additions: 5,
      deletions: 2,
      total_patch_bytes: 60,
    }))
    expect(later).not.toBeNull()
    expect(listWorkspaceRunChangesForSession('session-c')).toHaveLength(1)
    expect(listWorkspaceRunChangesForSession('session-b')).toHaveLength(1)
  })
})
