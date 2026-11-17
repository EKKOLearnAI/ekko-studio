import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/modules/studio/public/provider-config', () => ({}))
vi.mock('../../packages/server/src/modules/studio/public/provider-context', () => ({}))
vi.mock('../../packages/server/src/modules/hermes/services/profiles/profile', () => ({}))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}))

import { fetchProviderModels as discoverModels } from '../../packages/server/src/modules/studio/public/provider-catalog'
import { fetchProviderModels as profileModels } from '../../packages/server/src/modules/hermes/services/profiles/config'
import { fetchProviderCatalogForTest } from '../../packages/server/src/modules/hermes/services/providers/provider-editor'

const remoteFetch = vi.fn()
const baseUrl = 'https://relay.invalid/v1'
const catalogs = [
  { label: 'OpenAI data[].id', body: { data: [{ id: 'model-a' }] }, models: ['model-a'] },
  { label: 'CC-Switch models[].slug', body: { models: [null, {}, { slug: '' }, { slug: '  ' }, { slug: ' model-a ' }] }, models: ['model-a'] },
  { label: 'data before models and id before slug', body: { data: [{ id: 'model-a', slug: 'ignored' }], models: [{ slug: 'ignored' }] }, models: ['model-a'] },
  { label: 'non-array data fallback', body: { data: {}, models: [{ id: 'model-a', slug: 'ignored' }] }, models: ['model-a'] },
  { label: 'null data fallback', body: { data: null, models: [{ slug: 'model-a' }] }, models: ['model-a'] },
]

beforeEach(() => {
  remoteFetch.mockReset()
  vi.stubGlobal('fetch', remoteFetch)
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe.each([
  { label: 'Studio discovery', fetchModels: discoverModels },
  { label: 'Profile discovery', fetchModels: profileModels },
])('$label', ({ fetchModels }) => {
  it.each(catalogs)('reads $label', async ({ body, models }) => {
    remoteFetch.mockResolvedValue(Response.json(body))
    expect(await fetchModels(baseUrl, 'catalog-key')).toEqual(models)
  })

  it('keeps empty data authoritative and ignores malformed catalogs', async () => {
    for (const body of [{ data: [], models: [{ slug: 'ignored' }] }, null, {}, { models: {} }]) {
      remoteFetch.mockResolvedValue(Response.json(body))
      expect(await fetchModels(baseUrl, 'catalog-key')).toEqual([])
    }
  })

  it('keeps authentication, timeout, sorting, free filtering and Gemini prefix handling', async () => {
    remoteFetch.mockImplementation(async () => Response.json({ data: [{ id: 'models/z:free' }, { id: 'models/a:free' }, { id: 'models/paid' }] }))
    expect(await fetchModels('https://generativelanguage.googleapis.com/v1/', 'gemini-key', true)).toEqual(['a:free', 'z:free'])
    expect(remoteFetch).toHaveBeenCalledWith('https://generativelanguage.googleapis.com/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer gemini-key' }),
      signal: expect.any(AbortSignal),
    }))
    remoteFetch.mockResolvedValue(Response.json({ models: [{ slug: 'z:free' }, { slug: 'paid' }, { slug: 'a:free' }, { slug: 'a:free' }] }))
    expect(await fetchModels(baseUrl, 'catalog-key', true)).toEqual(['a:free', 'a:free', 'z:free'])
  })

  it('still returns no models for HTTP, JSON and transport failures', async () => {
    remoteFetch.mockResolvedValue(new Response('', { status: 401 }))
    expect(await fetchModels(baseUrl, 'catalog-key')).toEqual([])
    remoteFetch.mockResolvedValue(new Response('invalid JSON'))
    expect(await fetchModels(baseUrl, 'catalog-key')).toEqual([])
    remoteFetch.mockRejectedValue(new DOMException('timed out', 'TimeoutError'))
    expect(await fetchModels(baseUrl, 'catalog-key')).toEqual([])
  })
})

