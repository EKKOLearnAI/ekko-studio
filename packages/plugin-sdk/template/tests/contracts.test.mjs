import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../server.mjs'

function setup() {
  const methods = new Map(), records = new Map()
  apply({ extensions: { rpc: { register(name, fn) { methods.set(name, fn); return () => methods.delete(name) } } }, state: { plugin: {
    namespace(...parts) { const key = JSON.stringify(parts); return {
      async get(name) { return records.get(key + name) }, async set(name, value) { records.set(key + name, value) },
    } },
  } } })
  const call = (name, input, userId = 1) => methods.get(name)(input, { identity: { userId, profile: 'default' } })
  return { call, records }
}
test('reads defaults, saves validated settings, and isolates users', async () => {
  const { call } = setup()
  assert.deepEqual(await call('get-settings', null), { greeting: 'Hello', compact: false })
  assert.deepEqual(await call('save-settings', { greeting: 'Hi', compact: true }), { ok: true })
  assert.deepEqual(await call('get-settings', null), { greeting: 'Hi', compact: true })
  assert.deepEqual(await call('get-settings', null, 2), { greeting: 'Hello', compact: false })
})
test('rejects invalid inputs and invalid stored output', async () => {
  const { call, records } = setup()
  await assert.rejects(call('save-settings', { greeting: 123, compact: false }), /expected string/)
  await assert.rejects(call('save-settings', { greeting: 'Hi', compact: false, extra: true }), /unknown property/)
  await assert.rejects(call('get-settings', {}), /expected null/)
  records.set(JSON.stringify(['1', 'default']) + 'settings', { greeting: 'missing compact' })
  await assert.rejects(call('get-settings', null), /missing compact/)
})
