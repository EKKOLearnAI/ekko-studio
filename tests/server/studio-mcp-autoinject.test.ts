import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const updateConfigYamlForProfileMock = vi.fn()
const listProfileNamesFromDiskMock = vi.fn()
const fixtureRoots: string[] = []
let stableLauncher = ''

type GitMarker =
  | 'directory'
  | 'worktree'
  | 'submodule'
  | 'separate-worktrees'
  | 'nested-submodule-worktrees'

function createLauncherFixture(parent: string, gitMarker?: GitMarker): string {
  const root = mkdtempSync(join(parent, '.studio-mcp-autoinject-test-'))
  fixtureRoots.push(root)
  if (gitMarker === 'directory') mkdirSync(join(root, '.git'))
  if (gitMarker === 'worktree') {
    const gitDir = join(root, '.git-common/worktrees/fixture')
    mkdirSync(gitDir, { recursive: true })
    writeFileSync(join(gitDir, 'commondir'), '../..\n')
    writeFileSync(join(root, '.git'), `gitdir: ${gitDir}\n`)
  }
  if (gitMarker === 'submodule') {
    const gitDir = join(root, '.git-common/modules/fixture')
    mkdirSync(gitDir, { recursive: true })
    writeFileSync(join(root, '.git'), `gitdir: ${gitDir}\n`)
  }
  if (gitMarker === 'separate-worktrees') {
    const gitDir = join(root, '.git-common/worktrees/fixture')
    mkdirSync(gitDir, { recursive: true })
    writeFileSync(join(root, '.git'), `gitdir: ${gitDir}\n`)
  }
  if (gitMarker === 'nested-submodule-worktrees') {
    const gitDir = join(root, '.git-common/modules/vendor/worktrees/fixture')
    mkdirSync(gitDir, { recursive: true })
    writeFileSync(join(root, '.git'), `gitdir: ${gitDir}\n`)
  }
  mkdirSync(join(root, 'bin'))
  const launcher = join(root, 'bin/ekko-studio-mcp.mjs')
  writeFileSync(launcher, '#!/usr/bin/env node\n')
  return launcher
}

function createStableLauncherAlias(targetLauncher: string): string {
  const root = mkdtempSync(join(process.cwd(), '.studio-mcp-autoinject-alias-'))
  fixtureRoots.push(root)
  mkdirSync(join(root, '.git'))
  const aliasBin = join(root, 'bin')
  symlinkSync(dirname(targetLauncher), aliasBin, process.platform === 'win32' ? 'junction' : 'dir')
  return join(aliasBin, basename(targetLauncher))
}

const configMock = vi.hoisted(() => ({
  port: 8648,
  appHome: '/Users/test/.hermes-web-ui',
}))

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  updateConfigYamlForProfile: updateConfigYamlForProfileMock,
}))

vi.mock('../../packages/server/src/modules/hermes/services/profiles/profile', () => ({
  listProfileNamesFromDisk: listProfileNamesFromDiskMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/config', () => ({
  config: configMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}))

