import { afterEach, expect, it } from 'vitest'
import { effectScope } from 'vue'
import { usePluginWorkspacePicker } from '../../packages/client/src/composables/usePluginWorkspacePicker'

const scopes: ReturnType<typeof effectScope>[] = []
function setup() {
  const scope = effectScope(); scopes.push(scope)
  return scope.run(usePluginWorkspacePicker)!
}
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))

it('returns only the chosen directory and the owning view Profile, preserving native paths', async () => {
  const picker = setup(), signal = new AbortController().signal
  const choice = picker.open('team', { current: ' /projects/old ' }, signal)
  expect(picker.request.value).toEqual({ profile: 'team', current: '/projects/old' })
  picker.choose('  C:\\Projects\\Notes  ')
  await expect(choice).resolves.toEqual({ profile: 'team', workspace: 'C:\\Projects\\Notes' })
  expect(picker.request.value).toBeNull()
  picker.choose('/projects/late')
  expect(picker.request.value).toBeNull()
})

it('rejects concurrent calls and permits retry after cancellation', async () => {
  const picker = setup(), signal = new AbortController().signal
  const first = picker.open('default', {}, signal)
  await expect(picker.open('other', {}, signal)).rejects.toThrow('already open')
  picker.cancel()
  await expect(first).resolves.toBeNull()
  const retry = picker.open('other', {}, signal)
  picker.choose('/projects/new')
  await expect(retry).resolves.toEqual({ profile: 'other', workspace: '/projects/new' })
})

it('settles on view abort and ignores a stale view abort after a new request opens', async () => {
  const picker = setup(), first = new AbortController(), second = new AbortController()
  const cancelled = picker.open('first', {}, first.signal)
  picker.cancel()
  await expect(cancelled).resolves.toBeNull()
  const next = picker.open('second', {}, second.signal)
  first.abort()
  expect(picker.request.value?.profile).toBe('second')
  second.abort()
  await expect(next).resolves.toBeNull()
  await expect(picker.open('second', {}, second.signal)).resolves.toBeNull()
  expect(picker.request.value).toBeNull()
})

it('settles pending choices when the component scope is destroyed', async () => {
  const picker = setup()
  const choice = picker.open('team', {}, new AbortController().signal)
  scopes[0].stop()
  await expect(choice).resolves.toBeNull()
  expect(picker.request.value).toBeNull()
})

it('rejects malformed options and keeps empty or malformed selections from completing the request', async () => {
  const picker = setup(), signal = new AbortController().signal
  for (const options of [null, [], { current: 3 }, { current: null }, { current: '\0' }, { current: 'a'.repeat(4097) }]) {
    await expect(picker.open('team', options as any, signal)).rejects.toThrow('Invalid workspace picker options')
  }
  const choice = picker.open('team', {}, signal)
  for (const value of ['', '  ', '\0', 'a'.repeat(4097), null]) picker.choose(value as any)
  expect(picker.request.value).not.toBeNull()
  picker.cancel()
  await expect(choice).resolves.toBeNull()
})
