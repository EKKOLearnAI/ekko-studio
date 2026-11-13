/**
 * Speech-practice report persistence tests.
 *
 * Contract under test:
 *   - POST /api/studio/speech-practice/report writes the Markdown report under
 *     the Web UI upload dir (`UPLOAD_DIR` / `HERMES_WEB_UI_HOME/upload`) —
 *     NOT process.cwd();
 *   - the store sanitizes the suggested file stem so a path-traversal attempt
 *     cannot escape the reports directory;
 *   - empty / oversized payloads are rejected;
 *   - repeated saves with the same stem never overwrite an earlier file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let savedUploadDir: string | undefined
let savedWebUiHome: string | undefined

function resetEnv(): void {
  delete process.env.UPLOAD_DIR
  delete process.env.HERMES_WEB_UI_HOME
  delete process.env.HERMES_WEBUI_STATE_DIR
}

beforeEach(() => {
  savedUploadDir = process.env.UPLOAD_DIR
  savedWebUiHome = process.env.HERMES_WEB_UI_HOME
  resetEnv()
  vi.resetModules()
})

afterEach(() => {
  vi.resetModules()
  resetEnv()
  if (savedUploadDir !== undefined) process.env.UPLOAD_DIR = savedUploadDir
  if (savedWebUiHome !== undefined) process.env.HERMES_WEB_UI_HOME = savedWebUiHome
})

async function importStore() {
  const mod = await import('../../packages/server/src/modules/studio/services/speech-practice-report')
  return { store: mod.speechPracticeReportStore, max: mod.PRACTICE_REPORT_MAX_CHARS }
}

describe('SpeechPracticeReportStore', () => {
  it('writes reports under the Web UI upload dir, not cwd', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sp-home-'))
    process.env.HERMES_WEB_UI_HOME = home

    const { store } = await importStore()
    const saved = await store.saveReport('# 口语对练分析报告\n\nhello', '口语对练-英语')

    expect(saved.absPath.startsWith(join(home, 'upload', 'speech-practice'))).toBe(true)
    expect(saved.fileName).toMatch(/^口语对练-英语-.*\.md$/)
    expect(existsSync(saved.absPath)).toBe(true)
    expect(readFileSync(saved.absPath, 'utf8')).toContain('口语对练分析报告')

    rmSync(home, { recursive: true, force: true })
  })

  it('honors UPLOAD_DIR when set', async () => {
    const upload = mkdtempSync(join(tmpdir(), 'sp-upload-'))
    process.env.UPLOAD_DIR = upload

    const { store } = await importStore()
    const saved = await store.saveReport('# r1', 'stem')
    expect(saved.absPath.startsWith(join(upload, 'speech-practice'))).toBe(true)

    rmSync(upload, { recursive: true, force: true })
  })

  it('does not escape the reports dir when the suggested name contains traversal', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sp-safe-'))
    process.env.HERMES_WEB_UI_HOME = home

    const { store } = await importStore()
    const saved = await store.saveReport('# r2', '../../evil')
    expect(saved.absPath.startsWith(join(home, 'upload', 'speech-practice'))).toBe(true)
    expect(saved.absPath).not.toContain('..')
    expect(existsSync(saved.absPath)).toBe(true)
    expect(existsSync(join(home, 'upload', 'evil.md'))).toBe(false)

    rmSync(home, { recursive: true, force: true })
  })

  it('rejects empty markdown', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sp-empty-'))
    process.env.HERMES_WEB_UI_HOME = home
    const { store } = await importStore()

    await expect(store.saveReport('   ', 'stem')).rejects.toMatchObject({ code: 'empty_report' })
    rmSync(home, { recursive: true, force: true })
  })

  it('never overwrites an earlier report with the same stem', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sp-uniq-'))
    process.env.HERMES_WEB_UI_HOME = home
    const { store } = await importStore()

    const first = await store.saveReport('# a', 'same-stem')
    const second = await store.saveReport('# b', 'same-stem')
    expect(first.fileName).not.toBe(second.fileName)
    const files = readdirSync(join(home, 'upload', 'speech-practice'))
    expect(files.length).toBe(2)

    rmSync(home, { recursive: true, force: true })
  })

  it('rejects markdown larger than the cap', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sp-big-'))
    process.env.HERMES_WEB_UI_HOME = home
    const { store, max } = await importStore()

    await expect(store.saveReport('x'.repeat(max + 1), 'stem')).rejects.toMatchObject({ code: 'report_too_large' })
    rmSync(home, { recursive: true, force: true })
  })
})
