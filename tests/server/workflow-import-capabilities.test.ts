import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import { assertWorkflowImportCapabilities, workflowImportEnvironmentRevision } from '../../packages/server/src/modules/studio/services/workflow/import-capabilities'

const node = (data: Record<string, unknown>) => ({ id: 'agent', type: 'agent', data: { agent: 'hermes', ...data } })

describe('workflow import capabilities', () => {
  it('validates Hermes targets by provider and model while leaving api mode profile-owned', () => {
    const groups = [{ provider: 'custom:test', models: ['model-a'], api_mode: 'codex_responses' }]
    expect(() => assertWorkflowImportCapabilities([node({ provider: 'custom:test', model: 'model-a', apiMode: 'codex_responses' })], groups)).not.toThrow()
    expect(() => assertWorkflowImportCapabilities([node({ provider: 'custom:test', model: 'model-b', apiMode: 'codex_responses' })], groups)).toThrow('unavailable')
    expect(() => assertWorkflowImportCapabilities([node({ provider: 'custom:test', model: 'model-a', apiMode: 'chat_completions' })], groups)).not.toThrow()
    expect(() => assertWorkflowImportCapabilities([node({ provider: 'custom:test', model: 'model-a', apiMode: 'codex_responses' })], [{ provider: 'custom:test', models: ['model-a'] }])).not.toThrow()
  })

  it.each(['openai-codex', 'xai-oauth'])(
    'accepts Hermes provider %s when its catalog omits api mode',
    (provider) => {
      expect(() => assertWorkflowImportCapabilities([
        node({ provider, model: 'model-a', apiMode: 'codex_responses' }),
      ], [{ provider, models: ['model-a'] }])).not.toThrow()
    },
  )

  it('accepts scoped Coding Agent protocol overrides for a configured provider and model', () => {
    const groups = [{ provider: 'custom:test', models: ['model-a'], api_mode: 'chat_completions' }]

    expect(() => assertWorkflowImportCapabilities([
      node({ agent: 'codex', provider: 'custom:test', model: 'model-a', apiMode: 'codex_responses' }),
      node({ agent: 'claude-code', provider: 'custom:test', model: 'model-a', apiMode: 'anthropic_messages' }),
    ], groups)).not.toThrow()
  })

  it('accepts Ekko protocol overrides and server-managed auth providers', () => {
    expect(() => assertWorkflowImportCapabilities([
      node({ agent: 'ekko-agent', provider: 'openai-codex', model: 'model-a', apiMode: 'chat_completions' }),
    ], [{ provider: 'openai-codex', models: ['model-a'], api_mode: 'codex_responses' }])).not.toThrow()
  })

  it('keeps Ekko targets fail closed for missing models and unsupported protocols', () => {
    const groups = [{ provider: 'openai-codex', models: ['model-a'], api_mode: 'codex_responses' }]

    expect(() => assertWorkflowImportCapabilities([
      node({ agent: 'ekko-agent', provider: 'openai-codex', model: 'model-b', apiMode: 'codex_responses' }),
    ], groups)).toThrow('unavailable')
    expect(() => assertWorkflowImportCapabilities([
      node({ agent: 'ekko-agent', provider: 'openai-codex', model: 'model-a', apiMode: 'bedrock_converse' }),
    ], groups)).toThrow('unavailable')
  })

  it('keeps scoped Coding Agent targets fail closed for missing models and unsupported protocols', () => {
    const groups = [{ provider: 'custom:test', models: ['model-a'], api_mode: 'chat_completions' }]

    expect(() => assertWorkflowImportCapabilities([
      node({ agent: 'codex', provider: 'custom:test', model: 'model-b', apiMode: 'codex_responses' }),
    ], groups)).toThrow('unavailable')
    expect(() => assertWorkflowImportCapabilities([
      node({ agent: 'claude-code', provider: 'custom:test', model: 'model-a', apiMode: 'bedrock_converse' }),
    ], groups)).toThrow('unavailable')
  })

  it('does not require profile provider/model capabilities for supported global CLI nodes', () => {
    expect(() => assertWorkflowImportCapabilities([
      node({ agent: 'codex', agentMode: 'global' }),
      node({ agent: 'claude-code', agentMode: 'global' }),
      node({ agent: 'pi', agentMode: 'global' }),
    ], [])).not.toThrow()
  })

  it.each(['qwen', 'kimi', 'codebuddy', 'qoder', 'copilot', 'zcode'])('validates %s scoped models while allowing explicit global mode', agent => {
    expect(() => assertWorkflowImportCapabilities([node({ agent, agentMode: 'global' })], [])).not.toThrow()
    const target = node({ agent, agentMode: 'scoped', provider: 'custom:test', model: 'model-a', apiMode: 'codex_responses' })
    expect(() => assertWorkflowImportCapabilities([target], [{ provider: 'custom:test', models: ['model-a'], api_mode: 'chat_completions' }])).not.toThrow()
    if (agent !== 'qoder') expect(() => assertWorkflowImportCapabilities([target], [])).toThrow('unavailable')
  })

  it.each(['openai-codex', 'copilot', 'xai-oauth', 'qwen-oauth', 'nous', 'claude-oauth', 'minimax-oauth'])(
    'rejects scoped Coding Agent targets backed by auth provider %s',
    (provider) => {
      expect(() => assertWorkflowImportCapabilities([
        node({ agent: 'codex', provider, model: 'model-a', apiMode: 'codex_responses' }),
      ], [{ provider, models: ['model-a'], api_mode: 'codex_responses' }])).toThrow('unavailable')
    },
  )

  it('allows runtime-default nodes and revisions change with any target capability', () => {
    expect(() => assertWorkflowImportCapabilities([node({})], [])).not.toThrow()
    const one = workflowImportEnvironmentRevision([{ provider: 'p', models: ['a'], api_mode: 'chat_completions' }])
    const reordered = workflowImportEnvironmentRevision([{ provider: 'p', models: ['a'], api_mode: 'chat_completions' }])
    const changed = workflowImportEnvironmentRevision([{ provider: 'p', models: ['b'], api_mode: 'chat_completions' }])
    expect(one).toBe(reordered)
    expect(changed).not.toBe(one)
    const expected = createHash('sha256').update(JSON.stringify({ models: ['p\u0000a\u0000chat_completions'] })).digest('hex')
    expect(one).toBe(expected)
  })



})
