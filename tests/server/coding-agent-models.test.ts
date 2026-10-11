import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCodingAgentModelDiscovery } from '../../packages/server/src/modules/coding-agents/services/models'
import { createModelDiscoveryContext } from '../../packages/server/src/modules/coding-agents/services/models/process'
import { discoverAcpModels, modelsFromAcpSession } from '../../packages/server/src/modules/coding-agents/services/models/acp'
import { ModelDiscoveryError, normalizeModels, type ModelDiscoveryContext } from '../../packages/server/src/modules/coding-agents/services/models/types'
import { codexModels } from '../../packages/server/src/modules/coding-agents/services/codex/models'
import { claudeCodeModels } from '../../packages/server/src/modules/coding-agents/services/claude-code/models'
import { piModels } from '../../packages/server/src/modules/coding-agents/services/pi/models'
import { grokModels } from '../../packages/server/src/modules/coding-agents/services/grok/models'
import { openCodeModels } from '../../packages/server/src/modules/coding-agents/services/opencode/models'
import { cursorModels } from '../../packages/server/src/modules/coding-agents/services/cursor/models'
import { antigravityModels } from '../../packages/server/src/modules/coding-agents/services/antigravity/models'
import { nativeModelVariant, validateNativeModelEffort } from '../../packages/server/src/modules/coding-agents/services/models/variants'
import { qoderModels } from '../../packages/server/src/modules/coding-agents/services/qoder/models'
import { copilotModels } from '../../packages/server/src/modules/coding-agents/services/copilot/models'
import { zcodeModels } from '../../packages/server/src/modules/coding-agents/services/zcode/models'
import type { CodingAgentDefinition } from '../../packages/server/src/modules/coding-agents/contracts/definition'
import type { CodingAgentRuntime } from '../../packages/server/src/modules/studio/contracts/agents/runtime'

