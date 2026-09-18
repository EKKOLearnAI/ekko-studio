import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { createCipheriv, randomBytes } from 'crypto'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse as parseToml } from 'smol-toml'
import { parse as parseYaml } from 'yaml'
import { readDshMcpServers } from '../../packages/server/src/modules/coding-agents/services/dsh/config'
import { claudeProxyMessages, claudeProxyModels, registerClaudeCodeProxyTarget } from '../../packages/server/src/modules/coding-agents/services/claude-code/proxy'
import {
  revokeCodexProxyTargets,
  codexProxyModels,
  codexProxyResponses,
  isAuthorizedCodexProxyRequest,
  normalizeGrokChatCompletionsRequest,
  normalizeGrokResponsesRequest,
  registerCodexProxyTarget,
} from '../../packages/server/src/modules/coding-agents/services/codex/proxy'
import {
  codexToolSearchConfig,
  migratePersistedPiRuntimeMcpConfigs,
  prepareCodingAgentLaunch,
  restorePersistedCodexProxyTargets,
  restorePersistedPiProxyTargets,
  writeCodingAgentConfigFile,
} from '../../packages/server/src/bootstrap/coding-agents'
import { getModelContextLength } from '../../packages/server/src/modules/hermes/services/models/context'
import {
  normalizePiThinkingLevel,
  piModelSupportsThinking,
} from '../../packages/server/src/modules/coding-agents/services/pi/thinking'
import { codingAgentRunManager } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'
import { configureProfileConfig } from '../../packages/server/src/modules/studio/public/profile-config'
import * as providerRuntime from '../../packages/server/src/modules/studio/public/provider-runtime'
import { upsertCodingAgentMcpServer } from '../../packages/server/src/modules/coding-agents/services/mcp-manager'

// Registry tests verify isolated homes/model injection without requiring a
// machine-wide DSH install. Real Web composition is covered by dsh-web-real.
vi.mock('../../packages/server/src/modules/coding-agents/services/dsh/host', async original => {
  const actual = await original<typeof import('../../packages/server/src/modules/coding-agents/services/dsh/host')>()
  return { ...actual, createDshHost: (host: Parameters<typeof actual.createDshHost>[0]) => ({
    ...actual.createDshHost(host), runtimeInput: async () => ({ sourceHome: host.getSourceHome(), launchPath: '/fixture/bin' }),
  }) }
})

const homes: string[] = []

function mockProcessUid(uid: number) {
  vi.stubGlobal('process', Object.assign(process, {
    getuid: vi.fn(() => uid),
    geteuid: vi.fn(() => uid),
  }))
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'hermes-coding-agent-launch-'))
  homes.push(home)
  process.env.HERMES_WEB_UI_HOME = home
  process.env.HERMES_CODING_AGENT_GLOBAL_HOME = join(home, 'global-home')
  process.env.CODEX_HOME = join(home, 'global-home', '.codex')
  configureProfileConfig({
    buildModelGroups: () => ({ default: '', groups: [] }),
    getProfilesBaseDir: () => join(home, 'profiles'),
    getProfileDir: profile => join(home, 'profiles', profile),
    getActiveProfileName: () => 'default',
    listProfileNames: () => ['default'],
    providerEnvironmentMap: {},
    readConfigYaml: async () => ({}),
    readConfigYamlForProfile: async () => ({
      custom_providers: [{
        name: 'test',
        base_url: 'https://api.example.com/v1',
        api_key: 'sk-restored-upstream',
        api_mode: 'codex_responses',
      }],
    }),
    safeReadFile: async filePath => existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null,
    saveEnvValue: async () => undefined,
    saveEnvValueForProfile: async () => undefined,
    updateConfigYaml: async () => undefined,
    updateConfigYamlForProfile: async () => undefined,
  })
  return home
}

beforeEach(() => {
  mockProcessUid(1000)
})

it.each(['scoped', 'global'] as const)('prepares DSH %s ACP homes independently for simultaneous conversations', async mode => {
  const home = makeHome()
  const input = { mode, profile: 'default', provider: 'custom:test', model: 'test-model',
    baseUrl: 'https://api.example.com/v1', apiKey: 'upstream-test-secret', apiMode: 'chat_completions',
    workspace: join(home, 'workspace'), groupSystemPrompt: 'DSH group instructions' }
  const launch = await prepareCodingAgentLaunch('dsh', { ...input, sessionId: 'one', agentSessionId: 'run-one' })
  const other = await prepareCodingAgentLaunch('dsh', { ...input, sessionId: 'two', agentSessionId: 'run-two' })
  expect(launch.rootDir).not.toBe(other.rootDir)
  expect(launch.env.DSH_HOME).toBe(launch.rootDir)
  expect(launch.env.DSH_PERMISSION_MODE).toBe('danger-full-access')
  expect(launch.env.PATH).toContain('/fixture/bin')
  expect(launch.args).toEqual(['--profile', 'acp', '--patch', join(launch.rootDir, 'studio.patch.yml')])
  expect(readFileSync(launch.promptFile!, 'utf8')).toContain('DSH group instructions')
  const servers = readDshMcpServers(readFileSync(join(launch.rootDir, 'cordis.patch.yml'), 'utf8'))
  expect(servers.size).toBeGreaterThanOrEqual(4)
  for (const server of servers.values()) expect(server.env.ELECTRON_RUN_AS_NODE).toBe('1')
  const overlay = readFileSync(join(launch.rootDir, 'studio.patch.yml'), 'utf8')
  expect(overlay).not.toContain('upstream-test-secret')
  const acpConfig = parseYaml(overlay).find((row: any) => row.id === 'acp')
  if (mode === 'scoped') {
    expect(acpConfig.config).toEqual({ provider: 'ekko-studio', model: 'test-model' })
    expect(launch.env.HERMES_DSH_API_KEY).toBeTruthy()
    expect(launch.env.HERMES_DSH_API_KEY).not.toBe('upstream-test-secret')
  } else expect(acpConfig).toBeUndefined()
})

