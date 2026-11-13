import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'

it('restores the local account using the Web UI state-directory alias', () => {
  const home = mkdtempSync(join(tmpdir(), 'studio-cli-recovery-'))
  try {
    execFileSync(process.execPath, [resolve('bin/hermes-web-ui.mjs'), 'reset-default-login'], {
      env: { ...process.env, HERMES_WEB_UI_HOME: '', HERMES_WEBUI_STATE_DIR: home },
    })
    const db = new DatabaseSync(join(home, 'hermes-web-ui.db'))
    try {
      expect(db.prepare('SELECT username, role, status FROM users').all()).toEqual([
        { username: 'quanthermes', role: 'super_admin', status: 'active' },
      ])
    } finally { db.close() }
  } finally { rmSync(home, { recursive: true, force: true }) }
})
