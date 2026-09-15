import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupEkkoAgent, type EkkoAgentSetup } from '../../packages/ekko-agent/src'

const configMock = vi.hoisted(() => ({
  port: 8648,
  appHome: '/Users/test/.hermes-web-ui',
}))

vi.mock('../../packages/server/src/modules/studio/public/config', () => ({
  config: configMock,
}))

describe('Ekko MCP server context', () => {
  let baseDirectory = ''
  let setup: EkkoAgentSetup

  beforeEach(() => {
    delete process.env.HERMES_DESKTOP
    delete process.env.HERMES_AGENT_NODE
    delete process.env.HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT
    delete process.env.HERMES_WEB_UI_ALLOW_TRANSIENT_MCP_AUTOINJECT
    delete process.env.HERMES_WEB_UI_MCP_BIN
    configMock.port = 8648
    configMock.appHome = '/Users/test/.hermes-web-ui'
    baseDirectory = mkdtempSync(join(tmpdir(), 'ekko-mcp-context-'))
    setup = setupEkkoAgent({ baseDirectory, profiles: ['work'], env: { NODE_ENV: 'test' } })
  })

  afterEach(() => {
    setup.close()
    rmSync(baseDirectory, { recursive: true, force: true })
  })

  it('builds managed MCP servers for the current Web UI port and profile', async () => {
    const { buildManagedEkkoMcpServers } = await import('../../packages/server/src/modules/ekko/services/mcp')

    const servers = buildManagedEkkoMcpServers('work')

    expect(servers['ekko-studio-api']).toEqual({
      command: process.execPath,
      args: [join(process.cwd(), 'bin/ekko-studio-mcp.mjs'), 'api'],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        HERMES_WEB_UI_URL: 'http://127.0.0.1:8648',
        HERMES_WEB_UI_HOME: '/Users/test/.hermes-web-ui',
        HERMES_WEBUI_STATE_DIR: '/Users/test/.hermes-web-ui',
        HERMES_WEB_UI_PROFILE: 'work',
        HERMES_MCP_SERVER_NAME: 'ekko-studio-api',
        HERMES_MCP_TOOLSET: 'api',
        HERMES_MCP_NATIVE_TASK_PLAN: '1',
        HERMES_WEB_UI_MANAGED_MCP: '1',
      },
      enabled: true,
    })
    expect(servers['ekko-studio-browser']).toMatchObject({
      args: [join(process.cwd(), 'bin/ekko-studio-mcp.mjs'), 'browser'],
      env: { HERMES_WEB_UI_PROFILE: 'work', HERMES_MCP_TOOLSET: 'browser' },
    })
    expect(servers['ekko-studio-devices']).toMatchObject({
      args: [join(process.cwd(), 'bin/ekko-studio-mcp.mjs'), 'devices'],
      env: { HERMES_WEB_UI_PROFILE: 'work', HERMES_MCP_TOOLSET: 'devices' },
    })
    expect(servers['ekko-studio-use']).toMatchObject({
      args: [join(process.cwd(), 'bin/ekko-studio-mcp.mjs'), 'use'],
      env: { HERMES_WEB_UI_PROFILE: 'work', HERMES_MCP_TOOLSET: 'use', HERMES_MCP_NATIVE_TASK_PLAN: '1' },
    })
  })

  it('injects managed servers into config and merges caller-provided overrides', async () => {
    const {
      injectManagedEkkoMcpServers,
      resolveEkkoMcpServers,
    } = await import('../../packages/server/src/modules/ekko/services/mcp')

    const injection = injectManagedEkkoMcpServers(setup)
    expect(injection.targets).toEqual(expect.arrayContaining([
      { profile: 'default', status: 'injected' },
      { profile: 'work', status: 'injected' },
    ]))
    expect(setup.config.getMcpServer('ekko-studio-browser', 'work')).toMatchObject({
      enabled: true,
      env: { HERMES_WEB_UI_PROFILE: 'work' },
    })

    const servers = resolveEkkoMcpServers('default', {
      'ekko-studio-api': { command: 'custom-api' },
      custom: { command: 'custom-mcp' },
    }, setup)

    expect(servers?.['ekko-studio-api']).toEqual({ command: 'custom-api' })
    expect(servers?.custom).toEqual({ command: 'custom-mcp' })
    expect(servers?.['ekko-studio-browser']).toBeDefined()
    expect(servers?.['ekko-studio-devices']).toBeDefined()
    expect(servers?.['ekko-studio-use']).toBeDefined()
  })

  it('repairs persisted managed MCP launch environments without a bundled Node', async () => {
    const { injectManagedEkkoMcpServers } = await import('../../packages/server/src/modules/ekko/services/mcp')
    injectManagedEkkoMcpServers(setup)
    const stale = structuredClone(setup.config.read())
    for (const profile of Object.values(stale.mcp.profiles)) {
      for (const server of Object.values(profile.servers)) delete server.env?.ELECTRON_RUN_AS_NODE
    }
    setup.config.replace(stale)
    const result = injectManagedEkkoMcpServers(setup)
    expect(result.targets.every(target => target.status === 'updated')).toBe(true)
    for (const server of Object.values(setup.config.listMcpServers('work'))) {
      expect(server.command).toBe(process.execPath)
      expect(server.env?.ELECTRON_RUN_AS_NODE).toBe('1')
    }
    expect(injectManagedEkkoMcpServers(setup).targets.every(target => target.status === 'unchanged')).toBe(true)
  })

  it('repairs existing managed definitions to exclude shared planning for Ekko', async () => {
    const { injectManagedEkkoMcpServers } = await import('../../packages/server/src/modules/ekko/services/mcp')
    injectManagedEkkoMcpServers(setup)
    const stale = structuredClone(setup.config.read())
    for (const profile of Object.values(stale.mcp.profiles)) {
      for (const server of Object.values(profile.servers)) delete server.env?.HERMES_MCP_NATIVE_TASK_PLAN
    }
    setup.config.replace(stale)
    expect(injectManagedEkkoMcpServers(setup).targets.every(target => target.status === 'updated')).toBe(true)
    expect(setup.config.getMcpServer('ekko-studio-use', 'work')?.env?.HERMES_MCP_NATIVE_TASK_PLAN).toBe('1')
    expect(injectManagedEkkoMcpServers(setup).targets.every(target => target.status === 'unchanged')).toBe(true)
  })

  it('preserves a disabled managed server while refreshing its injected definition', async () => {
    const {
      injectManagedEkkoMcpServers,
      setEkkoMcpServerEnabled,
    } = await import('../../packages/server/src/modules/ekko/services/mcp')

    injectManagedEkkoMcpServers(setup)
    await setEkkoMcpServerEnabled('work', 'ekko-studio-api', false, setup)
    configMock.port = 8748
    const reinjection = injectManagedEkkoMcpServers(setup)

    expect(reinjection.targets).toContainEqual({ profile: 'work', status: 'updated' })
    expect(setup.config.getMcpServer('ekko-studio-api', 'work')).toMatchObject({
      enabled: false,
      env: { HERMES_WEB_UI_URL: 'http://127.0.0.1:8748' },
    })
  })

  it.each([false, true])('migrates Hermes split names and keeps disabled servers (new names already present: %s)', async (coexisting) => {
    const { injectManagedEkkoMcpServers } = await import('../../packages/server/src/modules/ekko/services/mcp')
    injectManagedEkkoMcpServers(setup)
    const stale = structuredClone(setup.config.read())
    for (const profile of Object.values(stale.mcp.profiles)) {
      for (const [name, server] of Object.entries(profile.servers)) {
        server.enabled = false
        profile.servers[name.replace(/^ekko-/, 'hermes-')] = { ...server }
        if (!coexisting) delete profile.servers[name]
      }
      profile.servers.custom = { command: 'user-command', enabled: true }
    }
    setup.config.replace(stale)
    const result = injectManagedEkkoMcpServers(setup)
    expect(result.targets.every(target => target.status === 'updated')).toBe(true)
    const servers = setup.config.listMcpServers('work')
    expect(Object.keys(servers).some(name => name.startsWith('hermes-studio-'))).toBe(false)
    expect(servers['ekko-studio-use'].enabled).toBe(false)
    expect(servers['ekko-studio-api'].args).toContain(join(process.cwd(), 'bin/ekko-studio-mcp.mjs'))
    expect(servers.custom.command).toBe('user-command')
    expect(Object.keys(servers)).toHaveLength(5)
    expect(injectManagedEkkoMcpServers(setup).targets.every(target => target.status === 'unchanged')).toBe(true)
  })

  it('keeps the browser toolset available for the Electron desktop runtime', async () => {
    process.env.HERMES_DESKTOP = 'true'
    const { buildManagedEkkoMcpServers } = await import('../../packages/server/src/modules/ekko/services/mcp')
    const browser = buildManagedEkkoMcpServers('default')['ekko-studio-browser'] as any
    expect(browser.args).toEqual([join(process.cwd(), 'bin/ekko-studio-mcp.mjs'), 'browser'])
    expect(browser.env.HERMES_MCP_TOOLSET).toBe('browser')
  })

  it('does not inject managed servers when autoinject is disabled or transient', async () => {
    const {
      injectManagedEkkoMcpServers,
      resolveEkkoMcpServers,
    } = await import('../../packages/server/src/modules/ekko/services/mcp')

    process.env.HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT = '1'
    expect(injectManagedEkkoMcpServers(setup).targets).toEqual([])
    expect(resolveEkkoMcpServers('default', undefined, setup)).toBeUndefined()
    expect(resolveEkkoMcpServers('default', { custom: { command: 'custom-mcp' } }, setup)).toEqual({
      custom: { command: 'custom-mcp' },
    })

    delete process.env.HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT
    configMock.appHome = '/private/tmp/wui-preview-home'
    expect(injectManagedEkkoMcpServers(setup).targets).toEqual([])
    expect(resolveEkkoMcpServers('default', undefined, setup)).toBeUndefined()

    process.env.HERMES_WEB_UI_ALLOW_TRANSIENT_MCP_AUTOINJECT = '1'
    injectManagedEkkoMcpServers(setup)
    expect(resolveEkkoMcpServers('default', undefined, setup)?.['ekko-studio-api']).toBeDefined()
  })
})