const homes: string[] = []
async function home() {
  const path = await mkdtemp(join(tmpdir(), 'coding-agent-models-'))
  homes.push(path)
  return path
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

function context(stdout = ''): ModelDiscoveryContext {
  return { home: tmpdir(), cwd: tmpdir(), env: {}, run: vi.fn(async () => ({ stdout, stderr: '' })),
    rpc: vi.fn().mockRejectedValue(new ModelDiscoveryError('unsupported')) }
}

describe('native model directory adapters', () => {
  it('groups Antigravity effort variants without advertising CLI-wide choices', async () => {
    const ctx = context('gemini-3.1-pro-high  Gemini 3.1 Pro (High)\ngemini-3.1-pro-low  Gemini 3.1 Pro (Low)\ngpt-oss-120b-medium  GPT-OSS 120B (Medium)\nclaude-opus-4-6-thinking  Claude Opus 4.6 (Thinking)\n')
    const models = normalizeModels((await antigravityModels.discover(ctx)).models)
    expect(models[0]).toMatchObject({ id: 'gemini-3.1-pro-high', modelFamily: 'gemini-3.1-pro', modelFamilyName: 'Gemini 3.1 Pro', reasoningEffort: 'high', reasoningEfforts: ['low', 'high'] })
    expect(models[1]).toMatchObject({ reasoningEffort: 'low', reasoningEfforts: ['low', 'high'] })
    expect(models[2]).toMatchObject({ modelFamilyName: 'GPT-OSS 120B', reasoningEfforts: ['medium'] })
    expect(models[3].reasoningEfforts).toBeUndefined()
    expect(ctx.run).toHaveBeenCalledTimes(1)
    expect(ctx.run).toHaveBeenCalledWith(['models'])
    expect(() => validateNativeModelEffort(models, models[0].id, models[1].id, 'low')).not.toThrow()
    expect(() => validateNativeModelEffort(models, models[0].id, 'gemini-3.1-pro-medium', 'medium')).toThrow('Invalid native')
  })

  it('keeps Cursor aliases, Fast and Thinking distinct while grouping effort tokens', async () => {
    const models = normalizeModels((await cursorModels.discover(context([
      'auto - Auto (current, default)',
      'gpt-5.3-codex-low - Codex 5.3 Low', 'gpt-5.3-codex - Codex 5.3',
      'gpt-5.3-codex-xhigh - Codex 5.3 Extra High',
      'gpt-5.3-codex-low-fast - Codex 5.3 Low Fast', 'gpt-5.3-codex-fast - Codex 5.3 Fast',
      'claude-4.6-opus-high-thinking - Claude Opus 4.6 1M Thinking',
      'claude-4.6-opus-max-thinking - Claude Opus 4.6 1M Max Thinking',
      'claude-4.6-opus-high - Claude Opus 4.6 1M',
      'gpt-5.5-extra-high-fast - GPT-5.5 Extra High Fast',
      'claude-haiku-5-5-thinking-low - Claude Haiku 5.5 Low',
      'gemini-3.1-pro - Gemini 3.1 Pro',
    ].join('\n')))).models)
    expect(models[1]).toMatchObject({ modelFamily: 'gpt-5.3-codex', modelFamilyName: 'Codex 5.3', reasoningEfforts: ['low', 'xhigh'] })
    expect(models[2]).toMatchObject({ modelFamily: 'gpt-5.3-codex' })
    expect(models[2].reasoningEffort).toBeUndefined()
    expect(models[4]).toMatchObject({ modelFamily: 'gpt-5.3-codex-fast', modelFamilyName: 'Codex 5.3 Fast', reasoningEfforts: ['low'] })
    expect(models[6]).toMatchObject({ modelFamily: 'claude-4.6-opus-thinking', reasoningEfforts: ['high', 'max'] })
    expect(models[8]).toMatchObject({ modelFamily: 'claude-4.6-opus', reasoningEfforts: ['high'] })
    expect(models[9]).toMatchObject({ id: 'gpt-5.5-extra-high-fast', modelFamily: 'gpt-5.5-fast', reasoningEffort: 'xhigh' })
    expect(models[10]).toMatchObject({ modelFamilyName: 'Claude Haiku 5.5 (Thinking)' })
    expect(models[11].modelFamily).toBeUndefined()
    expect(nativeModelVariant('gemini-3.1-pro')).toBeUndefined()
    expect(() => validateNativeModelEffort(models, models[1].id, models[4].id, 'low')).toThrow('Invalid native')
    expect(() => validateNativeModelEffort(models, models[6].id, models[7].id, 'high')).toThrow('Invalid native')
  })
  it.each([true, false])('reads Grok model-specific effort metadata (legacy initialize catalog: %s)', async legacy => {
    const state = { currentModelId: 'grok-4.7', availableModels: [
      { modelId: 'grok-4.7', name: 'Grok 4.7', _meta: { supportsReasoningEffort: true,
        reasoningEfforts: [{ id: 'deep', value: 'xhigh' }, { value: 'high' }, { value: 'low' }] }, apiKey: 'secret' },
      { modelId: 'grok-4.5', name: 'Grok 4.5', _meta: { supportsReasoningEffort: true,
        reasoningEfforts: [{ value: 'high' }, { value: 'medium' }, { value: 'low' }] } },
      { modelId: 'plain', _meta: { supportsReasoningEffort: false, reasoningEfforts: [{ value: 'high' }] } },
      { modelId: 'unknown' },
    ] }
    const ctx = context()
    const request = vi.fn(async (method: string) => {
      if (method === 'initialize') return { protocolVersion: 1, _meta: legacy ? { modelState: state } : {} }
      if (method === 'x.ai/models/list') {
        if (legacy) throw new Error('Method not found')
        return { result: state }
      }
      throw new Error('Discovery must not create sessions or send prompts')
    })
    ctx.rpc = async (args, call) => {
      expect(args).toEqual(['agent', '--no-leader', 'stdio'])
      return call({ request, notify: vi.fn(), controlInitialize: vi.fn() })
    }
    const result = await grokModels.discover(ctx)
    expect(result.models).toEqual([
      { id: 'grok-4.7', name: 'Grok 4.7', isDefault: true, reasoningEfforts: ['low', 'high', 'xhigh'] },
      { id: 'grok-4.5', name: 'Grok 4.5', isDefault: false, reasoningEfforts: ['low', 'medium', 'high'] },
      { id: 'plain', name: 'plain', isDefault: false, reasoningEfforts: [] },
      { id: 'unknown', name: 'unknown', isDefault: false },
    ])
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(request.mock.calls.map(([method]) => method)).toEqual(['initialize', 'x.ai/models/list'])
    expect(ctx.run).not.toHaveBeenCalled()
  })

  it('uses the native Grok compatibility menu only for models explicitly supporting effort', async () => {
    const ctx = context()
    ctx.rpc = async (_args, call) => call({ request: vi.fn().mockResolvedValue({ protocolVersion: 1, _meta: {
      modelState: { availableModels: [{ modelId: 'legacy-reasoning', _meta: { supportsReasoningEffort: true } }, { modelId: 'unknown' }] },
    } }), notify: vi.fn(), controlInitialize: vi.fn() })
    const result = await grokModels.discover(ctx)
    expect(result.models[0].reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(result.models[1].reasoningEfforts).toBeUndefined()
  })
  it.each([
    [piModels, 'provider  model  context  max-out  thinking  images\nglm  glm-5-turbo  128K  16.4K  yes  no\n', { id: 'glm/glm-5-turbo', provider: 'glm', contextWindow: 128000, maxOutputTokens: 16400 }],
    [grokModels, 'You are not authenticated.\nAvailable models:\n * grok-example (default)\n - grok-other\n', { id: 'grok-example', isDefault: true }],
    [openCodeModels, 'opencode/example\nlocal/qwen:8b\n', { id: 'opencode/example', provider: 'opencode' }],
    [cursorModels, '\u001b[1mAvailable models\u001b[0m\nauto - Auto (current, default)\ncode-high - Code High\n', { id: 'auto', name: 'Auto', isDefault: true }],
    [antigravityModels, 'gemini-example-high\tGemini Example (High)\n', { id: 'gemini-example-high', name: 'Gemini Example (High)' }],
    [qoderModels, 'MODEL\nQwen-Example\n', { id: 'Qwen-Example' }],
  ] as const)('parses the native %s model directory', async (adapter, stdout, expected) => {
    const result = await adapter.discover(context(stdout))
    expect(result.models[0]).toMatchObject(expected)
    if (adapter === grokModels) expect(result.scope).toBe('builtin')
  })

  it('does not manufacture model metadata or turn malformed output into an empty catalog', async () => {
    await expect(piModels.discover(context('unexpected failure'))).rejects.toMatchObject({ status: 'error' })
    await expect(piModels.discover(context('Failed to load model directory'))).rejects.toMatchObject({ status: 'error' })
    await expect(qoderModels.discover(context('Error:'))).rejects.toMatchObject({ status: 'error' })
    await expect(qoderModels.discover(context('Authentication required'))).rejects.toMatchObject({ status: 'auth_required' })
    expect(await qoderModels.discover(context('\u001b[1mMODEL\u001b[0m\n'))).toEqual({ models: [] })
    const result = await piModels.discover(context('provider model context max-out thinking images\np test 1M 32K yes yes'))
    expect(result.models[0].reasoningEfforts).toBeUndefined()
    expect(result.models[0].inputModalities).toEqual(['text', 'image'])
  })

  it('reads advertised Pi effort levels only for models supporting thinking', async () => {
    const ctx = context()
    ctx.run = vi.fn(async args => ({ stdout: args.includes('--help')
      ? '  --thinking <level> Thinking level: off, minimal, low, medium, high, xhigh, max\n  --other unrelated'
      : 'provider model context max-out thinking images\np thinking 128K 32K yes no\np simple 128K 32K no no', stderr: '' }))
    const result = await piModels.discover(ctx)
    expect(result.models[0].reasoningEfforts).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(result.models[1].reasoningEfforts).toBeUndefined()
  })

  it('keeps Claude model discovery usable if optional CLI help is unavailable', async () => {
    const ctx = context()
    ctx.run = vi.fn().mockRejectedValue(new Error('No help'))
    ctx.rpc = async (_args, call) => call({ request: vi.fn(), notify: vi.fn(), controlInitialize: vi.fn(async () => ({ models: [{ value: 'default' }] })) })
    expect((await claudeCodeModels.discover(ctx)).models).toEqual([{ id: 'default', name: 'default', isDefault: true }])
  })

  it('paginates Codex and keeps native hidden models without exposing account objects', async () => {
    const request = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({
      data: [{ model: 'one', displayName: 'One', hidden: true, api_key: 'secret', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], nextCursor: 'next',
    }).mockResolvedValueOnce({ data: [{ model: 'two', displayName: 'Two' }], nextCursor: null })
    const ctx = context()
    ctx.rpc = async (_args, call) => call({ request, notify: vi.fn(), controlInitialize: vi.fn() })
    const result = await codexModels.discover(ctx)
    expect(request).toHaveBeenLastCalledWith('model/list', { limit: 100, includeHidden: true, cursor: 'next' })
    expect(normalizeModels(result.models)).toEqual([
      { id: 'one', name: 'One', hidden: true, reasoningEfforts: ['high'] }, { id: 'two', name: 'Two' },
    ])
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('stops a broken Codex cursor loop', async () => {
    const ctx = context()
    ctx.rpc = async (_args, call) => call({ request: vi.fn().mockResolvedValue({ data: [], nextCursor: 'same' }), notify: vi.fn(), controlInitialize: vi.fn() })
    await expect(codexModels.discover(ctx)).rejects.toMatchObject({ status: 'error' })
  })

  it('preserves Claude model aliases without returning initialization account data', async () => {
    const ctx = context(), initialized = { account: { token: 'private' }, models: [{ value: 'opus', displayName: 'Custom upstream' }] }
    ctx.rpc = async (args, call) => {
      expect(args).toContain('--no-session-persistence')
      return call({ request: vi.fn(), notify: vi.fn(), controlInitialize: vi.fn(async () => initialized) })
    }
    expect(await claudeCodeModels.discover(ctx)).toEqual({ models: [{ id: 'opus', name: 'Custom upstream', isDefault: false }] })
  })

  it('uses the SDK transport for Copilot rather than its ACP selectors', async () => {
    const ctx = context()
    ctx.rpc = async (args, call, framing) => {
      expect(args).toEqual(['--headless', '--no-auto-update', '--stdio'])
      expect(framing).toBe('content-length')
      const request = vi.fn(async () => ({ models: [{ id: 'code', name: 'Code', capabilities: { limits: { max_context_window_tokens: 128000 }, supports: { vision: true } } }] }))
      const result = await call({ request, notify: vi.fn(), controlInitialize: vi.fn() })
      expect(request).toHaveBeenCalledWith('models.list')
      return result
    }
    expect((await copilotModels.discover(ctx)).models[0]).toMatchObject({ id: 'code', contextWindow: 128000, inputModalities: ['text', 'image'] })
  })

  it('prefers grouped ACP selectors and distinguishes unsupported from an empty directory', () => {
    expect(modelsFromAcpSession({ configOptions: [{ id: 'model', currentValue: 'code', options: [
      { name: 'Provider', options: [{ value: 'code', name: 'Code' }] },
    ] }] })).toEqual({ models: [{ id: 'code', name: 'Code', isDefault: true }] })
    expect(modelsFromAcpSession({ models: { availableModels: [], currentModelId: '' } })).toEqual({ models: [] })
    expect(() => modelsFromAcpSession({ sessionId: 'native' })).toThrow(ModelDiscoveryError)
    expect(modelsFromAcpSession({ models: { currentModelId: 'a', availableModels: [{ modelId: 'a', name: 'A', token: 'private' }] } }).models).toEqual([{ id: 'a', name: 'A', isDefault: true }])
  })

  it('attaches ACP thought-level metadata only to its current native model', () => {
    expect(modelsFromAcpSession({ configOptions: [
      { id: 'native-model', category: 'model', currentValue: 'a', options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] },
      { id: 'native-thought', category: 'thought_level', options: [{ value: 'low' }, { value: 'high' }] },
    ] }).models).toEqual([
      { id: 'a', name: 'A', isDefault: true, reasoningEfforts: ['low', 'high'] },
      { id: 'b', name: 'B', isDefault: false },
    ])
  })

  it.each([true, false])('closes ACP discovery sessions even when model selectors are unavailable (%s)', async selectors => {
    const ctx = context()
    const request = vi.fn(async (method: string) => {
      if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: true } } }
      if (method === 'session/new') return { sessionId: 'native-only', ...(selectors ? { models: { availableModels: [] } } : {}) }
      if (method === 'session/close') throw new Error('already closed')
      throw new Error('Discovery must never send a prompt')
    })
    ctx.rpc = async (_args, call) => call({ request, notify: vi.fn(), controlInitialize: vi.fn() })
    if (selectors) expect(await discoverAcpModels(ctx, ['--acp'])).toEqual({ models: [] })
    else await expect(discoverAcpModels(ctx, ['--acp'])).rejects.toMatchObject({ status: 'unsupported' })
    expect(request.mock.calls.map(([method]) => method)).toEqual(['initialize', 'session/new', 'session/close'])
  })

  it('reads exact ZCode builtin model ids without exposing unrelated rules or credentials', async () => {
    const file = join(await home(), 'builtin.json')
    await writeFile(file, JSON.stringify({ config: { modelConfigRules: {
      modelRules: [{ modelMatch: '.*', config: { apiKey: 'secret' } }],
      builtinProviderModelRules: [{ providerId: 'builtin', modelId: 'glm-example', config: { enabled: true, apiKey: 'secret' } }],
    } } }))
    const ctx = context(); ctx.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = file
    expect(await zcodeModels.discover(ctx)).toEqual({ models: [{ id: 'glm-example', name: 'glm-example', provider: 'builtin', hidden: false }] })
    await expect(zcodeModels.discover(context())).rejects.toMatchObject({ status: 'unsupported' })
  })

  it('resolves ZCode native effort rules per model and native provider without exposing personal credentials', async () => {
    const root = await home(), builtin = join(root, 'builtin.json'), personal = join(root, 'personal.json')
    await writeFile(builtin, JSON.stringify({ config: { modelConfigRules: {
      modelRules: [
        { modelMatch: '.*', config: { optionSpecs: { reasoningLevel: { values: ['disabled', 'enabled'] } } } },
        { modelMatch: 'glm-5\\.3', config: { optionSpecs: { reasoningLevel: { values: ['low', 'high', 'max'] } } } },
        { modelMatch: '[invalid', config: { optionSpecs: { reasoningLevel: { values: ['invalid'] } } } },
      ], builtinProviderModelRules: [
        { providerId: 'native', modelId: 'GLM-5.3' }, { providerId: 'other', modelId: 'GLM-5.3' },
        { providerId: 'native', modelId: 'GLM-5-Turbo' },
      ],
    } } }))
    await writeFile(personal, JSON.stringify({ config: {
      defaultModelSelection: { providerId: 'native', modelId: 'GLM-5.3' },
      providerConfigRules: { providerRules: [{ providerId: 'native', config: { access: { apiKey: 'secret' } } }] },
      modelConfigRules: { providerModelRules: [{ providerId: 'other', modelId: 'GLM-5.3',
        config: { optionSpecs: { reasoningLevel: { values: ['low', 'high'] } } } }] },
    } }))
    const ctx = context(); ctx.env = { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal }
    const result = await zcodeModels.discover(ctx)
    expect(result.models[0]).toMatchObject({ id: 'GLM-5.3', isDefault: true, reasoningEfforts: ['low', 'high', 'max'] })
    expect(result.models[1]).toMatchObject({ id: 'GLM-5.3', provider: 'other', reasoningEfforts: ['low', 'high'] })
    expect(result.models[1].isDefault).toBeUndefined()
    expect(result.models[2].reasoningEfforts).toEqual(['disabled', 'enabled'])
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('deduplicates by provider and model and allowlists public metadata', () => {
    expect(normalizeModels([
      { id: 'same', name: 'Name', provider: 'a', contextWindow: NaN, apiKey: 'secret' } as any,
      { id: 'same', name: 'Duplicate', provider: 'a' }, { id: 'same', name: 'Other', provider: 'b' },
    ])).toEqual([{ id: 'same', name: 'Name', provider: 'a' }, { id: 'same', name: 'Other', provider: 'b' }])
  })
})

function processContext(script: string, timeoutMs = 1500) {
  return createModelDiscoveryContext({ command: { command: process.execPath, args: ['-e', script, '--'] },
    home: tmpdir(), cwd: tmpdir(), env: process.env,
    host: { timeoutMs, commandExecution: (command, args) => ({ command, args }) } })
}

describe('bounded native discovery transports', () => {
  it('handles split JSONL UTF-8 and denies native client actions', async () => {
    const ctx = processContext(`
      let buffer = ''; let request;
      process.stdin.on('data', chunk => {
        buffer += chunk;
        while (buffer.includes('\\n')) {
          const end = buffer.indexOf('\\n'); const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          if (message.method === 'models') {
            request = message.id;
            process.stdout.write('startup noise\\n' + JSON.stringify({jsonrpc:'2.0',id:'action',method:'fs/write_text_file',params:{}}) + '\\n');
          } else if (message.id === 'action') {
            const result = Buffer.from(JSON.stringify({id:request,result:{name:'模型',denied:message.error.code}})+'\\n');
            process.stdout.write(result.subarray(0, result.length-3)); setTimeout(() => process.stdout.write(result.subarray(result.length-3)), 10);
          }
        }
      });
    `)
    expect(await ctx.rpc([], rpc => rpc.request('models'))).toEqual({ name: '模型', denied: -32601 })
  })

  it('handles fragmented Content-Length frames using byte lengths', async () => {
    const ctx = processContext(`
      let buffer = Buffer.alloc(0);
      process.stdin.on('data', chunk => {
        buffer = Buffer.concat([buffer,chunk]); const index = buffer.indexOf('\\r\\n\\r\\n'); if(index<0) return;
        const length = Number(buffer.subarray(0,index).toString().split(':')[1]); if(buffer.length<index+4+length) return;
        const message = JSON.parse(buffer.subarray(index+4,index+4+length).toString());
        const body = Buffer.from(JSON.stringify({id:message.id,result:{name:'模型'}}));
        const header = Buffer.from('Content-Length: '+body.length+'\\r\\n\\r\\n');
        process.stdout.write(header.subarray(0,5)); setTimeout(() => process.stdout.write(Buffer.concat([header.subarray(5),body])), 10);
      });
    `)
    expect(await ctx.rpc([], rpc => rpc.request('models.list'), 'content-length')).toEqual({ name: '模型' })
  })

  it('classifies authentication without returning private error text', async () => {
    const ctx = processContext(`process.stdin.on('data', chunk => { const message=JSON.parse(chunk); process.stdout.write(JSON.stringify({id:message.id,error:{code:-32000,message:'Authentication required; private-token'}})+'\\n'); });`)
    await expect(ctx.rpc([], rpc => rpc.request('initialize'))).rejects.toMatchObject({ status: 'auth_required', message: 'Native model discovery: auth_required' })
  })

  it('terminates a stalled child at the total discovery deadline', async () => {
    const ctx = processContext('setInterval(() => {}, 1000)', 200)
    await expect(ctx.rpc([], rpc => rpc.request('initialize'))).rejects.toMatchObject({ status: 'timeout' })
  })

  it('rejects oversized output', async () => {
    const ctx = processContext("process.stdout.write('x'.repeat(5*1024*1024)); setInterval(() => {}, 1000)")
    await expect(ctx.run([])).rejects.toMatchObject({ status: 'error' })
  })

  it.runIf(process.platform !== 'win32')('terminates descendants after their parent CLI exits', async () => {
    const pidFile = join(await home(), 'descendant.pid')
    const ctx = processContext(`
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      process.exit(0);
    `, 200)
    let pid: number | undefined
    try {
      await expect(ctx.run([])).rejects.toMatchObject({ status: 'timeout' })
      pid = Number(await readFile(pidFile, 'utf8'))
      await vi.waitFor(() => { expect(() => process.kill(pid!, 0)).toThrow() }, { timeout: 2000 })
    } finally {
      pid ||= Number(await readFile(pidFile, 'utf8').catch(() => '0'))
      if (pid) { try { process.kill(pid, 'SIGKILL') } catch {} }
    }
  })
})

function definition(id: CodingAgentRuntime): CodingAgentDefinition {
  return { id, name: id, command: id, provider: id, packageName: id }
}

describe('unified model directory service', () => {
  it('coalesces discovery, caches isolated snapshots and explicitly refreshes', async () => {
    const dataHome = await home(), resolveCommand = vi.fn(async () => ({ command: process.execPath, args: ['-e', "process.stdout.write('provider model context max-out thinking images\\nglm example 128K 16K yes no\\n')", '--'] }))
    const getModels = createCodingAgentModelDiscovery({ definitions: [definition('pi')], home: () => dataHome, dataHome: () => dataHome,
      commandEnv: async () => process.env, resolveCommand, commandExecution: (command, args) => ({ command, args }) })
    const [first, concurrent] = await Promise.all([getModels(), getModels({ refresh: true })])
    expect(resolveCommand).toHaveBeenCalledTimes(1)
    expect(first.agents[0].status).toBe('ready')
    expect(concurrent.agents[0].models).toEqual(first.agents[0].models)
    first.agents[0].models[0].name = 'mutated'
    expect((await getModels()).agents[0]).toMatchObject({ cached: true, models: [{ name: 'example' }] })
    await getModels({ refresh: true })
    expect(resolveCommand).toHaveBeenCalledTimes(2)
  })

  it('keeps failures separate, preserves registry order and never dispatches unknown agents', async () => {
    const dataHome = await home()
    const resolveCommand = vi.fn(async (agent: CodingAgentDefinition) => {
      if (agent.id === 'pi') return null
      if (agent.id === 'qwen') throw new Error('Authentication required; secret-token')
      return { command: process.execPath, args: ['-e', "process.stdout.write('You are not authenticated.\\nAvailable models:\\n* grok-test (default)\\n')", '--'] }
    })
    const getModels = createCodingAgentModelDiscovery({ definitions: ['pi', 'qwen', 'grok'].map(id => definition(id as CodingAgentRuntime)),
      home: () => dataHome, dataHome: () => dataHome, commandEnv: async () => process.env, resolveCommand, commandExecution: (command, args) => ({ command, args }) })
    const result = await getModels()
    expect(result.agents.map(agent => agent.status)).toEqual(['not_installed', 'auth_required', 'ready'])
    expect(result.agents[2].scope).toBe('builtin')
    expect(JSON.stringify(result)).not.toContain('secret-token')
    const calls = resolveCommand.mock.calls.length
    await expect(getModels({ agent: '../command' })).rejects.toMatchObject({ status: 400 })
    expect(resolveCommand).toHaveBeenCalledTimes(calls)
  })
})
