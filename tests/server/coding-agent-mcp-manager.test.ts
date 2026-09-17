import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureProfileConfig } from '../../packages/server/src/modules/studio/public/profile-config'

const stdioOptions: any[] = []
const processTree = vi.hoisted(() => ({ kill: vi.fn() }))

vi.mock('../../packages/server/src/modules/studio/public/process-tree', () => ({
  killOwnedProcessTree: processTree.kill,
}))

vi.mock('@modelcontextprotocol/client', () => ({
  Client: class {
    async connect() {}
    async listTools() {
      return { tools: [{ name: 'custom_tool' }] }
    }
    async close() {}
  },
  SSEClientTransport: class {},
  StreamableHTTPClientTransport: class {},
}))

vi.mock('@modelcontextprotocol/client/stdio', () => ({
  StdioClientTransport: class {
    pid = 4321

    constructor(options: any) {
      stdioOptions.push(options)
    }
  },
}))

import {
  listCodingAgentMcpServers,
  removeCodingAgentMcpServer,
  testCodingAgentMcpServer,
  upsertCodingAgentMcpServer,
} from '../../packages/server/src/modules/coding-agents/services/mcp-manager'
import { codingAgentRunManager } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'

const homes: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hermes-coding-agent-mcp-'))
  homes.push(home)
  process.env.HERMES_CODING_AGENT_GLOBAL_HOME = home
  process.env.HERMES_WEB_UI_HOME = home
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
  delete process.env.HERMES_CODING_AGENT_GLOBAL_HOME
  delete process.env.HERMES_WEB_UI_HOME
  delete process.env.HERMES_PROFILE_API_KEY
  stdioOptions.splice(0)
  processTree.kill.mockClear()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('coding Agent MCP manager', () => {
  it.each(['claude-code', 'codex', 'pi', 'grok', 'opencode', 'dsh'] as const)('gives %s an interaction MCP with enough time for a user answer', async agent => {
    makeHome()
    const { servers } = await listCodingAgentMcpServers(agent)
    const interaction = servers.find(server => server.name === 'ekko-studio-interaction')!
    expect(interaction.managed).toBe(true)
    const config = interaction.raw_config
    if (agent === 'codex' || agent === 'grok') expect(config.tool_timeout_sec).toBeGreaterThanOrEqual(360)
    else if (agent === 'pi') expect(config.requestTimeoutMs).toBeGreaterThanOrEqual(360_000)
    else if (agent === 'dsh') expect(config.toolCallTimeoutMs).toBeGreaterThanOrEqual(360_000)
    else expect(config.timeout).toBeGreaterThanOrEqual(360_000)
    expect((config.env || config.environment).ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('manages DSH native patches without persisting Studio-managed entries', async () => {
    const home = makeHome()
    await upsertCodingAgentMcpServer('dsh', 'docs', { command: 'node', args: ['docs.mjs'] })
    const listed = await listCodingAgentMcpServers('dsh')
    expect(listed.servers.find(server => server.name === 'docs')).toMatchObject({ raw_config: { enabled: true }, managed: false })
    const managed = listed.servers.filter(server => server.managed)
    expect(managed).toHaveLength(6)
    for (const server of managed) expect(server.raw_config.env.ELECTRON_RUN_AS_NODE).toBe('1')
    const path = join(home, '.dsh', 'cordis.patch.yml')
    expect(readFileSync(path, 'utf8')).not.toContain('ekko-studio-api')
    await upsertCodingAgentMcpServer('dsh', 'ekko-studio-api', { enabled: false })
    expect((await listCodingAgentMcpServers('dsh')).servers.find(server => server.name === 'ekko-studio-api')?.raw_config.enabled).toBe(false)
    await removeCodingAgentMcpServer('dsh', 'docs')
    expect((await listCodingAgentMcpServers('dsh')).servers.some(server => server.name === 'docs')).toBe(false)
  })

  it('manages Claude JSON while preserving unrelated root configuration', async () => {
    const home = makeHome()
    const path = join(home, '.claude', 'mcp.json')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(path, `${JSON.stringify({
      enabledMcpjsonServers: ['docs'],
      mcpServers: {
        docs: { url: 'https://example.com/mcp', enabled: true },
      },
    }, null, 2)}\n`)

    const initial = await listCodingAgentMcpServers('claude-code')
    expect(initial.servers.map(server => server.name)).toEqual(expect.arrayContaining([
      'docs',
      'ekko-studio-api',
      'ekko-studio-browser',
      'ekko-studio-devices',
      'ekko-studio-use',
      'ekko-studio-plan',
      'ekko-studio-interaction',
    ]))
    expect(initial.servers.find(server => server.name === 'ekko-studio-api')).toMatchObject({
      managed: true,
      connected: false,
      tools_registered: 0,
    })

    await upsertCodingAgentMcpServer('claude-code', 'search', {
      command: 'node',
      args: ['search.mjs'],
      enabled: true,
    })
    await removeCodingAgentMcpServer('claude-code', 'docs')

    const persisted = JSON.parse(readFileSync(path, 'utf-8'))
    expect(persisted.enabledMcpjsonServers).toEqual(['docs'])
    expect(persisted.mcpServers).toEqual({
      search: { command: 'node', args: ['search.mjs'], enabled: true },
    })
    expect(persisted.mcpServers['ekko-studio-api']).toBeUndefined()
  })

  it('preserves Pi MCP settings and rejects malformed JSON instead of overwriting it', async () => {
    const home = makeHome()
    const path = join(home, '.pi', 'agent', 'mcp.json')
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
    writeFileSync(path, `${JSON.stringify({
      settings: { hostConfigDiscovery: 'off', customFlag: true },
      mcpServers: { files: { command: 'files-mcp' } },
    }, null, 2)}\n`)

    await upsertCodingAgentMcpServer('pi', 'web', { url: 'https://example.com/mcp' })
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({
      settings: { hostConfigDiscovery: 'off', customFlag: true },
      mcpServers: {
        files: { command: 'files-mcp' },
        web: { url: 'https://example.com/mcp' },
      },
    })

    writeFileSync(path, '{ "mcpServers": ')
    await expect(upsertCodingAgentMcpServer('pi', 'unsafe', { command: 'unsafe' }))
      .rejects.toThrow('invalid JSON')
    expect(readFileSync(path, 'utf-8')).toBe('{ "mcpServers": ')
  })

  it.each([
    ['codex', '.codex'],
    ['grok', '.grok'],
  ] as const)('manages %s TOML and preserves non-MCP sections', async (agentId, directory) => {
    const home = makeHome()
    const path = join(home, directory, 'config.toml')
    mkdirSync(join(home, directory), { recursive: true })
    writeFileSync(path, [
      'model = "example-model"',
      '',
      '[features]',
      'web_search = true',
      '',
      '[mcp_servers."docs.search"]',
      'command = "node"',
      'args = ["docs.mjs"]',
      '',
      '[mcp_servers."docs.search".http_headers]',
      '"X-Mode" = "safe"',
      '',
    ].join('\n'))

    await upsertCodingAgentMcpServer(agentId, 'remote-tools', {
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer test-value' },
      enabled: true,
    })
    await removeCodingAgentMcpServer(agentId, 'docs.search')

    const persisted = readFileSync(path, 'utf-8')
    expect(persisted).toContain('model = "example-model"')
    expect(persisted).toContain('[features]')
    expect(persisted).toContain('web_search = true')
    expect(persisted).toContain('[mcp_servers.remote-tools]')
    expect(persisted).toContain('[mcp_servers.remote-tools.http_headers]')
    expect(persisted).not.toContain('[mcp_servers."docs.search"]')
    expect(persisted).not.toContain('[mcp_servers.ekko-studio-api]')
  })

  it('manages and probes OpenCode MCP using its native config shape', async () => {
    const home = makeHome()
    const path = join(home, '.config', 'opencode', 'opencode.json')
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
    writeFileSync(path, `${JSON.stringify({
      theme: 'system',
      mcp: {
        docs: {
          type: 'local',
          command: ['node', 'docs.mjs'],
          environment: { DOCS_MODE: 'safe' },
          enabled: true,
        },
      },
    }, null, 2)}\n`)

    const listed = await listCodingAgentMcpServers('opencode')
    expect(listed.servers.find(server => server.name === 'docs')?.raw_config).toMatchObject({
      type: 'stdio',
      command: 'node',
      args: ['docs.mjs'],
      env: { DOCS_MODE: 'safe' },
    })

    const tested = await testCodingAgentMcpServer('opencode', 'docs')
    expect(tested).toMatchObject({ ok: true, tools: ['custom_tool'] })
    expect(stdioOptions.at(-1)).toMatchObject({
      command: 'node',
      args: ['docs.mjs'],
    })

    await upsertCodingAgentMcpServer('opencode', 'search', {
      command: 'search-mcp',
      args: ['--stdio'],
      env: { SEARCH_MODE: 'local' },
      enabled: true,
    })

    const persisted = JSON.parse(readFileSync(path, 'utf8'))
    expect(persisted.theme).toBe('system')
    expect(persisted.mcp.search).toEqual({
      type: 'local',
      command: ['search-mcp', '--stdio'],
      enabled: true,
      environment: { SEARCH_MODE: 'local' },
    })
    expect(persisted.mcp['ekko-studio-api']).toBeUndefined()
  })

  it('prunes a manually removed Codex MCP server from persisted scoped runtimes', async () => {
    const home = makeHome()
    const globalPath = join(home, '.codex', 'config.toml')
    const scopedRoot = join(home, 'coding-agent', 'model', 'default', 'openrouter', 'codex')
    const runPath = join(scopedRoot, 'runs', 'run-1', 'config.toml')
    mkdirSync(join(home, '.codex'), { recursive: true })
    mkdirSync(join(scopedRoot, 'runs', 'run-1'), { recursive: true })
    const globalConfig = [
      '[mcp_servers.stale]',
      'url = "https://stale.example/mcp"',
      '',
      '[mcp_servers.keep]',
      'url = "https://keep.example/mcp"',
      '',
    ].join('\n')
    const scopedConfig = [
      'model = "test-model"',
      '',
      '[mcp_servers.stale]',
      'url = "https://stale.example/mcp"',
      '',
      '[mcp_servers.keep]',
      'url = "https://keep.example/mcp"',
      '',
    ].join('\n')
    writeFileSync(globalPath, globalConfig)
    writeFileSync(join(scopedRoot, 'config.toml'), scopedConfig)
    writeFileSync(runPath, scopedConfig)

    await removeCodingAgentMcpServer('codex', 'stale')

    for (const path of [globalPath, join(scopedRoot, 'config.toml'), runPath]) {
      const persisted = readFileSync(path, 'utf-8')
      expect(persisted).not.toContain('[mcp_servers.stale]')
      expect(persisted).toContain('[mcp_servers.keep]')
    }
    expect(readFileSync(runPath, 'utf-8')).toContain('model = "test-model"')
  })

  it('reads and preserves quoted TOML header keys when an MCP server is edited', async () => {
    const home = makeHome()
    const path = join(home, '.codex', 'config.toml')
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(path, [
      '[mcp_servers.docs]',
      'url = "https://example.com/mcp"',
      '',
      '[mcp_servers.docs.http_headers]',
      '"X-Mode" = "safe"',
      '"Authorization" = "Bearer value#fragment"',
      '',
    ].join('\n'))

    const listed = await listCodingAgentMcpServers('codex')
    expect(listed.servers.find(server => server.name === 'docs')?.raw_config.headers).toEqual({
      'X-Mode': 'safe',
      Authorization: 'Bearer value#fragment',
    })

    await upsertCodingAgentMcpServer('codex', 'docs', {
      ...listed.servers.find(server => server.name === 'docs')!.raw_config,
      enabled: false,
    })
    const persisted = readFileSync(path, 'utf-8')
    expect(persisted).toContain('X-Mode = "safe"')
    expect(persisted).toContain('Authorization = "Bearer value#fragment"')
  })

  it.each([
    ['codex', '.codex'],
    ['grok', '.grok'],
  ] as const)('preserves multiline TOML arrays when a %s MCP server is edited', async (agentId, directory) => {
    const home = makeHome()
    const path = join(home, directory, 'config.toml')
    mkdirSync(join(home, directory), { recursive: true })
    writeFileSync(path, [
      `[mcp_servers.docs]`,
      'command = "npx"',
      'args = [',
      '  "-y", # package manager confirmation',
      '  "@example/docs-mcp",',
      ']',
      '',
    ].join('\n'))

    const listed = await listCodingAgentMcpServers(agentId)
    const docs = listed.servers.find(server => server.name === 'docs')!
    expect(docs.raw_config.args).toEqual(['-y', '@example/docs-mcp'])

    await upsertCodingAgentMcpServer(agentId, 'docs', {
      ...docs.raw_config,
      enabled: false,
    })

    const persisted = readFileSync(path, 'utf-8')
    expect(persisted).toContain('args = ["-y", "@example/docs-mcp"]')
    expect(persisted).not.toContain('args = "["')
    expect((await listCodingAgentMcpServers(agentId)).servers
      .find(server => server.name === 'docs')?.raw_config.args)
      .toEqual(['-y', '@example/docs-mcp'])
  })

  it('migrates persisted managed overrides and allows enabling an old disabled entry', async () => {
    const home = makeHome()
    const path = join(home, 'coding-agent', 'mcp-overrides.json')
    mkdirSync(join(home, 'coding-agent'), { recursive: true })
    writeFileSync(path, JSON.stringify({
      disabled: { 'claude-code': { default: ['hermes-studio-api'] } },
      configs: { 'claude-code': { default: { 'hermes-studio-use': { command: 'custom-use' } } } },
    }))
    const listed = await listCodingAgentMcpServers('claude-code')
    expect(listed.servers.find(server => server.name === 'ekko-studio-api')?.raw_config.enabled).toBe(false)
    expect(listed.servers.find(server => server.name === 'ekko-studio-use')?.raw_config.command).toBe('custom-use')
    await upsertCodingAgentMcpServer('claude-code', 'hermes-studio-api', { enabled: true })
    expect((await listCodingAgentMcpServers('claude-code')).servers
      .find(server => server.name === 'ekko-studio-api')?.raw_config.enabled).not.toBe(false)
    const saved = JSON.parse(readFileSync(path, 'utf-8'))
    expect(saved.disabled).toBeUndefined()
    expect(saved.configs['claude-code'].default['ekko-studio-use']).toEqual({ command: 'custom-use' })
    expect(saved.configs['claude-code'].default['hermes-studio-use']).toBeUndefined()
  })

  it('uses per-Agent enable overrides for Studio-managed servers and directly tests custom servers', async () => {
    const home = makeHome()
    expect(existsSync(join(home, '.claude', 'mcp.json'))).toBe(false)

    const managed = (await listCodingAgentMcpServers('claude-code')).servers
      .find(server => server.name === 'ekko-studio-api')!
    await upsertCodingAgentMcpServer('claude-code', 'ekko-studio-api', {
      ...managed.raw_config,
      enabled: false,
    })
    expect((await listCodingAgentMcpServers('claude-code')).servers
      .find(server => server.name === 'ekko-studio-api')?.raw_config.enabled).toBe(false)
    await upsertCodingAgentMcpServer('claude-code', 'ekko-studio-api', { enabled: true })
    expect((await listCodingAgentMcpServers('claude-code')).servers
      .find(server => server.name === 'ekko-studio-api')?.raw_config.enabled).not.toBe(false)
    expect(existsSync(join(home, '.claude', 'mcp.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(home, 'coding-agent', 'mcp-overrides.json'), 'utf-8')).configs)
      .toBeUndefined()

    await upsertCodingAgentMcpServer('claude-code', 'custom', { command: 'custom-mcp' })
    process.env.HERMES_PROFILE_API_KEY = 'must-not-reach-mcp-probe'
    await expect(testCodingAgentMcpServer('claude-code', 'custom')).resolves.toEqual({
      ok: true,
      tools: ['custom_tool'],
      tool_details: [{
        name: 'custom_tool',
        description: '',
        input_schema: { type: 'object', properties: {} },
      }],
    })
    expect(stdioOptions).toHaveLength(1)
    expect(stdioOptions[0].env.HERMES_PROFILE_API_KEY).toBeUndefined()
  })

  it('invalidates every provider runtime for an Agent and Profile after managed MCP changes', async () => {
    makeHome()
    const matched: string[] = []
    vi.spyOn(codingAgentRunManager, 'invalidateMatching').mockImplementation((predicate) => {
      for (const launch of [
        { agentId: 'codex', profile: 'default', provider: 'custom:first' },
        { agentId: 'codex', profile: 'default', provider: 'custom:second' },
        { agentId: 'codex', profile: 'other', provider: 'custom:first' },
        { agentId: 'claude-code', profile: 'default', provider: 'custom:first' },
      ] as any[]) {
        if (predicate(launch)) matched.push(`${launch.agentId}/${launch.profile}/${launch.provider}`)
      }
      return { invalidated: matched.length, deferred: 0 }
    })

    await upsertCodingAgentMcpServer('codex', 'ekko-studio-api', {
      url: 'https://mcp.example.com/api',
      enabled: true,
    }, { profile: 'default', provider: 'custom:first' })

    expect(matched).toEqual([
      'codex/default/custom:first',
      'codex/default/custom:second',
    ])
  })

  it('cleans up the complete Windows process tree after probing a stdio server', async () => {
    makeHome()
    await upsertCodingAgentMcpServer('claude-code', 'custom', { command: 'custom-mcp' })
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      await testCodingAgentMcpServer('claude-code', 'custom')
    } finally {
      platform.mockRestore()
    }

    expect(processTree.kill).toHaveBeenCalledWith(4321, expect.any(Function))
  })
})
