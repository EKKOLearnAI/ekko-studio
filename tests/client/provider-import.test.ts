import { describe, expect, it } from 'vitest'
import { captureProviderImport, parseProviderImport, pendingProviderImport } from '@/utils/provider-import'
import { loadLocaleMessages, supportedLocales } from '@/i18n/messages'

const draft = { version: 1, name: 'Example Relay', baseUrl: 'https://relay.example/v1', model: 'example-model', apiKey: 'fixture-key' }
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

describe('provider import payload', () => {
  it.each(supportedLocales)('provides the import confirmation and error text in %s', async locale => {
    const messages = await loadLocaleMessages(locale)
    for (const key of ['importTitle', 'importNotice', 'importConfirm', 'importInvalid', 'importRequired', 'importDuplicate', 'importFailed']) {
      expect(messages.models[key], `${locale}: ${key}`).toBeTypeOf('string')
      expect(messages.models[key].trim()).not.toBe('')
    }
  })
  it('supports UTF-8 and an omitted key without accepting configuration beyond the import contract', () => {
    expect(parseProviderImport(encode({ ...draft, name: '示例模型', apiKey: undefined })))
      .toEqual({ ...draft, name: '示例模型', apiKey: '', apiMode: 'chat_completions' })
  })
  it('accepts a minimal draft for user-driven completion without inventing a model', () => {
    const result = parseProviderImport(encode({ version: 1, baseUrl: draft.baseUrl, apiKey: draft.apiKey }))
    expect(result.name).toBe('')
    expect(result.model).toBe('')
  })
  it.each(['chat_completions', 'codex_responses', 'anthropic_messages', 'auto'])('preserves explicit %s protocol', apiMode => {
    expect(parseProviderImport(encode({ ...draft, apiMode })).apiMode).toBe(apiMode)
  })
  it.each([
    { version: 2 }, { baseUrl: 'javascript:alert(1)' }, { baseUrl: 'file:///tmp/config' },
    { baseUrl: 'https://user:secret@relay.example/v1' }, { baseUrl: 'https://relay.example/v1?key=secret' },
    { baseUrl: 'https://relay.example/v1#secret' }, { name: '' }, { name: '__proto__' },
    { model: 'm\ninjected' }, { apiKey: 'key\r\nAuthorization: other' },
    { apiMode: 'shell' }, { profile: 'other' }, { command: 'touch /tmp/unwanted' },
    { replace: true }, { apiKey: 'k'.repeat(8193) },
  ])('rejects unsafe or ambiguous fields: %j', patch => {
    expect(() => parseProviderImport(encode({ ...draft, ...patch }))).toThrow()
  })
  it.each([null, [], '', 'not/base64', 'A'.repeat(32769), 'wA', encode(null), encode([])])('rejects malformed input', value => {
    expect(() => parseProviderImport(value)).toThrow()
  })
  it('retains a pending import only in memory, and does not expose malformed data in its error state', () => {
    captureProviderImport(encode(draft))
    expect(pendingProviderImport.value?.draft?.apiKey).toBe('fixture-key')
    captureProviderImport('invalid.secret-key')
    expect(pendingProviderImport.value).toEqual({ invalid: true })
    pendingProviderImport.value = null
  })
})
