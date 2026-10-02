import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAntigravityStreamParser } from '../../packages/server/src/modules/coding-agents/services/antigravity/stream-json'
import { buildAntigravityTurnArgs, createAntigravityStdoutReader } from '../../packages/server/src/modules/coding-agents/services/antigravity/turn-process'
import { prepareAntigravityRuntime, validateAntigravitySettings } from '../../packages/server/src/modules/coding-agents/services/antigravity/config'
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
    expect(buildAntigravityTurnArgs([], 'native-id', true, 'prompt')).toEqual(['-p', '--output-format', 'stream-json', '--conversation', 'native-id', '--print-timeout', '0', 'prompt'])
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
  it('fails closed on malformed settings', () => {
    expect(() => validateAntigravitySettings('[]')).toThrow()
    expect(() => validateAntigravitySettings('{')).toThrow()
  })
})

describe('Antigravity product routing', () => {
  it('retains Antigravity identity in workflow and group presets, forcing global mode', async () => {
    const { resolveWorkflowNodeRunTarget, normalizeWorkflowNode } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    const { normalizeGroupAgentPresetInput } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-presets')
    expect(resolveWorkflowNodeRunTarget('antigravity')).toMatchObject({ agent: 'antigravity', codingAgentId: 'antigravity' })
    expect(normalizeWorkflowNode({ id: 'a', data: { agent: 'antigravity', agentMode: 'scoped' } })?.data.agentMode).toBe('global')
    expect(normalizeGroupAgentPresetInput({ agent: 'antigravity', agentMode: 'scoped', name: 'A', profile: 'default' })).toMatchObject({ agent: 'antigravity', agentMode: 'global' })
  })
})
