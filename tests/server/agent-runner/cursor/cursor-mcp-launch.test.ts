import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { configureProfileConfig } from '../../../../packages/server/src/modules/studio/public/profile-config'
import { prepareCodingAgentLaunch } from '../../../../packages/server/src/bootstrap/coding-agents'

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
  it('writes managed servers into ~/.cursor/mcp.json and asks the CLI to approve them', async () => {
    const home = makeHome()
    mkdirSync(join(home, '.cursor'), { recursive: true })
    writeFileSync(join(home, '.cursor', 'mcp.json'), `${JSON.stringify({
      mcpServers: { docs: { command: 'docs-mcp' } },
    }, null, 2)}\n`)

    const launch = await prepareCodingAgentLaunch('cursor', {
      mode: 'global',
      profile: 'default',
      sessionId: 'cursor-mcp',
    })

    expect(launch.args).toEqual(['--approve-mcps'])
    expect(launch.args).not.toContain('--mcp-config')
    const mcpFile = launch.files.find(file => file.key === 'mcp')
    expect(mcpFile?.absolutePath).toBe(join(home, '.cursor', 'mcp.json'))
    const persisted = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'))
    expect(persisted.mcpServers.docs).toEqual({ command: 'docs-mcp' })
    expect(persisted.mcpServers['ekko-studio-api']).toMatchObject({
      env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
    })
  })
})
