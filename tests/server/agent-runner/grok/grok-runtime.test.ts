import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  grokSettingsConfig,
  grokUserMcpConfig,
  mergeGrokSettingsConfig,
  mergeGrokUserMcpConfig,
  prepareGlobalGrokRuntime,
  prepareScopedGrokRuntime,
  stripManagedGrokMcp,
} from '../../../../packages/server/src/modules/coding-agents/services/grok/config'
import { applyGrokStreamEvent } from '../../../../packages/server/src/modules/coding-agents/services/grok/event-adapter'
import { parseGrokStreamingJsonLine } from '../../../../packages/server/src/modules/coding-agents/services/grok/streaming-json'
import {
  buildGrokTurnArgs,
  grokSessionExists,
} from '../../../../packages/server/src/modules/coding-agents/services/grok/turn-process'
import { updateManagedPromptFileSync } from '../../../../packages/server/src/modules/coding-agents/services/prompt-file'

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hermes-grok-runtime-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Grok runtime isolation', () => {
  it('builds a global shadow home without changing the user Grok configuration', async () => {
    const root = makeRoot()
    const sourceHome = join(root, 'user-grok')
    const runtimeHome = join(root, 'studio-runtime')
    await mkdir(join(sourceHome, 'skills', 'review'), { recursive: true })
    writeFileSync(join(sourceHome, 'config.toml'), '[models]\ndefault = "grok-4"\n')
    writeFileSync(join(sourceHome, 'AGENTS.md'), 'User instructions.\n')
    writeFileSync(join(sourceHome, 'auth.json'), '{"token":"user-token"}\n')
    writeFileSync(join(sourceHome, 'auth.json.lock'), 'stale runtime lock\n')
    writeFileSync(join(sourceHome, 'skills', 'review', 'SKILL.md'), 'Review skill.\n')

    await prepareGlobalGrokRuntime({
      sourceHome,
      rootDir: runtimeHome,
      systemPrompt: 'Studio instructions.',
      managedMcpToml: '[mcp_servers.ekko-studio-api]\ncommand = "studio-mcp"\n',
    })

    expect(readFileSync(join(sourceHome, 'config.toml'), 'utf-8')).toBe('[models]\ndefault = "grok-4"\n')
    expect(readFileSync(join(sourceHome, 'AGENTS.md'), 'utf-8')).toBe('User instructions.\n')
    expect(readFileSync(join(runtimeHome, 'config.toml'), 'utf-8')).toContain('[mcp_servers.ekko-studio-api]')
    expect(readFileSync(join(runtimeHome, 'AGENTS.md'), 'utf-8')).toContain('Studio instructions.')
    expect(readFileSync(join(runtimeHome, 'AGENTS.md'), 'utf-8')).toContain('User instructions.')
    expect(readFileSync(join(runtimeHome, 'skills', 'review', 'SKILL.md'), 'utf-8')).toBe('Review skill.\n')
    expect(existsSync(join(runtimeHome, 'auth.json.lock'))).toBe(false)

    writeFileSync(join(runtimeHome, 'skills', 'review', 'SKILL.md'), 'Runtime-only edit.\n')
    expect(readFileSync(join(sourceHome, 'skills', 'review', 'SKILL.md'), 'utf-8')).toBe('Review skill.\n')
  })

  it('writes scoped proxy credentials only as an environment-variable reference', async () => {
    const rootDir = makeRoot()
    await prepareScopedGrokRuntime({
      rootDir,
      provider: 'custom-provider',
      model: 'custom-model',
      displayName: 'Custom Model',
      proxyBaseUrl: 'http://127.0.0.1:8647/api/coding-agents/codex-proxy/test/v1',
      contextWindow: 128_000,
      outputLimit: 8192,
      autoCompactThresholdPercent: 50,
      reasoningEffort: 'high',
      systemPrompt: 'Studio instructions.',
      userInstructions: 'User instructions.',
      settingsContent: [
        'api_key = "stale-native-key"',
        'access_token = "stale-native-token"',
        '',
        '[auth]',
        'refresh_token = "stale-refresh-token"',
        '',
        '[cli]',
        'installer = "npm"',
      ].join('\n'),
      managedMcpToml: '[mcp_servers.ekko-studio-use]\ncommand = "studio-mcp"\n',
    })

    const config = readFileSync(join(rootDir, 'config.toml'), 'utf-8')
    expect(config).toContain('[model.hermes-studio]')
    expect(config).toContain('api_backend = "responses"')
    expect(config).toContain('env_key = "HERMES_STUDIO_GROK_API_KEY"')
    expect(config).toContain('auto_compact_threshold_percent = 50')
    expect(config).not.toContain('api_key =')
    expect(config).not.toContain('stale-native')
    expect(config).not.toContain('stale-refresh-token')
    expect(config).not.toContain('[auth]')
    expect(config).toContain('[cli]')

    const promptPath = join(rootDir, 'AGENTS.md')
    const prompt = readFileSync(promptPath, 'utf-8')
    expect(prompt).toContain('Grok Build is the shell, not necessarily the upstream language model.')
    expect(prompt).toContain('selected upstream provider is `custom-provider`')
    expect(prompt).toContain('exact model ID is `custom-model`')

    updateManagedPromptFileSync(promptPath, 'Updated workflow instructions.')
    const updatedPrompt = readFileSync(promptPath, 'utf-8')
    expect(updatedPrompt).toContain('exact model ID is `custom-model`')
    expect(updatedPrompt).toContain('Updated workflow instructions.')
  })

  it('keeps multi-line user settings intact in the scoped Grok config', async () => {
    const rootDir = makeRoot()
    await prepareScopedGrokRuntime({
      rootDir,
      provider: 'custom-provider',
      model: 'custom-model',
      displayName: 'Custom Model',
      proxyBaseUrl: 'http://127.0.0.1:8647/api/coding-agents/codex-proxy/test/v1',
      contextWindow: 128_000,
      outputLimit: 8192,
      reasoningEffort: 'high',
      systemPrompt: 'Studio instructions.',
      userInstructions: 'User instructions.',
      settingsContent: [
        'allowed_tools = [',
        '  "bash",',
        '  "read",',
        ']',
        '',
        '[[profiles]]',
        'name = "fast"',
        '',
        '[tools]',
        'preamble = """',
        'keep this line',
        '[not a section]',
        '"""',
      ].join('\n'),
      managedMcpToml: '[mcp_servers.ekko-studio-use]\ncommand = "studio-mcp"\n',
    })

    const config = readFileSync(join(rootDir, 'config.toml'), 'utf-8')
    expect(config).toContain('allowed_tools = [\n  "bash",\n  "read",\n]')
    expect(config).toContain('[[profiles]]\nname = "fast"')
    expect(config).toContain('[tools]\npreamble = """\nkeep this line\n[not a section]\n"""')
  })

  it('copies global Grok skills into scoped runtimes', async () => {
    const root = makeRoot()
    const sourceHome = join(root, 'user-grok')
    const rootDir = join(root, 'runtime')
    await mkdir(join(sourceHome, 'skills', 'review'), { recursive: true })
    await mkdir(join(root, '.agents', 'skills', 'shared'), { recursive: true })
    writeFileSync(join(sourceHome, 'skills', 'review', 'SKILL.md'), 'Review skill.\n')
    writeFileSync(join(root, '.agents', 'skills', 'shared', 'SKILL.md'), 'Shared skill.\n')

    await prepareScopedGrokRuntime({
      sourceHome,
      rootDir,
      provider: 'custom-provider',
      model: 'custom-model',
      displayName: 'Custom Model',
      proxyBaseUrl: 'http://127.0.0.1:8647/v1',
      contextWindow: 128_000,
      outputLimit: 8192,
      reasoningEffort: '',
      systemPrompt: 'Studio instructions.',
      userInstructions: 'User instructions.',
      managedMcpToml: '',
    })

    expect(readFileSync(join(rootDir, 'skills', 'review', 'SKILL.md'), 'utf-8')).toBe('Review skill.\n')
    expect(readFileSync(join(rootDir, 'skills', 'shared', 'SKILL.md'), 'utf-8')).toBe('Shared skill.\n')
  })

  it('removes only Studio-managed MCP blocks', () => {
    const config = [
      '[mcp_servers.user-tools]',
      'command = "user-mcp"',
      '',
      '[mcp_servers.ekko-studio-api]',
      'command = "old-studio-mcp"',
    ].join('\n')

    expect(stripManagedGrokMcp(config)).toContain('[mcp_servers.user-tools]')
    expect(stripManagedGrokMcp(config)).not.toContain('ekko-studio-api')
  })

  it('separates Grok settings and user MCP without persisting managed MCP', () => {
    const config = [
      '[cli]',
      'installer = "npm"',
      '',
      '[mcp_servers.user-tools]',
      'command = "user-mcp"',
      '',
      '[mcp_servers.ekko-studio-api]',
      'command = "studio-mcp"',
    ].join('\n')

    expect(grokSettingsConfig(config)).toContain('[cli]')
    expect(grokSettingsConfig(config)).not.toContain('mcp_servers')
    expect(grokUserMcpConfig(config)).toContain('user-tools')
    expect(grokUserMcpConfig(config)).not.toContain('ekko-studio-api')
    expect(mergeGrokUserMcpConfig(config, '[mcp_servers.next]\ncommand = "next"')).toContain('[cli]')
    expect(mergeGrokUserMcpConfig(config, '[mcp_servers.next]\ncommand = "next"')).not.toContain('user-tools')
    expect(mergeGrokSettingsConfig(config, '[cli]\ninstaller = "brew"')).toContain('user-tools')
  })
})

