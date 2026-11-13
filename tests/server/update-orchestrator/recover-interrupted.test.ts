/**
 * Seam tests for scripts/recover-interrupted-update.sh (phase a).
 *
 * Master spec: docs/harness/source-deploy-refactor.md. Five recovery
 * paths + clean no-op, all idempotent.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterAll, describe, expect, it } from 'vitest'
import { readlinkSafe, runBash, symlinksSupported } from './helpers'

const REPO_ROOT = join(__dirname, '..', '..', '..')
const RECOVERY = join(REPO_ROOT, 'scripts', 'recover-interrupted-update.sh')

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const haveSymlinks = symlinksSupported()

interface Env {
  home: string
  deployDir: string
}

function makeEnv(): Env {
  const home = mkdtempSync(join(tmpdir(), 'recovery-'))
  tempDirs.push(home)
  const deployDir = join(home, 'deploy')
  mkdirSync(join(deployDir, 'dist'), { recursive: true })
  writeFileSync(join(deployDir, 'package.json'), JSON.stringify({ name: 'hermes-web-ui', version: '0.8.0' }))
  return { home, deployDir }
}

function runRecovery(env: Env): { status: number; stdout: string; stderr: string } {
  return runBash(RECOVERY, [], {
    HERMES_WEB_UI_HOME: env.home,
    DEPLOY_DIR: env.deployDir,
  })
}

function recoveryJournalMessages(home: string): string[] {
  const historyDir = join(home, 'updates', 'history')
  if (!existsSync(historyDir)) return []
  const fs = require('fs') as typeof import('fs')
  const messages: string[] = []
  for (const file of fs.readdirSync(historyDir)) {
    if (!file.startsWith('recovery-')) continue
    for (const line of readFileSync(join(historyDir, file), 'utf8').trim().split('\n').slice(1)) {
      messages.push(JSON.parse(line).message as string)
    }
  }
  return messages
}

describe('recover-interrupted-update', () => {
  it('clean state is a no-op exit 0', () => {
    const env = makeEnv()
    const res = runRecovery(env)
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('recovery sweep complete')
    expect(recoveryJournalMessages(env.home)).toEqual([])
  })

  it('breaks a stale lock (mtime > 6h) and journals the recovery', () => {
    const env = makeEnv()
    const lock = join(env.home, 'updates', '.update.lock')
    mkdirSync(lock, { recursive: true })
    const old = new Date(Date.now() - 7 * 3600 * 1000)
    utimesSync(lock, old, old)
    const res = runRecovery(env)
    expect(res.status).toBe(0)
    expect(existsSync(lock)).toBe(false)
    expect(recoveryJournalMessages(env.home).join('\n')).toContain('lock_recovered')
  })

  it('keeps a fresh lock (another update may be live)', () => {
    const env = makeEnv()
    const lock = join(env.home, 'updates', '.update.lock')
    mkdirSync(lock, { recursive: true })
    runRecovery(env)
    expect(existsSync(lock)).toBe(true)
  })

  it('removes leftover swap temp symlinks', () => {
    const env = makeEnv()
    const leftover = join(env.home, '.swap-tmp-12345')
    const { execFileSync } = require('child_process') as typeof import('child_process')
    execFileSync('bash', ['-c', `ln -s '${env.deployDir}' '${leftover}'`])
    const res = runRecovery(env)
    expect(res.status).toBe(0)
    expect(existsSync(leftover)).toBe(false)
  })

  it.skipIf(!haveSymlinks)('finishes a half-swap: pending deploy.new becomes the deploy link', () => {
    const env = makeEnv()
    const parent = join(env.home)
    const staged = join(env.home, 'staging-pending')
    mkdirSync(join(staged, 'dist'), { recursive: true })
    writeFileSync(join(staged, 'package.json'), JSON.stringify({ name: 'hermes-web-ui', version: '0.9.0' }))
    const { execFileSync } = require('child_process') as typeof import('child_process')
    // Simulate the crash: deploy moved aside, deploy.new prepared, no deploy link.
    rmSync(env.deployDir, { recursive: true, force: true })
    execFileSync('bash', ['-c', `ln -s '${staged}' '${parent}/deploy.new'`])
    const res = runRecovery(env)
    expect(res.status).toBe(0)
    expect(lstatSync(env.deployDir).isSymbolicLink()).toBe(true)
    expect(readlinkSafe(env.deployDir)).toBe(staged)
    expect(existsSync(join(parent, 'deploy.new'))).toBe(false)
    expect(recoveryJournalMessages(env.home).join('\n')).toContain('half_swap_finished')
  })

  it.skipIf(!haveSymlinks)('reverts a deploy symlink pointing at a missing target', () => {
    const env = makeEnv()
    const { execFileSync } = require('child_process') as typeof import('child_process')
    // lastgood lives NEXT TO the deploy link (atomic-swap.sh contract —
    // revert_to_lastgood reads dirname(deploy)/lastgood, never state/swap);
    // deploy -> a deleted staging dir.
    const lastgood = join(env.home, 'good-deploy')
    require('fs').renameSync(env.deployDir, lastgood)
    execFileSync('bash', ['-c', `ln -s '${lastgood}' '${join(env.home, 'lastgood')}'`])
    const gone = join(env.home, 'cache', 'staging-gone')
    mkdirSync(gone, { recursive: true })
    execFileSync('bash', ['-c', `ln -s '${gone}' '${env.deployDir}'`])
    rmSync(gone, { recursive: true, force: true })
    const res = runRecovery(env)
    expect(res.status).toBe(0)
    expect(readlinkSafe(env.deployDir)).toBe(lastgood)
    expect(recoveryJournalMessages(env.home).join('\n')).toContain('broken_deploy_reverted')
  })

  it.skipIf(!haveSymlinks)('re-stamps stale identity instead of re-swapping (settled decision)', () => {
    const env = makeEnv()
    mkdirSync(join(env.home, 'state'), { recursive: true })
    // Deploy tree serves 0.9.0 but identity says 0.8.0 (crash after swap,
    // before identity stamp).
    writeFileSync(join(env.deployDir, 'package.json'), JSON.stringify({ name: 'hermes-web-ui', version: '0.9.0' }))
    writeFileSync(join(env.home, 'state', 'identity.json'), JSON.stringify({
      schema: 1,
      capturedAt: '2026-09-06T00:00:00.000Z',
      version: '0.8.0',
      distSha256: 'a'.repeat(64),
      installerScriptSha256: 'b'.repeat(64),
      agentManifestSha: '0.0.0-noop',
    }))
    const res = runRecovery(env)
    expect(res.status).toBe(0)
    const identity = JSON.parse(readFileSync(join(env.home, 'state', 'identity.json'), 'utf8'))
    expect(identity.version).toBe('0.9.0')
    expect(recoveryJournalMessages(env.home).join('\n')).toContain('identity_restamped')
    // No swap happened: deploy is still the real directory.
    expect(lstatSync(env.deployDir).isSymbolicLink()).toBe(false)
  })

  it('leaves matching identity alone', () => {
    const env = makeEnv()
    mkdirSync(join(env.home, 'state'), { recursive: true })
    writeFileSync(join(env.home, 'state', 'identity.json'), JSON.stringify({
      schema: 1,
      capturedAt: '2026-09-06T00:00:00.000Z',
      version: '0.8.0',
      distSha256: 'a'.repeat(64),
      installerScriptSha256: 'b'.repeat(64),
      agentManifestSha: '0.0.0-noop',
    }))
    runRecovery(env)
    const identity = JSON.parse(readFileSync(join(env.home, 'state', 'identity.json'), 'utf8'))
    expect(identity.version).toBe('0.8.0')
  })
})