afterEach(() => {
  delete process.env.HERMES_WEB_UI_HOME
  delete process.env.HERMES_CODING_AGENT_GLOBAL_HOME
  delete process.env.CODEX_HOME
  delete process.env.HERMES_AGENT_NODE
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function makeProxyContext(routeKey: string, token: string, body: any): any {
  return {
    path: `/api/codex-proxy/${routeKey}/v1/responses`,
    params: { key: routeKey },
    request: { body },
    responseHeaders: {} as Record<string, string>,
    get(name: string) {
      if (name.toLowerCase() === 'authorization') return `Bearer ${token}`
      return ''
    },
    set(name: string, value: string) {
      this.responseHeaders[name] = value
    },
  }
}

describe('coding agent launch preparation', () => {
  it('maps Grok system input messages to Responses developer messages', () => {
    const body = {
      instructions: 'Keep top-level instructions.',
      max_output_tokens: 4096,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: 'Grok project rules' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
      ],
    }

    expect(normalizeGrokResponsesRequest(body)).toEqual({
      instructions: body.instructions,
      input: [
        { role: 'developer', content: [{ type: 'input_text', text: 'Grok project rules' }] },
        body.input[1],
      ],
    })
    expect(body.input[0].role).toBe('system')
    expect(body.max_output_tokens).toBe(4096)
  })

  it('maps Grok Chat Completions system messages to developer messages', () => {
    const body = {
      model: 'grok-test',
      messages: [
        { role: 'system', content: 'Project rules' },
        { role: 'user', content: 'Hello' },
      ],
    }

    expect(normalizeGrokChatCompletionsRequest(body)).toEqual({
      ...body,
      messages: [
        { role: 'developer', content: 'Project rules' },
        body.messages[1],
      ],
    })
    expect(body.messages[0].role).toBe('system')
  })

  it('gates Codex tool_search feature flags by CLI version', () => {
    expect(codexToolSearchConfig('0.127.0')).toEqual({ toolSearch: false, alwaysDefer: false })
    expect(codexToolSearchConfig('0.128.0')).toEqual({ toolSearch: true, alwaysDefer: true })
    expect(codexToolSearchConfig('0.141.0')).toEqual({ toolSearch: true, alwaysDefer: true })
    expect(codexToolSearchConfig('0.142.0')).toEqual({ toolSearch: true, alwaysDefer: false })
    expect(codexToolSearchConfig('')).toEqual({ toolSearch: true, alwaysDefer: true })
  })

  it('restores persisted Codex and Grok profile proxy targets after a server restart', async () => {
    const home = makeHome()
    for (const [agentId, suffix] of [['codex', 'codex-restart'], ['grok', 'grok-restart']] as const) {
      const routeKey = Buffer.from(JSON.stringify([
        'default',
        'custom:test',
        `${agentId}-model`,
        'codex_responses',
        'https://api.example.com/v1',
        `${agentId}-agent-session`,
        `${agentId}-chat-session`,
      ])).toString('base64url')
      const token = `hwui_${suffix}`
      const configPath = join(
        home,
        'coding-agent',
        'model',
        'default',
        'custom_test',
        agentId,
        'runs',
        suffix,
        'config.toml',
      )
      mkdirSync(dirname(configPath), { recursive: true })
      writeFileSync(configPath, [
        'model_provider = "custom"',
        '',
        '[model_providers.custom]',
        `base_url = "http://127.0.0.1:8648/api/codex-proxy/${routeKey}/v1"`,
        'requires_openai_auth = false',
        `experimental_bearer_token = ${JSON.stringify(token)}`,
        '',
        '[mcp_servers.unrelated]',
        'base_url = "https://mcp.example.com/not-a-codex-proxy"',
        'experimental_bearer_token = "not-a-runtime-token"',
        '',
      ].join('\n'))
    }

    await expect(restorePersistedCodexProxyTargets()).resolves.toBe(2)

    for (const [agentId, suffix] of [['codex', 'codex-restart'], ['grok', 'grok-restart']] as const) {
      const routeKey = Buffer.from(JSON.stringify([
        'default',
        'custom:test',
        `${agentId}-model`,
        'codex_responses',
        'https://api.example.com/v1',
        `${agentId}-agent-session`,
        `${agentId}-chat-session`,
      ])).toString('base64url')
      expect(isAuthorizedCodexProxyRequest(makeProxyContext(routeKey, `hwui_${suffix}`, {}))).toBe(true)
    }
  })

  it('applies edited Studio-managed MCP configuration to the scoped Codex runtime', async () => {
    const home = makeHome()
    await upsertCodingAgentMcpServer('codex', 'ekko-studio-api', {
      url: 'https://mcp.example.com/api',
      enabled: true,
    }, { profile: 'default', provider: 'custom:test' })

    const launch = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'custom:test',
      model: 'codex-model',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-runtime',
      apiMode: 'codex_responses',
      sessionId: 'managed-mcp-session',
      agentSessionId: 'managed-mcp-agent-session',
    })
    const config = readFileSync(join(launch.rootDir, 'config.toml'), 'utf-8')
    const managedBlock = config.match(/\[mcp_servers\.ekko-studio-api\][\s\S]*?(?=\n\[|$)/)?.[0] || ''
    expect(managedBlock).toContain('url = "https://mcp.example.com/api"')
    expect(managedBlock).not.toContain('command =')
  })

  it('keeps Studio-managed Codex settings at TOML root when user config contains tables', async () => {
    const home = makeHome()
    const globalConfigPath = join(home, 'global-home', '.codex', 'config.toml')
    mkdirSync(dirname(globalConfigPath), { recursive: true })
    writeFileSync(globalConfigPath, [
      'sandbox_mode = "workspace-write"',
      '',
      '[hooks.state."state-id"]',
      'command = "state-hook"',
      '',
    ].join('\n'))

    const launch = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'custom:test',
      model: 'codex-model',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-runtime',
      apiMode: 'codex_responses',
      sessionId: 'codex-table-order-session',
      agentSessionId: 'codex-table-order-agent-session',
    })
    const config = readFileSync(join(launch.rootDir, 'config.toml'), 'utf-8')
    const providerIndex = config.indexOf('model_provider = "custom"')
    const providerSectionIndex = config.indexOf('[model_providers.custom]')
    const hooksSectionIndex = config.indexOf('[hooks.state."state-id"]')

    expect(providerIndex).toBeGreaterThanOrEqual(0)
    expect(providerIndex).toBeLessThan(providerSectionIndex)
    expect(providerSectionIndex).toBeLessThan(hooksSectionIndex)
    expect(config.slice(0, config.indexOf('\n['))).toContain('model = "codex-model"')
  })

  it('preserves complete multiline top-level arrays when strings and comments contain brackets', async () => {
    const home = makeHome()
    const globalConfigPath = join(home, 'global-home', '.codex', 'config.toml')
    mkdirSync(dirname(globalConfigPath), { recursive: true })
    writeFileSync(globalConfigPath, [
      'notify = [',
      '  "first item contains ]",',
      '  "second item", # comment contains [',
      ']',
      '',
      '[features]',
      'goals = true',
      '',
    ].join('\n'))

    const launch = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'custom:test',
      model: 'codex-model',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      apiMode: 'codex_responses',
      sessionId: 'codex-multiline-array-session',
      agentSessionId: 'codex-multiline-array-agent-session',
    })
    const config = readFileSync(join(launch.rootDir, 'config.toml'), 'utf-8')
    const parsed = parseToml(config)

    expect(parsed.notify).toEqual(['first item contains ]', 'second item'])
    expect(config).toContain('  "second item", # comment contains [\n]')
  })

  it('preserves arrays containing multiline strings that end with a quote', async () => {
    const home = makeHome()
    const globalConfigPath = join(home, 'global-home', '.codex', 'config.toml')
    mkdirSync(dirname(globalConfigPath), { recursive: true })
    writeFileSync(globalConfigPath, [
      'notify = [',
      '  """first line contains ]',
      'second line contains [ and ends with a quote"""",',
      ']',
      '',
      '[features]',
      'goals = true',
      '',
    ].join('\n'))

    const launch = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'custom:test',
      model: 'codex-model',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      apiMode: 'codex_responses',
      sessionId: 'codex-multiline-string-array-session',
      agentSessionId: 'codex-multiline-string-array-agent-session',
    })
    const config = readFileSync(join(launch.rootDir, 'config.toml'), 'utf-8')
    const parsed = parseToml(config)

    expect(parsed.notify).toEqual(['first line contains ]\nsecond line contains [ and ends with a quote"'])
    expect(config).toContain('second line contains [ and ends with a quote"""",\n]')
  })

  it('preserves top-level multiline string values', async () => {
    const home = makeHome()
    const globalConfigPath = join(home, 'global-home', '.codex', 'config.toml')
    mkdirSync(dirname(globalConfigPath), { recursive: true })
    writeFileSync(globalConfigPath, [
      'custom_instructions = """first line',
      'second line contains [ and ]',
      'third line"""',
      '',
      '[features]',
      'goals = true',
      '',
    ].join('\n'))

    const launch = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'custom:test',
      model: 'codex-model',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      apiMode: 'codex_responses',
      sessionId: 'codex-multiline-string-session',
      agentSessionId: 'codex-multiline-string-agent-session',
    })
    const config = readFileSync(join(launch.rootDir, 'config.toml'), 'utf-8')
    const parsed = parseToml(config)

    expect(parsed.custom_instructions).toBe('first line\nsecond line contains [ and ]\nthird line')
  })

  it('does not treat table headers inside multiline strings as real sections', async () => {
    const home = makeHome()
    const globalConfigPath = join(home, 'global-home', '.codex', 'config.toml')
    mkdirSync(dirname(globalConfigPath), { recursive: true })
    writeFileSync(globalConfigPath, [
      '[custom]',
      'template = """first line',
      '[features]',
      'this remains string content',
      '"""',
      '',
      '[features]',
      'goals = true',
      '',
    ].join('\n'))

    const launch = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'custom:test',
      model: 'codex-model',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      apiMode: 'codex_responses',
      sessionId: 'codex-multiline-table-string-session',
      agentSessionId: 'codex-multiline-table-string-agent-session',
    })
    const parsed = parseToml(readFileSync(join(launch.rootDir, 'config.toml'), 'utf-8'))

    expect(parsed.custom).toEqual({
      template: 'first line\n[features]\nthis remains string content\n',
    })
  })

  it('keeps Codex array-of-table hooks out of the features table', async () => {
    const home = makeHome()
    const globalConfigPath = join(home, 'global-home', '.codex', 'config.toml')
    mkdirSync(dirname(globalConfigPath), { recursive: true })
    writeFileSync(globalConfigPath, [
      '[features]',
      'goals = true',
      'hooks = true',
      'js_repl = false',
      '',
      '[[hooks.SessionStart]]',
      'matcher = "startup|resume|clear|compact"',
      '',
      '[[hooks.SessionStart.hooks]]',
      'command = \'node "C:/Users/Lenovo/.agent-extensions/token-saver/agent-token-saver-hook.mjs"\'',
      'timeout = 5',
      'type = "command"',
      '',
    ].join('\n'))

    const launch = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'custom:test',
      model: 'codex-model',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      apiMode: 'codex_responses',
      sessionId: 'codex-array-table-session',
      agentSessionId: 'codex-array-table-agent-session',
    })
    const config = readFileSync(join(launch.rootDir, 'config.toml'), 'utf-8')
    const featureIndex = config.indexOf('[features]')
    const featureBlock = config.slice(featureIndex)

    expect(config).toContain('[[hooks.SessionStart]]')
    expect(config).toContain('[[hooks.SessionStart.hooks]]')
    expect(featureBlock).toContain('goals = true')
    expect(featureBlock).not.toContain('matcher = "startup|resume|clear|compact"')
    expect(featureBlock).not.toContain('type = "command"')
  })

  it('preserves empty Codex array-of-table instances', async () => {
    const home = makeHome()
    const globalConfigPath = join(home, 'global-home', '.codex', 'config.toml')
    mkdirSync(dirname(globalConfigPath), { recursive: true })
    writeFileSync(globalConfigPath, [
      '[[hooks.SessionStart]]',
      '',
      '[[hooks.SessionStart]]',
      'matcher = "resume"',
      '',
    ].join('\n'))

    const launch = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'custom:test',
      model: 'codex-model',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      apiMode: 'codex_responses',
      sessionId: 'codex-empty-array-table-session',
      agentSessionId: 'codex-empty-array-table-agent-session',
    })
    const config = readFileSync(join(launch.rootDir, 'config.toml'), 'utf-8')

    expect(config.match(/\[\[hooks\.SessionStart\]\]/g)).toHaveLength(2)
    expect(parseToml(config)).toMatchObject({
      hooks: { SessionStart: [{}, { matcher: 'resume' }] },
    })
  })

  it('invalidates all scoped runtimes when a shared Coding Agent config changes', async () => {
    makeHome()
    const matched: string[] = []
    vi.spyOn(codingAgentRunManager, 'invalidateMatching').mockImplementation((predicate) => {
      for (const launch of [
        { agentId: 'codex', profile: 'default', provider: 'custom:first' },
        { agentId: 'codex', profile: 'other', provider: 'custom:second' },
        { agentId: 'claude-code', profile: 'default', provider: 'custom:first' },
      ] as any[]) {
        if (predicate(launch)) matched.push(`${launch.agentId}/${launch.profile}/${launch.provider}`)
      }
      return { invalidated: matched.length, deferred: 0 }
    })

    await writeCodingAgentConfigFile('codex', 'agents', 'Updated shared instructions.\n', {
      profile: 'default',
      provider: 'custom:first',
    })

    expect(matched).toEqual([
      'codex/default/custom:first',
      'codex/other/custom:second',
    ])
  })

  it('translates Studio reasoning choices into Pi thinking levels', () => {
    expect(normalizePiThinkingLevel('default')).toBeUndefined()
    expect(normalizePiThinkingLevel('none')).toBe('off')
    expect(normalizePiThinkingLevel('ultra')).toBe('max')
    expect(normalizePiThinkingLevel('xhigh')).toBe('xhigh')
    expect(normalizePiThinkingLevel('unsupported')).toBeUndefined()
    expect(piModelSupportsThinking(false, 'high')).toBe(true)
    expect(piModelSupportsThinking(false, 'none')).toBe(false)
    expect(piModelSupportsThinking(true, 'none')).toBe(true)
  })

  it('migrates persisted Pi MCP runtime configs from direct tools to proxy mode', async () => {
    const home = makeHome()
    const piHome = join(home, 'coding-agent', 'model', 'default', 'custom_test', 'pi')
    const runtimeMcpPath = join(piHome, 'runs', 'old-run', 'mcp.json')
    const userMcpPath = join(home, 'coding-agent', 'model', 'default', 'user_only', 'pi', 'mcp.json')
    mkdirSync(dirname(runtimeMcpPath), { recursive: true })
    mkdirSync(dirname(userMcpPath), { recursive: true })
    writeFileSync(runtimeMcpPath, `${JSON.stringify({
      settings: {
        directTools: true,
        freezeDirectTools: true,
        agentPluginPaths: ['./plugins'],
      },
      mcpServers: {
        user_docs: { url: 'https://docs.example.com/mcp', directTools: true },
        'ekko-studio-api': {
          command: 'node',
          env: { HERMES_WEB_UI_MANAGED_MCP: '1' },
          directTools: true,
        },
      },
    }, null, 2)}\n`)
    const userContent = `${JSON.stringify({
      mcpServers: {
        user_docs: { url: 'https://docs.example.com/mcp' },
      },
    }, null, 2)}\n`
    writeFileSync(userMcpPath, userContent)

    await expect(migratePersistedPiRuntimeMcpConfigs()).resolves.toBe(1)

    const migrated = JSON.parse(readFileSync(runtimeMcpPath, 'utf-8'))
    expect(migrated.settings.directTools).toBe(false)
    expect(migrated.settings.agentPluginPaths).toEqual(['./plugins'])
    expect(migrated.settings).not.toHaveProperty('freezeDirectTools')
    expect(migrated.mcpServers.user_docs.directTools).toBe(true)
    expect(migrated.mcpServers['ekko-studio-api']).toMatchObject({
      directTools: false,
      lifecycle: 'lazy',
    })
    expect(readFileSync(userMcpPath, 'utf-8')).toBe(userContent)
    await expect(migratePersistedPiRuntimeMcpConfigs()).resolves.toBe(0)
  })

  it('keeps stable credential-free Pi config files beside isolated run directories', async () => {
    const home = makeHome()
    const adapterEntry = join(
      home,
      'coding-agent',
      'pi-mcp-adapter',
      'node_modules',
      'pi-mcp-adapter',
      'index.ts',
    )
    mkdirSync(dirname(adapterEntry), { recursive: true })
    writeFileSync(adapterEntry, 'export default {}')
    const userMcpPath = join(home, 'global-home', '.pi', 'agent', 'mcp.json')
    mkdirSync(dirname(userMcpPath), { recursive: true })
    writeFileSync(userMcpPath, `${JSON.stringify({
      settings: {
        hostConfigDiscovery: 'off',
        agentPluginPaths: ['./plugins'],
      },
      mcpServers: {
        user_docs: { url: 'https://docs.example.com/mcp' },
      },
    }, null, 2)}\n`)

    const result = await prepareCodingAgentLaunch('pi', {
      profile: 'default',
      provider: 'custom:test',
      model: 'test-model',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-runtime-secret',
      apiMode: 'codex_responses',
      sessionId: 'session-1',
      agentSessionId: 'agent-session-1',
    })

    const piHome = join(home, 'coding-agent', 'model', 'default', 'custom_test', 'pi')
    expect(result.rootDir).toMatch(new RegExp(`${piHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[/\\\\]runs[/\\\\]`))
    expect(existsSync(join(piHome, 'settings.json'))).toBe(true)
    expect(existsSync(join(piHome, 'mcp.json'))).toBe(true)
    expect(existsSync(join(piHome, 'auth.json'))).toBe(false)
    expect(existsSync(join(piHome, 'AGENTS.md'))).toBe(false)
    expect(existsSync(join(piHome, 'models.json'))).toBe(false)
    expect(existsSync(join(piHome, 'APPEND_SYSTEM.md'))).toBe(false)
    expect(existsSync(join(result.rootDir, 'settings.json'))).toBe(true)
    expect(existsSync(join(result.rootDir, 'mcp.json'))).toBe(true)
    expect(existsSync(join(result.rootDir, 'APPEND_SYSTEM.md'))).toBe(true)
    const stableMcp = JSON.parse(readFileSync(join(piHome, 'mcp.json'), 'utf-8'))
    expect(stableMcp.mcpServers).toEqual({})
    const runtimeMcp = JSON.parse(readFileSync(join(result.rootDir, 'mcp.json'), 'utf-8'))
    expect(runtimeMcp.settings.agentPluginPaths).toEqual(['./plugins'])
    expect(runtimeMcp.settings.directTools).toBe(false)
    expect(runtimeMcp.settings).not.toHaveProperty('freezeDirectTools')
    expect(runtimeMcp.mcpServers.user_docs).toEqual({ url: 'https://docs.example.com/mcp' })
    expect(runtimeMcp.mcpServers['ekko-studio-api']).toMatchObject({ directTools: false, lifecycle: 'lazy' })
    expect(runtimeMcp.mcpServers['ekko-studio-browser']).toMatchObject({ directTools: false, lifecycle: 'lazy' })
    expect(runtimeMcp.mcpServers['ekko-studio-devices']).toMatchObject({ directTools: false, lifecycle: 'lazy' })
    expect(runtimeMcp.mcpServers['ekko-studio-use']).toMatchObject({ directTools: false, lifecycle: 'lazy' })
    const runtimeModels = JSON.parse(readFileSync(join(result.rootDir, 'models.json'), 'utf-8'))
    expect(runtimeModels.providers['hermes-studio'].apiKey).toMatch(/^hwui_/)
    expect(runtimeModels.providers['hermes-studio'].apiKey).not.toBe('sk-runtime-secret')
    const persistedProxyTargetPath = join(result.rootDir, 'proxy-target.json')
    const persistedProxyTargetContent = readFileSync(persistedProxyTargetPath, 'utf-8')
    const persistedProxyTarget = JSON.parse(persistedProxyTargetContent)
    expect(persistedProxyTarget.input).toMatchObject({
      profile: 'default',
      provider: 'custom:test',
      model: 'test-model',
      baseUrl: 'https://api.example.com/v1',
      apiMode: 'codex_responses',
    })
    expect(persistedProxyTarget.input).not.toHaveProperty('apiKey')
    expect(persistedProxyTarget.apiKeyEncrypted).toMatchObject({
      v: 2,
      algorithm: 'aes-256-gcm',
    })
    expect(persistedProxyTargetContent).not.toContain('sk-runtime-secret')
    const encryptionKeyPath = join(home, 'coding-agent', '.pi-proxy-target.key')
    expect(existsSync(encryptionKeyPath)).toBe(true)
    if (process.platform !== 'win32') {
      expect(statSync(encryptionKeyPath).mode & 0o777).toBe(0o600)
      expect(statSync(persistedProxyTargetPath).mode & 0o777).toBe(0o600)
    }
    expect(persistedProxyTarget.token).toBe(runtimeModels.providers['hermes-studio'].apiKey)
    await expect(restorePersistedPiProxyTargets()).resolves.toBe(1)
    expect(result.args).not.toContain('rpc')
    expect(readFileSync(join(result.rootDir, 'launch.sh'), 'utf-8')).not.toContain('--mode rpc')

    const rpcResult = await prepareCodingAgentLaunch('pi', {
      profile: 'default',
      provider: 'custom:test',
      model: 'test-model',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-runtime-secret',
      apiMode: 'codex_responses',
      sessionId: 'session-2',
      agentSessionId: 'agent-session-2',
      piOutputMode: 'rpc',
      reasoningEffort: 'high',
    })
    expect(rpcResult.args).toEqual(expect.arrayContaining(['--mode', 'rpc']))
    expect(readFileSync(join(rpcResult.rootDir, 'launch.sh'), 'utf-8')).toContain('--mode rpc')
    const rpcModels = JSON.parse(readFileSync(join(rpcResult.rootDir, 'models.json'), 'utf-8'))
    expect(rpcModels.providers['hermes-studio'].models[0]).toMatchObject({
      reasoning: true,
      thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
    })
  })

  it.each([
    'pi-mcp-adapter@2.32.1',
    'npm:pi-mcp-adapter',
    'npm:pi-mcp-adapter@2.32.1',
    { source: 'npm:pi-mcp-adapter@2.32.1' },
  ])('reuses a user Pi MCP adapter package %j without the bundle', async (adapterPackage) => {
    const home = makeHome()
    const liveSettingsPath = join(home, 'global-home', '.pi', 'agent', 'settings.json')
    mkdirSync(dirname(liveSettingsPath), { recursive: true })
    writeFileSync(liveSettingsPath, `${JSON.stringify({
      packages: [adapterPackage],
    }, null, 2)}\n`)

    const result = await prepareCodingAgentLaunch('pi', {
      profile: 'default',
      provider: 'custom:test',
      model: 'test-model',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-runtime-secret',
      apiMode: 'codex_responses',
      sessionId: 'session-user-adapter',
      agentSessionId: 'agent-session-user-adapter',
    })

    const runtimeSettings = JSON.parse(readFileSync(join(result.rootDir, 'settings.json'), 'utf-8'))
    const bundledEntry = join(home, 'coding-agent', 'pi-mcp-adapter', 'node_modules', 'pi-mcp-adapter', 'index.ts')
    expect(runtimeSettings.extensions).not.toContain(bundledEntry)
    expect(runtimeSettings.extensions).toContain(join(result.rootDir, 'hermes-studio-runtime.ts'))
    // The user's own package selection is preserved so Pi loads their adapter.
    expect(runtimeSettings.packages).toEqual([
      typeof adapterPackage === 'string' && !adapterPackage.startsWith('npm:') ? `npm:${adapterPackage}` : adapterPackage,
    ])
  })

  it('preserves a relative user adapter extension alongside an inherited bundled entry', async () => {
    const home = makeHome()
    const liveDir = join(home, 'global-home', '.pi', 'agent')
    const userAdapter = join(liveDir, 'node_modules', 'pi-mcp-adapter', 'index.ts')
    mkdirSync(dirname(userAdapter), { recursive: true })
    writeFileSync(userAdapter, 'export default function () {}')
    const liveSettings = JSON.stringify({ extensions: ['./node_modules/pi-mcp-adapter/index.ts'] })
    writeFileSync(join(liveDir, 'settings.json'), liveSettings)
    const bundle = join(home, 'coding-agent', 'pi-mcp-adapter', 'node_modules', 'pi-mcp-adapter', 'index.ts')
    const scopedDir = join(home, 'coding-agent', 'model', 'default', 'custom_test', 'pi')
    mkdirSync(scopedDir, { recursive: true })
    writeFileSync(join(scopedDir, 'settings.json'), JSON.stringify({ extensions: [bundle, './custom.ts'] }))
    const result = await prepareCodingAgentLaunch('pi', {
      profile: 'default', provider: 'custom:test', model: 'test-model',
      baseUrl: 'https://api.example.com/v1', apiKey: 'test-key', apiMode: 'codex_responses',
    })
    const settings = JSON.parse(readFileSync(join(result.rootDir, 'settings.json'), 'utf-8'))
    expect(settings.extensions).toContain(userAdapter)
    expect(settings.extensions).toContain(join(scopedDir, 'custom.ts'))
    expect(settings.extensions).not.toContain(bundle)
    expect(settings.extensions).toContain(join(result.rootDir, 'hermes-studio-runtime.ts'))
    expect(readFileSync(join(liveDir, 'settings.json'), 'utf-8')).toBe(liveSettings)
  })

  it('falls back to the bundle when scoped settings disable the live adapter package', async () => {
    const home = makeHome()
    const liveDir = join(home, 'global-home', '.pi', 'agent')
    mkdirSync(liveDir, { recursive: true })
    writeFileSync(join(liveDir, 'settings.json'), JSON.stringify({ packages: ['npm:pi-mcp-adapter'] }))
    const bundle = join(home, 'coding-agent', 'pi-mcp-adapter', 'node_modules', 'pi-mcp-adapter', 'index.ts')
    mkdirSync(dirname(bundle), { recursive: true })
    writeFileSync(bundle, 'export default function () {}')
    const scopedDir = join(home, 'coding-agent', 'model', 'default', 'custom_test', 'pi')
    mkdirSync(scopedDir, { recursive: true })
    const packages = [{ source: 'npm:pi-mcp-adapter', extensions: [] }]
    writeFileSync(join(scopedDir, 'settings.json'), JSON.stringify({ packages }))
    const result = await prepareCodingAgentLaunch('pi', {
      profile: 'default', provider: 'custom:test', model: 'test-model',
      baseUrl: 'https://api.example.com/v1', apiKey: 'test-key', apiMode: 'codex_responses',
    })
    const settings = JSON.parse(readFileSync(join(result.rootDir, 'settings.json'), 'utf-8'))
    expect(settings.extensions).toContain(bundle)
    expect(settings.packages).toEqual(packages)
  })

  it('injects the bundled Pi MCP adapter when the user has no pi-mcp-adapter installed', async () => {
    const home = makeHome()
    const adapterEntry = join(home, 'coding-agent', 'pi-mcp-adapter', 'node_modules', 'pi-mcp-adapter', 'index.ts')
    mkdirSync(dirname(adapterEntry), { recursive: true })
    writeFileSync(adapterEntry, 'export default {}')

    const result = await prepareCodingAgentLaunch('pi', {
      profile: 'default',
      provider: 'custom:test',
      model: 'test-model',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-runtime-secret',
      apiMode: 'codex_responses',
      sessionId: 'session-bundled-adapter',
      agentSessionId: 'agent-session-bundled-adapter',
    })

    const runtimeSettings = JSON.parse(readFileSync(join(result.rootDir, 'settings.json'), 'utf-8'))
    expect(runtimeSettings.extensions).toContain(adapterEntry)
  })

  it('migrates legacy plaintext Pi proxy targets to encrypted storage during restore', async () => {
    const home = makeHome()
    const targetPath = join(
      home,
      'coding-agent',
      'model',
      'default',
      'custom_test',
      'pi',
      'runs',
      'legacy-run',
      'proxy-target.json',
    )
    mkdirSync(dirname(targetPath), { recursive: true })
    writeFileSync(targetPath, `${JSON.stringify({
      input: {
        profile: 'default',
        provider: 'custom:test',
        model: 'legacy-model',
        baseUrl: 'https://legacy.example.com/v1',
        apiKey: 'sk-legacy-plaintext',
        apiMode: 'codex_responses',
        agentId: 'pi',
        agentSessionId: 'legacy-agent-session',
        chatSessionId: 'legacy-chat-session',
      },
      token: 'hwui_legacy_token',
    }, null, 2)}\n`)

    await expect(restorePersistedPiProxyTargets()).resolves.toBe(1)

    const migratedContent = readFileSync(targetPath, 'utf8')
    const migrated = JSON.parse(migratedContent)
    expect(migrated.input).not.toHaveProperty('apiKey')
    expect(migrated.apiKeyEncrypted).toMatchObject({ v: 2, algorithm: 'aes-256-gcm' })
    expect(migratedContent).not.toContain('sk-legacy-plaintext')
    if (process.platform !== 'win32') {
      chmodSync(targetPath, 0o644)
      await expect(restorePersistedPiProxyTargets()).resolves.toBe(1)
      expect(statSync(targetPath).mode & 0o777).toBe(0o600)
    }
    await expect(restorePersistedPiProxyTargets()).resolves.toBe(1)
  })

  it('restores legacy v1 encrypted Pi proxy targets and rewrites them with authenticated v2 metadata', async () => {
    const home = makeHome()
    const keyPath = join(home, 'coding-agent', '.pi-proxy-target.key')
    const targetPath = join(
      home,
      'coding-agent',
      'model',
      'default',
      'custom_test',
      'pi',
      'runs',
      'legacy-v1-run',
      'proxy-target.json',
    )
    mkdirSync(dirname(keyPath), { recursive: true })
    mkdirSync(dirname(targetPath), { recursive: true })
    const key = randomBytes(32)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from('hermes-studio/pi-proxy-target/v1', 'utf8'))
    const ciphertext = Buffer.concat([cipher.update('sk-legacy-v1-secret', 'utf8'), cipher.final()])
    writeFileSync(keyPath, key, { mode: 0o600 })
    writeFileSync(targetPath, `${JSON.stringify({
      input: {
        profile: 'default',
        provider: 'custom:test',
        model: 'legacy-v1-model',
        baseUrl: 'https://legacy-v1.example.com/v1',
        apiMode: 'codex_responses',
        agentId: 'pi',
        agentSessionId: 'legacy-v1-agent-session',
        chatSessionId: 'legacy-v1-chat-session',
      },
      token: 'hwui_legacy_v1_token',
      apiKeyEncrypted: {
        v: 1,
        algorithm: 'aes-256-gcm',
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      },
    }, null, 2)}\n`)

    await expect(restorePersistedPiProxyTargets()).resolves.toBe(1)

    const migratedContent = readFileSync(targetPath, 'utf8')
    const migrated = JSON.parse(migratedContent)
    expect(migrated.apiKeyEncrypted).toMatchObject({ v: 2, algorithm: 'aes-256-gcm' })
    expect(migratedContent).not.toContain('sk-legacy-v1-secret')
    await expect(restorePersistedPiProxyTargets()).resolves.toBe(1)
  })

  it('rejects encrypted Pi proxy credentials when authenticated target metadata is tampered', async () => {
    const home = makeHome()
    const adapterEntry = join(
      home,
      'coding-agent',
      'pi-mcp-adapter',
      'node_modules',
      'pi-mcp-adapter',
      'index.ts',
    )
    mkdirSync(dirname(adapterEntry), { recursive: true })
    writeFileSync(adapterEntry, 'export default {}')

    const result = await prepareCodingAgentLaunch('pi', {
      profile: 'default',
      provider: 'custom:test',
      model: 'test-model',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-authenticated-secret',
      apiMode: 'codex_responses',
      sessionId: 'tamper-session',
      agentSessionId: 'tamper-agent-session',
    })
    const targetPath = join(result.rootDir, 'proxy-target.json')
    const persisted = JSON.parse(readFileSync(targetPath, 'utf8'))
    const tamperedBaseUrl = structuredClone(persisted)
    tamperedBaseUrl.input.baseUrl = 'https://attacker.example.com/v1'
    writeFileSync(targetPath, `${JSON.stringify(tamperedBaseUrl, null, 2)}\n`)

    await expect(restorePersistedPiProxyTargets()).resolves.toBe(0)

    const tamperedToken = structuredClone(persisted)
    tamperedToken.token = 'hwui_attacker_token'
    writeFileSync(targetPath, `${JSON.stringify(tamperedToken, null, 2)}\n`)
    await expect(restorePersistedPiProxyTargets()).resolves.toBe(0)
  })

  it('persists generated isolated Pi session identities when callers omit IDs', async () => {
    const home = makeHome()
    const adapterEntry = join(
      home,
      'coding-agent',
      'pi-mcp-adapter',
      'node_modules',
      'pi-mcp-adapter',
      'index.ts',
    )
    mkdirSync(dirname(adapterEntry), { recursive: true })
    writeFileSync(adapterEntry, 'export default {}')

    const result = await prepareCodingAgentLaunch('pi', {
      profile: 'default',
      provider: 'custom:test',
      model: 'test-model',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-isolated-secret',
      apiMode: 'codex_responses',
    })
    const persisted = JSON.parse(readFileSync(join(result.rootDir, 'proxy-target.json'), 'utf8'))

    expect(persisted.input.agentSessionId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(persisted.input.chatSessionId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(persisted.input.agentSessionId).not.toBe(persisted.input.chatSessionId)
  })

  it.each(['codex', 'claude-code', 'pi'] as const)('injects global %s MCP into private files and preserves user configuration', async agent => {
    const home = makeHome()
    const source = join(home, 'global-home', agent === 'codex' ? '.codex' : agent === 'pi' ? '.pi/agent' : '.claude')
    mkdirSync(source, { recursive: true })
    const external = { command: 'user-mcp', args: ['--custom'], env: { USER_OPTION: 'keep' } }
    const sourceConfig = agent === 'codex' ? 'config.toml' : 'mcp.json'
    const original = agent === 'codex'
      ? [
          '# User formatting must remain unchanged.',
          'model = "user-model"',
          'model_provider = "user-provider"',
          '[profiles.personal]',
          'model = "personal-model"',
          '[mcp_servers."user.tools"]',
          'command = "user-mcp"',
          'args = ["--custom"]',
          'env = { USER_OPTION = "keep" }',
          '[mcp_servers.hermes-studio]',
          'command = "obsolete-studio"',
        ].join('\n')
      : JSON.stringify({ mcpServers: { 'user.tools': external } }, null, 4)
    const settings = JSON.stringify({ defaultProvider: 'user-provider', defaultModel: 'user-model', packages: ['npm:pi-mcp-adapter'] })
    writeFileSync(join(source, sourceConfig), original)
    writeFileSync(join(source, 'settings.json'), settings)
    writeFileSync(join(source, 'auth.json'), '{"user":"login-fixture"}')
    const input = { mode: 'global' as const, profile: 'default', sessionId: 'first', agentSessionId: 'first-run', piOutputMode: 'rpc' as const }
    const first = await prepareCodingAgentLaunch(agent, input)
    const second = await prepareCodingAgentLaunch(agent, { ...input, sessionId: 'second', agentSessionId: 'second-run' })
    const resumed = await prepareCodingAgentLaunch(agent, { ...input, agentNativeSessionId: 'native-thread' })
    expect(first.rootDir).not.toBe(second.rootDir)
    expect(resumed.rootDir).toBe(first.rootDir)
    for (const launch of [first, second, resumed]) {
      const configPath = join(launch.rootDir, sourceConfig)
      const runtime = agent === 'codex' ? parseToml(readFileSync(configPath, 'utf8')) : JSON.parse(readFileSync(configPath, 'utf8'))
      const servers = agent === 'codex' ? runtime.mcp_servers : runtime.mcpServers
      expect(servers['user.tools']).toEqual(external)
      expect(servers['hermes-studio']).toBeUndefined()
      for (const toolset of ['api', 'browser', 'devices', 'use', 'interaction']) {
        expect(servers[`ekko-studio-${toolset}`]).toMatchObject({ env: { ELECTRON_RUN_AS_NODE: '1' } })
      }
      if (agent === 'codex') {
        expect(runtime).toMatchObject({ model: 'user-model', model_provider: 'user-provider', profiles: { personal: { model: 'personal-model' } } })
        expect(launch.env.CODEX_HOME).toBe(launch.rootDir)
      } else {
        expect(launch.args[launch.args.indexOf('--mcp-config') + 1]).toBe(configPath)
        expect(launch.args).not.toContain('--model')
      }
      if (agent === 'pi') {
        expect(launch.env.PI_CODING_AGENT_DIR).toBe(source)
        expect(launch.args.filter(arg => arg.includes('pi-mcp-adapter'))).toEqual([])
      }
    }
    await upsertCodingAgentMcpServer(agent, 'ekko-studio-interaction', { enabled: false }, { profile: 'default', provider: 'global' })
    const disabled = await prepareCodingAgentLaunch(agent, input)
    const content = readFileSync(join(disabled.rootDir, sourceConfig), 'utf8')
    if (agent === 'codex') expect((parseToml(content).mcp_servers as any)['ekko-studio-interaction'].enabled).toBe(false)
    else expect(JSON.parse(content).mcpServers['ekko-studio-interaction']).toBeUndefined()
    expect(readFileSync(join(source, sourceConfig), 'utf8')).toBe(original)
    expect(readFileSync(join(source, 'settings.json'), 'utf8')).toBe(settings)
    expect(readFileSync(join(source, 'auth.json'), 'utf8')).toBe('{"user":"login-fixture"}')
  })

  it('launches Claude Code with the global config when requested', async () => {
    const home = makeHome()
    const rootDir = join(home, 'coding-agent', 'model', 'default', 'global', 'claude-code')
    const promptPath = join(rootDir, 'hermes-rules.md')

    const result = await prepareCodingAgentLaunch('claude-code', {
      mode: 'global',
      profile: 'default',
    })

    expect(result).toMatchObject({
      agentId: 'claude-code',
      mode: 'global',
      profile: 'default',
      provider: 'global',
      model: '',
      rootDir,
      workspaceDir: join(home, 'coding-agent', 'workspace', 'default', 'global'),
      command: 'claude',
      args: [
        '--append-system-prompt-file',
        promptPath,
        '--mcp-config', join(rootDir, 'mcp.json'),
        '--dangerously-skip-permissions',
      ],
      env: {},
      shellCommand: `cd ${join(home, 'coding-agent', 'workspace', 'default', 'global')} && claude --append-system-prompt-file ${promptPath} --mcp-config ${join(rootDir, 'mcp.json')} --dangerously-skip-permissions`,
      files: [{
        key: 'prompt',
        path: 'hermes-rules.md',
        absolutePath: promptPath,
      }, { key: 'mcp', path: 'mcp.json', absolutePath: join(rootDir, 'mcp.json') }],
      promptFile: promptPath,
    })
    const prompt = readFileSync(promptPath, 'utf-8')
    expect(prompt).toContain('<!-- BEGIN HERMES WEB UI PROMPT -->')
    expect(prompt).toContain('# 输出格式规范')
    expect(existsSync(join(home, 'global-home', '.claude', 'hermes-rules.md'))).toBe(false)
  })

  it('uses Claude Code auto permission mode instead of dangerous bypass when running as root', async () => {
    mockProcessUid(0)
    const home = makeHome()

    const result = await prepareCodingAgentLaunch('claude-code', {
      mode: 'global',
      profile: 'default',
    })

    expect(result).toMatchObject({
      agentId: 'claude-code',
      mode: 'global',
      rootDir: join(home, 'coding-agent', 'model', 'default', 'global', 'claude-code'),
      command: 'claude',
      args: [
        '--append-system-prompt-file',
        join(home, 'coding-agent', 'model', 'default', 'global', 'claude-code', 'hermes-rules.md'),
        '--mcp-config', join(home, 'coding-agent', 'model', 'default', 'global', 'claude-code', 'mcp.json'),
        '--permission-mode',
        'auto',
        '--allowedTools',
        'mcp__ekko-studio-interaction__ekko_studio_update_plan',
      ],
      shellCommand: `cd ${join(home, 'coding-agent', 'workspace', 'default', 'global')} && claude --append-system-prompt-file ${join(home, 'coding-agent', 'model', 'default', 'global', 'claude-code', 'hermes-rules.md')} --mcp-config ${join(home, 'coding-agent', 'model', 'default', 'global', 'claude-code', 'mcp.json')} --permission-mode auto --allowedTools mcp__ekko-studio-interaction__ekko_studio_update_plan`,
    })
  })

  it('launches Codex with the global config when requested', async () => {
    const home = makeHome()
    const globalCodexHome = join(home, 'global-home', '.codex')
    const rootDir = join(home, 'coding-agent', 'model', 'default', 'global', 'codex')
    mkdirSync(globalCodexHome, { recursive: true })
    writeFileSync(join(globalCodexHome, 'config.toml'), 'model = "gpt-global"\n')
    writeFileSync(join(globalCodexHome, 'auth.json'), '{"token":"user-token"}\n')
    writeFileSync(join(globalCodexHome, 'AGENTS.md'), 'User global Codex instructions.\n')

    const result = await prepareCodingAgentLaunch('codex', {
      mode: 'global',
      profile: 'default',
    })

    expect(result).toMatchObject({
      agentId: 'codex',
      mode: 'global',
      profile: 'default',
      provider: 'global',
      model: '',
      rootDir,
      workspaceDir: join(home, 'coding-agent', 'workspace', 'default', 'global'),
      command: 'codex',
      args: [],
      env: { CODEX_HOME: rootDir },
      files: [
        { key: 'agents', path: 'AGENTS.md', absolutePath: join(rootDir, 'AGENTS.md') },
        { key: 'config', path: 'config.toml', absolutePath: join(rootDir, 'config.toml') },
      ],
      promptFile: join(rootDir, 'AGENTS.md'),
    })
    expect(result.shellCommand).toContain(`CODEX_HOME=${rootDir}`)
    expect(result.shellCommand).toContain('codex')
    expect(parseToml(readFileSync(join(rootDir, 'config.toml'), 'utf8')).model).toBe('gpt-global')
    expect(readFileSync(join(rootDir, 'auth.json'), 'utf8')).toBe('{"token":"user-token"}\n')
    const prompt = readFileSync(join(rootDir, 'AGENTS.md'), 'utf8')
    expect(prompt).toContain('User global Codex instructions.')
    expect(prompt).toContain('Ekko Studio MCP usage')
    expect(readFileSync(join(globalCodexHome, 'config.toml'), 'utf8')).toBe('model = "gpt-global"\n')
    expect(readFileSync(join(globalCodexHome, 'auth.json'), 'utf8')).toBe('{"token":"user-token"}\n')
    expect(readFileSync(join(globalCodexHome, 'AGENTS.md'), 'utf8')).toBe('User global Codex instructions.\n')
  })

  it('launches Grok from an isolated shadow home without changing the user config', async () => {
    const home = makeHome()
    const globalGrokHome = join(home, 'global-home', '.grok')
    const rootDir = join(home, 'coding-agent', 'model', 'default', 'global', 'grok')
    mkdirSync(globalGrokHome, { recursive: true })
    writeFileSync(join(globalGrokHome, 'config.toml'), '[models]\ndefault = "grok-4"\n')
    writeFileSync(join(globalGrokHome, 'auth.json'), '{"token":"user-token"}\n')
    writeFileSync(join(globalGrokHome, 'AGENTS.md'), 'User global Grok instructions.\n')

    const result = await prepareCodingAgentLaunch('grok', {
      mode: 'global',
      profile: 'default',
    })

    expect(result).toMatchObject({
      agentId: 'grok',
      mode: 'global',
      profile: 'default',
      provider: 'global',
      model: '',
      rootDir,
      workspaceDir: join(home, 'coding-agent', 'workspace', 'default', 'global'),
      command: 'grok',
      args: ['--always-approve', '--no-auto-update'],
      env: { GROK_HOME: rootDir },
      promptFile: join(rootDir, 'AGENTS.md'),
    })
    expect(result.files).toEqual(expect.arrayContaining([
      { key: 'config', path: 'config.toml', absolutePath: join(rootDir, 'config.toml') },
      { key: 'agents', path: 'AGENTS.md', absolutePath: join(rootDir, 'AGENTS.md') },
    ]))
    expect(readFileSync(join(rootDir, 'config.toml'), 'utf8')).toContain('[mcp_servers.ekko-studio-api]')
    expect(readFileSync(join(rootDir, 'auth.json'), 'utf8')).toBe('{"token":"user-token"}\n')
    expect(readFileSync(join(rootDir, 'AGENTS.md'), 'utf8')).toContain('User global Grok instructions.')
    expect(readFileSync(join(globalGrokHome, 'config.toml'), 'utf8')).toBe('[models]\ndefault = "grok-4"\n')
    expect(readFileSync(join(globalGrokHome, 'AGENTS.md'), 'utf8')).toBe('User global Grok instructions.\n')
  })

  it('launches global OpenCode with native provider settings plus managed MCP', async () => {
    const home = makeHome()
    const globalOpenCodeHome = join(home, 'global-home', '.config', 'opencode')
    const firstSkill = join(globalOpenCodeHome, 'skills', 'first-skill')
    const secondSkill = join(globalOpenCodeHome, 'skills', 'second-skill')
    mkdirSync(firstSkill, { recursive: true })
    mkdirSync(secondSkill, { recursive: true })
    writeFileSync(join(globalOpenCodeHome, 'AGENTS.md'), 'User global OpenCode instructions.\n')
    writeFileSync(join(firstSkill, 'SKILL.md'), '# First skill\n')
    writeFileSync(join(secondSkill, 'SKILL.md'), '# Second skill\n')
    writeFileSync(join(globalOpenCodeHome, 'opencode.json'), `${JSON.stringify({
      model: 'native/model',
      provider: { native: { npm: '@ai-sdk/openai-compatible' } },
      instructions: ['USER.md'],
      mcp: { local: { type: 'local', command: ['local-mcp'], enabled: true } },
    }, null, 2)}\n`)

    const result = await prepareCodingAgentLaunch('opencode', {
      mode: 'global',
      profile: 'default',
    })
    const config = JSON.parse(readFileSync(join(result.rootDir, 'opencode.json'), 'utf8'))

    expect(result).toMatchObject({
      agentId: 'opencode',
      mode: 'global',
      provider: 'global',
      model: '',
      command: 'opencode',
      args: [],
      env: {
        OPENCODE_CONFIG_DIR: result.rootDir,
        OPENCODE_DB: join(result.rootDir, 'opencode.db'),
        OPENCODE_CONFIG_CONTENT: expect.any(String),
        OPENCODE_DISABLE_CLAUDE_CODE: '1',
      },
      promptFile: join(result.rootDir, 'hermes-rules.md'),
    })
    expect(config.model).toBe('native/model')
    expect(config.provider.native).toEqual({ npm: '@ai-sdk/openai-compatible' })
    expect(config.instructions).toEqual(['USER.md'])
    expect(JSON.parse(result.env.OPENCODE_CONFIG_CONTENT).instructions)
      .toEqual([join(result.rootDir, 'hermes-rules.md')])
    expect(config.mcp.local).toEqual({ type: 'local', command: ['local-mcp'], enabled: true })
    expect(config.mcp['ekko-studio-api']).toMatchObject({ type: 'local', enabled: true })
    expect(readFileSync(join(result.rootDir, 'AGENTS.md'), 'utf8')).toContain('User global OpenCode instructions.')
    expect(readFileSync(join(result.rootDir, 'hermes-rules.md'), 'utf8')).toContain('BEGIN HERMES WEB UI PROMPT')
    expect(statSync(join(result.rootDir, 'skills')).isDirectory()).toBe(true)
    expect(readFileSync(join(result.rootDir, 'skills', 'first-skill', 'SKILL.md'), 'utf8')).toBe('# First skill\n')
    expect(result.files).toEqual(expect.arrayContaining([
      { key: 'config', path: 'opencode.json', absolutePath: join(result.rootDir, 'opencode.json') },
      { key: 'agents', path: 'AGENTS.md', absolutePath: join(result.rootDir, 'AGENTS.md') },
      { key: 'prompt', path: 'hermes-rules.md', absolutePath: join(result.rootDir, 'hermes-rules.md') },
      { key: 'launcher', path: 'launch.sh', absolutePath: join(result.rootDir, 'launch.sh') },
    ]))
  })

  it.each(['chat', 'group-chat'] as const)('isolates global OpenCode %s prompts while preserving native session storage', async (surface) => {
    const home = makeHome()
    const inputs = ['first', 'second'].map(name => ({
      mode: 'global' as const,
      profile: 'default',
      sessionId: `opencode-${name}`,
      agentSessionId: `run-${name}`,
      workspace: join(home, `workspace-${name}`),
      groupSystemPrompt: `ROLE_${name}`,
      ...(surface === 'group-chat' ? { groupRuntimeScope: { roomId: 'room', agentId: name } } : {}),
    }))
    const first = await prepareCodingAgentLaunch('opencode', inputs[0])
    const second = await prepareCodingAgentLaunch('opencode', inputs[1])

    expect(first.promptFile).not.toBe(second.promptFile)
    for (const [launch, name] of [[first, 'first'], [second, 'second']] as const) {
      expect(launch.promptFile).toBe(join(launch.rootDir, 'hermes-rules.md'))
      expect(readFileSync(launch.promptFile!, 'utf8')).toContain(`ROLE_${name}`)
      expect(JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT).instructions).toEqual([launch.promptFile])
      const launcher = launch.files.find(file => file.key === 'launcher')!
      expect(dirname(launcher.absolutePath)).toBe(launch.rootDir)
      expect(readFileSync(launcher.absolutePath, 'utf8')).toContain(JSON.stringify(launch.promptFile))
    }
    const sharedRoot = join(home, 'coding-agent', 'model', 'default', 'global', 'opencode')
    expect(first.env.OPENCODE_CONFIG_DIR).toBe(sharedRoot)
    expect(first.env.OPENCODE_DB).toBe(join(sharedRoot, 'opencode.db'))
    const resumed = await prepareCodingAgentLaunch('opencode', inputs[0])
    expect(resumed.promptFile).toBe(first.promptFile)
    expect(resumed.env.OPENCODE_DB).toBe(first.env.OPENCODE_DB)
    expect(readFileSync(second.promptFile!, 'utf8')).toContain('ROLE_second')
  })

  it('launches scoped OpenCode through the Responses proxy without writing the upstream key', async () => {
    const home = makeHome()
    const globalOpenCodeHome = join(home, 'global-home', '.config', 'opencode')
    const globalSkill = join(globalOpenCodeHome, 'skills', 'workflow-skill')
    mkdirSync(globalSkill, { recursive: true })
    writeFileSync(join(globalOpenCodeHome, 'AGENTS.md'), 'OpenCode workflow memory.\n')
    writeFileSync(join(globalSkill, 'SKILL.md'), '# Workflow skill\n')
    const result = await prepareCodingAgentLaunch('opencode', {
      mode: 'scoped',
      profile: 'default',
      sessionId: 'opencode-chat',
      agentSessionId: 'opencode-run',
      provider: 'test',
      model: 'test-model',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-opencode-upstream',
      apiMode: 'codex_responses',
    })
    const configText = readFileSync(join(result.rootDir, 'opencode.json'), 'utf8')
    const config = JSON.parse(configText)

    expect(result.args).toEqual(['--model', 'hermes-studio/test-model'])
    expect(result.env.HERMES_OPENCODE_API_KEY).toBeTruthy()
    expect(result.env.HERMES_OPENCODE_API_KEY).not.toBe('sk-opencode-upstream')
    expect(result.env.OPENCODE_CONFIG).toBeUndefined()
    const baseRoot = join(home, 'coding-agent', 'model', 'default', 'test', 'opencode')
    expect(result.env.OPENCODE_CONFIG_DIR).toBe(baseRoot)
    expect(result.env.OPENCODE_DB).toBe(join(result.rootDir, 'opencode.db'))
    expect(result.env.OPENCODE_CONFIG_CONTENT).toBe(configText)
    expect(result.env.OPENCODE_DISABLE_CLAUDE_CODE).toBe('1')
    expect(result.env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBeUndefined()
    expect(result.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined()
    expect(config.model).toBe('hermes-studio/test-model')
    expect(config.provider['hermes-studio'].npm).toBe('@ai-sdk/openai')
    expect(config.provider['hermes-studio'].options.baseURL).toContain('/api/codex-proxy/')
    expect(config.provider['hermes-studio'].options.apiKey).toBe('{env:HERMES_OPENCODE_API_KEY}')
    expect(config.provider['hermes-studio'].models['test-model']).toMatchObject({
      attachment: true,
      modalities: { input: ['text', 'image'], output: ['text'] },
    })
    expect(configText).not.toContain('sk-opencode-upstream')
    expect(readFileSync(join(result.rootDir, 'AGENTS.md'), 'utf8')).not.toContain('OpenCode workflow memory.')
    expect(readFileSync(join(baseRoot, 'AGENTS.md'), 'utf8')).toContain('OpenCode workflow memory.')
    expect(JSON.parse(readFileSync(join(baseRoot, 'opencode.json'), 'utf8')).mcp['ekko-studio-api'])
      .toMatchObject({ type: 'local', enabled: true })
    expect(statSync(join(baseRoot, 'skills')).isDirectory()).toBe(true)
    expect(readFileSync(join(baseRoot, 'skills', 'workflow-skill', 'SKILL.md'), 'utf8')).toBe('# Workflow skill\n')
    expect(existsSync(join(baseRoot, 'launch.sh'))).toBe(true)
    expect(existsSync(join(result.rootDir, 'skills'))).toBe(false)
  })

  it.each([{ input: ['text'] }, { input: ['text', 'image'] }])('allows OpenCode images regardless of model metadata $input', async ({ input }) => {
    makeHome()
    const capabilities = vi.spyOn(providerRuntime, 'getModelRuntimeCapabilities').mockReturnValue({
      input, reasoning: false, contextWindow: 128_000, outputLimit: 8192,
    })
    const launch = await prepareCodingAgentLaunch('opencode', {
      mode: 'scoped', profile: 'default', provider: 'test', model: 'capability-test',
      baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', apiMode: 'codex_responses',
      sessionId: 'image-capabilities', agentSessionId: 'image-capabilities-run',
    })
    const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT)
    expect(config.provider['hermes-studio'].models['capability-test']).toMatchObject({
      attachment: true, modalities: { input: ['text', 'image'], output: ['text'] },
    })
    expect(capabilities).not.toHaveBeenCalled()
  })

  it('launches interactive Pi with its global config when requested', async () => {
    const home = makeHome()
    const adapter = join(home, 'coding-agent', 'pi-mcp-adapter', 'node_modules', 'pi-mcp-adapter', 'index.ts')
    mkdirSync(dirname(adapter), { recursive: true })
    writeFileSync(adapter, 'export default {}')

    const result = await prepareCodingAgentLaunch('pi', {
      mode: 'global',
      profile: 'default',
    })
    const rootDir = result.rootDir
    const promptPath = join(rootDir, 'APPEND_SYSTEM.md')

    expect(result).toMatchObject({
      agentId: 'pi',
      mode: 'global',
      profile: 'default',
      provider: 'global',
      model: '',
      rootDir,
      workspaceDir: join(home, 'coding-agent', 'workspace', 'default', 'global'),
      command: 'pi',
      args: ['--append-system-prompt', promptPath, '--extension', adapter, '--mcp-config', join(rootDir, 'mcp.json')],
      env: { PI_CODING_AGENT_DIR: join(home, 'global-home', '.pi', 'agent') },
      files: [
        { key: 'prompt', path: 'APPEND_SYSTEM.md', absolutePath: promptPath },
        { key: 'mcp', path: 'mcp.json', absolutePath: join(rootDir, 'mcp.json') },
      ],
      promptFile: promptPath,
    })
    expect(rootDir).toContain(join('coding-agent', 'model', 'default', 'global', 'pi', 'runs'))
    expect(readFileSync(promptPath, 'utf8')).toContain('Ekko Studio MCP usage')
    expect(existsSync(join(home, 'global-home', '.pi', 'agent', 'APPEND_SYSTEM.md'))).toBe(false)
  })

  it('runs Studio Pi chats over RPC while preserving the global Pi config', async () => {
    const home = makeHome()
    const adapter = join(home, 'coding-agent', 'pi-mcp-adapter', 'node_modules', 'pi-mcp-adapter', 'index.ts')
    mkdirSync(dirname(adapter), { recursive: true })
    writeFileSync(adapter, 'export default {}')

    const result = await prepareCodingAgentLaunch('pi', {
      mode: 'global',
      profile: 'default',
      sessionId: 'global-pi-chat',
      agentSessionId: 'global-pi-run',
      agentNativeSessionId: 'global-pi-native',
      piOutputMode: 'rpc',
    })

    expect(result).toMatchObject({
      agentId: 'pi',
      mode: 'global',
      profile: 'default',
      provider: 'global',
      model: '',
      workspaceDir: join(home, 'coding-agent', 'workspace', 'default', 'global'),
      command: 'pi',
      env: {
        PI_CODING_AGENT_DIR: join(home, 'global-home', '.pi', 'agent'),
      },
    })
    expect(result.rootDir).toContain(join('model', 'default', 'global', 'pi', 'runs'))
    expect(result.args).toEqual([
      '--mode', 'rpc',
      '--session-id', 'global-pi-native',
      '--extension', join(result.rootDir, 'hermes-studio-runtime.ts'),
      '--extension', adapter,
      '--mcp-config', join(result.rootDir, 'mcp.json'),
      '--no-approve',
    ])
    expect(result.args).not.toContain('--provider')
    expect(result.args).not.toContain('--model')
    expect(result.args).not.toContain('--session-dir')
    expect(result.env.HERMES_PI_DYNAMIC_PROMPT_FILE).toBe(join(result.rootDir, 'dynamic-system-prompt.md'))
    expect(readFileSync(join(result.rootDir, 'hermes-studio-runtime.ts'), 'utf8'))
      .toContain('before_agent_start')
    expect(readFileSync(join(result.rootDir, 'dynamic-system-prompt.md'), 'utf8')).toBe('')
    expect(readFileSync(join(result.rootDir, 'launch.sh'), 'utf8')).toContain('--mode rpc')
  })

  it('does not modify an existing global Claude Code prompt file', async () => {
    const home = makeHome()
    const claudePromptPath = join(home, 'global-home', '.claude', 'hermes-rules.md')
    mkdirSync(dirname(claudePromptPath), { recursive: true })
    writeFileSync(claudePromptPath, 'Existing Claude notes\n')

    await prepareCodingAgentLaunch('claude-code', { mode: 'global', profile: 'default' })
    await prepareCodingAgentLaunch('claude-code', { mode: 'global', profile: 'default' })

    expect(readFileSync(claudePromptPath, 'utf-8')).toBe('Existing Claude notes\n')
    const studioPromptPath = join(home, 'coding-agent', 'model', 'default', 'global', 'claude-code', 'hermes-rules.md')
    expect(readFileSync(studioPromptPath, 'utf-8').match(/BEGIN HERMES WEB UI PROMPT/g)).toHaveLength(1)
  })

  it('uses a selected workspace directory when launching a coding agent', async () => {
    const home = makeHome()
    const workspace = join(home, 'selected workspace')

    const result = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'openrouter',
      model: 'openai/gpt-oss-20b:free',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
      workspace,
    })

    expect(result.rootDir).toBe(join(home, 'coding-agent', 'model', 'default', 'openrouter', 'codex'))
    expect(result.workspaceDir).toBe(workspace)
    expect(result.shellCommand).toContain(workspace)
  })

  it('launches Claude Code with scoped settings instead of a CLI --model override', async () => {
    const home = makeHome()

    const result = await prepareCodingAgentLaunch('claude-code', {
      profile: 'default',
      provider: 'openrouter',
      model: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
    })

    expect(result.rootDir).toBe(join(home, 'coding-agent', 'model', 'default', 'openrouter', 'claude-code'))
    expect(result.workspaceDir).toBe(join(home, 'coding-agent', 'workspace', 'default', 'openrouter'))
    expect(result.args).toEqual([
      '--settings',
      join(result.rootDir, 'settings.json'),
      '--mcp-config',
      join(result.rootDir, 'mcp.json'),
      '--append-system-prompt-file',
      join(result.rootDir, 'hermes-rules.md'),
      '--dangerously-skip-permissions',
    ])
    expect(result.shellCommand).toContain(`cd ${join(home, 'coding-agent', 'workspace', 'default', 'openrouter')} &&`)
    expect(result.shellCommand).toContain(join(result.rootDir, 'launch.sh'))
    expect(result.shellCommand).not.toContain('ANTHROPIC_API_KEY')
    expect(result.shellCommand).not.toContain('hwui_')
    expect(result.shellCommand).not.toContain('--model')
    const launcher = readFileSync(join(result.rootDir, 'launch.sh'), 'utf-8')
    expect(launcher).toContain('exec claude --settings')
    expect(launcher).toContain('--dangerously-skip-permissions')
    expect(launcher).not.toContain('--model')

    const settings = JSON.parse(readFileSync(join(result.rootDir, 'settings.json'), 'utf-8'))
    expect(settings.model).toBe('cognitivecomputations/dolphin-mistral-24b-venice-edition:free')
    expect(settings.env.ANTHROPIC_API_KEY).toMatch(/^hwui_/)
    expect(settings.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
    expect(settings.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/claude-code-proxy\/.+$/)
    expect(settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(String(getModelContextLength({
      profile: 'default',
      provider: 'openrouter',
      model: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
    })))
    expect(settings.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('50')
    expect(settings.env.ENABLE_TOOL_SEARCH).toBe('true')
    expect(settings.env).toMatchObject({
      ANTHROPIC_MODEL: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
      ANTHROPIC_CUSTOM_MODEL_OPTION: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
      ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'Dolphin Mistral 24b Venice Edition:Free',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
      ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'Dolphin Mistral 24b Venice Edition:Free',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'Dolphin Mistral 24b Venice Edition:Free',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'Dolphin Mistral 24b Venice Edition:Free',
    })
    expect(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL).not.toBe('claude-sonnet-4-6')
    expect(result.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)
    expect(result.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('50')
    expect(result.env.ENABLE_TOOL_SEARCH).toBe('true')

    const mcp = JSON.parse(readFileSync(join(result.rootDir, 'mcp.json'), 'utf-8'))
    expect(mcp.mcpServers['ekko-studio-api']).toMatchObject({
      command: process.execPath,
      args: [join(process.cwd(), 'bin/ekko-studio-mcp.mjs'), 'api'],
      env: {
        HERMES_WEB_UI_URL: 'http://127.0.0.1:8648',
        HERMES_WEB_UI_HOME: home,
        HERMES_WEBUI_STATE_DIR: home,
        HERMES_WEB_UI_PROFILE: 'default',
        HERMES_MCP_SERVER_NAME: 'ekko-studio-api',
        HERMES_MCP_TOOLSET: 'api',
        HERMES_WEB_UI_MANAGED_MCP: '1',
      },
    })
    for (const name of ['ekko-studio-api', 'ekko-studio-browser', 'ekko-studio-devices', 'ekko-studio-use', 'ekko-studio-interaction']) {
      expect(mcp.mcpServers[name].env.ELECTRON_RUN_AS_NODE).toBe('1')
    }
    expect(mcp.mcpServers['ekko-studio-browser']).toMatchObject({
      command: process.execPath,
      args: [join(process.cwd(), 'bin/ekko-studio-mcp.mjs'), 'browser'],
      env: {
        HERMES_MCP_SERVER_NAME: 'ekko-studio-browser',
        HERMES_MCP_TOOLSET: 'browser',
      },
    })
    expect(mcp.mcpServers['ekko-studio-devices']).toMatchObject({
      command: process.execPath,
      args: [join(process.cwd(), 'bin/ekko-studio-mcp.mjs'), 'devices'],
      env: {
        HERMES_MCP_SERVER_NAME: 'ekko-studio-devices',
        HERMES_MCP_TOOLSET: 'devices',
      },
    })
    expect(mcp.mcpServers['ekko-studio-use']).toMatchObject({
      command: process.execPath,
      args: [join(process.cwd(), 'bin/ekko-studio-mcp.mjs'), 'use'],
      env: {
        HERMES_MCP_SERVER_NAME: 'ekko-studio-use',
        HERMES_MCP_TOOLSET: 'use',
      },
    })

    const prompt = readFileSync(join(result.rootDir, 'hermes-rules.md'), 'utf-8')
    expect(prompt).toContain('# 输出格式规范')
    expect(prompt).toContain('当你的回复中包含图片、视频或文件引用时')
  })

  it('uses the desktop runtime node for scoped Ekko Studio MCP configs when available', async () => {
    const home = makeHome()
    process.env.HERMES_AGENT_NODE = '/runtime/node'

    const result = await prepareCodingAgentLaunch('claude-code', {
      profile: 'default',
      provider: 'openrouter',
      model: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
    })

    const mcp = JSON.parse(readFileSync(join(result.rootDir, 'mcp.json'), 'utf-8'))
    expect(mcp.mcpServers['ekko-studio-api']).toMatchObject({
      command: '/runtime/node',
      args: [join(process.cwd(), 'bin/ekko-studio-mcp.mjs'), 'api'],
      env: {
        HERMES_WEB_UI_HOME: home,
        HERMES_MCP_SERVER_NAME: 'ekko-studio-api',
        HERMES_MCP_TOOLSET: 'api',
      },
    })
    expect(mcp.mcpServers['ekko-studio-devices'].command).toBe('/runtime/node')
    expect(mcp.mcpServers['ekko-studio-browser'].command).toBe('/runtime/node')
    expect(mcp.mcpServers['ekko-studio-use'].command).toBe('/runtime/node')
  })

  it('cleans legacy Hermes MCP entries from scoped Claude and Codex configs', async () => {
    const home = makeHome()
    const claudeRoot = join(home, 'coding-agent', 'model', 'default', 'openrouter', 'claude-code')
    const claudeMcpPath = join(claudeRoot, 'mcp.json')
    mkdirSync(dirname(claudeMcpPath), { recursive: true })
    writeFileSync(claudeMcpPath, `${JSON.stringify({
      mcpServers: {
        'hermes-studio': {
          command: 'hermes-web-ui-mcp',
          env: { HERMES_WEB_UI_MANAGED_MCP: '1' },
        },
        'hermes-web-ui-mcp': {
          command: 'hermes-web-ui-mcp',
          env: { HERMES_WEB_UI_MANAGED_MCP: '1' },
        },
        custom: {
          command: 'custom-mcp',
        },
      },
    }, null, 2)}\n`)

    const claude = await prepareCodingAgentLaunch('claude-code', {
      profile: 'default',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
    })
    const claudeMcp = JSON.parse(readFileSync(join(claude.rootDir, 'mcp.json'), 'utf-8'))
    expect(claudeMcp.mcpServers['hermes-studio']).toBeUndefined()
    expect(claudeMcp.mcpServers['hermes-web-ui-mcp']).toBeUndefined()
    expect(claudeMcp.mcpServers.custom).toEqual({ command: 'custom-mcp' })
    expect(claudeMcp.mcpServers['ekko-studio-api']).toBeDefined()
    expect(claudeMcp.mcpServers['ekko-studio-browser']).toBeDefined()
    expect(claudeMcp.mcpServers['ekko-studio-devices']).toBeDefined()
    expect(claudeMcp.mcpServers['ekko-studio-use']).toBeDefined()

    const codexRoot = join(home, 'coding-agent', 'model', 'default', 'openrouter', 'codex')
    const codexConfigPath = join(codexRoot, 'config.toml')
    mkdirSync(dirname(codexConfigPath), { recursive: true })
    writeFileSync(codexConfigPath, [
      '[mcp_servers.hermes-studio]',
      'command = "hermes-web-ui-mcp"',
      '[mcp_servers.hermes-web-ui-mcp]',
      'command = "hermes-web-ui-mcp"',
      '',
    ].join('\n'))

    const codex = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'openrouter',
      model: 'openai/gpt-oss-20b:free',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
    })
    const codexConfig = readFileSync(join(codex.rootDir, 'config.toml'), 'utf-8')
    expect(codexConfig).not.toContain('[mcp_servers.hermes-studio]')
    expect(codexConfig).not.toContain('[mcp_servers.hermes-web-ui-mcp]')
    expect(codexConfig).toContain('[mcp_servers.ekko-studio-api]')
    expect(codexConfig).toContain('[mcp_servers.ekko-studio-browser]')
    expect(codexConfig).toContain('[mcp_servers.ekko-studio-devices]')
    expect(codexConfig).toContain('[mcp_servers.ekko-studio-use]')
    expect(codexConfig).toContain('[mcp_servers.ekko-studio-interaction]')
    expect(codexConfig).toMatch(/\[mcp_servers.ekko-studio-interaction\][\s\S]*?tool_timeout_sec = 360/)
    expect(codexConfig).toMatch(/\[mcp_servers.ekko-studio-use\][\s\S]*?tool_timeout_sec = 360/)
  })

  it('inherits external MCP configs for scoped Claude and Codex launches', async () => {
    const home = makeHome()
    const claudeGlobalMcpPath = join(home, 'global-home', '.claude', 'mcp.json')
    const claudeGlobalSettingsPath = join(home, 'global-home', '.claude', 'settings.json')
    const codexGlobalConfigPath = join(home, 'global-home', '.codex', 'config.toml')
    const codexScopedConfigPath = join(home, 'coding-agent', 'model', 'default', 'openrouter', 'codex', 'config.toml')
    mkdirSync(dirname(claudeGlobalMcpPath), { recursive: true })
    mkdirSync(dirname(codexGlobalConfigPath), { recursive: true })
    mkdirSync(dirname(codexScopedConfigPath), { recursive: true })
    writeFileSync(claudeGlobalMcpPath, `${JSON.stringify({
      mcpServers: {
        'nowledge-mem': {
          type: 'streamableHttp',
          url: 'https://nowledge-mem.example/remote-api/mcp/',
          headers: { APP: 'claude code', Authorization: 'Bearer test' },
        },
        'ekko-studio-api': { command: 'stale-managed' },
      },
    }, null, 2)}
`)
    writeFileSync(claudeGlobalSettingsPath, `${JSON.stringify({
      enabledMcpjsonServers: ['nowledge-mem'],
      plugins: { 'nowledge-mem@nowledge-community': true },
      forceLoginMethod: 'claudeai',
      apiKeyHelper: '/tmp/native-claude-key-helper',
      env: {
        SAFE_USER_SETTING: 'preserved',
        CLAUDE_CODE_OAUTH_TOKEN: 'stale-native-oauth-token',
        ANTHROPIC_AUTH_TOKEN: 'stale-native-auth-token',
        ANTHROPIC_API_KEY: 'stale-native-api-key',
        ANTHROPIC_BASE_URL: 'https://native-login.example',
      },
    }, null, 2)}
`)
    writeFileSync(codexGlobalConfigPath, [
      'preferred_auth_method = "chatgpt"',
      'forced_login_method = "chatgpt"',
      'chatgpt_base_url = "https://native-login.example"',
      'experimental_bearer_token = "stale-native-token"',
      '',
      '[mcp_servers.nowledge-mem]',
      'type = "streamableHttp"',
      'url = "https://nowledge-mem.example/remote-api/mcp/"',
      '',
      '[mcp_servers.nowledge-mem.http_headers]',
      'APP = "codex"',
      'Authorization = "Bearer test"',
      '',
      '[mcp_servers.ekko-studio-api]',
      'command = "stale-managed"',
      '',
      '[model_providers.unrelated]',
      'name = "should-not-be-copied"',
      '',
      '[auth]',
      'access_token = "stale-native-token"',
      '',
    ].join('\n'))
    writeFileSync(codexScopedConfigPath, [
      '[mcp_servers.nowledge-mem]',
      'type = "streamableHttp"',
      'url = "https://nowledge-mem.scoped-latest.example/remote-api/mcp/"',
      '',
      '[mcp_servers.nowledge-mem.http_headers]',
      'APP = "codex-scoped"',
      'Authorization = "Bearer scoped"',
      '',
      '[mcp_servers.nowledge-mem]',
      'type = "streamableHttp"',
      'url = "https://nowledge-mem.scoped-latest.example/remote-api/mcp/"',
      '',
      '[mcp_servers.nowledge-mem.http_headers]',
      'APP = "codex-scoped-latest"',
      'Authorization = "Bearer scoped-latest"',
      '',
    ].join('\n'))

    const claude = await prepareCodingAgentLaunch('claude-code', {
      profile: 'default',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'test-api-key',
    })
    const claudeSettings = JSON.parse(readFileSync(join(claude.rootDir, 'settings.json'), 'utf-8'))
    const claudeMcp = JSON.parse(readFileSync(join(claude.rootDir, 'mcp.json'), 'utf-8'))
    expect(claudeSettings.enabledMcpjsonServers).toEqual(['nowledge-mem'])
    expect(claudeSettings.plugins).toMatchObject({ 'nowledge-mem@nowledge-community': true })
    expect(claudeSettings).not.toHaveProperty('forceLoginMethod')
    expect(claudeSettings).not.toHaveProperty('apiKeyHelper')
    expect(claudeSettings.env.SAFE_USER_SETTING).toBe('preserved')
    expect(claudeSettings.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')
    expect(claudeSettings.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
    expect(claudeSettings.env.ANTHROPIC_API_KEY).toMatch(/^hwui_/)
    expect(claudeSettings.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:/)
    expect(claudeMcp.mcpServers['nowledge-mem']).toMatchObject({
      type: 'http',
      url: 'https://nowledge-mem.example/remote-api/mcp/',
    })
    expect(claudeMcp.mcpServers['ekko-studio-api'].command).toBe(process.execPath)

    const codex = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'openrouter',
      model: 'openai/gpt-oss-20b:free',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'test-api-key',
    })
    const codexConfig = readFileSync(join(codex.rootDir, 'config.toml'), 'utf-8')
    expect(codexConfig.match(/^\[mcp_servers\.nowledge-mem\]$/gm)).toHaveLength(1)
    expect(codexConfig.match(/^\[mcp_servers\.nowledge-mem\.http_headers\]$/gm)).toHaveLength(1)
    expect(codexConfig).toContain('url = "https://nowledge-mem.scoped-latest.example/remote-api/mcp/"')
    expect(codexConfig).toContain('APP = "codex-scoped-latest"')
    expect(codexConfig).not.toContain('preferred_auth_method')
    expect(codexConfig).not.toContain('forced_login_method')
    expect(codexConfig).not.toContain('chatgpt_base_url')
    expect(codexConfig).not.toContain('stale-native-token')
    expect(codexConfig).not.toContain('[auth]')
    expect(codexConfig).not.toContain('APP = "codex"')
    expect(codexConfig).not.toContain('APP = "codex-scoped"')
    expect(codexConfig).not.toContain('command = "stale-managed"')
    expect(codexConfig).not.toContain('[model_providers.unrelated]')
    expect(codexConfig).toContain('[mcp_servers.ekko-studio-api]')
    expect(codexConfig).toContain('[mcp_servers.ekko-studio-browser]')
    expect(codexConfig).toContain('[mcp_servers.ekko-studio-devices]')
    expect(codexConfig).toContain('[mcp_servers.ekko-studio-use]')
    expect(codexConfig).toContain('[mcp_servers.ekko-studio-interaction]')
    expect(codexConfig).toMatch(/\[mcp_servers.ekko-studio-interaction\][\s\S]*?tool_timeout_sec = 360/)
    expect(codexConfig).toMatch(/\[mcp_servers.ekko-studio-use\][\s\S]*?tool_timeout_sec = 360/)
  })

  it('isolates Claude Code settings for hidden chat runs only', async () => {
    const home = makeHome()

    const result = await prepareCodingAgentLaunch('claude-code', {
      profile: 'default',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
      isolateSettings: true,
    })

    expect(result.args).toEqual([
      '--settings',
      join(result.rootDir, 'settings.json'),
      '--setting-sources',
      'local',
      '--mcp-config',
      join(result.rootDir, 'mcp.json'),
      '--append-system-prompt-file',
      join(result.rootDir, 'hermes-rules.md'),
      '--dangerously-skip-permissions',
    ])
    expect(result.shellCommand).not.toContain('--setting-sources local')
    const launcher = readFileSync(join(result.rootDir, 'launch.sh'), 'utf-8')
    expect(launcher).toContain('--setting-sources local')
    expect(result.rootDir).toBe(join(home, 'coding-agent', 'model', 'default', 'openrouter', 'claude-code'))
  })

  it('writes group prompts only to the current hidden run files and preserves single-chat prompts', async () => {
    const home = makeHome()
    const sharedLaunch = {
      profile: 'default',
      provider: 'custom_group_prompt',
      model: 'test-model',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'sk-test',
    }
    const groupSystemPrompt = [
      'GROUP_ONLY_DYNAMIC_PROMPT',
      '当前房间：测试群聊',
      '## 图片格式',
    ].join('\n')

    const groupClaude = await prepareCodingAgentLaunch('claude-code', {
      ...sharedLaunch,
      sessionId: 'gc-run-claude',
      agentSessionId: 'gc-agent-claude',
      groupSystemPrompt,
      groupRuntimeScope: {
        roomId: 'room-1',
        agentId: 'room-agent-claude',
      },
    })
    const singleClaude = await prepareCodingAgentLaunch('claude-code', {
      ...sharedLaunch,
      sessionId: 'single-run-claude',
      agentSessionId: 'single-agent-claude',
    })
    const groupCodex = await prepareCodingAgentLaunch('codex', {
      ...sharedLaunch,
      sessionId: 'gc-run-codex',
      agentSessionId: 'gc-agent-codex',
      groupSystemPrompt,
      groupRuntimeScope: {
        roomId: 'room-1',
        agentId: 'room-agent-codex',
      },
    })
    const singleCodex = await prepareCodingAgentLaunch('codex', {
      ...sharedLaunch,
      sessionId: 'single-run-codex',
      agentSessionId: 'single-agent-codex',
    })

    expect(groupClaude.rootDir).not.toBe(singleClaude.rootDir)
    expect(groupCodex.rootDir).not.toBe(singleCodex.rootDir)
    expect(groupClaude.rootDir).toContain(join('custom_group_prompt', 'claude-code', 'group-chat'))
    expect(groupCodex.rootDir).toContain(join('custom_group_prompt', 'codex', 'group-chat'))
    expect(groupClaude.rootDir).not.toContain(join('claude-code', 'runs'))
    expect(groupCodex.rootDir).not.toContain(join('codex', 'runs'))

    const groupClaudePrompt = readFileSync(join(groupClaude.rootDir, 'hermes-rules.md'), 'utf-8')
    const singleClaudePrompt = readFileSync(join(singleClaude.rootDir, 'hermes-rules.md'), 'utf-8')
    const groupCodexConfig = readFileSync(join(groupCodex.rootDir, 'config.toml'), 'utf-8')
    const singleCodexConfig = readFileSync(join(singleCodex.rootDir, 'config.toml'), 'utf-8')

    expect(groupClaudePrompt).toContain(groupSystemPrompt)
    expect(groupCodexConfig).toContain('GROUP_ONLY_DYNAMIC_PROMPT')
    expect(singleClaudePrompt).toContain('# 输出格式规范')
    expect(singleCodexConfig).toContain('# 输出格式规范')
    expect(singleClaudePrompt).not.toContain('GROUP_ONLY_DYNAMIC_PROMPT')
    expect(singleCodexConfig).not.toContain('GROUP_ONLY_DYNAMIC_PROMPT')

    expect(groupClaude.args).toContain('--append-system-prompt-file')
    expect(groupClaude.args).not.toContain('--append-system-prompt')
    expect(groupClaude.args.join(' ')).not.toContain('GROUP_ONLY_DYNAMIC_PROMPT')
    expect(groupCodex.args.join(' ')).not.toContain('developer_instructions=')
    expect(groupCodex.args.join(' ')).not.toContain('GROUP_ONLY_DYNAMIC_PROMPT')

    const updatedGroupPrompt = `${groupSystemPrompt}\nUPDATED_SAME_FILE`
    const nextGroupClaude = await prepareCodingAgentLaunch('claude-code', {
      ...sharedLaunch,
      sessionId: 'gc-run-claude-next',
      agentSessionId: 'gc-agent-claude-next',
      groupSystemPrompt: updatedGroupPrompt,
      groupRuntimeScope: {
        roomId: 'room-1',
        agentId: 'room-agent-claude',
      },
    })
    const nextGroupCodex = await prepareCodingAgentLaunch('codex', {
      ...sharedLaunch,
      sessionId: 'gc-run-codex-next',
      agentSessionId: 'gc-agent-codex-next',
      groupSystemPrompt: updatedGroupPrompt,
      groupRuntimeScope: {
        roomId: 'room-1',
        agentId: 'room-agent-codex',
      },
    })

    expect(nextGroupClaude.rootDir).toBe(groupClaude.rootDir)
    expect(nextGroupCodex.rootDir).toBe(groupCodex.rootDir)
    expect(readFileSync(join(nextGroupClaude.rootDir, 'hermes-rules.md'), 'utf-8')).toContain('UPDATED_SAME_FILE')
    expect(readFileSync(join(nextGroupCodex.rootDir, 'config.toml'), 'utf-8')).toContain('UPDATED_SAME_FILE')

    expect(existsSync(join(
      home,
      'coding-agent',
      'model',
      'default',
      'custom_group_prompt',
      'claude-code',
      'hermes-rules.md',
    ))).toBe(false)
    expect(existsSync(join(
      home,
      'coding-agent',
      'model',
      'default',
      'custom_group_prompt',
      'codex',
      'config.toml',
    ))).toBe(false)
  })

  it('uses Claude Code auto permission mode for scoped root launches', async () => {
    mockProcessUid(0)
    const home = makeHome()

    const result = await prepareCodingAgentLaunch('claude-code', {
      profile: 'default',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
      isolateSettings: true,
    })

    expect(result.args).toEqual([
      '--settings',
      join(result.rootDir, 'settings.json'),
      '--setting-sources',
      'local',
      '--mcp-config',
      join(result.rootDir, 'mcp.json'),
      '--append-system-prompt-file',
      join(result.rootDir, 'hermes-rules.md'),
      '--permission-mode',
      'auto',
      '--allowedTools',
      'mcp__ekko-studio-interaction__ekko_studio_update_plan',
    ])
    const launcher = readFileSync(join(result.rootDir, 'launch.sh'), 'utf-8')
    expect(launcher).toContain('--permission-mode auto')
    expect(launcher).toContain('--allowedTools mcp__ekko-studio-interaction__ekko_studio_update_plan')
    expect(launcher).not.toContain('--dangerously-skip-permissions')
    expect(result.rootDir).toBe(join(home, 'coding-agent', 'model', 'default', 'openrouter', 'claude-code'))
  })

  it('keeps Claude Code protocol overrides behind the local proxy', async () => {
    const home = makeHome()

    const result = await prepareCodingAgentLaunch('claude-code', {
      profile: 'default',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
      apiMode: 'anthropic_messages',
    })

    const settings = JSON.parse(readFileSync(join(result.rootDir, 'settings.json'), 'utf-8'))
    expect(settings.env.ANTHROPIC_API_KEY).toMatch(/^hwui_/)
    expect(settings.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
    expect(settings.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/claude-code-proxy\/.+$/)
  })

  it('keeps canonical custom provider identity behind filesystem-safe Claude config paths', async () => {
    const home = makeHome()
    const provider = 'custom:compat-provider'
    const result = await prepareCodingAgentLaunch('claude-code', {
      profile: 'default',
      provider,
      model: 'review-model',
      baseUrl: 'https://provider.example',
      apiKey: 'provider-key',
      apiMode: 'anthropic_messages',
    })

    expect(result.provider).toBe(provider)
    expect(result.rootDir).toBe(join(home, 'coding-agent', 'model', 'default', 'custom_compat-provider', 'claude-code'))
    const settings = JSON.parse(readFileSync(join(result.rootDir, 'settings.json'), 'utf-8'))
    const proxyUrl = new URL(settings.env.ANTHROPIC_BASE_URL)
    const routeKey = proxyUrl.pathname.split('/').filter(Boolean).at(-1) || ''
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: 'api_error',
        request_id: '',
        error: {
          type: 'api_error',
          message: 'The encrypted content opaque-value could not be verified. Reason: Encrypted content could not be decrypted or parsed.',
        },
      }), { status: 400, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_retry_ok',
        type: 'message',
        role: 'assistant',
        model: 'review-model',
        content: [{ type: 'text', text: 'continued' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const body = {
      model: 'client-alias',
      max_tokens: 64,
      thinking: { type: 'adaptive' },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'inspect the repository' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '', signature: 'opaque-signature' },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'README.md' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'contents' }] },
      ],
    }
    const ctx = makeProxyContext(routeKey, settings.env.ANTHROPIC_API_KEY, body)
    await claudeProxyMessages(ctx)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(ctx.body.content).toEqual([{ type: 'text', text: 'continued' }])
    const retryBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body))
    expect(retryBody.messages[1].content.map((block: any) => block.type)).toEqual(['tool_use'])
  })

  it('rejects control characters in canonical provider identities before proxy registration', async () => {
    makeHome()

    await expect(prepareCodingAgentLaunch('claude-code', {
      profile: 'default',
      provider: 'custom:x\0y',
      model: 'review-model',
      baseUrl: 'https://provider.example',
      apiKey: 'provider-key',
      apiMode: 'anthropic_messages',
    })).rejects.toThrow('Invalid provider')
  })

  it('keeps Codex model selection on the CLI while isolating CODEX_HOME', async () => {
    const home = makeHome()

    const result = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'openrouter',
      model: 'openai/gpt-oss-20b:free',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
    })

    expect(result.rootDir).toBe(join(home, 'coding-agent', 'model', 'default', 'openrouter', 'codex'))
    expect(result.workspaceDir).toBe(join(home, 'coding-agent', 'workspace', 'default', 'openrouter'))
    expect(result.args).toEqual(['--model', 'openai/gpt-oss-20b:free'])
    expect(result.env).toEqual({ CODEX_HOME: result.rootDir })

    const config = readFileSync(join(result.rootDir, 'config.toml'), 'utf-8')
    expect(config).toContain('requires_openai_auth = false')
    expect(config).toContain('[features]')
    expect(config).toContain('tool_search = true')
    expect(config).toContain(`model_catalog_json = "${join(result.rootDir, 'codex-model-catalog.json')}"`)
    expect(config).toContain('model_reasoning_summary = "auto"')
    expect(config).toContain('developer_instructions = """')
    expect(config).toContain('Ekko Studio MCP usage')
    expect(config).toContain('ekko_studio_browser_toolset is available')
    expect(config).toContain('call it with action=list')
    expect(config).toContain('Browser MCP exposes a compact toolset rather than resources')
    expect(config).toContain('# 输出格式规范')
    expect(config).toContain('[mcp_servers.ekko-studio-api]')
    expect(config).toContain('[mcp_servers.ekko-studio-devices]')
    expect(config).toContain('[mcp_servers.ekko-studio-use]')
    expect(config).toContain(`command = "${process.execPath}"`)
    expect(config).toContain(`args = ["${join(process.cwd(), 'bin/ekko-studio-mcp.mjs')}", "api"]`)
    expect(config).toContain(`args = ["${join(process.cwd(), 'bin/ekko-studio-mcp.mjs')}", "devices"]`)
    expect(config).toContain(`args = ["${join(process.cwd(), 'bin/ekko-studio-mcp.mjs')}", "use"]`)
    expect(config).toContain('ELECTRON_RUN_AS_NODE = "1"')
    expect(config).toContain(`HERMES_WEB_UI_URL = "http://127.0.0.1:8648", HERMES_WEB_UI_HOME = "${home}"`)
    expect(config).toContain('HERMES_WEBUI_STATE_DIR = "')
    expect(config).toContain('HERMES_WEB_UI_PROFILE = "default"')
    expect(config).toContain('HERMES_MCP_SERVER_NAME = "ekko-studio-api"')
    expect(config).toContain('HERMES_MCP_SERVER_NAME = "ekko-studio-devices"')
    expect(config).toContain('HERMES_MCP_SERVER_NAME = "ekko-studio-use"')
    expect(config).toContain('HERMES_MCP_TOOLSET = "api"')
    expect(config).toContain('HERMES_MCP_TOOLSET = "devices"')
    expect(config).toContain('HERMES_MCP_TOOLSET = "use"')
    expect(config).toContain('HERMES_WEB_UI_MANAGED_MCP = "1"')

    expect(result.files.some(file => file.key === 'agents')).toBe(true)
    const agents = readFileSync(join(result.rootDir, 'AGENTS.md'), 'utf-8')
    expect(agents).toContain('Ekko Studio MCP usage')
    expect(agents).toContain('# 输出格式规范')

    const catalog = JSON.parse(readFileSync(join(result.rootDir, 'codex-model-catalog.json'), 'utf-8'))
    expect(catalog.models.some((entry: any) => entry.slug === 'openai/gpt-oss-20b:free')).toBe(true)
    expect(catalog.models[0]).toHaveProperty('base_instructions')
    expect(catalog.models[0]).toHaveProperty('model_messages')
    expect(catalog.models[0]).toHaveProperty('default_reasoning_summary', 'auto')
    expect(catalog.models[0]).toHaveProperty('input_modalities', ['text', 'image'])
    expect(catalog.models[0].supported_reasoning_levels).toEqual(expect.arrayContaining([
      expect.objectContaining({ effort: 'max' }),
    ]))
  })

  it('binds managed mobile MCP calls to the current Studio chat session for Codex', async () => {
    makeHome()

    const result = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'openrouter',
      model: 'openai/gpt-oss-20b:free',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
      sessionId: 'studio-chat-session',
    })

    expect(result.env.HERMES_STUDIO_SESSION_ID).toBe('studio-chat-session')
    expect(readFileSync(join(result.rootDir, 'launch.sh'), 'utf-8'))
      .toContain('export HERMES_STUDIO_SESSION_ID=studio-chat-session')
  })

  it('runs scoped Grok through the local proxy without writing the upstream secret to disk', async () => {
    const home = makeHome()

    const result = await prepareCodingAgentLaunch('grok', {
      profile: 'default',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-upstream-secret',
      apiMode: 'chat_completions',
      reasoningEffort: 'high',
    })

    expect(result.rootDir).toBe(join(home, 'coding-agent', 'model', 'default', 'deepseek', 'grok'))
    expect(result.args).toEqual([
      '--model', 'hermes-studio',
      '--always-approve',
      '--no-auto-update',
      '--reasoning-effort', 'high',
    ])
    expect(result.env.GROK_HOME).toBe(result.rootDir)
    expect(result.env.HERMES_STUDIO_GROK_API_KEY).toMatch(/^hwui_/)
    expect(result.env.HERMES_STUDIO_GROK_API_KEY).not.toBe('sk-upstream-secret')

    const config = readFileSync(join(result.rootDir, 'config.toml'), 'utf-8')
    expect(config).toContain('[model.hermes-studio]')
    expect(config).toContain('model = "deepseek-v4-pro"')
    expect(config).toContain('api_backend = "responses"')
    expect(config).toContain('env_key = "HERMES_STUDIO_GROK_API_KEY"')
    expect(config).toContain(`/api/codex-proxy/`)
    expect(config).toContain('[mcp_servers.ekko-studio-api]')
    expect(config).not.toContain('sk-upstream-secret')

    const prompt = readFileSync(join(result.rootDir, 'AGENTS.md'), 'utf-8')
    expect(prompt).toContain('selected upstream provider is `deepseek`')
    expect(prompt).toContain('exact model ID is `deepseek-v4-pro`')
  })

  it('points Codex Chat Completions providers at the local Responses proxy', async () => {
    const home = makeHome()

    const result = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-upstream',
      apiMode: 'chat_completions',
    })

    const config = readFileSync(join(result.rootDir, 'config.toml'), 'utf-8')
    expect(config).toContain(`base_url = "http://127.0.0.1:8648/api/codex-proxy/`)
    expect(config).toContain('wire_api = "responses"')
    expect(config).toContain('requires_openai_auth = false')
    expect(config).toMatch(/experimental_bearer_token = "hwui_[^"]+"/)
    expect(result.rootDir).toBe(join(home, 'coding-agent', 'model', 'default', 'deepseek', 'codex'))

    const catalog = JSON.parse(readFileSync(join(result.rootDir, 'codex-model-catalog.json'), 'utf-8'))
    const deepseekModel = catalog.models.find((entry: any) => entry.slug === 'deepseek-v4-pro')
    expect(deepseekModel).toMatchObject({
      display_name: 'Deepseek V4 Pro',
    })
    expect(deepseekModel.context_window).toBeGreaterThan(0)
    expect(deepseekModel.max_context_window).toBe(deepseekModel.context_window)
    expect(deepseekModel.model_messages.instructions_template).toContain('{{ base_instructions }}')
  })

  it('normalizes Codex app-server provider mode to Responses for scoped Codex runs', async () => {
    const home = makeHome()

    const result = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'ai-pixel.online',
      model: 'gpt-5.5',
      baseUrl: 'https://ai-pixel.online/v1',
      apiKey: 'sk-upstream',
      apiMode: 'codex_app_server' as any,
    })

    const config = readFileSync(join(result.rootDir, 'config.toml'), 'utf-8')
    expect(config).toContain(`base_url = "http://127.0.0.1:`)
    expect(config).toContain('/api/codex-proxy/')
    expect(config).toContain('wire_api = "responses"')
    expect(config).toContain('requires_openai_auth = false')
    expect(config).toMatch(/experimental_bearer_token = "hwui_[^"]+"/)
    expect(config).not.toContain('base_url = "https://ai-pixel.online/v1"')
    expect(result.rootDir).toBe(join(home, 'coding-agent', 'model', 'default', 'ai-pixel.online', 'codex'))
  })

  it('defaults Codex providers without an api mode to Chat Completions', async () => {
    makeHome()
    const launch = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      apiKey: 'sk-upstream',
    })
    const config = readFileSync(join(launch.rootDir, 'config.toml'), 'utf-8')
    const routeKey = config.match(/\/api\/codex-proxy\/([^/]+)\/v1/)?.[1] || ''
    const token = config.match(/experimental_bearer_token = "([^"]+)"/)?.[1] || ''
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'chatcmpl_test',
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'ok' },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(routeKey, token, {
      max_output_tokens: 16,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    })

    await codexProxyResponses(ctx)

    expect(fetchMock).toHaveBeenCalledWith('https://api.xiaomimimo.com/v1/chat/completions', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer sk-upstream' }),
    }))
  })

  it('points Codex Responses providers at the local Responses proxy for stream capture', async () => {
    const home = makeHome()

    const result = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'openai-api',
      model: 'gpt-5.5',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-upstream',
      apiMode: 'codex_responses',
      sessionId: 'chat-session-1',
      agentSessionId: 'agent-session-1',
    })

    const config = readFileSync(join(result.rootDir, 'config.toml'), 'utf-8')
    expect(config).toContain(`base_url = "http://127.0.0.1:8648/api/codex-proxy/`)
    expect(config).toMatch(/experimental_bearer_token = "hwui_[^"]+"/)
    expect(config).not.toContain('base_url = "https://api.openai.com/v1"')
    expect(dirname(dirname(result.rootDir))).toBe(join(home, 'coding-agent', 'model', 'default', 'openai-api', 'codex'))
  })

  it('points Codex Anthropic Messages providers at the local Responses proxy', async () => {
    const home = makeHome()

    const result = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'anthropic-compatible',
      model: 'claude-sonnet-4-6',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-upstream',
      apiMode: 'anthropic_messages',
    })

    const config = readFileSync(join(result.rootDir, 'config.toml'), 'utf-8')
    expect(config).toContain(`base_url = "http://127.0.0.1:8648/api/codex-proxy/`)
    expect(config).toContain('wire_api = "responses"')
    expect(config).toContain('requires_openai_auth = false')
    expect(config).toMatch(/experimental_bearer_token = "hwui_[^"]+"/)
    expect(result.rootDir).toBe(join(home, 'coding-agent', 'model', 'default', 'anthropic-compatible', 'codex'))
  })

  it('authenticates the enlarged Codex Responses parser with the registered route token', () => {
    const target = registerCodexProxyTarget({
      profile: 'default',
      provider: 'parser-auth',
      model: 'test-model',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-upstream',
      apiMode: 'codex_responses',
    })
    const context = (token: string) => ({
      path: `/api/codex-proxy/${target.routeKey}/v1/responses`,
      get(name: string) {
        return name.toLowerCase() === 'authorization' ? `Bearer ${token}` : ''
      },
    }) as any

    expect(isAuthorizedCodexProxyRequest(context(target.token))).toBe(true)
    expect(isAuthorizedCodexProxyRequest(context('wrong-token'))).toBe(false)
  })

  it.each([
    ['chat_completions', 'https://chat-history.example.com'],
    ['anthropic_messages', 'https://anthropic-history.example.com'],
    ['codex_responses', 'https://responses-history.example.com/v1'],
  ] as const)('strips historical inline images before %s provider dispatch', async (apiMode, baseUrl) => {
    const target = registerCodexProxyTarget({
      profile: 'default',
      provider: `history-${apiMode}`,
      model: 'test-model',
      baseUrl,
      apiKey: 'sk-upstream',
      apiMode,
      agentSessionId: `history-${apiMode}`,
    })
    const fetchMock = vi.fn(async () => {
      if (apiMode === 'chat_completions') {
        return new Response(JSON.stringify({
          id: 'chatcmpl_history',
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (apiMode === 'anthropic_messages') {
        return new Response(JSON.stringify({
          id: 'msg_history',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        id: 'resp_history',
        object: 'response',
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const historicalImage = 'data:image/png;base64,HISTORICAL'
    const currentImageA = 'data:image/png;base64,CURRENT_A'
    const currentImageB = 'data:image/jpeg;base64,CURRENT_B'
    const body = {
      input: [
        { role: 'user', content: [{ type: 'input_image', image_url: historicalImage }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'old response' }] },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'current request' },
            { type: 'input_image', image_url: currentImageA },
            { type: 'input_image', image_url: currentImageB },
          ],
        },
      ],
    }

    await codexProxyResponses(makeProxyContext(target.routeKey, target.token, body))

    const forwarded = String(fetchMock.mock.calls[0]?.[1]?.body || '')
    expect(forwarded).not.toContain('HISTORICAL')
    expect(forwarded).toContain('historical inline image omitted before provider request')
    expect(forwarded).toContain('CURRENT_A')
    expect(forwarded).toContain('CURRENT_B')
    expect(body.input[0].content[0].image_url).toBe(historicalImage)
  })

  it('adapts Codex Responses requests to OpenAI Chat Completions', async () => {
    makeHome()
    const launch = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-upstream',
      apiMode: 'chat_completions',
    })
    const config = readFileSync(join(launch.rootDir, 'config.toml'), 'utf-8')
    const routeKey = config.match(/\/api\/codex-proxy\/([^/]+)\/v1/)?.[1] || ''
    const token = config.match(/experimental_bearer_token = "([^"]+)"/)?.[1] || ''
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'chatcmpl_test',
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'ok' },
      }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(routeKey, token, {
      max_output_tokens: 16,
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        { role: 'developer', content: [{ type: 'input_text', text: 'be terse' }] },
      ],
    })

    await codexProxyResponses(ctx)

    expect(fetchMock).toHaveBeenCalledWith('https://api.deepseek.com/v1/chat/completions', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer sk-upstream' }),
    }))
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(requestBody).toMatchObject({
      model: 'deepseek-v4-pro',
      max_tokens: 16,
      // The in-input `developer` message converts to `system` and is relocated
      // to the front (vLLM et al. reject a system message mid-conversation).
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hello' },
      ],
    })
    expect(ctx.body.output[0].content[0].text).toBe('ok')
    expect(ctx.body.usage).toMatchObject({ input_tokens: 3, output_tokens: 1, total_tokens: 4 })
  })

  it('replays DeepSeek reasoning_content when Codex continues after a tool call', async () => {
    const target = registerCodexProxyTarget({
      profile: 'default',
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-upstream',
      apiMode: 'chat_completions',
      agentSessionId: 'codex-deepseek-tool-replay',
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'chatcmpl_after_tool',
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'The README is present.' },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(target.routeKey, target.token, {
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'inspect the repo' }] },
        {
          type: 'reasoning',
          id: 'rs_before_read',
          summary: [{ type: 'summary_text', text: 'I should read the README first.' }],
        },
        {
          type: 'function_call',
          call_id: 'call_read',
          name: 'read_file',
          arguments: '{"path":"README.md"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_read',
          output: 'README contents',
        },
      ],
    })

    await codexProxyResponses(ctx)

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(requestBody.messages).toEqual([
      { role: 'user', content: 'inspect the repo' },
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'I should read the README first.',
        tool_calls: [{
          id: 'call_read',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"README.md"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_read', content: 'README contents' },
    ])
    expect(ctx.status).toBeUndefined()
    expect(ctx.body.output[0].content[0].text).toBe('The README is present.')
  })

  it('adapts Codex Responses requests to Anthropic Messages', async () => {
    makeHome()
    const launch = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'anthropic-compatible',
      model: 'claude-sonnet-4-6',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-upstream',
      apiMode: 'anthropic_messages',
    })
    const config = readFileSync(join(launch.rootDir, 'config.toml'), 'utf-8')
    const routeKey = config.match(/\/api\/codex-proxy\/([^/]+)\/v1/)?.[1] || ''
    const token = config.match(/experimental_bearer_token = "([^"]+)"/)?.[1] || ''
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 'toolu_1', name: 'search', input: { query: 'repo' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 2 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(routeKey, token, {
      instructions: 'be terse',
      max_output_tokens: 64,
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        { type: 'function_call_output', call_id: 'call_0', output: 'done' },
      ],
      tools: [{
        type: 'function',
        name: 'search',
        description: 'Search files',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      }],
    })

    await codexProxyResponses(ctx)

    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/v1/messages', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer sk-upstream',
        'x-api-key': 'sk-upstream',
        'anthropic-version': '2023-06-01',
      }),
    }))
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(requestBody).toMatchObject({
      model: 'claude-sonnet-4-6',
      system: 'be terse',
      max_tokens: 64,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_0', content: 'done' }] },
      ],
      tools: [{
        name: 'search',
        description: 'Search files',
        input_schema: { type: 'object', properties: { query: { type: 'string' } } },
      }],
    })
    expect(ctx.body.output[0].content[0].text).toBe('ok')
    expect(ctx.body.output[1]).toMatchObject({
      type: 'function_call',
      call_id: 'toolu_1',
      name: 'search',
      arguments: '{"query":"repo"}',
    })
    expect(ctx.body.usage).toMatchObject({ input_tokens: 5, output_tokens: 2, total_tokens: 7 })
  })

  it('preserves deferred MCP discovery through the Codex Anthropic proxy', async () => {
    makeHome()
    const launch = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'anthropic-compatible',
      model: 'claude-sonnet-4-6',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-upstream',
      apiMode: 'anthropic_messages',
    })
    const config = readFileSync(join(launch.rootDir, 'config.toml'), 'utf-8')
    const routeKey = config.match(/\/api\/codex-proxy\/([^/]+)\/v1/)?.[1] || ''
    const token = config.match(/experimental_bearer_token = "([^"]+)"/)?.[1] || ''
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_search',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{
          type: 'tool_use',
          id: 'call_search',
          name: 'tool_search',
          input: { query: 'Ekko Studio browser tabs' },
        }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 3, output_tokens: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_browser',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{
          type: 'tool_use',
          id: 'call_browser',
          name: 'ekko_studio_browser_toolset',
          input: { action: 'list' },
        }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 4, output_tokens: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const toolSearch = {
      type: 'tool_search',
      execution: 'client',
      description: 'Search deferred MCP tools.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
    }
    const firstCtx = makeProxyContext(routeKey, token, {
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'open a browser' }] }],
      tools: [toolSearch],
    })

    await codexProxyResponses(firstCtx)

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tools).toEqual([{
      name: 'tool_search',
      description: 'Search deferred MCP tools.',
      input_schema: toolSearch.parameters,
    }])
    expect(firstCtx.body.output).toEqual([{
      type: 'tool_search_call',
      call_id: 'call_search',
      status: 'completed',
      execution: 'client',
      arguments: { query: 'Ekko Studio browser tabs' },
    }])

    const secondCtx = makeProxyContext(routeKey, token, {
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'open a browser' }] },
        {
          type: 'tool_search_call',
          call_id: 'call_search',
          status: 'completed',
          execution: 'client',
          arguments: { query: 'Ekko Studio browser tabs' },
        },
        {
          type: 'tool_search_output',
          call_id: 'call_search',
          status: 'completed',
          execution: 'client',
          tools: [{
            type: 'namespace',
            name: 'mcp__ekko_studio_browser',
            tools: [{
              type: 'function',
              name: 'ekko_studio_browser_toolset',
              description: 'Discover browser operations.',
              parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
            }],
          }],
        },
      ],
      tools: [toolSearch],
    })

    await codexProxyResponses(secondCtx)

    const secondRequestBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(secondRequestBody.tools.map((tool: any) => tool.name)).toEqual([
      'tool_search',
      'ekko_studio_browser_toolset',
    ])
    expect(secondRequestBody.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'user',
        content: [expect.objectContaining({ type: 'tool_result', tool_use_id: 'call_search' })],
      }),
    ]))
    expect(secondCtx.body.output[0]).toMatchObject({
      type: 'function_call',
      call_id: 'call_browser',
      name: 'ekko_studio_browser_toolset',
      namespace: 'mcp__ekko_studio_browser',
    })
  })

  it('exposes split Hermes MCP tools to Anthropic Codex runs and restores their namespace', async () => {
    makeHome()
    const launch = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'anthropic-compatible',
      model: 'claude-sonnet-4-6',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-upstream',
      apiMode: 'anthropic_messages',
    })
    const config = readFileSync(join(launch.rootDir, 'config.toml'), 'utf-8')
    const routeKey = config.match(/\/api\/codex-proxy\/([^/]+)\/v1/)?.[1] || ''
    const token = config.match(/experimental_bearer_token = "([^"]+)"/)?.[1] || ''
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'msg_browser',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{
        type: 'tool_use',
        id: 'toolu_browser',
        name: 'ekko_studio_browser_toolset',
        input: { action: 'list' },
      }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 4, output_tokens: 1 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(routeKey, token, {
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'open a browser' }] }],
      tools: [{
        type: 'namespace',
        name: 'mcp__ekko_studio_browser',
        description: 'Ekko Studio browser tools',
      }],
    })

    await codexProxyResponses(ctx)

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(requestBody.tools).toEqual([expect.objectContaining({
      name: 'ekko_studio_browser_toolset',
      input_schema: expect.objectContaining({
        required: ['action'],
      }),
    })])
    expect(ctx.body.output[0]).toMatchObject({
      type: 'function_call',
      call_id: 'toolu_browser',
      name: 'ekko_studio_browser_toolset',
      arguments: '{"action":"list"}',
      namespace: 'mcp__ekko_studio_browser',
    })
  })

  it('streams Codex proxy text as complete Responses message events', async () => {
    makeHome()
    const launch = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-upstream',
      apiMode: 'chat_completions',
    })
    const config = readFileSync(join(launch.rootDir, 'config.toml'), 'utf-8')
    const routeKey = config.match(/\/api\/codex-proxy\/([^/]+)\/v1/)?.[1] || ''
    const token = config.match(/experimental_bearer_token = "([^"]+)"/)?.[1] || ''
    const encoder = new TextEncoder()
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"p"}}]}\n\n'))
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ong"}}]}\n\n'))
        controller.enqueue(encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}\n\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(routeKey, token, {
      stream: true,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
    })

    await codexProxyResponses(ctx)

    const chunks: string[] = []
    for await (const chunk of ctx.body) chunks.push(String(chunk))
    const sse = chunks.join('')
    expect(sse).toMatch(/event: response\.created[\s\S]*"created_at":\d+/)
    expect(sse).toContain('"sequence_number":0')
    expect(sse).toContain('event: response.output_item.added')
    expect(sse).toContain('event: response.content_part.added')
    expect(sse).toContain('"delta":"p"')
    expect(sse).toContain('"delta":"ong"')
    expect(sse).toContain('event: response.output_text.done')
    expect(sse).toContain('"text":"pong"')
    expect(sse).toContain('event: response.output_item.done')
    expect(sse).toContain('"output":[{"type":"message"')
    expect(sse).not.toContain('"usage"')
  })

  it('keeps OpenCode response.completed valid when Chat Completions omits usage', async () => {
    const target = registerCodexProxyTarget({
      profile: 'default',
      provider: 'openai-compatible',
      model: 'gpt-5.6-sol',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-upstream',
      apiMode: 'chat_completions',
      agentId: 'opencode',
      agentSessionId: 'opencode-terminal-run',
      chatSessionId: 'opencode-terminal-chat',
    })
    const encoder = new TextEncoder()
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'))
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(target.routeKey, target.token, {
      stream: true,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
    })

    await codexProxyResponses(ctx)

    const chunks: string[] = []
    for await (const chunk of ctx.body) chunks.push(String(chunk))
    const completed = chunks.join('')
      .split('\n\n')
      .find(frame => frame.startsWith('event: response.completed'))
    expect(completed).toBeTruthy()
    const payload = JSON.parse(completed!.split('\ndata: ')[1])
    expect(payload).toMatchObject({
      type: 'response.completed',
      response: {
        status: 'completed',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
        },
      },
    })
  })

  it('keeps the selected Chat Completions protocol and emits Pi-compatible Responses reasoning events', async () => {
    const target = registerCodexProxyTarget({
      profile: 'default',
      provider: 'glm',
      model: 'glm-5-turbo',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      apiKey: 'sk-upstream',
      apiMode: 'chat_completions',
      agentId: 'pi',
      agentSessionId: 'pi-reasoning-run',
      chatSessionId: 'pi-reasoning-chat',
    })
    const encoder = new TextEncoder()
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"inspect"}}]}\n\n'))
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"done"}}]}\n\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(target.routeKey, target.token, {
      stream: true,
      reasoning: { effort: 'medium', summary: 'auto' },
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'check' }] }],
    })
    await codexProxyResponses(ctx)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    )
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(requestBody).toMatchObject({
      model: 'glm-5-turbo',
      stream: true,
    })
    expect(requestBody).not.toHaveProperty('thinking')

    const chunks: string[] = []
    for await (const chunk of ctx.body) chunks.push(String(chunk))
    const sse = chunks.join('')
    expect(sse).toContain('event: response.output_item.added')
    expect(sse).toContain('"type":"reasoning"')
    expect(sse).toContain('event: response.reasoning_summary_text.delta')
    expect(sse).toContain('"delta":"inspect"')
    expect(sse).toContain('event: response.output_item.done')
    expect(sse).toContain('event: response.output_text.delta')
    expect(sse).toContain('"delta":"done"')
  })

  it('streams Anthropic thinking and text as Pi-compatible Responses events', async () => {
    makeHome()
    const launch = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'anthropic-compatible',
      model: 'claude-sonnet-4-6',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-upstream',
      apiMode: 'anthropic_messages',
    })
    const config = readFileSync(join(launch.rootDir, 'config.toml'), 'utf-8')
    const routeKey = config.match(/\/api\/codex-proxy\/([^/]+)\/v1/)?.[1] || ''
    const token = config.match(/experimental_bearer_token = "([^"]+)"/)?.[1] || ''
    const encoder = new TextEncoder()
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","usage":{"input_tokens":3,"output_tokens":0}}}\n\n'))
        controller.enqueue(encoder.encode('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n'))
        controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"inspect"}}\n\n'))
        controller.enqueue(encoder.encode('event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n'))
        controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"he"}}\n\n'))
        controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"llo"}}\n\n'))
        controller.enqueue(encoder.encode('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\n'))
        controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'))
        controller.close()
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(routeKey, token, {
      stream: true,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
    })

    await codexProxyResponses(ctx)

    const chunks: string[] = []
    for await (const chunk of ctx.body) chunks.push(String(chunk))
    const sse = chunks.join('')
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/v1/messages', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'anthropic-version': '2023-06-01' }),
    }))
    expect(sse).toContain('event: response.output_item.added')
    expect(sse).toContain('"type":"reasoning"')
    expect(sse).toContain('event: response.reasoning_summary_text.delta')
    expect(sse).toContain('"delta":"inspect"')
    expect(sse).toContain('"delta":"he"')
    expect(sse).toContain('"delta":"llo"')
    expect(sse).toContain('event: response.output_text.done')
    expect(sse).toContain('"text":"hello"')
    expect(sse).toContain('event: response.completed')
    expect(sse).not.toContain('"usage"')
  })

  it('preserves native Responses usage for Codex Responses providers', async () => {
    const target = registerCodexProxyTarget({
      profile: 'default',
      provider: 'openai-api',
      model: 'gpt-5.5',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-upstream',
      apiMode: 'codex_responses',
    })
    const encoder = new TextEncoder()
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_native","status":"in_progress"}}\n\n'))
        controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n'))
        controller.enqueue(encoder.encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_native","status":"completed","usage":{"input_tokens":11,"output_tokens":2,"total_tokens":13}}}\n\n'))
        controller.close()
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(target.routeKey, target.token, {
      stream: true,
      reasoning: { effort: 'high', summary: 'auto' },
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
    })
    await codexProxyResponses(ctx)

    const chunks: string[] = []
    for await (const chunk of ctx.body) chunks.push(String(chunk))
    const sse = chunks.join('')
    expect(fetchMock).toHaveBeenCalledWith('https://api.openai.com/v1/responses', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer sk-upstream' }),
    }))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      reasoning: { effort: 'high', summary: 'auto' },
    })
    expect(sse).toContain('"usage":{"input_tokens":11,"output_tokens":2,"total_tokens":13}')
  })

  it('maps Grok system messages before forwarding native Responses requests', async () => {
    const target = registerCodexProxyTarget({
      profile: 'default',
      provider: 'openai-api',
      model: 'grok-test',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-upstream',
      apiMode: 'codex_responses',
      agentId: 'grok',
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'resp_grok',
      status: 'completed',
      output: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await codexProxyResponses(makeProxyContext(target.routeKey, target.token, {
      max_output_tokens: 4096,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: 'Project rules' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
      ],
    }))

    const forwarded = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(forwarded).toMatchObject({
      model: 'grok-test',
      input: [
        { role: 'developer', content: [{ type: 'input_text', text: 'Project rules' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
      ],
    })
    expect(forwarded).not.toHaveProperty('max_output_tokens')
  })

  it('normalizes Grok requests before forwarding to Chat Completions providers', async () => {
    const target = registerCodexProxyTarget({
      profile: 'default',
      provider: 'custom',
      model: 'grok-chat-test',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-upstream',
      apiMode: 'chat_completions',
      agentId: 'grok',
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'chatcmpl_grok',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await codexProxyResponses(makeProxyContext(target.routeKey, target.token, {
      instructions: 'Top-level rules',
      max_output_tokens: 4096,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: 'Project rules' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
      ],
    }))

    const forwarded = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(forwarded.messages[0]).toMatchObject({
      role: 'developer',
      content: expect.stringContaining('Top-level rules'),
    })
    expect(forwarded.messages[0].content).toContain('Project rules')
    expect(forwarded).not.toHaveProperty('max_tokens')
    expect(forwarded).not.toHaveProperty('max_output_tokens')
  })

  it('normalizes image response annotations before streaming them to Grok', async () => {
    const target = registerCodexProxyTarget({
      profile: 'default', provider: 'custom', model: 'grok-vision-test',
      baseUrl: 'https://api.example.com/v1', apiKey: 'sk-upstream',
      apiMode: 'codex_responses', agentId: 'grok',
    })
    const part = { type: 'output_text', text: 'A red square' }
    const item = { type: 'message', id: 'msg_vision', role: 'assistant', status: 'completed', content: [part] }
    const frames = [
      { type: 'response.content_part.added', part: { ...part, text: '' } },
      { type: 'response.content_part.done', part },
      { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { id: 'resp_vision', output: [item] } },
    ]
    const fetchMock = vi.fn(async (_url: string, _init: any) => new Response(
      frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ))
    vi.stubGlobal('fetch', fetchMock)
    const imageUrl = 'data:image/png;base64,AQID'
    const ctx = makeProxyContext(target.routeKey, target.token, {
      stream: true,
      input: [{ role: 'user', content: [
        { type: 'input_text', text: 'Describe this image' },
        { type: 'input_image', image_url: imageUrl },
      ] }],
    })
    await codexProxyResponses(ctx)
    const chunks: string[] = []
    for await (const chunk of ctx.body) chunks.push(String(chunk))
    const events = chunks.join('').split('\n\n').filter(Boolean)
      .map(frame => JSON.parse(frame.split('\ndata: ')[1]))
    expect(events[0].part.annotations).toEqual([])
    expect(events[1].part.annotations).toEqual([])
    expect(events[2].item.content[0].annotations).toEqual([])
    expect(events[3].response.output[0].annotations).toBeUndefined()
    expect(events[3].response.output[0].content[0].annotations).toEqual([])
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).input[0].content[1]).toEqual({
      type: 'input_image', image_url: imageUrl,
    })
  })

  it('does not append Grok proxy deltas before Grok prints them through stdout', async () => {
    const target = registerCodexProxyTarget({
      profile: 'default',
      provider: 'openai-api',
      model: 'grok-stream-test',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-upstream',
      apiMode: 'codex_responses',
      agentId: 'grok',
      agentSessionId: 'agent-session-grok-stream',
    })
    const handleResponseEvent = vi.spyOn(codingAgentRunManager, 'handleResponseEvent')
    const encoder = new TextEncoder()
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n'))
        controller.enqueue(encoder.encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_grok","status":"completed","output":[]}}\n\n'))
        controller.close()
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(target.routeKey, target.token, {
      stream: true,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
    })
    await codexProxyResponses(ctx)
    for await (const _chunk of ctx.body) {
      // Drain the proxy stream so all observable events are processed.
    }

    expect(handleResponseEvent).not.toHaveBeenCalled()
  })

  it('exposes Codex proxy models with route-token authentication', async () => {
    makeHome()
    const launch = await prepareCodingAgentLaunch('codex', {
      profile: 'default',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-upstream',
      apiMode: 'chat_completions',
    })
    const config = readFileSync(join(launch.rootDir, 'config.toml'), 'utf-8')
    const routeKey = config.match(/\/api\/codex-proxy\/([^/]+)\/v1/)?.[1] || ''
    const token = config.match(/experimental_bearer_token = "([^"]+)"/)?.[1] || ''
    const ctx = makeProxyContext(routeKey, token, {})

    await codexProxyModels(ctx)

    expect(ctx.body).toMatchObject({
      object: 'list',
      data: [{ id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' }],
    })
  })

  it('adapts Claude Code streaming requests to the Responses API for codex_responses providers', async () => {
    const target = registerClaudeCodeProxyTarget({
      provider: 'fun-codex',
      model: 'gpt-5.5',
      baseUrl: 'https://api.apikey.fan/v1',
      apiKey: 'sk-upstream',
      apiMode: 'codex_responses',
    })
    const encoder = new TextEncoder()
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"hi"}\n\n'))
        controller.enqueue(encoder.encode('data: {"type":"response.completed","response":{"status":"completed","usage":{"output_tokens":1}}}\n\n'))
        controller.close()
      },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(target.routeKey, target.token, {
      stream: true,
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hello' }],
    })

    await claudeProxyMessages(ctx)

    expect(fetchMock).toHaveBeenCalledWith('https://api.apikey.fan/v1/responses', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer sk-upstream' }),
    }))
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(requestBody).toMatchObject({
      model: 'gpt-5.5',
      stream: true,
      store: false,
      max_output_tokens: 32,
      input: [{ role: 'user', content: 'hello' }],
    })

    const chunks: string[] = []
    for await (const chunk of ctx.body) chunks.push(String(chunk))
    const sse = chunks.join('')
    expect(ctx.responseHeaders['Content-Type']).toContain('text/event-stream')
    expect(sse).toContain('event: message_start')
    expect(sse).toContain('"type":"text_delta","text":"hi"')
    expect(sse).toContain('event: message_stop')
  })

  it('returns one normalized Claude tool call when Responses uses separate item and call ids', async () => {
    const target = registerClaudeCodeProxyTarget({
      provider: 'fun-codex',
      model: 'gpt-5.5',
      baseUrl: 'https://api.apikey.fan/v1',
      apiKey: 'sk-upstream',
      apiMode: 'codex_responses',
    })
    const fullArguments = JSON.stringify({
      file_path: '/tmp/package.json',
      pages: '',
    })
    const encoder = new TextEncoder()
    const frames = [
      { type: 'response.created', response: { id: 'resp_read', status: 'in_progress' } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_read',
          call_id: 'call_read',
          name: 'Read',
          arguments: '',
          status: 'in_progress',
        },
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        item_id: 'fc_read',
        delta: fullArguments,
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_read',
          call_id: 'call_read',
          name: 'Read',
          arguments: fullArguments,
          status: 'completed',
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_read',
          status: 'completed',
          usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
        },
      },
    ]
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
        }
        controller.close()
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(target.routeKey, target.token, {
      stream: true,
      messages: [{ role: 'user', content: 'read package.json' }],
      tools: [{
        name: 'Read',
        input_schema: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            pages: { type: 'string' },
          },
          required: ['file_path'],
        },
      }],
    })

    await claudeProxyMessages(ctx)

    const chunks: string[] = []
    for await (const chunk of ctx.body) chunks.push(String(chunk))
    const sse = chunks.join('')
    expect(sse.match(/"type":"tool_use"/g)).toHaveLength(1)
    expect(sse).toContain('"id":"call_read","name":"Read"')
    expect(sse).toContain('partial_json":"{\\"file_path\\":\\"/tmp/package.json\\"}"')
    expect(sse).not.toContain('"name":"tool"')
    expect(sse).not.toContain('pages')
  })

  it('round-trips reasoning_content for DeepSeek-style OpenAI Chat tool calls', async () => {
    const target = registerClaudeCodeProxyTarget({
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-upstream',
      apiMode: 'chat_completions',
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'chatcmpl_test',
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          reasoning_content: 'Need to inspect the repository first.',
          content: null,
          tool_calls: [{
            id: 'call_2',
            type: 'function',
            function: { name: 'search', arguments: '{"query":"proxy"}' },
          }],
        },
      }],
      usage: { prompt_tokens: 12, completion_tokens: 8 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(target.routeKey, target.token, {
      max_tokens: 32,
      messages: [
        { role: 'user', content: 'check it' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Need the current repo files.' },
            { type: 'tool_use', id: 'call_1', name: 'search', input: { query: 'reasoning_content' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: 'found one file' },
          ],
        },
      ],
    })

    await claudeProxyMessages(ctx)

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(requestBody.messages[1]).toMatchObject({
      role: 'assistant',
      reasoning_content: 'Need the current repo files.',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'search', arguments: '{"query":"reasoning_content"}' },
      }],
    })
    expect(ctx.body.content[0]).toEqual({
      type: 'thinking',
      thinking: 'Need to inspect the repository first.',
    })
    expect(ctx.body.content[1]).toMatchObject({
      type: 'tool_use',
      id: 'call_2',
      name: 'search',
      input: { query: 'proxy' },
    })
  })

  it('passes Anthropic Messages providers through the local proxy without exposing upstream credentials', async () => {
    const target = registerClaudeCodeProxyTarget({
      provider: 'fun-claude',
      model: 'claude-sonnet-4-6',
      baseUrl: 'https://api.apikey.fan',
      apiKey: 'sk-upstream',
      apiMode: 'anthropic_messages',
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeProxyContext(target.routeKey, target.token, {
      model: 'ignored-client-model',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hello' }],
    })

    await claudeProxyMessages(ctx)

    expect(fetchMock).toHaveBeenCalledWith('https://api.apikey.fan/v1/messages', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer sk-upstream',
        'x-api-key': 'sk-upstream',
      }),
    }))
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(requestBody.model).toBe('claude-sonnet-4-6')
    expect(ctx.body.content[0].text).toBe('hi')
  })

  it('keeps Claude proxy routes separate for the same model with different protocols', () => {
    const chat = registerClaudeCodeProxyTarget({
      provider: 'same-provider',
      model: 'same-model',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-chat',
      apiMode: 'chat_completions',
    })
    const anthropic = registerClaudeCodeProxyTarget({
      provider: 'same-provider',
      model: 'same-model',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-anthropic',
      apiMode: 'anthropic_messages',
    })

    expect(chat.routeKey).not.toBe(anthropic.routeKey)
    expect(chat.token).not.toBe(anthropic.token)
  })

  it('keeps proxy routes separate for different hidden agent sessions', () => {
    const first = registerClaudeCodeProxyTarget({
      provider: 'same-provider',
      model: 'same-model',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-one',
      apiMode: 'chat_completions',
      agentSessionId: 'agent-one',
      chatSessionId: 'chat-one',
    })
    const second = registerClaudeCodeProxyTarget({
      provider: 'same-provider',
      model: 'same-model',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-two',
      apiMode: 'chat_completions',
      agentSessionId: 'agent-two',
      chatSessionId: 'chat-two',
    })

    expect(first.routeKey).not.toBe(second.routeKey)
    expect(first.token).not.toBe(second.token)
  })

  it('keeps hidden session runtime configs separate for the same agent, provider, and model', async () => {
    makeHome()
    const common = {
      profile: 'default',
      provider: 'same-provider',
      model: 'same-model',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-upstream',
      apiMode: 'codex_responses' as const,
      isolateSettings: true,
    }
    const first = await prepareCodingAgentLaunch('claude-code', {
      ...common,
      sessionId: 'chat-one',
      agentSessionId: 'agent-one',
    })
    const second = await prepareCodingAgentLaunch('claude-code', {
      ...common,
      sessionId: 'chat-two',
      agentSessionId: 'agent-two',
    })

    expect(first.rootDir).not.toBe(second.rootDir)
    const firstSettings = JSON.parse(readFileSync(join(first.rootDir, 'settings.json'), 'utf-8'))
    const secondSettings = JSON.parse(readFileSync(join(second.rootDir, 'settings.json'), 'utf-8'))
    const decodeTarget = (baseUrl: string) => JSON.parse(Buffer.from(
      new URL(baseUrl).pathname.split('/').filter(Boolean).at(-1) || '',
      'base64url',
    ).toString('utf-8'))

    expect(decodeTarget(firstSettings.env.ANTHROPIC_BASE_URL).slice(-2)).toEqual(['agent-one', 'chat-one'])
    expect(decodeTarget(secondSettings.env.ANTHROPIC_BASE_URL).slice(-2)).toEqual(['agent-two', 'chat-two'])
  })

  it('keeps Codex proxy routes separate for the same model with different upstream URLs', () => {
    const first = registerCodexProxyTarget({
      profile: 'default',
      provider: 'same-provider',
      model: 'same-model',
      baseUrl: 'https://api-one.example.com/v1',
      apiKey: 'sk-one',
      apiMode: 'chat_completions',
    })
    const second = registerCodexProxyTarget({
      profile: 'default',
      provider: 'same-provider',
      model: 'same-model',
      baseUrl: 'https://api-two.example.com/v1',
      apiKey: 'sk-two',
      apiMode: 'chat_completions',
    })

    expect(first.routeKey).not.toBe(second.routeKey)
    expect(first.token).not.toBe(second.token)
  })

  it('exposes Claude-visible alias models from the local proxy models endpoint', async () => {
    const target = registerClaudeCodeProxyTarget({
      provider: 'openrouter',
      model: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-upstream',
      apiMode: 'codex_responses',
    })
    const ctx = makeProxyContext(target.routeKey, target.token, {})

    await claudeProxyModels(ctx)

    const ids = ctx.body.data.map((model: any) => model.id)
    expect(ids).toContain('claude-haiku-4-5')
    expect(ids).toContain('claude-sonnet-4-6')
    expect(ids).toContain('claude-opus-4-7')
    expect(ids).toContain('cognitivecomputations/dolphin-mistral-24b-venice-edition:free')
  })
})


