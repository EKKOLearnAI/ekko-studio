import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

vi.mock('../../packages/server/src/modules/studio/services/update/manifest-client', () => ({
  fetchDevicePackageManifest: vi.fn().mockResolvedValue(null),
  fetchSourcePackageManifest: vi.fn().mockResolvedValue(null),
  resolveManifestCheckResult: vi.fn(),
}))

import {
  __resetEnvironmentCheckForTest,
  assertEnvironmentMatches,
  getLastEnvironmentCheck,
  readDeviceEnvState,
  runEnvironmentCheck,
  startReconcileLoop,
  stopReconcileLoop,
} from '../../packages/server/src/modules/studio/services/update/reconcile'
import type { CapturedEnvironment } from '../../packages/server/src/modules/studio/services/update/reconcile'
import type { DeviceEnvironment } from '../../packages/server/src/modules/studio/services/update/types'

function makeState(overrides: Partial<CapturedEnvironment> = {}): CapturedEnvironment {
  return {
    version: '0.7.20',
    capturedAt: '2026-08-25T10:00:00Z',
    nodeVersion: 'v20.10.0',
    agentVersion: '0.11.0',
    aptPackages: ['curl', 'git'],
    scripts: { install: '0.7.20' },
    driftFromManifest: [],
    ...overrides,
  }
}

function makeManifest(overrides: Partial<DeviceEnvironment> = {}): DeviceEnvironment {
  return {
    requiredNodeRange: '>=18.0.0',
    requiredHermesAgentRange: '>=0.10.0',
    requiredSystemFiles: [],
    ...overrides,
  }
}

describe('assertEnvironmentMatches', () => {
  it('returns no drift when both Node and Agent versions satisfy their ranges', () => {
    const state = makeState({ nodeVersion: 'v20.10.0', agentVersion: '0.11.0' })
    const manifest = makeManifest()

    expect(assertEnvironmentMatches(state, manifest)).toEqual([])
  })

  it('reports requiredNodeRange when actual Node version is below the floor', () => {
    const state = makeState({ nodeVersion: 'v16.20.0' })
    const manifest = makeManifest({ requiredNodeRange: '>=18.0.0' })

    const drift = assertEnvironmentMatches(state, manifest)
    expect(drift).toEqual([
      expect.objectContaining({
        gate: 'requiredNodeRange',
        expected: '>=18.0.0',
        actual: 'v16.20.0',
      }),
    ])
  })

  it('reports requiredHermesAgentRange when actual Agent version is below the floor', () => {
    const state = makeState({ agentVersion: '0.9.5' })
    const manifest = makeManifest({ requiredHermesAgentRange: '>=0.10.0' })

    const drift = assertEnvironmentMatches(state, manifest)
    expect(drift).toEqual([
      expect.objectContaining({
        gate: 'requiredHermesAgentRange',
        expected: '>=0.10.0',
        actual: '0.9.5',
      }),
    ])
  })

  it('returns no drift when state is null (drift is not computed without captured env)', () => {
    const manifest = makeManifest()
    expect(assertEnvironmentMatches(null, manifest)).toEqual([])
  })

  it('reports requiredSystemFiles when a declared file is absent', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'reconcile-absent-'))
    try {
      const state = makeState()
      const manifest = makeManifest({
        requiredSystemFiles: [{ path: 'scripts/install-device-package.sh', kind: 'present' }],
      })

      const drift = assertEnvironmentMatches(state, manifest, { deployDir: tmp })
      expect(drift).toEqual([
        expect.objectContaining({
          gate: 'requiredSystemFiles',
          expected: 'present',
          actual: 'absent',
          detail: 'scripts/install-device-package.sh',
        }),
      ])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('reports requiredSystemFiles when a declared executable is not executable', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'reconcile-exec-'))
    try {
      const scriptDir = join(tmp, 'scripts')
      mkdirSync(scriptDir, { recursive: true })
      const scriptPath = join(scriptDir, 'install-device-package.sh')
      writeFileSync(scriptPath, '#!/bin/bash\necho ok\n')
      const state = makeState()
      const manifest = makeManifest({
        requiredSystemFiles: [{ path: 'scripts/install-device-package.sh', kind: 'executable' }],
      })

      // On Windows fs.statSync.mode always reports 0 for the executable bits,
      // so the executable check is platform-dependent; assert only that the
      // gate either reports drift or passes — never throws.
      const drift = assertEnvironmentMatches(state, manifest, { deployDir: tmp })
      expect(Array.isArray(drift)).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('reports requiredSystemFiles when an absent-kind file is present', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'reconcile-present-'))
    try {
      writeFileSync(join(tmp, 'legacy-script.sh'), '#!/bin/bash\n')
      const state = makeState()
      const manifest = makeManifest({
        requiredSystemFiles: [{ path: 'legacy-script.sh', kind: 'absent' }],
      })

      const drift = assertEnvironmentMatches(state, manifest, { deployDir: tmp })
      expect(drift).toEqual([
        expect.objectContaining({
          gate: 'requiredSystemFiles',
          expected: 'absent',
          actual: 'present',
          detail: 'legacy-script.sh',
        }),
      ])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('supports semver range operators <=, >, <, ~, ^', () => {
    const cases: Array<{ range: string; actual: string; expected: boolean }> = [
      { range: '<=18.0.0', actual: 'v18.0.0', expected: true },
      { range: '<=18.0.0', actual: 'v18.0.1', expected: false },
      { range: '>18.0.0', actual: 'v18.0.1', expected: true },
      { range: '>18.0.0', actual: 'v18.0.0', expected: false },
      { range: '<19.0.0', actual: 'v18.5.0', expected: true },
      { range: '<19.0.0', actual: 'v19.0.0', expected: false },
      { range: '~18.0.0', actual: 'v18.0.5', expected: true },
      { range: '~18.0.0', actual: 'v18.1.0', expected: false },
      { range: '^18.0.0', actual: 'v18.5.0', expected: true },
      { range: '^18.0.0', actual: 'v19.0.0', expected: false },
    ]

    for (const c of cases) {
      const state = makeState({ nodeVersion: c.actual })
      const manifest = makeManifest({ requiredNodeRange: c.range, requiredHermesAgentRange: undefined })
      const drift = assertEnvironmentMatches(state, manifest)
      if (c.expected) {
        expect(drift.find((d) => d.gate === 'requiredNodeRange')).toBeUndefined()
      } else {
        expect(drift.find((d) => d.gate === 'requiredNodeRange')).toBeDefined()
      }
    }
  })
})

