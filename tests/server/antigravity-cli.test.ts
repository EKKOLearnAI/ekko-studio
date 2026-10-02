import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAntigravityStreamParser } from '../../packages/server/src/modules/coding-agents/services/antigravity/stream-json'
import { buildAntigravityTurnArgs, createAntigravityStdoutReader } from '../../packages/server/src/modules/coding-agents/services/antigravity/turn-process'
import { prepareAntigravityRuntime, validateAntigravitySettings, parseAntigravityConfig } from '../../packages/server/src/modules/coding-agents/services/antigravity/config'
import { NativeTurnUsage } from '../../packages/server/src/modules/coding-agents/services/runtime/native-usage'

const roots: string[] = []
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })
const line = (event: unknown) => JSON.stringify(event)
describe('Antigravity official CLI protocol', () => {
  it('waits for a terminal result across model/tool/model steps and avoids result text and usage duplication', () => {
    const parse = createAntigravityStreamParser()
    expect(parse(line({ event: 'init', conversation_id: 'native', init: { model: 'test-model' } }))).toEqual([{ type: 'session', sessionId: 'native', model: 'test-model' }])
    expect(parse(line({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE', text_delta: 'First', usage: { input_tokens: 50 } } }))).toEqual([{ type: 'text', data: 'First' }])
    const tool = { event: 'step_update', step_update: { conversation_id: 'native', step_index: 4, step_type: 'tool', state: 'DONE', tool_info: { name: 'run_command', parameters: { CommandLine: 'pwd' }, output: '/workspace' } } }
    expect(parse(line(tool)).map(e => e.type)).toEqual(['tool_started', 'tool_completed'])
    expect(parse(line(tool))).toEqual([])
    expect(parse(line({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE', text_delta: 'Final' } }))).toEqual([{ type: 'text', data: 'Final' }])
    const final = { event: 'result', result: { conversation_id: 'native', status: 'SUCCESS', response: 'FirstFinal', usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 8, cache_read_tokens: 30 } } }
    const events = parse(line(final))
    expect(events.map(e => e.type)).toEqual(['session', 'complete'])
    const completion = events.at(-1) as any
    const rows = new NativeTurnUsage().rows('antigravity', completion.usage, 'test-model')
    expect(rows).toHaveLength(1)
    expect(rows[0].usage).toMatchObject({ inputTokens: 100, outputTokens: 20, reasoningTokens: 8, cacheReadTokens: 30 })
    expect(parse(line(final))).toEqual([])
  })
  it('closes failed tool cards for the actual CLI ERROR step state', () => {
    const parse = createAntigravityStreamParser()
    const events = parse(JSON.stringify({ event: 'step_update', step_update: {
      conversation_id: 'native', step_index: 2, step_type: 'tool', state: 'ERROR',
      tool_info: { name: 'tool', parameters: {}, error: { type: 'TOOL_ERROR', message: 'failed' } },
    } }))
    expect(events.map(event => event.type)).toEqual(['tool_started', 'tool_completed'])
    expect(events.at(-1)).toMatchObject({ failed: true, output: { message: 'failed' } })
  })
  it.each(['ERROR', 'CANCELED', 'INTERRUPTED', undefined])('does not treat %s as success', status => {
    const events = createAntigravityStreamParser()(line({ event: 'result', result: { status, error: 'failed' } }))
    expect(events).toEqual([{ type: 'error', message: 'failed', usage: undefined }])
  })
  it('uses result text as fallback and rejects malformed events', () => {
    const parse = createAntigravityStreamParser()
    expect(parse('not json')).toEqual([])
    expect(parse('null')).toEqual([])
    expect(parse(line({ event: 'result', result: { status: 'SUCCESS', response: 'answer' } })).map(e => e.type)).toEqual(['text', 'complete'])
  })
  it('uses explicit native conversation identity without granting blanket permissions', () => {
    expect(buildAntigravityTurnArgs([], 'native-id', true, 'prompt')).toEqual(['--input-format', 'stream-json', '--output-format', 'stream-json', '--conversation', 'native-id', '--print-timeout', '0'])
    expect(buildAntigravityTurnArgs([], 'native-id', false, 'prompt')).not.toContain('--conversation')
    expect(buildAntigravityTurnArgs([], '', false, 'prompt')).not.toContain('--dangerously-skip-permissions')
  })
  it('handles fragmented UTF-8 and final lines without a newline', () => {
    const reader = createAntigravityStdoutReader()
    const bytes = Buffer.from('你好\nlast')
    expect(reader.push(bytes.subarray(0, 2))).toEqual([])
    expect(reader.push(bytes.subarray(2))).toEqual(['你好'])
    expect(reader.end()).toEqual(['last'])
  })
  it('isolates generated MCP and settings without modifying native credentials, permissions or user MCP', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studio-antigravity-')); roots.push(root)
    const home = join(root, 'home'), runtime = join(root, 'runtime')
    await mkdir(join(home, '.gemini', 'config', 'skills'), { recursive: true })
    await mkdir(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
    await mkdir(join(home, '.gemini', 'antigravity'), { recursive: true })
    const mcp = JSON.stringify({ mcpServers: { custom: { command: 'node' } } })
    await writeFile(join(home, '.gemini', 'config', 'mcp_config.json'), mcp)
    await writeFile(join(home, '.gemini', 'antigravity-cli', 'settings.json'), '{"permissions":{"allow":[]}}')
    const prepared = await prepareAntigravityRuntime({ home, rootDir: runtime, systemPrompt: 'Studio rules', managedMcp: { studio: { command: 'node', env: { ELECTRON_RUN_AS_NODE: '1' } } } })
    expect(prepared.env.HOME).toBe(runtime)
    expect(JSON.parse(await readFile(join(runtime, '.gemini', 'config', 'mcp_config.json'), 'utf8')).mcpServers).toHaveProperty('studio')
    expect(await readFile(join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8')).toBe(mcp)
    expect(JSON.parse(await readFile(join(runtime, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')).permissions.allow).toEqual(['mcp(studio/*)'])
    expect(await readFile(join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')).toBe('{"permissions":{"allow":[]}}')
    await writeFile(join(runtime, '.gemini', 'antigravity', 'native-session'), 'persisted')
    expect(await readFile(join(home, '.gemini', 'antigravity', 'native-session'), 'utf8')).toBe('persisted')
  })
  it('treats empty native configuration as default and accepts a BOM', () => {
    expect(parseAntigravityConfig('')).toEqual({})
    expect(parseAntigravityConfig('  \n')).toEqual({})
    expect(parseAntigravityConfig('\uFEFF{"permissions":{}}')).toEqual({ permissions: {} })
    expect(() => parseAntigravityConfig('null')).toThrow()
  })
  it('prepares a runtime when the native CLI has created zero-byte config files', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agy-empty-config-')); roots.push(home)
    await mkdir(join(home, '.gemini', 'config'), { recursive: true })
    await mkdir(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
    await writeFile(join(home, '.gemini', 'config', 'mcp_config.json'), '')
    await writeFile(join(home, '.gemini', 'antigravity-cli', 'settings.json'), '')
    const runtime = await prepareAntigravityRuntime({ home, rootDir: join(home, 'runtime'), systemPrompt: 'rules', managedMcp: {} })
    expect(JSON.parse(await readFile(runtime.files.find(file => file.key === 'mcp')!.absolutePath, 'utf8'))).toEqual({ mcpServers: {} })
  })
  it('fails closed on malformed settings', () => {
    expect(() => validateAntigravitySettings('[]')).toThrow()
    expect(() => validateAntigravitySettings('{')).toThrow()
  })
})

describe('Antigravity product routing', () => {
  it('retains Antigravity identity in workflow and group presets, preserving scoped mode', async () => {
    const { resolveWorkflowNodeRunTarget, normalizeWorkflowNode } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    const { normalizeGroupAgentPresetInput } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-presets')
    expect(resolveWorkflowNodeRunTarget('antigravity')).toMatchObject({ agent: 'antigravity', codingAgentId: 'antigravity' })
    expect(normalizeWorkflowNode({ id: 'a', data: { agent: 'antigravity', agentMode: 'scoped' } })?.data.agentMode).toBe('scoped')
    expect(normalizeGroupAgentPresetInput({ agent: 'antigravity', agentMode: 'scoped', name: 'A', profile: 'default', provider: 'external', model: 'chosen-model', apiMode: 'chat_completions' })).toMatchObject({ agent: 'antigravity', agentMode: 'scoped' })
  })
})

// Opt-in actual CLI check: empty temporary HOME, no credentials, no inference.
describe('Antigravity actual CLI argument acceptance', () => {
  it.skipIf(!process.env.ANTIGRAVITY_TEST_CLI)('accepts the adapter NDJSON flags and reaches authentication, not argument parsing', async () => {
    const { spawnSync } = await import('node:child_process')
    const home = await mkdtemp(join(tmpdir(), 'studio-agy-no-auth-')); roots.push(home)
    const result = spawnSync(process.env.ANTIGRAVITY_TEST_CLI!, buildAntigravityTurnArgs([], '', false, ''), {
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home },
      input: `${JSON.stringify({ event: 'user', message: { content: 'argument acceptance test' } })}\n`,
      encoding: 'utf8', timeout: 15000,
    })
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(2)
    expect(result.stderr).not.toContain('took "--output-format"')
    expect(result.stderr).toMatch(/authentication required|authentication failed/i)
    const terminal = result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(event => event.event === 'result')
    expect(terminal.result.status).toBe('ERROR')
  })
})
