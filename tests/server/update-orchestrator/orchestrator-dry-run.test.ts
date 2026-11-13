/**
 * Dry-run tests for scripts/update-orchestrator.sh (phase a core).
 *
 * Master spec: docs/harness/source-deploy-refactor.md (§ Architecture,
 * § Testing Strategy). WEBUI_DRY_RUN=1 skips only `systemctl restart`;
 * every other step (journal, swap, identity) really executes against a
 * fake deploy root.
 */
import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { readlinkSafe, runBash, symlinksSupported } from './helpers'

const REPO_ROOT = join(__dirname, '..', '..', '..')
const ORCHESTRATOR = join(REPO_ROOT, 'scripts', 'update-orchestrator.sh')

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const haveSymlinks = symlinksSupported()

interface Fixture {
  home: string
  deployDir: string
  archive: string
  archiveSha: string
}

function makeTree(root: string, version: string): string {
  const tree = join(root, `tree-${version}`)
  mkdirSync(join(tree, 'dist', 'server'), { recursive: true })
  writeFileSync(join(tree, 'package.json'), JSON.stringify({ name: 'hermes-web-ui', version }))
  writeFileSync(join(tree, 'package-lock.json'), '{}')
  writeFileSync(join(tree, 'dist', 'server', 'index.js'), `console.log("${version}")`)
  return tree
}

function makeArchive(root: string, version: string, opts: { wrap?: boolean } = {}): { archive: string; sha: string } {
  const tree = makeTree(root, version)
  const archive = join(root, `archive-${version}.tar.gz`)
  const args = ['--force-local']
  if (opts.wrap === false) {
    args.push('-czf', archive, '-C', tree, '.')
  } else {
    args.push('-czf', archive, '-C', root, `tree-${version}`)
  }
  const { execFileSync } = require('child_process') as typeof import('child_process')
  execFileSync('tar', args)
  const sha = createHash('sha256').update(readFileSync(archive)).digest('hex')
  return { archive, sha }
}

function makeFixture(targetVersion: string, opts: { wrap?: boolean; withNodeModules?: boolean } = {}): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'orchestrator-'))
  tempDirs.push(home)
  const deployDir = join(home, 'deploy')
  // Legacy layout: a real directory with an old version.
  const old = makeTree(home, '0.8.0')
  mkdirSync(deployDir, { recursive: true })
  writeFileSync(join(deployDir, 'package.json'), JSON.stringify({ name: 'hermes-web-ui', version: '0.8.0' }))
  mkdirSync(join(deployDir, 'dist', 'server'), { recursive: true })
  writeFileSync(join(deployDir, 'dist', 'server', 'index.js'), 'old')
  writeFileSync(join(deployDir, 'package-lock.json'), '{}')
  // Optionally seed node_modules in the old deploy tree so that
  // preserve_node_modules_across_swap can be exercised.
  if (opts.withNodeModules) {
    mkdirSync(join(deployDir, 'node_modules'), { recursive: true })
    writeFileSync(join(deployDir, 'node_modules', '.package-lock.json'), '{}')
  }
  rmSync(old, { recursive: true, force: true })
  const { archive, sha } = makeArchive(home, targetVersion, opts)
  return { home, deployDir, archive, archiveSha: sha }
}

function runOrchestrator(fixture: Fixture, extraEnv: Record<string, string> = {}) {
  return runBash(ORCHESTRATOR, [], {
    HERMES_WEB_UI_HOME: fixture.home,
    DEPLOY_DIR: fixture.deployDir,
    HERMES_WEB_UI_UPDATE_VERSION: '0.9.0',
    HERMES_WEB_UI_UPDATE_PACKAGE_ARCHIVE: fixture.archive,
    HERMES_WEB_UI_UPDATE_SOURCE_PACKAGE_SHA256: fixture.archiveSha,
    WEBUI_DRY_RUN: '1',
    WEBUI_UPDATE_SKIP_HEALTHCHECK: '1',
    ...extraEnv,
  })
}

function journalStages(home: string): string[] {
  const historyDir = join(home, 'updates', 'history')
  if (!existsSync(historyDir)) return []
  const files = require('fs').readdirSync(historyDir) as string[]
  if (files.length === 0) return []
  const lines = readFileSync(join(historyDir, files[0]), 'utf8').trim().split('\n')
  return lines.slice(1).map((line) => JSON.parse(line).stage)
}

