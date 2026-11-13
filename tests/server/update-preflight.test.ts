import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runUpdatePreflight } from '../../packages/server/src/modules/studio/services/update/preflight'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'hermes-preflight-test-'))
}

function buildOrchestrator(caps: string | null): string {
  if (caps === null) return '#!/usr/bin/env bash\nset -Euo pipefail\necho "no capabilities here"\n'
  return `#!/usr/bin/env bash\nset -Euo pipefail\nORCHESTRATOR_CAPABILITIES="${caps}"\n`
}

describe('update preflight', () => {
  it('allows low-risk layouts', () => {
    const result = runUpdatePreflight('source-deploy', {
      deployDir: '/opt/hermes-web-ui',
      webUiHome: '/home/hermesui/.hermes-web-ui',
      uploadDir: '/home/hermesui/.hermes-web-ui/upload',
      hermesHome: '/srv/hermes-data',
    }, {
      stagingDir: '/tmp/hermes-update-staging',
      logDir: '/tmp/hermes-update-logs',
      stateFile: '/tmp/hermes-update-state.json',
      minFreeSpaceBytes: 1024,
    })

    expect(result.riskLevel).toBe('low')
    expect(result.shouldBlock).toBe(false)
    expect(result.issues).toHaveLength(0)
  })

  it('allows the default hermes_data layout without warnings', () => {
    const result = runUpdatePreflight('source-deploy', {
      deployDir: '/opt/hermes-web-ui',
      webUiHome: '/home/hermesui/.hermes-web-ui',
      uploadDir: '/home/hermesui/.hermes-web-ui/upload',
      hermesHome: '/opt/hermes-web-ui/hermes_data',
    }, {
      stagingDir: '/tmp/hermes-update-staging',
      logDir: '/tmp/hermes-update-logs',
      stateFile: '/tmp/hermes-update-state.json',
      minFreeSpaceBytes: 1024,
    })

    expect(result.riskLevel).toBe('low')
    expect(result.shouldBlock).toBe(false)
    expect(result.warningText).toBe('')
    expect(result.issues).toHaveLength(0)
  })

  it('blocks when the web-ui data directory is inside the deploy directory', () => {
    const result = runUpdatePreflight('npm-package', {
      deployDir: '/opt/hermes-web-ui',
      webUiHome: '/opt/hermes-web-ui/state',
      uploadDir: '/opt/hermes-web-ui/state/upload',
      hermesHome: '/srv/hermes-data',
    }, {
      stagingDir: '/tmp/hermes-update-staging',
      logDir: '/tmp/hermes-update-logs',
      stateFile: '/tmp/hermes-update-state.json',
      minFreeSpaceBytes: 1024,
    })

    expect(result.riskLevel).toBe('high')
    expect(result.shouldBlock).toBe(true)
    expect(result.blockingText).toContain('Web UI data directory is inside the deploy directory')
    expect(result.issues.some(issue => issue.code === 'upload-dir-in-deploy-dir')).toBe(true)
  })

  it.runIf(process.platform !== 'win32')('blocks when the device does not meet the minimum free-space requirement', () => {
    const result = runUpdatePreflight('device-package', {
      deployDir: '/opt/hermes-web-ui',
      webUiHome: '/home/hermesui/.hermes-web-ui',
      uploadDir: '/home/hermesui/.hermes-web-ui/upload',
      hermesHome: '/srv/hermes-data',
    }, {
      stagingDir: '/tmp/hermes-update-staging',
      logDir: '/tmp/hermes-update-logs',
      stateFile: '/tmp/hermes-update-state.json',
      minFreeSpaceBytes: Number.MAX_SAFE_INTEGER,
    })

    expect(result.riskLevel).toBe('high')
    expect(result.shouldBlock).toBe(true)
    expect(result.issues.some(issue => issue.code === 'insufficient-disk-space')).toBe(true)
  })

  describe('agent-data-safety', () => {
    it('blocks source-deploy when orchestrator has no capabilities and hermes_data is substantial', () => {
      const dir = makeTempDir()
      try {
        // Deploy tree with an old (0.8.1-style) orchestrator — no capabilities.
        mkdirSync(join(dir, 'scripts'), { recursive: true })
        writeFileSync(join(dir, 'scripts', 'update-orchestrator.sh'), buildOrchestrator(null))
        // Simulate substantial hermes_data (>2 top-level entries).
        const hd = join(dir, 'hermes_data')
        mkdirSync(hd, { recursive: true })
        mkdirSync(join(hd, 'profiles'))
        mkdirSync(join(hd, 'sessions'))
        writeFileSync(join(hd, 'state.db'), 'x'.repeat(100))

        const result = runUpdatePreflight('source-deploy', {
          deployDir: dir,
          webUiHome: join(dir, '..', '.hermes-web-ui'),
          uploadDir: join(dir, '..', '.hermes-web-ui', 'upload'),
          hermesHome: join(dir, 'hermes_data'),
        })

        expect(result.riskLevel).toBe('high')
        expect(result.shouldBlock).toBe(true)
        const issue = result.issues.find(i => i.code === 'agent-data-safety')
        expect(issue).toBeDefined()
        expect(issue!.message).toContain('bootstrap')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('blocks when no orchestrator file exists (≤0.8.0 devices)', () => {
      const dir = makeTempDir()
      try {
        // No scripts/ directory at all — simulates ≤0.8.0 devices.
        const hd = join(dir, 'hermes_data')
        mkdirSync(hd, { recursive: true })
        mkdirSync(join(hd, 'profiles'))
        mkdirSync(join(hd, 'sessions'))
        mkdirSync(join(hd, 'skills'))
        writeFileSync(join(hd, 'state.db'), 'x'.repeat(100))

        const result = runUpdatePreflight('device-package', {
          deployDir: dir,
          webUiHome: join(dir, '..', '.hermes-web-ui'),
          uploadDir: join(dir, '..', '.hermes-web-ui', 'upload'),
          hermesHome: join(dir, 'hermes_data'),
        })

        expect(result.riskLevel).toBe('high')
        expect(result.shouldBlock).toBe(true)
        const issue = result.issues.find(i => i.code === 'agent-data-safety')
        expect(issue).toBeDefined()
        expect(issue!.message).toContain('no orchestrator')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('blocks when orchestrator is missing required capabilities (e.g. 0.8.2)', () => {
      const dir = makeTempDir()
      try {
        mkdirSync(join(dir, 'scripts'), { recursive: true })
        // 0.8.2 only had hermes_data_preservation, not prebuilt_dist.
        writeFileSync(join(dir, 'scripts', 'update-orchestrator.sh'), buildOrchestrator('hermes_data_preservation'))
        const hd = join(dir, 'hermes_data')
        mkdirSync(hd, { recursive: true })
        mkdirSync(join(hd, 'a'))
        mkdirSync(join(hd, 'b'))
        mkdirSync(join(hd, 'c'))

        const result = runUpdatePreflight('source-deploy', {
          deployDir: dir,
          webUiHome: '',
          uploadDir: '',
          hermesHome: join(dir, 'hermes_data'),
        })

        expect(result.shouldBlock).toBe(true)
        const issue = result.issues.find(i => i.code === 'agent-data-safety')
        expect(issue).toBeDefined()
        expect(issue!.message).toContain('prebuilt_dist')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('allows when orchestrator has all required capabilities (0.8.3+)', () => {
      const dir = makeTempDir()
      try {
        mkdirSync(join(dir, 'scripts'), { recursive: true })
        writeFileSync(
          join(dir, 'scripts', 'update-orchestrator.sh'),
          buildOrchestrator('hermes_data_preservation prebuilt_dist node_modules_preservation'),
        )
        const hd = join(dir, 'hermes_data')
        mkdirSync(hd, { recursive: true })
        mkdirSync(join(hd, 'profiles'))
        mkdirSync(join(hd, 'sessions'))
        writeFileSync(join(hd, 'state.db'), 'x'.repeat(100))

        const result = runUpdatePreflight('source-deploy', {
          deployDir: dir,
          webUiHome: '',
          uploadDir: '',
          hermesHome: join(dir, 'hermes_data'),
        })

        expect(result.riskLevel).toBe('low')
        expect(result.shouldBlock).toBe(false)
        expect(result.issues.find(i => i.code === 'agent-data-safety')).toBeUndefined()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('allows when hermes_data has ≤2 top-level entries (no substantial data)', () => {
      const dir = makeTempDir()
      try {
        // No orchestrator at all — but data is negligible.
        const hd = join(dir, 'hermes_data')
        mkdirSync(hd, { recursive: true })
        mkdirSync(join(hd, '.gitkeep'))

        const result = runUpdatePreflight('source-deploy', {
          deployDir: dir,
          webUiHome: '',
          uploadDir: '',
          hermesHome: join(dir, 'hermes_data'),
        })

        expect(result.shouldBlock).toBe(false)
        expect(result.issues.find(i => i.code === 'agent-data-safety')).toBeUndefined()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('skips the check for npm-package strategy', () => {
      const dir = makeTempDir()
      try {
        // No orchestrator, substantial data — but strategy is npm-package.
        const hd = join(dir, 'hermes_data')
        mkdirSync(hd, { recursive: true })
        mkdirSync(join(hd, 'profiles'))
        mkdirSync(join(hd, 'sessions'))
        writeFileSync(join(hd, 'state.db'), 'x'.repeat(100))

        const result = runUpdatePreflight('npm-package', {
          deployDir: dir,
          webUiHome: '',
          uploadDir: '',
          hermesHome: join(dir, 'hermes_data'),
        })

        expect(result.shouldBlock).toBe(false)
        expect(result.issues.find(i => i.code === 'agent-data-safety')).toBeUndefined()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
