// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useModelProtocolSelection } from '../../packages/client/src/composables/useModelProtocolSelection'

describe('model protocol confirmation', () => {
  function setup() {
    const apply = vi.fn()
    const disabled = ref(false)
    const scope = effectScope()
    const choice = scope.run(() => useModelProtocolSelection(apply, disabled))!
    return { choice, apply, disabled, scope }
  }
  it('keeps each model protocol independent within a shared provider', () => {
    const { choice, apply, scope } = setup()
    const gpt = { provider: 'shared', model: 'gpt', apiMode: 'codex_responses' as const }
    choice.select(gpt)
    expect(apply).not.toHaveBeenCalled()
    expect(choice.apiMode.value).toBe('codex_responses')
    choice.confirm()
    expect(apply).toHaveBeenLastCalledWith(gpt)
    choice.select({ provider: 'shared', model: 'opus', apiMode: 'chat_completions' }, gpt)
    expect(choice.apiMode.value).toBe('chat_completions')
    choice.apiMode.value = 'anthropic_messages'
    choice.confirm()
    expect(apply).toHaveBeenLastCalledWith({ provider: 'shared', model: 'opus', apiMode: 'anthropic_messages' })
    scope.stop()
  })
  it('reopens the saved override and discards cancellation without applying a model', () => {
    const { choice, apply, scope } = setup()
    const current = { provider: 'shared', model: 'opus', apiMode: 'anthropic_messages' as const }
    choice.select({ ...current, apiMode: 'chat_completions' }, current)
    expect(choice.apiMode.value).toBe('anthropic_messages')
    choice.apiMode.value = 'codex_responses'
    choice.cancel(); choice.confirm()
    expect(choice.show.value).toBe(false)
    expect(apply).not.toHaveBeenCalled()
    scope.stop()
  })
  it('cancels a pending choice when switching becomes disabled', async () => {
    const { choice, apply, disabled, scope } = setup()
    choice.select({ provider: 'p', model: 'm' })
    disabled.value = true
    choice.confirm()
    await nextTick()
    expect(choice.show.value).toBe(false)
    disabled.value = false
    choice.confirm()
    expect(apply).not.toHaveBeenCalled()
    scope.stop()
  })
})