describe('update orchestrator (dry-run)', () => {
  it.skipIf(!haveSymlinks)('runs the full lifecycle: swap, journal, identity stamp', () => {
    const fixture = makeFixture('0.9.0', { wrap: false })
    const res = runOrchestrator(fixture)
    expect(res.status).toBe(0)

    const stages = journalStages(fixture.home)
    expect(stages[0]).toBe('queued')
    expect(stages).toContain('manifest_self_check')
    expect(stages).toContain('identity_stamped')
    expect(stages[stages.length - 1]).toBe('succeeded')

    // Deploy is now a symlink at the staging dir.
    expect(require('fs').lstatSync(fixture.deployDir).isSymbolicLink()).toBe(true)
    const target = readFileSync(fixture.deployDir + '/package.json', 'utf8')
    expect(JSON.parse(target).version).toBe('0.9.0')

    // Identity stamped with the settled sentinel.
    const identity = JSON.parse(readFileSync(join(fixture.home, 'state', 'identity.json'), 'utf8'))
    expect(identity.version).toBe('0.9.0')
    expect(identity.agentManifestSha).toBe('0.0.0-noop')
    expect(identity.distSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it.skipIf(!haveSymlinks)('unwraps a single top-level directory (flat archive tolerance)', () => {
    const fixture = makeFixture('0.9.0', { wrap: true })
    const res = runOrchestrator(fixture)
    expect(res.status).toBe(0)
    expect(JSON.parse(readFileSync(join(fixture.deployDir, 'package.json'), 'utf8')).version).toBe('0.9.0')
  })

  it.skipIf(!haveSymlinks)('captures the legacy deploy as lastgood beside the deploy link', () => {
    const fixture = makeFixture('0.9.0', { wrap: false })
    runOrchestrator(fixture)
    // atomic-swap.sh contract: lastgood lives NEXT TO the deploy link so
    // revert_to_lastgood can find it (not in state/swap).
    const lastgood = readlinkSafe(join(fixture.home, 'lastgood'))
    expect(lastgood).toContain('.previous-')
    expect(JSON.parse(readFileSync(join(lastgood, 'package.json'), 'utf8')).version).toBe('0.8.0')
  })

  it.skipIf(!haveSymlinks)('second update on phase-a layout chains lastgood to the previous staging', () => {
    const fixture = makeFixture('0.9.0', { wrap: false })
    runOrchestrator(fixture)
    // Second update to 0.9.1.
    const { archive, sha } = makeArchive(fixture.home, '0.9.1', { wrap: false })
    const res = runBash(ORCHESTRATOR, [], {
      HERMES_WEB_UI_HOME: fixture.home,
      DEPLOY_DIR: fixture.deployDir,
      HERMES_WEB_UI_UPDATE_VERSION: '0.9.1',
      HERMES_WEB_UI_UPDATE_PACKAGE_ARCHIVE: archive,
      HERMES_WEB_UI_UPDATE_SOURCE_PACKAGE_SHA256: sha,
      WEBUI_DRY_RUN: '1',
      WEBUI_UPDATE_SKIP_HEALTHCHECK: '1',
    })
    expect(res.status).toBe(0)
    expect(JSON.parse(readFileSync(join(fixture.deployDir, 'package.json'), 'utf8')).version).toBe('0.9.1')
    const identity = JSON.parse(readFileSync(join(fixture.home, 'state', 'identity.json'), 'utf8'))
    expect(identity.version).toBe('0.9.1')
  })

  it.skipIf(!haveSymlinks)('ship block: manifest version mismatch reverts and quarantines', () => {
    const fixture = makeFixture('0.8.0', { wrap: false }) // archive claims 0.8.0, target 0.9.0
    const res = runOrchestrator(fixture)
    expect(res.status).toBe(0) // ship block is a clean rolled_back exit

    const stages = journalStages(fixture.home)
    expect(stages[stages.length - 1]).toBe('rolled_back')

    // Deploy untouched: still the legacy real directory with the old tree.
    expect(require('fs').lstatSync(fixture.deployDir).isSymbolicLink()).toBe(false)
    expect(JSON.parse(readFileSync(join(fixture.deployDir, 'package.json'), 'utf8')).version).toBe('0.8.0')
  })

  it.skipIf(!haveSymlinks)('healthcheck failure reverts to lastgood', () => {
    const fixture = makeFixture('0.9.0', { wrap: false })
    const res = runOrchestrator(fixture, {
      WEBUI_UPDATE_SKIP_HEALTHCHECK: '',
      HERMES_WEB_UI_UPDATE_HEALTHCHECK_URL: 'http://127.0.0.1:9/health',
      HERMES_WEB_UI_UPDATE_HEALTHCHECK_RETRIES: '1',
      HERMES_WEB_UI_UPDATE_HEALTHCHECK_INTERVAL_MS: '1',
    })
    expect(res.status).toBe(0)
    const stages = journalStages(fixture.home)
    expect(stages[stages.length - 1]).toBe('rolled_back')
    // Deploy reverted to the captured legacy tree.
    const target = readlinkSafe(fixture.deployDir)
    expect(target).toContain('.previous-')
    expect(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).version).toBe('0.8.0')
  })

  it.skipIf(!haveSymlinks)('reuses a completed partial download instead of deadlocking on 416', () => {
    const fixture = makeFixture('0.9.0', { wrap: false })
    // Crash window: download finished (partial == archive, sha verified)
    // but extract never ran. The retry must reuse the partial, not send
    // curl -C - past EOF (416 on every mirror → exit 4 loop).
    const cacheDir = join(fixture.home, 'updates', 'cache')
    mkdirSync(cacheDir, { recursive: true })
    const { copyFileSync } = require('fs') as typeof import('fs')
    copyFileSync(fixture.archive, join(cacheDir, 'partial-test-task.part'))
    const res = runOrchestrator(fixture, {
      HERMES_WEB_UI_UPDATE_TASK_ID: 'test-task',
      // Dummy URL that would fail if curl actually ran.
      HERMES_WEB_UI_UPDATE_PACKAGE_ARCHIVE: '',
      HERMES_WEB_UI_UPDATE_SOURCE_PACKAGE_URLS: 'http://127.0.0.1:9/artifact.tar.gz',
    })
    expect(res.status, `orchestrator failed: ${res.stderr}`).toBe(0)
    expect(JSON.parse(readFileSync(join(fixture.deployDir, 'package.json'), 'utf8')).version).toBe('0.9.0')
  })

  it('policy pin refuses a non-pinned target version (exit 3, no swap)', () => {
    const fixture = makeFixture('0.9.0', { wrap: false })
    mkdirSync(join(fixture.home, 'updates'), { recursive: true })
    writeFileSync(join(fixture.home, 'updates', 'policy.json'), JSON.stringify({ schema: 1, pinned_version: '0.7.5' }))
    const res = runOrchestrator(fixture)
    expect(res.status).toBe(3)
    // Deploy untouched.
    expect(require('fs').lstatSync(fixture.deployDir).isSymbolicLink()).toBe(false)
    const stages = journalStages(fixture.home)
    expect(stages[stages.length - 1]).toBe('failed')
  })

  it('policy blocklist refuses the target version (exit 3)', () => {
    const fixture = makeFixture('0.9.0', { wrap: false })
    mkdirSync(join(fixture.home, 'updates'), { recursive: true })
    writeFileSync(join(fixture.home, 'updates', 'policy.json'), JSON.stringify({ schema: 1, blocklist: ['0.9.0'] }))
    const res = runOrchestrator(fixture)
    expect(res.status).toBe(3)
  })

  it('a held lock refuses a second concurrent orchestrator (exit 3)', () => {
    const fixture = makeFixture('0.9.0', { wrap: false })
    mkdirSync(join(fixture.home, 'updates', '.update.lock'), { recursive: true })
    const res = runOrchestrator(fixture)
    expect(res.status).toBe(3)
  })

  it('fails without a target version (usage error, exit 2)', () => {
    const fixture = makeFixture('0.9.0', { wrap: false })
    const res = runBash(ORCHESTRATOR, [], {
      HERMES_WEB_UI_HOME: fixture.home,
      DEPLOY_DIR: fixture.deployDir,
      WEBUI_DRY_RUN: '1',
    })
    expect(res.status).toBe(2)
  })

  it.skipIf(!haveSymlinks)('preserves pre-built dist while dry-run skips dependency installation and building', () => {
    // Archive has dist/server/index.js (pre-built by CI). The orchestrator
    // must survive the real swap even when dry-run skips npm ci and building.
    const fixture = makeFixture('0.9.0', { wrap: false })
    const res = runOrchestrator(fixture)
    expect(res.status, `orchestrator failed: ${res.stderr}`).toBe(0)
    // Dry-run never launches the build toolchain.
    const output = res.stdout + res.stderr
    expect(output).toContain('dry-run: APP_USER unknown; skipping npm ci + build')
    // dist/ is present from the archive.
    expect(existsSync(join(fixture.deployDir, 'dist', 'server', 'index.js'))).toBe(true)
  })

  it.skipIf(!haveSymlinks)('preserves node_modules from old deploy tree across swap', () => {
    // Old deploy has node_modules/. After atomic swap, preserve_node_modules_across_swap
    // should copy them into the new deploy tree.
    const fixture = makeFixture('0.9.0', { wrap: false, withNodeModules: true })
    const res = runOrchestrator(fixture)
    expect(res.status, `orchestrator failed: ${res.stderr}`).toBe(0)
    // node_modules should be preserved from the old tree.
    expect(existsSync(join(fixture.deployDir, 'node_modules'))).toBe(true)
    // The specific seed file we put in the old tree's node_modules.
    expect(existsSync(join(fixture.deployDir, 'node_modules', '.package-lock.json'))).toBe(true)
    const output = res.stdout + res.stderr
    expect(output).toContain('preserving node_modules')
  })

  it.skipIf(!haveSymlinks)('skips node_modules preservation when lockfile changed between versions', () => {
    // Old deploy has node_modules/ but with a DIFFERENT package-lock.json sha
    // than the new archive. preserve_node_modules must NOT copy (would be stale).
    const fixture = makeFixture('0.9.0', { wrap: false, withNodeModules: true })
    // Mutate the old tree's package-lock.json to have a different sha than the new archive.
    const oldLock = join(fixture.deployDir, 'package-lock.json')
    writeFileSync(oldLock, JSON.stringify({ name: 'hermes-web-ui', lockfileVersion: 3, lock_is_different: true }))
    const res = runOrchestrator(fixture)
    expect(res.status, `orchestrator failed: ${res.stderr}`).toBe(0)
    // node_modules should NOT be preserved (lockfile mismatch).
    expect(existsSync(join(fixture.deployDir, 'node_modules'))).toBe(false)
    const output = res.stdout + res.stderr
    expect(output).toContain('lockfile changed')
    expect(output).toContain('skipping node_modules preservation')
  })
})