describe('OpenCode Free coding agents', () => {
  it.each(['claude-code', 'codex', 'pi', 'grok', 'opencode'])('prepares %s with a protected local proxy and no upstream key', async (id) => {
    const home = makeHome()
    if (id === 'pi') {
      const adapter = join(home, 'coding-agent', 'pi-mcp-adapter', 'node_modules', 'pi-mcp-adapter', 'index.ts')
      mkdirSync(dirname(adapter), { recursive: true })
      writeFileSync(adapter, 'export default {}')
    }
    const launch = await prepareCodingAgentLaunch(id as any, {
      profile: 'default', provider: 'opencode-free', model: 'mimo-v2.5-free', mode: 'scoped',
    })
    const contents = launch.files.map(file => readFileSync(file.absolutePath, 'utf8')).join('\n')
    expect(contents).toMatch(/api\/(codex-proxy|claude-code-proxy)\//)
    expect(contents + JSON.stringify(launch.env)).toContain('hwui_')
    if (id === 'codex' || id === 'pi') {
      revokeCodexProxyTargets('default', 'opencode-free')
      const restored = id === 'pi' ? await restorePersistedPiProxyTargets() : await restorePersistedCodexProxyTargets()
      expect(restored).toBeGreaterThan(0)
    }
  })

  it.each([
    ['mimo-v2.5-free', 'chat/completions'],
    ['muse-spark-free', 'responses'],
    ['qwen3-free', 'messages'],
  ])('routes %s anonymously through both proxy protocols', async (model, endpoint) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'test', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }],
      output: [], choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
    }), { headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    for (const claude of [false, true]) {
      const input = { profile: 'default', provider: 'opencode-free', model, baseUrl: 'https://stale.example', apiKey: 'stale-key' }
      const target = claude ? registerClaudeCodeProxyTarget(input) : registerCodexProxyTarget(input)
      const handler = claude ? claudeProxyMessages : codexProxyResponses
      const body = { model, max_tokens: 16, messages: [{ role: 'user', content: 'hello' }], input: 'hello' }
      const denied = makeProxyContext(target.routeKey, '', body)
      await handler(denied)
      expect(denied.status).toBe(401)
      fetchMock.mockClear()
      const ctx = makeProxyContext(target.routeKey, target.token, body)
      await handler(ctx)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0] as any
      expect(url).toBe(`https://opencode.ai/zen/v1/${endpoint}`)
      const headers = new Headers(init.headers)
      expect(headers.has('authorization')).toBe(false)
      expect(headers.has('x-api-key')).toBe(false)
      expect(JSON.parse(init.body).model).toBe(model)
    }
  })

  it('rejects paid model IDs for the native anonymous provider', async () => {
    makeHome()
    await expect(prepareCodingAgentLaunch('codex', {
      provider: 'opencode-free', model: 'gpt-5', mode: 'scoped',
    })).rejects.toMatchObject({ status: 400 })
  })
})