describe('Grok streaming JSON adaptation', () => {
  it('passes every prompt through a file and uses explicit new/resume session flags', () => {
    const windowsPromptPath = 'C:/Users/Test User/AppData/Local/Ekko Studio/turn & echo injected.md'
    const firstTurn = buildGrokTurnArgs(['--always-approve'], 'session-1', false, windowsPromptPath)
    const resumedTurn = buildGrokTurnArgs(['--always-approve'], 'session-1', true, '/studio/turn-2.md')

    expect(firstTurn).toEqual([
      '--always-approve',
      '--session-id', 'session-1',
      '--output-format', 'streaming-json',
      '--prompt-file', windowsPromptPath,
    ])
    expect(resumedTurn).toContain('--resume')
    expect(resumedTurn).not.toContain('--session-id')
  })

  it('detects persisted sessions after a failed first turn', () => {
    const root = makeRoot()
    const workspace = join(root, 'workspace with spaces')
    const sessionId = '9bf2543c-3b57-43de-b5f6-838c2f73a554'
    mkdirSync(join(root, 'sessions', encodeURIComponent(workspace), sessionId), { recursive: true })

    expect(grokSessionExists(root, workspace, sessionId)).toBe(true)
    expect(grokSessionExists(root, workspace, '11111111-1111-4111-8111-111111111111')).toBe(false)
  })

  it('parses the documented event stream and maps terminal tool updates', () => {
    const started: unknown[] = []
    const completed: unknown[] = []
    const sessions: string[] = []
    const sink = {
      text: () => undefined,
      thought: () => undefined,
      toolStarted: (value: unknown) => started.push(value),
      toolCompleted: (value: unknown) => completed.push(value),
      usage: () => undefined,
      session: (value: string) => sessions.push(value),
      complete: () => undefined,
      error: () => undefined,
      status: () => undefined,
    }

    const start = parseGrokStreamingJsonLine('{"type":"tool_call","toolCallId":"call-1","toolName":"read_file","rawInput":{"path":"README.md"}}')
    const done = parseGrokStreamingJsonLine('{"type":"tool_call_update","toolCallId":"call-1","status":"completed","rawOutput":{"lines":42}}')
    const end = parseGrokStreamingJsonLine('{"type":"end","sessionId":"session-1","stopReason":"end_turn","usage":{"input_tokens":12}}')
    if (start) applyGrokStreamEvent(start, sink)
    if (done) applyGrokStreamEvent(done, sink)
    if (end) applyGrokStreamEvent(end, sink)

    expect(started).toEqual([{ id: 'call-1', name: 'read_file', input: { path: 'README.md' } }])
    expect(completed).toEqual([{ id: 'call-1', output: { lines: 42 }, failed: false }])
    expect(sessions).toEqual(['session-1'])
  })

  it('accepts usage fields emitted at the top level of native events', () => {
    const usage = parseGrokStreamingJsonLine('{"type":"end","sessionId":"session-1","data":{"usage":{"prompt_tokens":81441,"completion_tokens":128}}}')

    expect(usage).toEqual({
      type: 'end',
      sessionId: 'session-1',
      stopReason: '',
      usage: { prompt_tokens: 81441, completion_tokens: 128 },
    })
  })
})
