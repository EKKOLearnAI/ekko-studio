const { test } = require('node:test')
const assert = require('node:assert/strict')
const { providerImportPayload, providerImportFromArgs, providerImportTarget } = require('../dist/main/provider-import.js')

const data = Buffer.from(JSON.stringify({ version: 1, name: 'Relay', baseUrl: 'https://relay.example/v1', model: 'm' })).toString('base64url')
const link = `ekko-studio://import/provider?data=${data}`

test('reads the same import payload from initial launch and second-instance arguments', () => {
  assert.equal(providerImportPayload(link), data)
  assert.equal(providerImportFromArgs(['studio.exe', '--hidden', link]), data)
  assert.equal(providerImportFromArgs(['studio.exe', 'ordinary-file']), null)
})
test('rejects other schemes, actions, credentials, duplicates and extra parameters', () => {
  for (const value of [
    'ccswitch://import/provider?data=abc', 'ekko-studio://run/command?data=abc',
    'ekko-studio://user@import/provider?data=abc', `${link}&data=abc`,
    `${link}&redirect=https://other.example`, `${link}#secret`,
    'ekko-studio://import/provider?data=' + 'a'.repeat(32769),
    'ekko-studio://import/provider?data=bad/value',
  ]) assert.equal(providerImportPayload(value), null)
})
test('routes imports only to the configured service and preserves a remote base path', () => {
  const result = new URL(providerImportTarget('https://studio.example/subpath/', data))
  assert.equal(result.origin, 'https://studio.example')
  assert.equal(result.pathname, '/subpath/')
  assert.equal(result.search, '')
  assert.equal(result.hash, `#/hermes/models?importProvider=${data}`)
  assert.throws(() => providerImportTarget('file:///tmp/config', data))
  assert.throws(() => providerImportTarget('https://studio.example', 'bad/route'))
})
