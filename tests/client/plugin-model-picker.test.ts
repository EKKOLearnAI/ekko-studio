import { afterEach, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('../../packages/client/src/api/hermes/system', () => ({ fetchAvailableModelsForProfile: mocks.fetch }))
import { usePluginModelPicker } from '../../packages/client/src/composables/usePluginModelPicker'

const catalog = () => ({ groups: [{ provider: 'custom:test', label: 'Test', models: ['disabled', 'canonical'], api_key: 'private-key', base_url: 'https://private.invalid',
  api_mode: 'chat_completions', api_mode_by_model: { canonical: 'codex_responses' }, model_meta: { disabled: { disabled: true }, canonical: { alias: 'Friendly' } } }],
  custom_models: { 'custom:test': ['custom-model'] }, model_aliases: {} })
const scopes: ReturnType<typeof effectScope>[] = []
function setup() {
  const scope = effectScope(); scopes.push(scope)
  return scope.run(usePluginModelPicker)!
}
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); vi.resetAllMocks() })

it('returns only the bound Profile and canonical model reference, with the configured per-model protocol', async () => {
  mocks.fetch.mockResolvedValue(catalog())
  const picker = setup(), signal = new AbortController().signal
  const selected = picker.open('team', { current: { provider: 'custom:test', model: 'canonical' } }, signal)
  await vi.waitFor(() => expect(picker.request.value?.profile).toBe('team'))
  expect(mocks.fetch).toHaveBeenCalledWith('team', expect.any(AbortSignal))
  expect(picker.displayName('canonical', 'custom:test')).toBe('Friendly')
  picker.choose({ provider: 'other', model: 'canonical' })
  picker.choose({ provider: 'custom:test', model: 'disabled' })
  expect(picker.request.value).not.toBeNull()
  picker.choose({ provider: 'custom:test', model: 'canonical' })
  await expect(selected).resolves.toEqual({ profile: 'team', provider: 'custom:test', model: 'canonical', apiMode: 'codex_responses' })
  expect(picker.request.value).toBeNull()
})

it('supports cancellation and Profile-local custom models without changing the application selection', async () => {
  mocks.fetch.mockResolvedValue(catalog())
  const picker = setup(), signal = new AbortController().signal
  const cancelled = picker.open('default', {}, signal)
  picker.cancel()
  await expect(cancelled).resolves.toBeNull()
  const custom = picker.open('team', {}, signal)
  await vi.waitFor(() => expect(picker.request.value?.profile).toBe('team'))
  picker.choose({ provider: 'custom:test', model: 'custom-model' })
  await expect(custom).resolves.toEqual({ profile: 'team', provider: 'custom:test', model: 'custom-model' })
})

it('rejects overlapping calls and ignores a catalog that arrives after its view is closed', async () => {
  let release!: (value: unknown) => void
  mocks.fetch.mockImplementation(() => new Promise(resolve => { release = resolve }))
  const picker = setup(), controller = new AbortController()
  const selected = picker.open('first', {}, controller.signal)
  await expect(picker.open('second', {}, controller.signal)).rejects.toThrow('already open')
  controller.abort()
  await expect(selected).resolves.toBeNull()
  release(catalog())
  await Promise.resolve()
  expect(picker.request.value).toBeNull()
  expect(mocks.fetch.mock.calls[0][1].aborted).toBe(true)
})

it('propagates catalog errors, permits retry and settles a pending choice on unmount', async () => {
  mocks.fetch.mockRejectedValueOnce(new Error('Profile access denied')).mockResolvedValue(catalog())
  const picker = setup(), signal = new AbortController().signal
  await expect(picker.open('team', {}, signal)).rejects.toThrow('Profile access denied')
  const retry = picker.open('team', {}, signal)
  await vi.waitFor(() => expect(picker.request.value).not.toBeNull())
  scopes[0].stop()
  await expect(retry).resolves.toBeNull()
  await expect(picker.open('team', { current: { provider: 1, model: 'x' } } as any, signal)).rejects.toThrow('Invalid model picker options')
})
