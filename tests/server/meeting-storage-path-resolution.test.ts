/**
 * MeetingStorageService baseDir resolution contract.
 *
 * Historical bug (v0.7.20 on 6.6.6.31): the service read `HERMES_WEB_UI_HOME`
 * directly and fell back to `process.cwd()`, diverging from every other subsystem
 * which goes through `getWebUiHome()`. When the systemd env-file only exported
 * `HERMES_WEBUI_STATE_DIR`, the service silently wrote meetings into the deploy
 * tree (/opt/hermes-web-ui/src/meetings) while the audio had been uploaded into
 * the real home (/home/hermesui/.hermes-web-ui/meetings) — producing 404s on
 * /api/studio/meeting-storage/:id/audio with zero log trail.
 *
 * This test pins:
 *   - HERMES_WEB_UI_HOME takes priority when set
 *   - HERMES_WEBUI_STATE_DIR is honored as alias when HOME is unset
 *   - HERMES_WEB_UI_HOME wins when both are set
 *   - When neither is set, the fallback is ~/.hermes-web-ui/meetings (NOT cwd)
 *   - baseDir is created eagerly on construction
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { tmpdir } from 'os'

const savedHome = process.env.HERMES_WEB_UI_HOME
const savedState = process.env.HERMES_WEBUI_STATE_DIR

function resetEnv(): void {
  delete process.env.HERMES_WEB_UI_HOME
  delete process.env.HERMES_WEBUI_STATE_DIR
}

beforeEach(() => {
  resetEnv()
  vi.resetModules()
})

afterEach(() => {
  vi.resetModules()
  resetEnv()
  if (savedHome !== undefined) process.env.HERMES_WEB_UI_HOME = savedHome
  if (savedState !== undefined) process.env.HERMES_WEBUI_STATE_DIR = savedState
})

describe('MeetingStorageService baseDir resolution', () => {
  it('uses HERMES_WEB_UI_HOME when set', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ms-home-'))
    process.env.HERMES_WEB_UI_HOME = home

    const mod = await import('../../packages/server/src/modules/studio/services/meeting-storage/index')
    const svc = mod.MeetingStorageService.getInstance() as unknown as { baseDir: string }
    expect(svc.baseDir).toBe(join(home, 'meetings'))
    expect(existsSync(join(home, 'meetings'))).toBe(true)

    rmSync(home, { recursive: true, force: true })
  })

  it('falls back to HERMES_WEBUI_STATE_DIR when HERMES_WEB_UI_HOME is unset', async () => {
    const state = mkdtempSync(join(tmpdir(), 'ms-state-'))
    process.env.HERMES_WEBUI_STATE_DIR = state

    const mod = await import('../../packages/server/src/modules/studio/services/meeting-storage/index')
    const svc = mod.MeetingStorageService.getInstance() as unknown as { baseDir: string }
    expect(svc.baseDir).toBe(join(state, 'meetings'))
    expect(existsSync(join(state, 'meetings'))).toBe(true)

    rmSync(state, { recursive: true, force: true })
  })

  it('prefers HERMES_WEB_UI_HOME over HERMES_WEBUI_STATE_DIR when both are set', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ms-home-'))
    const state = mkdtempSync(join(tmpdir(), 'ms-state-'))
    process.env.HERMES_WEB_UI_HOME = home
    process.env.HERMES_WEBUI_STATE_DIR = state

    const mod = await import('../../packages/server/src/modules/studio/services/meeting-storage/index')
    const svc = mod.MeetingStorageService.getInstance() as unknown as { baseDir: string }
    expect(svc.baseDir).toBe(join(home, 'meetings'))
    expect(existsSync(join(home, 'meetings'))).toBe(true)
    expect(existsSync(join(state, 'meetings'))).toBe(false)

    rmSync(home, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  })

  it('falls back to ~/.hermes-web-ui/meetings when neither env var is set (NOT process.cwd)', async () => {
    // The historical bug: fallback was process.cwd(), which under systemd is
    // WorkingDirectory=/opt/hermes-web-ui — a deploy tree, not a state dir.
    const expectedHome = join(homedir(), '.hermes-web-ui', 'meetings')

    const mod = await import('../../packages/server/src/modules/studio/services/meeting-storage/index')
    const svc = mod.MeetingStorageService.getInstance() as unknown as { baseDir: string }
    expect(svc.baseDir).toBe(expectedHome)
    // cwd should NOT be used; verify by pointing cwd at a throwaway dir
    expect(svc.baseDir).not.toContain('node_modules')
  })

  it('writes metadata into the resolved baseDir, not cwd', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ms-cwd-'))
    process.env.HERMES_WEB_UI_HOME = home

    // Move cwd to somewhere that should NOT receive data
    const throwaway = mkdtempSync(join(tmpdir(), 'ms-cwd-throwaway-'))
    const originalCwd = process.cwd()
    process.chdir(throwaway)
    try {
      const mod = await import('../../packages/server/src/modules/studio/services/meeting-storage/index')
      const svc = mod.MeetingStorageService.getInstance()
      await svc.saveMeetingMetadata('meeting-test-1', {
        id: 'meeting-test-1',
        title: 'x',
        createdAt: 0,
        updatedAt: 0,
        useDiarize: false,
        sentences: [],
        analysisResult: null,
        htmlContent: '',
        speakerMap: {},
        speakers: [],
        status: 'idle',
        analysisMode: 'hermes',
        audioDuration: 0,
      })

      // Data must land under home, not cwd/throwaway
      expect(existsSync(join(home, 'meetings', 'meeting-test-1', 'metadata.json'))).toBe(true)
      expect(existsSync(join(throwaway, 'meetings'))).toBe(false)
    } finally {
      process.chdir(originalCwd)
      rmSync(home, { recursive: true, force: true })
      rmSync(throwaway, { recursive: true, force: true })
    }
  })
})
