import { describe, expect, it } from 'vitest'
import {
  normalizeProviderExtraHeaders,
  normalizeProviderProxyUrl,
} from '../../packages/server/src/modules/studio/contracts/provider-request-options'
import { getCompatibleCustomProviders } from '../../packages/server/src/modules/studio/contracts/provider-compat'

describe('provider request options', () => {
  it('normalizes header names and applies case-insensitive last-value wins', () => {
    expect(normalizeProviderExtraHeaders({
      'User-Agent': 'first', 'user-agent': 'second', 'X-Custom': 'value',
    })).toEqual({ 'user-agent': 'second', 'x-custom': 'value' })
  })

  it.each([
    { 'bad header': 'value' },
    { 'x-test': 'line\r\nInjected: value' },
    { 'x-test': '\0' },
    { 'x-test': 123 },
    { 'x-test': '\u4e2d\u6587' },
    { Authorization: 'not-the-provider-key' },
    { 'X-Api-Key': 'not-the-provider-key' },
    { 'X-Goog-Api-Key': 'not-the-provider-key' },
    { 'Proxy-Authorization': 'must-not-reach-upstream' },
    { Host: 'other.example' },
    { 'Content-Type': 'text/plain' },
    { 'Content-Length': '0' },
    { 'Transfer-Encoding': 'chunked' },
    { Connection: 'keep-alive' },
    { 'Accept-Encoding': 'unsupported' },
    { 'x-test': 'x'.repeat(65_536) },
  ])('rejects invalid or transport-owned headers (case %#)', headers => {
    expect(() => normalizeProviderExtraHeaders(headers)).toThrow()
  })

  it('handles prototype-like header names as ordinary own properties', () => {
    const headers = normalizeProviderExtraHeaders(JSON.parse('{"__proto__":"value"}'))
    expect(Object.hasOwn(headers, '__proto__')).toBe(true)
    expect(headers.__proto__).toBe('value')
  })

  it.each([
    ['localhost:8080', 'http://localhost:8080'],
    [' http://localhost:8080/ ', 'http://localhost:8080'],
    ['https://user:p%40ss@proxy.example:8443', 'https://user:p%40ss@proxy.example:8443'],
    ['http://[::1]:8080', 'http://[::1]:8080'],
    ['', undefined],
    [null, undefined],
  ])('normalizes proxy %s', (input, output) => {
    expect(normalizeProviderProxyUrl(input)).toBe(output)
  })

  it.each([
    'socks5://proxy.example:1080',
    'http://proxy.example/path',
    'http://proxy.example?query=1',
    'http://proxy.example#fragment',
    'http://proxy.example:0',
    'http://proxy.example:70000',
    'http://user:%ZZ@proxy.example',
    'http://proxy.example\r\n',
    false,
  ])('rejects malformed proxies without echoing credentials', input => {
    expect(() => normalizeProviderProxyUrl(input)).toThrow('Proxy')
  })

  it('keeps networking fields and aliases in both provider schemas', () => {
    const [legacy, modern] = getCompatibleCustomProviders({
      custom_providers: [{
        name: 'legacy', base_url: 'https://legacy.example', preserve_client_identity: false,
        proxy_url: 'http://localhost:8080', extra_headers: { 'User-Agent': 'custom' },
      }],
      providers: {
        modern: {
          baseUrl: 'https://modern.example', preserveClientIdentity: true,
          proxyUrl: 'localhost:8081', extraHeaders: { 'X-Custom': 'test' },
        },
      },
    })
    expect(legacy).toMatchObject({
      preserve_client_identity: false, proxy_url: 'http://localhost:8080',
      extra_headers: { 'user-agent': 'custom' },
    })
    expect(modern).toMatchObject({
      preserve_client_identity: true, proxy_url: 'localhost:8081',
      extra_headers: { 'x-custom': 'test' },
    })
  })
})