describe('studio MCP autoinject', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    delete process.env.HERMES_DESKTOP
    delete process.env.HERMES_AGENT_NODE
    delete process.env.AUTH_TOKEN
    delete process.env.HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT
    delete process.env.HERMES_WEB_UI_ALLOW_TRANSIENT_MCP_AUTOINJECT
    delete process.env.HERMES_WEB_UI_MCP_BIN
    stableLauncher = createLauncherFixture(process.cwd(), 'directory')
    process.env.HERMES_WEB_UI_MCP_BIN = stableLauncher
    configMock.port = 8648
    configMock.appHome = '/Users/test/.hermes-web-ui'
    listProfileNamesFromDiskMock.mockReturnValue(['default', 'work'])
    updateConfigYamlForProfileMock.mockImplementation(async (_profile: string, updater: any) => {
      const updated = await updater({})
      return updated.result
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    delete process.env.HERMES_WEB_UI_MCP_BIN
    for (const root of fixtureRoots.splice(0).reverse()) rmSync(root, { recursive: true, force: true })
  })

  it('injects bundled MCP server into every profile without relying on a global PATH shim', async () => {
    const { injectBundledMcpServer } = await import('../../packages/server/src/modules/hermes/services/mcp/studio-autoinject')

    const result = await injectBundledMcpServer()

    expect(result.targets.map(target => target.profile)).toEqual(['default', 'work'])
    expect(updateConfigYamlForProfileMock).toHaveBeenCalledTimes(2)
    const injectedDefault = await updateConfigYamlForProfileMock.mock.calls[0][1]({})
    expect(injectedDefault.data.mcp_servers['ekko-studio-api']).toEqual({
      command: process.execPath,
      args: [stableLauncher, 'api'],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        HERMES_WEB_UI_URL: 'http://127.0.0.1:8648',
        HERMES_WEB_UI_HOME: '/Users/test/.hermes-web-ui',
        HERMES_WEBUI_STATE_DIR: '/Users/test/.hermes-web-ui',
        HERMES_WEB_UI_PROFILE: 'default',
        HERMES_MCP_SERVER_NAME: 'ekko-studio-api',
        HERMES_MCP_TOOLSET: 'api',
        HERMES_MCP_USER_CLARIFICATION: '0',
        HERMES_WEB_UI_MANAGED_MCP: '1',
      },
      enabled: true,
    })
    expect(injectedDefault.data.mcp_servers['ekko-studio-browser']).toMatchObject({
      command: process.execPath,
      args: [stableLauncher, 'browser'],
      env: {
        HERMES_MCP_SERVER_NAME: 'ekko-studio-browser',
        HERMES_MCP_TOOLSET: 'browser',
      },
      enabled: true,
    })
    expect(injectedDefault.data.mcp_servers['ekko-studio-devices']).toMatchObject({
      command: process.execPath,
      args: [stableLauncher, 'devices'],
      env: {
        HERMES_MCP_SERVER_NAME: 'ekko-studio-devices',
        HERMES_MCP_TOOLSET: 'devices',
      },
      enabled: true,
    })
    expect(injectedDefault.data.mcp_servers['ekko-studio-use']).toMatchObject({
      command: process.execPath,
      args: [stableLauncher, 'use'],
      timeout: 1860,
      env: {
        HERMES_MCP_SERVER_NAME: 'ekko-studio-use',
        HERMES_MCP_TOOLSET: 'use',
      },
      enabled: true,
    })
    expect(injectedDefault.data.mcp_servers['ekko-studio-api']).not.toHaveProperty('timeout')
    expect(injectedDefault.data.mcp_servers['ekko-studio-browser']).not.toHaveProperty('timeout')
    expect(injectedDefault.data.mcp_servers['ekko-studio-devices']).not.toHaveProperty('timeout')
    const injectedWork = await updateConfigYamlForProfileMock.mock.calls[1][1]({})
    expect(injectedWork.data.mcp_servers['ekko-studio-api'].env.HERMES_WEB_UI_PROFILE).toBe('work')
    expect(result.serverNames).toEqual([
      'ekko-studio-api',
      'ekko-studio-browser',
      'ekko-studio-devices',
      'ekko-studio-use',
      'ekko-studio-interaction',
    ])
    expect(result.command).toBe(process.execPath)
  })

  it.each([undefined, '0'])('repairs managed MCP Node mode %s and then leaves the config unchanged', async (runAsNode) => {
    vi.stubEnv('HERMES_DESKTOP', 'true')
    vi.stubEnv('ELECTRON_RUN_AS_NODE', undefined)
    const { injectBundledMcpServer } = await import('../../packages/server/src/modules/hermes/services/mcp/studio-autoinject')
    await injectBundledMcpServer()
    const updater = updateConfigYamlForProfileMock.mock.calls[0][1]
    const initial = await updater({})
    for (const server of Object.values(initial.data.mcp_servers) as any[]) {
      expect(server.command).toBe(process.execPath)
      expect(server.env.ELECTRON_RUN_AS_NODE).toBe('1')
      if (runAsNode === undefined) delete server.env.ELECTRON_RUN_AS_NODE
      else server.env.ELECTRON_RUN_AS_NODE = runAsNode
    }
    initial.data.mcp_servers['ekko-studio-api'].timeout = 42
    const repaired = await updater(initial.data)
    expect(repaired.result.status).toBe('updated')
    for (const server of Object.values(repaired.data.mcp_servers) as any[]) {
      expect(server.env.ELECTRON_RUN_AS_NODE).toBe('1')
    }
    expect(repaired.data.mcp_servers['ekko-studio-api'].timeout).toBe(42)
    expect((await updater(repaired.data)).result.status).toBe('unchanged')
  })

  it('migrates an existing managed use server from the default MCP timeout', async () => {
    const { injectBundledMcpServer } = await import('../../packages/server/src/modules/hermes/services/mcp/studio-autoinject')
    await injectBundledMcpServer()

    const updater = updateConfigYamlForProfileMock.mock.calls[0][1]
    const initial = await updater({})
    const stale = structuredClone(initial.data)
    delete stale.mcp_servers['ekko-studio-use'].timeout

    const migrated = await updater(stale)

    expect(migrated.result.status).toBe('updated')
    expect(migrated.data.mcp_servers['ekko-studio-use'].timeout).toBe(1860)
    expect(migrated.data.mcp_servers['ekko-studio-api']).not.toHaveProperty('timeout')
  })

  it('preserves an existing timeout on an unrelated managed server during config resync', async () => {
    const { injectBundledMcpServer } = await import('../../packages/server/src/modules/hermes/services/mcp/studio-autoinject')
    await injectBundledMcpServer()

    const updater = updateConfigYamlForProfileMock.mock.calls[0][1]
    const initial = await updater({})
    const configured = structuredClone(initial.data)
    configured.mcp_servers['ekko-studio-api'].timeout = 42
    configured.mcp_servers['ekko-studio-api'].env.HERMES_WEB_UI_URL = 'http://127.0.0.1:9999'

    const resynced = await updater(configured)

    expect(resynced.result.status).toBe('updated')
    expect(resynced.data.mcp_servers['ekko-studio-api'].env.HERMES_WEB_UI_URL).toBe('http://127.0.0.1:8648')
    expect(resynced.data.mcp_servers['ekko-studio-api'].timeout).toBe(42)
  })

  it('skips autoinject for transient preview homes by default', async () => {
    configMock.appHome = '/private/tmp/wui-preview-home'
    const { injectBundledMcpServer } = await import('../../packages/server/src/modules/hermes/services/mcp/studio-autoinject')

    const result = await injectBundledMcpServer()

    expect(result.targets).toEqual([])
    expect(updateConfigYamlForProfileMock).not.toHaveBeenCalled()
  })

  it('keeps the same browser MCP entry in desktop mode', async () => {
    process.env.HERMES_DESKTOP = 'true'
    const { injectBundledMcpServer } = await import('../../packages/server/src/modules/hermes/services/mcp/studio-autoinject')
    const result = await injectBundledMcpServer()
    const injected = await updateConfigYamlForProfileMock.mock.calls[0][1]({})
    expect(injected.data.mcp_servers['ekko-studio-browser']).toMatchObject({
      args: [stableLauncher, 'browser'],
      env: { HERMES_MCP_SERVER_NAME: 'ekko-studio-browser', HERMES_MCP_TOOLSET: 'browser' },
    })
    expect(result.serverNames).toContain('ekko-studio-browser')
  })

  it('does not remove the desktop browser entry when a Web UI process resyncs the shared profile', async () => {
    const { injectBundledMcpServer } = await import('../../packages/server/src/modules/hermes/services/mcp/studio-autoinject')
    await injectBundledMcpServer()

    const updater = updateConfigYamlForProfileMock.mock.calls[0][1]
    const desktopManaged = await updater({})
    const browserBefore = structuredClone(desktopManaged.data.mcp_servers['ekko-studio-browser'])
    const webUiResync = await updater(desktopManaged.data)

    expect(webUiResync.write).toBe(false)
    expect(webUiResync.result.status).toBe('unchanged')
    expect(webUiResync.data.mcp_servers['ekko-studio-browser']).toEqual(browserBefore)
  })

  it('skips autoinject for a transient bundled launcher even with a stable app home', async () => {
    process.env.HERMES_WEB_UI_MCP_BIN = createLauncherFixture(tmpdir())
    const { injectBundledMcpServer } = await import('../../packages/server/src/modules/hermes/services/mcp/studio-autoinject')

    const result = await injectBundledMcpServer()

    expect(result.targets).toEqual([])
    expect(updateConfigYamlForProfileMock).not.toHaveBeenCalled()
  })

  it('skips autoinject for a bundled launcher inside a linked Git worktree', async () => {
    process.env.HERMES_WEB_UI_MCP_BIN = createLauncherFixture(process.cwd(), 'worktree')
    const { injectBundledMcpServer } = await import('../../packages/server/src/modules/hermes/services/mcp/studio-autoinject')

    const result = await injectBundledMcpServer()

    expect(result.targets).toEqual([])
    expect(updateConfigYamlForProfileMock).not.toHaveBeenCalled()
  })

  it('keeps autoinject enabled for a submodule-style Git checkout', async () => {
    process.env.HERMES_WEB_UI_MCP_BIN = createLauncherFixture(process.cwd(), 'submodule')
    const { injectBundledMcpServer } = await import('../../packages/server/src/modules/hermes/services/mcp/studio-autoinject')

    const result = await injectBundledMcpServer()

    expect(result.targets.map(target => target.profile)).toEqual(['default', 'work'])
    expect(updateConfigYamlForProfileMock).toHaveBeenCalledTimes(2)
  })

  it('does not treat worktrees-shaped separate git dirs as linked worktrees', async () => {
    const { injectBundledMcpServer } = await import('../../packages/server/src/modules/hermes/services/mcp/studio-autoinject')

    for (const marker of ['separate-worktrees', 'nested-submodule-worktrees'] as const) {
      vi.clearAllMocks()
      process.env.HERMES_WEB_UI_MCP_BIN = createLauncherFixture(process.cwd(), marker)

      const result = await injectBundledMcpServer()

      expect(result.targets.map(target => target.profile)).toEqual(['default', 'work'])
      expect(updateConfigYamlForProfileMock).toHaveBeenCalledTimes(2)
    }
  })

  it('skips stable-looking aliases that resolve to transient launchers', async () => {
    const targets = [
      createLauncherFixture(tmpdir()),
      createLauncherFixture(process.cwd(), 'worktree'),
    ]
    const { injectBundledMcpServer } = await import('../../packages/server/src/modules/hermes/services/mcp/studio-autoinject')

    for (const target of targets) {
      vi.clearAllMocks()
      process.env.HERMES_WEB_UI_MCP_BIN = createStableLauncherAlias(target)

      const result = await injectBundledMcpServer()

      expect(result.targets).toEqual([])
      expect(updateConfigYamlForProfileMock).not.toHaveBeenCalled()
    }
  })

  it('allows transient preview autoinject when explicitly requested', async () => {
    configMock.appHome = '/private/tmp/wui-preview-home'
    process.env.HERMES_WEB_UI_ALLOW_TRANSIENT_MCP_AUTOINJECT = '1'
    const { injectBundledMcpServer } = await import('../../packages/server/src/modules/hermes/services/mcp/studio-autoinject')

    await injectBundledMcpServer()

    expect(updateConfigYamlForProfileMock).toHaveBeenCalledTimes(2)
  })

  it.each([true, false])('renames the managed plan server while preserving enabled=%s and hiding clarification', async enabled => {
    const { injectBundledMcpServer } = await import('../../packages/server/src/modules/hermes/services/mcp/studio-autoinject')
    await injectBundledMcpServer()
    const updater = updateConfigYamlForProfileMock.mock.calls[0][1]
    const current = (await updater({})).data
    const legacy = current.mcp_servers['ekko-studio-interaction']
    legacy.enabled = enabled
    legacy.env.HERMES_MCP_SERVER_NAME = 'ekko-studio-plan'
    delete legacy.env.HERMES_MCP_USER_CLARIFICATION
    current.mcp_servers['ekko-studio-plan'] = legacy
    delete current.mcp_servers['ekko-studio-interaction']
    const migrated = await updater(current)
    expect(migrated.write).not.toBe(false)
    expect(migrated.data.mcp_servers['ekko-studio-plan']).toBeUndefined()
    const server = migrated.data.mcp_servers['ekko-studio-interaction']
    expect(server.enabled).toBe(enabled)
    if (enabled) expect(server.env.HERMES_MCP_USER_CLARIFICATION).toBe('0')
    expect(Object.keys(migrated.data.mcp_servers)).toHaveLength(5)
  })

  it.each([false, true])('migrates Hermes split names without duplicates (new names already present: %s)', async (coexisting) => {
    const { injectBundledMcpServer } = await import('../../packages/server/src/modules/hermes/services/mcp/studio-autoinject')
    await injectBundledMcpServer()
    const updater = updateConfigYamlForProfileMock.mock.calls[0][1]
    const current = (await updater({})).data
    for (const name of Object.keys(current.mcp_servers)) {
      current.mcp_servers[name.replace(/^ekko-/, 'hermes-')] = current.mcp_servers[name]
      if (!coexisting) delete current.mcp_servers[name]
    }
    current.mcp_servers['hermes-studio-api'].timeout = 123
    current.mcp_servers.custom = { command: 'user-command' }
    const migrated = await updater(current)
    expect(migrated.result.status).toBe('updated')
    expect(Object.keys(migrated.data.mcp_servers).some(name => name.startsWith('hermes-studio-'))).toBe(false)
    expect(migrated.data.mcp_servers['ekko-studio-api'].timeout).toBe(123)
    expect(migrated.data.mcp_servers.custom.command).toBe('user-command')
    expect(Object.keys(migrated.data.mcp_servers)).toHaveLength(6)
    const repeated = await updater(migrated.data)
    expect(repeated.result.status).toBe('unchanged')
    expect(repeated.write).toBe(false)
  })

  it('respects a user-disabled managed MCP server entry', async () => {
    const { injectBundledMcpServer } = await import('../../packages/server/src/modules/hermes/services/mcp/studio-autoinject')

    await injectBundledMcpServer()

    const updated = await updateConfigYamlForProfileMock.mock.calls[0][1]({
      mcp_servers: {
        'ekko-studio-api': {
          command: process.execPath,
          args: [stableLauncher, 'api'],
          env: {
            HERMES_WEB_UI_URL: 'http://127.0.0.1:8648',
            HERMES_WEB_UI_HOME: '/Users/test/.hermes-web-ui',
            HERMES_WEBUI_STATE_DIR: '/Users/test/.hermes-web-ui',
            HERMES_WEB_UI_PROFILE: 'default',
            HERMES_MCP_SERVER_NAME: 'ekko-studio-api',
            HERMES_MCP_TOOLSET: 'api',
            HERMES_WEB_UI_MANAGED_MCP: '1',
          },
          enabled: false,
        },
      },
    })

    expect(updated.write).toBe(false)
    expect(updated.result).toMatchObject({
      status: 'skipped',
      reason: 'existing ekko-studio-api MCP server is disabled by user',
    })
    expect(updated.data.mcp_servers['ekko-studio-api'].enabled).toBe(false)
  })

  it('cleans a disabled legacy managed MCP server entry before injecting split servers', async () => {
    const { injectBundledMcpServer } = await import('../../packages/server/src/modules/hermes/services/mcp/studio-autoinject')

    await injectBundledMcpServer()

    const updated = await updateConfigYamlForProfileMock.mock.calls[0][1]({
      mcp_servers: {
        'hermes-studio': {
          command: 'hermes-web-ui-mcp',
          env: {
            HERMES_WEB_UI_MANAGED_MCP: '1',
          },
          enabled: false,
        },
      },
    })

    expect(updated.write).not.toBe(false)
    expect(updated.result).toMatchObject({
      status: 'updated',
    })
    expect(updated.data.mcp_servers['hermes-studio']).toBeUndefined()
    expect(updated.data.mcp_servers['ekko-studio-api']).toBeDefined()
    expect(updated.data.mcp_servers['ekko-studio-browser']).toBeDefined()
    expect(updated.data.mcp_servers['ekko-studio-devices']).toBeDefined()
    expect(updated.data.mcp_servers['ekko-studio-use']).toBeDefined()
  })

  it('updates old managed PATH-only MCP entries to the bundled node script', async () => {
    const { injectBundledMcpServer } = await import('../../packages/server/src/modules/hermes/services/mcp/studio-autoinject')

    await injectBundledMcpServer()

    const updated = await updateConfigYamlForProfileMock.mock.calls[0][1]({
      mcp_servers: {
        'hermes-studio': {
          command: 'hermes-web-ui-mcp',
          env: {
            HERMES_WEB_UI_URL: 'http://127.0.0.1:8648',
            HERMES_WEB_UI_HOME: '/tmp/hermes-web-ui-home',
            HERMES_WEBUI_STATE_DIR: '/tmp/hermes-web-ui-home',
            HERMES_WEB_UI_PROFILE: 'default',
            HERMES_WEB_UI_MANAGED_MCP: '1',
          },
          enabled: true,
        },
        'hermes-web-ui-mcp': {
          command: 'hermes-web-ui-mcp',
          env: {
            HERMES_WEB_UI_MANAGED_MCP: '1',
          },
          enabled: true,
        },
      },
    })
    expect(updated.result.status).toBe('updated')
    expect(updated.data.mcp_servers['hermes-studio']).toBeUndefined()
    expect(updated.data.mcp_servers['hermes-web-ui-mcp']).toBeUndefined()
    expect(updated.data.mcp_servers['ekko-studio-api'].command).toBe(process.execPath)
    expect(updated.data.mcp_servers['ekko-studio-api'].args).toEqual([stableLauncher, 'api'])
    expect(updated.data.mcp_servers['ekko-studio-browser'].args).toEqual([stableLauncher, 'browser'])
    expect(updated.data.mcp_servers['ekko-studio-devices'].args).toEqual([stableLauncher, 'devices'])
    expect(updated.data.mcp_servers['ekko-studio-use'].args).toEqual([stableLauncher, 'use'])
  })

  it('uses the desktop runtime node for bundled MCP servers when available', async () => {
    process.env.HERMES_DESKTOP = 'true'
    process.env.HERMES_AGENT_NODE = '/runtime/node'
    const { injectBundledMcpServer } = await import('../../packages/server/src/modules/hermes/services/mcp/studio-autoinject')

    await injectBundledMcpServer()

    const injected = await updateConfigYamlForProfileMock.mock.calls[0][1]({})
    expect(injected.data.mcp_servers['ekko-studio-api'].command).toBe('/runtime/node')
    expect(injected.data.mcp_servers['ekko-studio-api'].args).toEqual([
      stableLauncher, 'api',
    ])
    expect(injected.data.mcp_servers['ekko-studio-browser'].args).toEqual([
      stableLauncher, 'browser',
    ])
    expect(injected.data.mcp_servers['ekko-studio-devices'].args).toEqual([
      stableLauncher, 'devices',
    ])
    expect(injected.data.mcp_servers['ekko-studio-use'].args).toEqual([
      stableLauncher, 'use',
    ])
  })

  it('removes stale injected tokens from managed server config', async () => {
    const { injectBundledMcpServer } = await import('../../packages/server/src/modules/hermes/services/mcp/studio-autoinject')

    await injectBundledMcpServer()

    const updated = await updateConfigYamlForProfileMock.mock.calls[0][1]({
      mcp_servers: {
        'ekko-studio-api': {
          command: 'hermes-web-ui-mcp',
          args: ['api'],
          env: {
            HERMES_WEB_UI_URL: 'http://127.0.0.1:8648',
            HERMES_WEB_UI_HOME: '/tmp/hermes-web-ui-home',
            HERMES_WEBUI_STATE_DIR: '/tmp/hermes-web-ui-home',
            HERMES_WEB_UI_PROFILE: 'default',
            HERMES_MCP_SERVER_NAME: 'ekko-studio-api',
            HERMES_MCP_TOOLSET: 'api',
            HERMES_WEB_UI_MANAGED_MCP: '1',
            HERMES_WEB_UI_TOKEN: 'old-token',
          },
          enabled: true,
        },
      },
    })
    expect(updated.result.status).toBe('updated')
    expect(updated.data.mcp_servers['ekko-studio-api'].env.HERMES_WEB_UI_TOKEN).toBeUndefined()
  })

  it('skips an unmanaged existing server entry', async () => {
    const { injectBundledMcpServer } = await import('../../packages/server/src/modules/hermes/services/mcp/studio-autoinject')

    await injectBundledMcpServer()

    const updated = await updateConfigYamlForProfileMock.mock.calls[0][1]({
      mcp_servers: {
        'hermes-studio': { command: 'custom-command' },
      },
    })
    expect(updated.write).toBe(false)
    expect(updated.result.status).toBe('skipped')
  })
})
