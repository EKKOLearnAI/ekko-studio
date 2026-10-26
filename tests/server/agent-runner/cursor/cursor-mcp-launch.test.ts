import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureProfileConfig } from '../../../../packages/server/src/modules/studio/public/profile-config'
import { prepareCodingAgentLaunch } from '../../../../packages/server/src/bootstrap/coding-agents'
import { isolateUnhealthyRuntimeMcpServers } from '../../../../packages/server/src/modules/coding-agents/services/mcp-runtime-isolation'
import { setManagedMcpServerEnabled } from '../../../../packages/server/src/modules/coding-agents/services/mcp-overrides'

const homes: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hermes-cursor-mcp-launch-'))
  homes.push(home)
  process.env.HERMES_WEB_UI_HOME = home
  process.env.HERMES_CODING_AGENT_GLOBAL_HOME = home
  configureProfileConfig({
    buildModelGroups: () => ({ default: '', groups: [] }),
    getProfilesBaseDir: () => join(home, 'profiles'),
    getProfileDir: profile => join(home, 'profiles', profile),
    getActiveProfileName: () => 'default',
    listProfileNames: () => ['default'],
    providerEnvironmentMap: {},
    readConfigYaml: async () => ({}),
    readConfigYamlForProfile: async () => ({}),
    safeReadFile: async filePath => existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null,
    saveEnvValue: async () => undefined,
    saveEnvValueForProfile: async () => undefined,
    updateConfigYaml: async () => undefined,
    updateConfigYamlForProfile: async () => undefined,
  })
  return home
}

