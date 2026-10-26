import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import * as appConfig from '../../packages/server/src/modules/studio/public/app-config'
import * as profiles from '../../packages/server/src/modules/hermes/services/profiles/profile'
import * as runtime from '../../packages/server/src/modules/hermes/services/runtime/process'
import {
  ensureProfileGatewaysRunning,
  gatewayAutostartDisabledByEnv,
  gatewayAutoStartManagementMode,
  gatewayMultiplexConfigEnabledForDefaultProfile,
  gatewayStatusLooksRuntimeLocked,
  gatewayStatusLooksRunning,
  gatewayStateLooksRunningForProfile,
  parseGatewayStatusesFromProfileListOutput,
  prepareGatewayForProfileDelete,
  recoverWindowsDesktopGatewayOrphans,
  reconcileGatewayManagementTransition,
  resolveGatewayTargetProfile,
  selectGatewayProfilesForAutostart,
  selectProfilesForGatewayAutostart,
  shouldRecoverWindowsDesktopGatewayOrphans,
  shouldUseUnifiedGatewayManagement,
  shouldUseManagedGatewayRun,
  shouldUseManagedGatewayRunForAutostart,
} from '../../packages/server/src/modules/hermes/services/gateway/autostart'

describe('gateway autostart status parsing', () => {
  it('requires explicit opt-in before selecting gateway profiles', () => {
    const names = ['default', 'work', 'test']
    expect(selectProfilesForGatewayAutostart(names)).toEqual([])
    expect(selectProfilesForGatewayAutostart(names, {})).toEqual([])
    expect(selectProfilesForGatewayAutostart(names, { include: ['work'] })).toEqual([])
    expect(selectProfilesForGatewayAutostart(names, { enabled: true })).toEqual(names)
  })

  it.each([undefined, null, {}, [], { enabled: 'true' }])('normalizes missing or invalid enablement to off: %j', value => {
    expect(appConfig.normalizeGatewayAutoStartConfig(value)).toEqual({ enabled: false })
  })

  it.each([undefined, {}, { enabled: false }, { include: ['default'] }])('skips gateway discovery and CLI calls without opt-in: %j', async policy => {
    const readConfig = vi.spyOn(appConfig, 'readAppConfig').mockResolvedValue({ gatewayAutoStart: policy })
    const discoverProfiles = vi.spyOn(profiles, 'listProfileNamesFromDisk').mockReturnValue(['default'])
    const exec = vi.spyOn(runtime, 'execHermesWithBin').mockRejectedValue(new Error('Unexpected Hermes command'))
    try {
      await ensureProfileGatewaysRunning()
      expect(discoverProfiles).not.toHaveBeenCalled()
      expect(exec).not.toHaveBeenCalled()
    } finally {
      readConfig.mockRestore()
      discoverProfiles.mockRestore()
      exec.mockRestore()
    }
  })

  it('honors gateway autostart include, exclude, disabled, and unknown profiles', () => {
    const profiles = ['default', 'work', 'reviewer', 'scratch']

    expect(selectProfilesForGatewayAutostart(profiles, { enabled: true, include: ['work', 'missing', 'work', ' reviewer '] })).toEqual([
      'work',
      'reviewer',
    ])
    expect(selectProfilesForGatewayAutostart(profiles, { enabled: true, exclude: ['scratch', 'missing'] })).toEqual([
      'default',
      'work',
      'reviewer',
    ])
    expect(selectProfilesForGatewayAutostart(profiles, { enabled: true, include: ['work', 'scratch'], exclude: ['scratch'] })).toEqual([
      'work',
    ])
    expect(selectProfilesForGatewayAutostart(profiles, { enabled: true, include: ['missing'] })).toEqual([])
    expect(selectProfilesForGatewayAutostart(profiles, { enabled: true, include: [] })).toEqual([])
    expect(selectProfilesForGatewayAutostart(profiles, { enabled: false, include: ['default'] })).toEqual([])
  })

  it('selects only the default gateway target in unified gateway management', () => {
    const profiles = ['default', 'work', 'reviewer']

    expect(selectGatewayProfilesForAutostart(profiles, undefined, true)).toEqual([])
    expect(selectGatewayProfilesForAutostart(profiles, { enabled: true }, true)).toEqual(['default'])
    expect(selectGatewayProfilesForAutostart(profiles, { enabled: true, include: ['work'] }, true)).toEqual(['default'])
    expect(selectGatewayProfilesForAutostart(profiles, { enabled: true, include: [] }, true)).toEqual([])
    expect(selectGatewayProfilesForAutostart(profiles, { enabled: false }, true)).toEqual([])
    expect(selectGatewayProfilesForAutostart(profiles, { enabled: true, include: ['work'] }, false)).toEqual(['work'])
  })

  it('resolves gateway target profile for unified management', () => {
    expect(resolveGatewayTargetProfile('work', false)).toEqual({
      requestedProfile: 'work',
      targetProfile: 'work',
      unified: false,
    })
    expect(resolveGatewayTargetProfile('work', true)).toEqual({
      requestedProfile: 'work',
      targetProfile: 'default',
      unified: true,
    })
    expect(resolveGatewayTargetProfile('', true)).toEqual({
      requestedProfile: 'default',
      targetProfile: 'default',
      unified: true,
    })
  })

  it('detects Hermes Agent multiplex gateway config in the default profile', () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-gateway-multiplex-'))
    try {
      expect(gatewayMultiplexConfigEnabledForDefaultProfile(home)).toBe(false)

      writeFileSync(join(home, 'config.yaml'), 'gateway:\n  multiplex_profiles: true\n', 'utf-8')
      expect(gatewayMultiplexConfigEnabledForDefaultProfile(home)).toBe(true)

      writeFileSync(join(home, 'config.yaml'), 'multiplex_profiles: "yes"\n', 'utf-8')
      expect(gatewayMultiplexConfigEnabledForDefaultProfile(home)).toBe(true)

      writeFileSync(join(home, 'config.yaml'), 'gateway:\n  multiplex_profiles: false\n', 'utf-8')
      expect(gatewayMultiplexConfigEnabledForDefaultProfile(home)).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('honors Web UI gateway management overrides around Hermes Agent multiplex config', () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-gateway-management-'))
    try {
      writeFileSync(join(home, 'config.yaml'), 'gateway:\n  multiplex_profiles: true\n', 'utf-8')

      expect(gatewayAutoStartManagementMode({ management: 'unified' })).toBe('unified')
      expect(gatewayAutoStartManagementMode({ management: 'per_profile' })).toBe('per_profile')
      expect(gatewayAutoStartManagementMode({ management: 'auto' })).toBe('auto')
      expect(shouldUseUnifiedGatewayManagement({ management: 'auto' }, home)).toBe(true)
      expect(shouldUseUnifiedGatewayManagement({ management: 'per_profile' }, home)).toBe(false)
      expect(shouldUseUnifiedGatewayManagement({ management: 'unified' }, home)).toBe(true)

      writeFileSync(join(home, 'config.yaml'), 'gateway:\n  multiplex_profiles: false\n', 'utf-8')
      expect(shouldUseUnifiedGatewayManagement({ management: 'auto' }, home)).toBe(false)
      expect(shouldUseUnifiedGatewayManagement({ management: 'unified' }, home)).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('detects the environment-level gateway autostart disable flag', () => {
    expect(gatewayAutostartDisabledByEnv({ HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART: '1' })).toBe(true)
    expect(gatewayAutostartDisabledByEnv({ HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART: 'true' })).toBe(true)
    expect(gatewayAutostartDisabledByEnv({ HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART: 'off' })).toBe(false)
    expect(gatewayAutostartDisabledByEnv({})).toBe(false)
  })

  it('stops per-profile gateways and starts default when switching to unified management', async () => {
    const events: string[] = []

    const result = await reconcileGatewayManagementTransition(
      { management: 'per_profile' },
      { enabled: true, management: 'unified' },
      {
        profiles: ['default', 'work', 'reviewer'],
        stopGateway: async profile => { events.push(`stop:${profile}`) },
        startGateway: async profile => { events.push(`start:${profile}`) },
        waitForGateway: async () => true,
      },
    )

    expect(result).toMatchObject({
      changed: true,
      previousUnified: false,
      nextUnified: true,
      stoppedProfiles: ['default', 'work', 'reviewer'],
      startedProfiles: ['default'],
    })
    expect(events).toEqual(['stop:default', 'stop:work', 'stop:reviewer', 'start:default'])
  })

  it('stops default and starts selected profile gateways when switching back to per-profile management', async () => {
    const events: string[] = []

    const result = await reconcileGatewayManagementTransition(
      { enabled: true, management: 'unified' },
      { enabled: true, management: 'per_profile', exclude: ['reviewer'] },
      {
        profiles: ['default', 'work', 'reviewer'],
        stopGateway: async profile => { events.push(`stop:${profile}`) },
        startGateway: async profile => { events.push(`start:${profile}`) },
        waitForGateway: async () => true,
      },
    )

    expect(result).toMatchObject({
      changed: true,
      previousUnified: true,
      nextUnified: false,
      stoppedProfiles: ['default'],
      startedProfiles: ['default', 'work'],
    })
    expect(events).toEqual(['stop:default', 'start:default', 'start:work'])
  })

  it('treats runtime lock conflicts as an already-running gateway', () => {
    expect(gatewayStatusLooksRuntimeLocked(
      'Gateway runtime lock is already held by another instance. Exiting.',
    )).toBe(true)
  })

  it('does not treat not-running status as running', () => {
    expect(gatewayStatusLooksRunning('Gateway is not running')).toBe(false)
  })

  it('parses gateway status from hermes profile list output', () => {
    const output = `
 Profile          Model                        Gateway      Alias        Distribution
 ───────────────    ───────────────────────────    ───────────    ───────────    ────────────────────
 ◆default         glm-5-turbo                  running      —            —
  akri            glm-5-turbo                  running      akri         —
  tester          gpt-5.5                      stopped      tester       —
`
    const statuses = parseGatewayStatusesFromProfileListOutput(output, ['default', 'akri', 'tester'])
    expect(statuses.get('default')).toBe('running')
    expect(statuses.get('akri')).toBe('running')
    expect(statuses.get('tester')).toBe('stopped')
  })

  it('parses gateway status when profile or model fills the table column', () => {
    const output = `
 Profile          Model                        Gateway      Alias        Distribution
 ───────────────    ───────────────────────────    ───────────    ───────────    ────────────────────
  daily_assistant deepseek-v4-flash            running      —            —
  long_model      provider/model-name-that-fills-column stopped      —            —
`
    const statuses = parseGatewayStatusesFromProfileListOutput(output, ['daily_assistant', 'long_model'])
    expect(statuses.get('daily_assistant')).toBe('running')
    expect(statuses.get('long_model')).toBe('stopped')
  })

  it('uses profile-list gateway status text for running checks', () => {
    expect(gatewayStatusLooksRunning('running')).toBe(true)
    expect(gatewayStatusLooksRunning('stopped')).toBe(false)
    expect(gatewayStatusLooksRunning('not running')).toBe(false)
  })

  it('uses managed gateway mode by default', () => {
    const previous = process.env.HERMES_WEB_UI_MANAGED_GATEWAY
    try {
      delete process.env.HERMES_WEB_UI_MANAGED_GATEWAY
      expect(shouldUseManagedGatewayRun()).toBe(true)
      expect(shouldUseManagedGatewayRunForAutostart('darwin')).toBe(true)
      expect(shouldUseManagedGatewayRunForAutostart('linux')).toBe(true)
      expect(shouldUseManagedGatewayRunForAutostart('win32')).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.HERMES_WEB_UI_MANAGED_GATEWAY
      else process.env.HERMES_WEB_UI_MANAGED_GATEWAY = previous
    }
  })

  it('keeps managed gateway mode enabled when explicitly set', () => {
    const previous = process.env.HERMES_WEB_UI_MANAGED_GATEWAY
    process.env.HERMES_WEB_UI_MANAGED_GATEWAY = '1'
    try {
      expect(shouldUseManagedGatewayRun()).toBe(true)
      expect(shouldUseManagedGatewayRunForAutostart()).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.HERMES_WEB_UI_MANAGED_GATEWAY
      else process.env.HERMES_WEB_UI_MANAGED_GATEWAY = previous
    }
  })

  it('allows managed gateway mode to be disabled by environment', () => {
    const previous = process.env.HERMES_WEB_UI_MANAGED_GATEWAY
    try {
      for (const value of ['0', 'false', 'no', 'off']) {
        process.env.HERMES_WEB_UI_MANAGED_GATEWAY = value
        expect(shouldUseManagedGatewayRun()).toBe(false)
        expect(shouldUseManagedGatewayRunForAutostart('win32')).toBe(false)
        expect(shouldUseManagedGatewayRunForAutostart('darwin')).toBe(false)
      }
    } finally {
      if (previous === undefined) delete process.env.HERMES_WEB_UI_MANAGED_GATEWAY
      else process.env.HERMES_WEB_UI_MANAGED_GATEWAY = previous
    }
  })

  it('only recovers Windows desktop gateway orphans when enabled', () => {
    expect(shouldRecoverWindowsDesktopGatewayOrphans('win32', { HERMES_DESKTOP: 'true' })).toBe(true)
    expect(shouldRecoverWindowsDesktopGatewayOrphans('darwin', { HERMES_DESKTOP: 'true' })).toBe(false)
    expect(shouldRecoverWindowsDesktopGatewayOrphans('win32', {})).toBe(false)
    expect(shouldRecoverWindowsDesktopGatewayOrphans('win32', {
      HERMES_DESKTOP: 'true',
      HERMES_WEB_UI_DISABLE_GATEWAY_STARTUP_RECOVERY: '1',
    })).toBe(false)
  })

  it('kills Windows desktop gateway runtime PIDs and removes stale runtime files', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-gateway-recovery-'))
    const workHome = join(home, 'profiles', 'work')
    mkdirSync(workHome, { recursive: true })
    const killed: number[] = []
    const stopped: string[] = []

    try {
      writeFileSync(join(home, 'gateway.pid'), JSON.stringify({ pid: 11111 }), 'utf-8')
      writeFileSync(join(home, 'gateway_state.json'), JSON.stringify({ pid: 99999, gateway_state: 'stopped' }), 'utf-8')
      writeFileSync(join(workHome, 'gateway.lock'), JSON.stringify({ pid: '22222' }), 'utf-8')
      writeFileSync(join(workHome, 'gateway_state.json'), JSON.stringify({ pid: 33333, gateway_state: 'running' }), 'utf-8')

      const result = await recoverWindowsDesktopGatewayOrphans({
        platform: 'win32',
        env: { HERMES_DESKTOP: 'true' },
        hermesHome: home,
        isAlive: pid => pid !== 99999,
        stopGateway: async profileDir => { stopped.push(profileDir) },
        execTaskkill: async pid => { killed.push(pid) },
      })

      expect(result.attempted).toBe(true)
      expect(stopped.sort()).toEqual([home, workHome].sort())
      expect(result.stoppedProfileDirs.sort()).toEqual([home, workHome].sort())
      expect(killed.sort((a, b) => a - b)).toEqual([11111, 22222, 33333])
      expect(result.killedPids.sort((a, b) => a - b)).toEqual([11111, 22222, 33333])
      expect(existsSync(join(home, 'gateway.pid'))).toBe(false)
      expect(existsSync(join(home, 'gateway_state.json'))).toBe(false)
      expect(existsSync(join(workHome, 'gateway.lock'))).toBe(false)
      expect(existsSync(join(workHome, 'gateway_state.json'))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('skips recovery outside Windows desktop mode without deleting runtime files', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-gateway-recovery-skip-'))
    try {
      const pidPath = join(home, 'gateway.pid')
      writeFileSync(pidPath, JSON.stringify({ pid: 11111 }), 'utf-8')

      const result = await recoverWindowsDesktopGatewayOrphans({
        platform: 'linux',
        env: { HERMES_DESKTOP: 'true' },
        hermesHome: home,
        isAlive: () => {
          throw new Error('should not check liveness')
        },
      })

      expect(result.attempted).toBe(false)
      expect(existsSync(pidPath)).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('detects managed gateway state files with a live pid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-gateway-state-'))
    try {
      writeFileSync(
        join(dir, 'gateway_state.json'),
        JSON.stringify({ pid: process.pid, gateway_state: 'running' }),
        'utf-8',
      )
      expect(gatewayStateLooksRunningForProfile(dir)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prepares a profile delete by marking the gateway desired stopped', async () => {
    const previousHermesHome = process.env.HERMES_HOME
    const previousHermesBin = process.env.HERMES_BIN
    const home = mkdtempSync(join(tmpdir(), 'wui-delete-gateway-'))
    const profileDir = join(home, 'profiles', 'work')
    mkdirSync(profileDir, { recursive: true })

    try {
      process.env.HERMES_HOME = home
      process.env.HERMES_BIN = '/definitely/missing/hermes'

      await prepareGatewayForProfileDelete('work')

      expect(JSON.parse(readFileSync(join(profileDir, 'gateway_state.json'), 'utf-8'))).toMatchObject({
        gateway_state: 'stopped',
        desired_state: 'stopped',
      })
    } finally {
      if (previousHermesHome === undefined) delete process.env.HERMES_HOME
      else process.env.HERMES_HOME = previousHermesHome
      if (previousHermesBin === undefined) delete process.env.HERMES_BIN
      else process.env.HERMES_BIN = previousHermesBin
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('does not fail profile deletion prep when the gateway is already stopped', async () => {
    const previousHermesHome = process.env.HERMES_HOME
    const previousHermesBin = process.env.HERMES_BIN
    const home = mkdtempSync(join(tmpdir(), 'wui-delete-gateway-'))
    mkdirSync(join(home, 'profiles', 'work'), { recursive: true })

    try {
      process.env.HERMES_HOME = home
      process.env.HERMES_BIN = '/definitely/missing/hermes'

      await expect(prepareGatewayForProfileDelete('work')).resolves.toBeUndefined()
    } finally {
      if (previousHermesHome === undefined) delete process.env.HERMES_HOME
      else process.env.HERMES_HOME = previousHermesHome
      if (previousHermesBin === undefined) delete process.env.HERMES_BIN
      else process.env.HERMES_BIN = previousHermesBin
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('does not fall back to the default profile when delete prep sees a missing profile', async () => {
    const previousHermesHome = process.env.HERMES_HOME
    const previousHermesBin = process.env.HERMES_BIN
    const home = mkdtempSync(join(tmpdir(), 'wui-delete-gateway-missing-'))

    try {
      process.env.HERMES_HOME = home
      process.env.HERMES_BIN = '/definitely/missing/hermes'

      await expect(prepareGatewayForProfileDelete('missing')).resolves.toBeUndefined()
      expect(existsSync(join(home, 'gateway_state.json'))).toBe(false)
    } finally {
      if (previousHermesHome === undefined) delete process.env.HERMES_HOME
      else process.env.HERMES_HOME = previousHermesHome
      if (previousHermesBin === undefined) delete process.env.HERMES_BIN
      else process.env.HERMES_BIN = previousHermesBin
      rmSync(home, { recursive: true, force: true })
    }
  })
})
