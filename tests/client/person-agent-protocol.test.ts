import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, type EffectScope } from 'vue'
import type { AvailableModelGroup } from '../../packages/client/src/api/hermes/system'
import type { CodingAgentApiMode } from '../../packages/client/src/api/coding-agents'

vi.mock('../../packages/client/src/api/client', () => ({ request: vi.fn() }))
import { useModelProtocolSelection } from '../../packages/client/src/composables/useModelProtocolSelection'

const scopes: EffectScope[] = []
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()) })

const selection = { provider: 'custom:relay', model: 'model-a' }
function group(extra: Partial<AvailableModelGroup> = {}): AvailableModelGroup {
  return { provider: selection.provider, label: 'Relay', models: ['model-a', 'model-b'], base_url: 'https://relay.invalid/v1', api_key: '', ...extra }
}
function setup() {
  const apply = vi.fn(), disabled = ref(false), scope = effectScope()
  scopes.push(scope)
  const protocol = scope.run(() => useModelProtocolSelection(apply, disabled))!
  return { protocol, apply, disabled }
}

describe('Person Agent protocol inheritance', () => {
  it.each<CodingAgentApiMode>(['chat_completions', 'codex_responses', 'anthropic_messages'])('inherits supplier %s and emits the mode without confirmation', mode => {
    const { protocol, apply } = setup()
    protocol.selectInherited(selection, undefined, group({ api_mode: mode }))
    expect(protocol.show.value).toBe(false)
    expect(apply).toHaveBeenCalledExactlyOnceWith({ ...selection, apiMode: mode })
  })

  it('uses an explicit per-model mode ahead of the supplier default', () => {
    const { protocol, apply } = setup()
    protocol.selectInherited({ ...selection, apiMode: 'codex_responses' }, undefined,
      group({ api_mode: 'chat_completions', api_mode_by_model: { 'model-a': 'codex_responses' } }))
    expect(protocol.show.value).toBe(false)
    expect(apply).toHaveBeenCalledExactlyOnceWith({ ...selection, apiMode: 'codex_responses' })
  })

  it('preserves a valid saved override when reselecting the same model', () => {
    const { protocol, apply } = setup()
    protocol.selectInherited({ ...selection, apiMode: 'chat_completions' }, { ...selection, apiMode: 'anthropic_messages' }, group({ api_mode: 'chat_completions' }))
    expect(protocol.show.value).toBe(false)
    expect(apply).toHaveBeenCalledExactlyOnceWith({ ...selection, apiMode: 'anthropic_messages' })
  })

  it('keeps a valid saved protocol even if catalog protocol metadata is missing', () => {
    const { protocol, apply } = setup()
    protocol.selectInherited(selection, { ...selection, apiMode: 'codex_responses' }, group())
    expect(protocol.show.value).toBe(false)
    expect(apply).toHaveBeenCalledExactlyOnceWith({ ...selection, apiMode: 'codex_responses' })
  })

  it('inherits a known mode when the current model has no saved protocol', () => {
    const { protocol, apply } = setup()
    protocol.selectInherited(selection, selection, group({ api_mode: 'codex_responses' }))
    expect(protocol.show.value).toBe(false)
    expect(apply).toHaveBeenCalledExactlyOnceWith({ ...selection, apiMode: 'codex_responses' })
  })

  it.each([
    { ...selection, model: 'model-b', apiMode: 'anthropic_messages' as const },
    { ...selection, provider: 'custom:other', apiMode: 'anthropic_messages' as const },
  ])('does not carry an override across a different model or provider', current => {
    const { protocol, apply } = setup()
    protocol.selectInherited(selection, current, group({ api_mode: 'codex_responses' }))
    expect(apply).toHaveBeenCalledExactlyOnceWith({ ...selection, apiMode: 'codex_responses' })
  })

  it.each([{}, { api_mode: 'codex_responses' as const, api_mode_by_model: {} },
    { api_mode: 'codex_responses' as const, api_mode_by_model: { 'model-a': null } }])('asks when protocol metadata cannot resolve this model', metadata => {
    const { protocol, apply } = setup()
    protocol.selectInherited(selection, undefined, group(metadata))
    expect(protocol.show.value).toBe(true)
    expect(apply).not.toHaveBeenCalled()
  })

  it('asks before applying a selection that conflicts with the current catalog', () => {
    const { protocol, apply } = setup()
    protocol.selectInherited({ ...selection, apiMode: 'chat_completions' }, undefined, group({ api_mode: 'codex_responses' }))
    expect(protocol.show.value).toBe(true)
    expect(protocol.apiMode.value).toBe('codex_responses')
    expect(apply).not.toHaveBeenCalled()
    protocol.confirm()
    expect(apply).toHaveBeenCalledExactlyOnceWith({ ...selection, apiMode: 'codex_responses' })
  })

  it('does not infer from an event alone when its provider group is missing', () => {
    const { protocol, apply } = setup()
    protocol.selectInherited({ ...selection, apiMode: 'codex_responses' })
    expect(protocol.show.value).toBe(true)
    expect(apply).not.toHaveBeenCalled()
  })

  it('does not automatically apply unsupported protocol values', () => {
    const { protocol, apply } = setup()
    protocol.selectInherited({ ...selection, apiMode: 'bedrock_converse' }, undefined, group({ api_mode: 'bedrock_converse' }))
    expect(protocol.show.value).toBe(true)
    expect(apply).not.toHaveBeenCalled()
  })

  it('asks before replacing an unsupported saved protocol', () => {
    const { protocol, apply } = setup()
    protocol.selectInherited(selection, { ...selection, apiMode: 'bedrock_converse' }, group({ api_mode: 'codex_responses' }))
    expect(protocol.show.value).toBe(true)
    expect(apply).not.toHaveBeenCalled()
  })

  it('cancels without committing and confirms the explicit choice', () => {
    const { protocol, apply } = setup()
    protocol.selectInherited(selection, undefined, group())
    protocol.cancel()
    protocol.confirm()
    expect(apply).not.toHaveBeenCalled()
    protocol.selectInherited(selection, undefined, group())
    protocol.apiMode.value = 'anthropic_messages'
    protocol.confirm()
    expect(apply).toHaveBeenCalledExactlyOnceWith({ ...selection, apiMode: 'anthropic_messages' })
  })

  it('cancels pending work when disabled and does not apply a known mode', async () => {
    const { protocol, apply, disabled } = setup()
    protocol.selectInherited(selection, undefined, group())
    disabled.value = true
    await nextTick()
    protocol.confirm()
    protocol.selectInherited(selection, undefined, group({ api_mode: 'codex_responses' }))
    expect(protocol.show.value).toBe(false)
    expect(apply).not.toHaveBeenCalled()
  })

  it('retains confirmation behavior for callers that do not opt into inheritance', () => {
    const { protocol, apply } = setup()
    protocol.select({ ...selection, apiMode: 'codex_responses' })
    expect(protocol.show.value).toBe(true)
    expect(apply).not.toHaveBeenCalled()
  })
})