afterEach(() => {
  delete process.env.HERMES_WEB_UI_HOME
  delete process.env.HERMES_CODING_AGENT_GLOBAL_HOME
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('Cursor MCP launch wiring', () => {
  it('loads a managed MCP plugin without copying or rewriting native user/project MCP', async () => {
    const home = makeHome()
    mkdirSync(join(home, '.cursor'), { recursive: true })
    const userMcp = `${JSON.stringify({
      mcpServers: {
        docs: { command: 'docs-mcp' },
        later: { command: 'later-mcp', enabled: false },
      },
    }, null, 2)}\n`
    writeFileSync(join(home, '.cursor', 'mcp.json'), userMcp)

    const workspace = join(home, 'project')
    mkdirSync(join(workspace, '.cursor'), { recursive: true })
    writeFileSync(join(workspace, '.cursor', 'mcp.json'), userMcp)
    const launch = await prepareCodingAgentLaunch('cursor', {
      mode: 'global',
      profile: 'alpha',
      sessionId: 'cursor-mcp',
      workspace,
    })

    expect(launch.workspaceDir).toBe(workspace)
    for (const key of ['HOME', 'USERPROFILE', 'CURSOR_CONFIG_DIR', 'CURSOR_API_KEY']) {
      expect(launch.env).not.toHaveProperty(key)
    }
    expect(readFileSync(join(workspace, '.cursor', 'mcp.json'), 'utf8')).toBe(userMcp)
    const manifest = JSON.parse(readFileSync(join(launch.args[2], '.cursor-plugin', 'plugin.json'), 'utf8'))
    expect(manifest).toMatchObject({ name: 'ekko-studio-mcp', mcpServers: 'mcp.json' })
    expect(join(launch.args[2], manifest.mcpServers)).toBe(launch.files.find(file => file.key === 'mcp')?.absolutePath)

    expect(launch.args).not.toContain('--mcp-config')
    const mcpFile = launch.files.find(file => file.key === 'mcp')
    expect(launch.args).toEqual(['--approve-mcps', '--plugin-dir', dirname(mcpFile!.absolutePath)])
    expect(mcpFile?.absolutePath).toBeTruthy()
    expect(mcpFile?.absolutePath).not.toBe(join(home, '.cursor', 'mcp.json'))
    expect(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).toBe(userMcp)
    const runtime = JSON.parse(readFileSync(mcpFile!.absolutePath, 'utf8'))
    expect(runtime.mcpServers.docs).toBeUndefined()
    expect(runtime.mcpServers.later).toBeUndefined()
    expect(runtime.mcpServers['ekko-studio-api']).toMatchObject({
      env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
    })

    const second = await prepareCodingAgentLaunch('cursor', {
      mode: 'global',
      profile: 'beta',
      sessionId: 'cursor-mcp-beta',
    })
    const secondFile = second.files.find(file => file.key === 'mcp')
    expect(secondFile?.absolutePath).not.toBe(mcpFile?.absolutePath)
    expect(second.args).toEqual(['--approve-mcps', '--plugin-dir', dirname(secondFile!.absolutePath)])
    expect(second.args[2]).not.toBe(launch.args[2])
    expect(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).toBe(userMcp)

    const sameProfile = await prepareCodingAgentLaunch('cursor', {
      mode: 'global',
      profile: 'alpha',
      sessionId: 'cursor-mcp-a',
      agentSessionId: 'agent-a',
    })
    const otherSession = await prepareCodingAgentLaunch('cursor', {
      mode: 'global',
      profile: 'alpha',
      sessionId: 'cursor-mcp-b',
      agentSessionId: 'agent-b',
    })
    expect(sameProfile.files.find(file => file.key === 'mcp')?.absolutePath)
      .not.toBe(otherSession.files.find(file => file.key === 'mcp')?.absolutePath)
    expect(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).toBe(userMcp)
  })

  it('forces global mode when the caller requests scoped', async () => {
    const home = makeHome()
    const launch = await prepareCodingAgentLaunch('cursor', {
      mode: 'scoped',
      profile: 'default',
    })

    expect(launch.agentId).toBe('cursor')
    expect(launch.mode).toBe('global')
    expect(launch.command).toBe('agent')
    expect(launch.args[0]).toBe('--approve-mcps')
    expect(launch.args[1]).toBe('--plugin-dir')
    expect(launch.args).not.toContain('--mcp-config')
    expect(launch.args).not.toContain('streaming-json')
    expect(launch.args).not.toContain('--prompt-file')
    const mcpFile = launch.files.find(file => file.key === 'mcp')
    expect(mcpFile?.absolutePath).not.toBe(join(home, '.cursor', 'mcp.json'))
    expect(existsSync(join(home, '.cursor', 'mcp.json'))).toBe(false)
  })

  it('puts the group run credential on the runtime MCP copy only', async () => {
    const home = makeHome()
    mkdirSync(join(home, '.cursor'), { recursive: true })
    const userMcp = `${JSON.stringify({
      mcpServers: { docs: { command: 'docs-mcp' } },
    }, null, 2)}\n`
    writeFileSync(join(home, '.cursor', 'mcp.json'), userMcp)
    const runTokenFile = join(home, 'group-run-credential.json')

    const launch = await prepareCodingAgentLaunch('cursor', {
      mode: 'global',
      profile: 'alpha',
      sessionId: 'cursor-group-mcp',
      agentSessionId: 'agent-group',
      studioMcpTokenFile: runTokenFile,
    })

    const mcpFile = launch.files.find(file => file.key === 'mcp')
    const runtime = JSON.parse(readFileSync(mcpFile!.absolutePath, 'utf8'))
    for (const server of Object.values(runtime.mcpServers) as Array<{ env: Record<string, string> }>) {
      expect(server.env.HERMES_WEB_UI_RUN_TOKEN_FILE).toBe(runTokenFile)
      expect(server.env.HERMES_WEB_UI_PROFILE).toBe('alpha')
      expect(server.env.ELECTRON_RUN_AS_NODE).toBe('1')
    }
    expect(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).toBe(userMcp)
  })

  it('rebinds a resumed session to the runtime copy and leaves the user file untouched', async () => {
    const home = makeHome()
    mkdirSync(join(home, '.cursor'), { recursive: true })
    const userPath = join(home, '.cursor', 'mcp.json')
    writeFileSync(userPath, `${JSON.stringify({
      mcpServers: { docs: { command: 'docs-mcp' } },
    }, null, 2)}\n`)

    const first = await prepareCodingAgentLaunch('cursor', {
      mode: 'global',
      profile: 'alpha',
      sessionId: 'cursor-resume',
      agentSessionId: 'agent-resume',
    })
    const resumedUser = `${JSON.stringify({
      mcpServers: {
        docs: { command: 'docs-mcp' },
        kept: { command: 'kept-mcp' },
        later: { command: 'later-mcp', enabled: false },
      },
    }, null, 2)}\n`
    writeFileSync(userPath, resumedUser)

    const second = await prepareCodingAgentLaunch('cursor', {
      mode: 'global',
      profile: 'alpha',
      sessionId: 'cursor-resume',
      agentSessionId: 'agent-resume',
    })
    const mcpFile = second.files.find(file => file.key === 'mcp')
    expect(mcpFile?.absolutePath).toBeTruthy()
    expect(mcpFile?.absolutePath).not.toBe(userPath)
    expect(second.args).toEqual(['--approve-mcps', '--plugin-dir', dirname(mcpFile!.absolutePath)])
    expect(second.args[2]).toBe(first.args[2])
    expect(readFileSync(userPath, 'utf8')).toBe(resumedUser)
    const runtime = JSON.parse(readFileSync(mcpFile!.absolutePath, 'utf8'))
    expect(runtime.mcpServers.docs).toBeUndefined()
    expect(runtime.mcpServers.kept).toBeUndefined()
    expect(runtime.mcpServers.later).toBeUndefined()
  })

  it('leaves native MCP health checks and disabled entries to Cursor', async () => {
    const home = makeHome()
    mkdirSync(join(home, '.cursor'), { recursive: true })
    const userMcp = `${JSON.stringify({
      mcpServers: {
        docs: { command: 'docs-mcp' },
        later: { command: 'later-mcp', enabled: false },
      },
    }, null, 2)}\n`
    writeFileSync(join(home, '.cursor', 'mcp.json'), userMcp)
    const launch = await prepareCodingAgentLaunch('cursor', {
      mode: 'global',
      profile: 'alpha',
      sessionId: 'cursor-unhealthy',
    })
    const mcpFile = launch.files.find(file => file.key === 'mcp')
    const probe = vi.fn(async () => ({ ok: false, error: 'timeout' }))
    const removed = await isolateUnhealthyRuntimeMcpServers('cursor', mcpFile!.absolutePath, { probe })

    expect(removed).toEqual([])
    expect(probe).not.toHaveBeenCalled()
    expect(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).toBe(userMcp)
    const runtime = JSON.parse(readFileSync(mcpFile!.absolutePath, 'utf8'))
    expect(runtime.mcpServers.docs).toBeUndefined()
    expect(runtime.mcpServers.later).toBeUndefined()
    expect(runtime.mcpServers['ekko-studio-api']).toMatchObject({
      env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
    })
  })

  it('isolates disabled managed servers per profile and refreshes them on resume', async () => {
    makeHome()
    setManagedMcpServerEnabled('cursor', 'alpha', 'ekko-studio-browser', false)
    const input = { profile: 'alpha', sessionId: 'cursor-disabled', agentSessionId: 'agent-disabled' }
    const alpha = await prepareCodingAgentLaunch('cursor', input)
    const beta = await prepareCodingAgentLaunch('cursor', { ...input, profile: 'beta' })
    const servers = (launch: typeof alpha) => JSON.parse(readFileSync(launch.files.find(file => file.key === 'mcp')!.absolutePath, 'utf8')).mcpServers
    expect(servers(alpha)['ekko-studio-browser']).toBeUndefined()
    expect(servers(beta)['ekko-studio-browser']).toBeDefined()
    setManagedMcpServerEnabled('cursor', 'alpha', 'ekko-studio-browser', true)
    const resumed = await prepareCodingAgentLaunch('cursor', input)
    expect(resumed.args).toEqual(alpha.args)
    expect(servers(resumed)['ekko-studio-browser']).toBeDefined()
  })
})