describe('connection test and refresh catalog probe', () => {
  it.each(catalogs)('reads $label', async ({ body, models }) => {
    remoteFetch.mockResolvedValue(Response.json(body))
    expect(await fetchProviderCatalogForTest(baseUrl, 'catalog-key', 'codex_responses')).toEqual(models)
    expect(remoteFetch).toHaveBeenCalledWith(new URL(`${baseUrl}/models`), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer catalog-key', Accept: 'application/json' }),
      redirect: 'manual', signal: expect.any(AbortSignal),
    }))
  })

  it('keeps Gemini native models/name selection, prefix removal and authentication', async () => {
    remoteFetch.mockResolvedValue(Response.json({ data: [{ id: 'ignored' }], models: [{ name: 'models/gemini-test' }, null, {}, { name: 'models/gemini-test' }] }))
    expect(await fetchProviderCatalogForTest('https://generativelanguage.googleapis.com/v1beta', 'gemini-key')).toEqual(['gemini-test'])
    expect(remoteFetch).toHaveBeenCalledWith(new URL('https://generativelanguage.googleapis.com/v1beta/models'), expect.objectContaining({
      headers: { Accept: 'application/json', 'x-goog-api-key': 'gemini-key' },
    }))
    remoteFetch.mockResolvedValue(Response.json({ data: [{ id: 'ignored' }] }))
    await expect(fetchProviderCatalogForTest('https://generativelanguage.googleapis.com/v1beta', 'gemini-key')).rejects.toMatchObject({ code: 'PROVIDER_TEST_FAILED' })
  })

  it('preserves name fallback, deduplication, order and Anthropic authentication', async () => {
    remoteFetch.mockResolvedValue(Response.json({ models: [{ slug: 'z' }, { id: 'a', slug: 'ignored' }, { name: 'legacy-name' }, { slug: 'z' }] }))
    expect(await fetchProviderCatalogForTest(baseUrl, 'anthropic-key', 'anthropic_messages')).toEqual(['z', 'a', 'legacy-name'])
    expect(remoteFetch.mock.calls[0][1].headers).toEqual({ Accept: 'application/json', 'x-api-key': 'anthropic-key', 'anthropic-version': '2023-06-01' })
  })

  it.each([
    { label: 'null', body: null, code: 'PROVIDER_TEST_FAILED' },
    { label: 'unsupported', body: { models: {} }, code: 'PROVIDER_TEST_FAILED' },
    { label: 'empty models', body: { models: [] }, code: 'PROVIDER_EMPTY_CATALOG' },
    { label: 'empty entries', body: { models: [null, {}, { slug: ' ' }] }, code: 'PROVIDER_EMPTY_CATALOG' },
    { label: 'empty data takes priority', body: { data: [], models: [{ slug: 'ignored' }] }, code: 'PROVIDER_EMPTY_CATALOG' },
  ])('rejects $label with its existing error code', async ({ body, code }) => {
    remoteFetch.mockResolvedValue(Response.json(body))
    await expect(fetchProviderCatalogForTest(baseUrl, '')).rejects.toMatchObject({ status: 422, code })
  })

  it.each([401, 404, 405])('preserves HTTP %s classification', async status => {
    remoteFetch.mockResolvedValue(new Response('', { status }))
    await expect(fetchProviderCatalogForTest(baseUrl, '')).rejects.toMatchObject({
      status: 422, code: status === 401 ? 'PROVIDER_TEST_FAILED' : 'PROVIDER_CATALOG_UNAVAILABLE',
    })
  })

  it('still rejects invalid JSON', async () => {
    remoteFetch.mockResolvedValue(new Response('invalid JSON'))
    await expect(fetchProviderCatalogForTest(baseUrl, '')).rejects.toMatchObject({ message: 'Provider returned invalid JSON', code: 'PROVIDER_TEST_FAILED' })
  })

  it('enforces the model limit before deduplication and the response byte limit', async () => {
    remoteFetch.mockResolvedValue(Response.json({ models: Array.from({ length: 10_001 }, () => ({ slug: 'same-model' })) }))
    await expect(fetchProviderCatalogForTest(baseUrl, '')).rejects.toMatchObject({ code: 'PROVIDER_MODEL_LIMIT_EXCEEDED' })
    remoteFetch.mockResolvedValue(Response.json({ models: [{ slug: 'x'.repeat(2 * 1024 * 1024) }] }))
    await expect(fetchProviderCatalogForTest(baseUrl, '')).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_TOO_LARGE' })
  })

  it('keeps the eight-second timeout', async () => {
    vi.useFakeTimers()
    remoteFetch.mockImplementation((_url: URL, { signal }: RequestInit) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const result = expect(fetchProviderCatalogForTest(baseUrl, '')).rejects.toMatchObject({ code: 'PROVIDER_TEST_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(8000)
    await result
  })

  it('follows same-origin redirects and retains credentials for the compatible catalog', async () => {
    remoteFetch.mockResolvedValueOnce(new Response('', { status: 302, headers: { location: '/catalog' } }))
      .mockResolvedValueOnce(Response.json({ models: [{ slug: 'model-a' }] }))
    expect(await fetchProviderCatalogForTest(baseUrl, 'catalog-key')).toEqual(['model-a'])
    expect(remoteFetch.mock.calls[1][0]).toEqual(new URL('https://relay.invalid/catalog'))
    expect(remoteFetch.mock.calls[1][1].headers.Authorization).toBe('Bearer catalog-key')
  })

  it.each(['https://other.invalid/models', 'http://relay.invalid/models'])('rejects redirect to %s', async location => {
    remoteFetch.mockResolvedValue(new Response('', { status: 302, headers: { location } }))
    await expect(fetchProviderCatalogForTest(baseUrl, 'catalog-key')).rejects.toMatchObject({ code: 'PROVIDER_REDIRECT_REJECTED' })
    expect(remoteFetch).toHaveBeenCalledTimes(1)
  })

  it('still rejects a redirect loop after three redirects', async () => {
    remoteFetch.mockImplementation(async () => new Response('', { status: 302, headers: { location: '/again' } }))
    await expect(fetchProviderCatalogForTest(baseUrl, 'catalog-key')).rejects.toMatchObject({ code: 'PROVIDER_REDIRECT_REJECTED' })
    expect(remoteFetch).toHaveBeenCalledTimes(4)
  })
})