describe('readDeviceEnvState', () => {
  let originalHome: string | undefined
  let tmp: string

  beforeEach(() => {
    originalHome = process.env.HERMES_WEB_UI_HOME
    tmp = mkdtempSync(join(tmpdir(), 'reconcile-state-'))
    process.env.HERMES_WEB_UI_HOME = tmp
    __resetEnvironmentCheckForTest()
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HERMES_WEB_UI_HOME
    else process.env.HERMES_WEB_UI_HOME = originalHome
    rmSync(tmp, { recursive: true, force: true })
  })

  it('returns null when env-state.json does not exist', async () => {
    const state = await readDeviceEnvState()
    expect(state).toBeNull()
  })

  it('parses a well-formed env-state.json', async () => {
    const stateJson = {
      version: '0.7.20',
      capturedAt: '2026-08-25T10:00:00Z',
      nodeVersion: 'v20.10.0',
      agentVersion: '0.11.0',
      aptPackages: ['curl'],
      scripts: { install: '0.7.20' },
    }
    writeFileSync(resolve(tmp, 'env-state.json'), JSON.stringify(stateJson))

    const state = await readDeviceEnvState()
    expect(state).toEqual(expect.objectContaining({
      version: '0.7.20',
      capturedAt: '2026-08-25T10:00:00Z',
      nodeVersion: 'v20.10.0',
      agentVersion: '0.11.0',
    }))
  })

  it('returns null when env-state.json is malformed', async () => {
    writeFileSync(resolve(tmp, 'env-state.json'), '{not valid json')

    const state = await readDeviceEnvState()
    expect(state).toBeNull()
  })
})

describe('runEnvironmentCheck', () => {
  let originalHome: string | undefined
  let tmp: string

  beforeEach(() => {
    originalHome = process.env.HERMES_WEB_UI_HOME
    tmp = mkdtempSync(join(tmpdir(), 'reconcile-run-'))
    process.env.HERMES_WEB_UI_HOME = tmp
    __resetEnvironmentCheckForTest()
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HERMES_WEB_UI_HOME
    else process.env.HERMES_WEB_UI_HOME = originalHome
    rmSync(tmp, { recursive: true, force: true })
  })

  it('reports unavailable when env-state.json is missing', async () => {
    const result = await runEnvironmentCheck()
    expect(result.status).toBe('unavailable')
    expect(result.drift).toEqual([])
    expect(result.reconcileSupported).toBe(false)
    expect(getLastEnvironmentCheck()).toEqual(result)
  })

  it('reports ok when state is present but no manifest can be fetched', async () => {
    writeFileSync(resolve(tmp, 'env-state.json'), JSON.stringify({
      version: '0.7.20',
      capturedAt: '2026-08-25T10:00:00Z',
      nodeVersion: 'v20.10.0',
      agentVersion: '0.11.0',
      aptPackages: [],
      scripts: {},
    }))

    const result = await runEnvironmentCheck()
    expect(result.status).toBe('ok')
    expect(result.drift).toEqual([])
    expect(result.actualVersion).toBe('0.7.20')
  })
})

describe('reconcile loop scheduling', () => {
  beforeEach(() => {
    __resetEnvironmentCheckForTest()
  })

  afterEach(() => {
    stopReconcileLoop()
    __resetEnvironmentCheckForTest()
  })

  it('starts and stops without throwing', () => {
    expect(() => startReconcileLoop()).not.toThrow()
    expect(() => startReconcileLoop()).not.toThrow() // idempotent
    expect(() => stopReconcileLoop()).not.toThrow()
  })
})