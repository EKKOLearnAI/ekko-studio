import { afterEach, expect, it, vi } from 'vitest'
import { fetchPluginMarket, fetchPluginMarketCount } from '../../packages/client/src/api/studio/plugin-market'
import { installedMarketPlugin, matchesPluginCategory, matchesPluginSearch } from '../../packages/client/src/plugins/catalog'
import type { InstalledPlugin } from '../../packages/client/src/api/studio/plugins'

const row = (index = 1) => ({ id: index.toString(16).padStart(64, '0'), name: `Plugin ${index}`, description: 'A published plugin',
  repository: `https://github.com/example/plugin-${index}`, manifestId: `plugin-${index}`, version: '1.0.0', apiVersion: 1,
  permissions: ['commands', 'tools'], sourceCommit: 'b'.repeat(40), installSource: `github:example/plugin-${index}#${'b'.repeat(40)}` })
const page = (list: unknown[], total = list.length, current = 1) => Response.json({ ok: true, data: { list, total, page: current, pageSize: 100 } })
afterEach(() => vi.unstubAllGlobals())

it.each([0, 123])('fetches the published count without entries or credentials: %s', async total => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true, data: { total } }))
  vi.stubGlobal('fetch', fetch)
  expect(await fetchPluginMarketCount(new AbortController().signal)).toBe(total)
  expect(fetch).toHaveBeenCalledOnce()
  const [url, options] = fetch.mock.calls[0]
  expect(new URL(url).pathname).toBe('/api/studio/plugins/count')
  expect(options).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', headers: { Accept: 'application/json' } })
})
it.each([{ ok: false, data: { total: 1 } }, { ok: true, data: {} }, ...[-1, 0.5, '12', null, Number.MAX_SAFE_INTEGER + 1].map(total => ({ ok: true, data: { total } }))])('rejects an invalid catalog count %j', async body => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)))
  await expect(fetchPluginMarketCount(new AbortController().signal)).rejects.toThrow('Invalid')
})
it('handles unavailable counts and propagates cancellation', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 }))
  vi.stubGlobal('fetch', fetch)
  await expect(fetchPluginMarketCount(new AbortController().signal)).rejects.toThrow('unavailable')
  fetch.mockImplementation(async (_, options) => { options.signal.throwIfAborted(); return Response.json({}) })
  const controller = new AbortController(); controller.abort()
  await expect(fetchPluginMarketCount(controller.signal)).rejects.toThrow()
})

it('keeps the plugin center usable when an installed package has invalid permission metadata', () => {
  expect(matchesPluginCategory(undefined, 'all')).toBe(true)
  expect(matchesPluginCategory(undefined, 'agents')).toBe(false)
  expect(matchesPluginCategory(['agents'], 'agents')).toBe(true)
})

it('loads every page without credentials so filtering can find entries beyond the first page', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(page(Array.from({ length: 100 }, (_, i) => row(i + 1)), 101))
    .mockResolvedValueOnce(page([{ ...row(101), permissions: ['agents'], name: 'Last agent' }], 101, 2))
  vi.stubGlobal('fetch', fetch)
  const entries = await fetchPluginMarket(new AbortController().signal)
  expect(entries).toHaveLength(101)
  expect(entries.filter(entry => matchesPluginCategory(entry.permissions, 'agents')).map(entry => entry.name)).toEqual(['Last agent'])
  expect(entries.filter(entry => matchesPluginSearch(entry, ' LAST '))).toHaveLength(1)
  expect(fetch.mock.calls.map(([url]) => new URL(url).searchParams.get('page'))).toEqual(['1', '2'])
  for (const [, options] of fetch.mock.calls) expect(options).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', headers: { Accept: 'application/json' } })
})
it('retains legacy or incompatible publications for browsing without an installable release', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(page([
    { ...row(1), version: null, manifestId: null, sourceCommit: null },
    { ...row(2), apiVersion: 2 }, { ...row(3), installSource: '/tmp/arbitrary' }, { ...row(4), version: 'latest' },
  ])))
  expect((await fetchPluginMarket(new AbortController().signal)).map(entry => entry.release)).toEqual([null, null, null, null])
})
it('keeps public authors and distinguishes zero stars from unavailable counts', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(page([
    { ...row(1), author: { name: 'Plugin Maintainer' }, repositoryStars: 0 },
    { ...row(2), repositoryStars: null }, { ...row(3), repositoryStars: '42' },
  ])))
  const entries = await fetchPluginMarket(new AbortController().signal)
  expect(entries[0].author?.name).toBe('Plugin Maintainer')
  expect(entries.map(entry => entry.repositoryStars)).toEqual([0, null, null])
})
it('does not publish a partial result if another page is unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(page(Array.from({ length: 100 }, (_, i) => row(i)), 101))
    .mockResolvedValueOnce(new Response('', { status: 503 })))
  await expect(fetchPluginMarket(new AbortController().signal)).rejects.toThrow('unavailable')
})
it('rejects a nonadvancing page and honors request cancellation', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(page([row()], 101)).mockResolvedValueOnce(page([row()], 101))
  vi.stubGlobal('fetch', fetch)
  await expect(fetchPluginMarket(new AbortController().signal)).rejects.toThrow('Invalid')
  fetch.mockImplementation(async (_, options) => { options.signal.throwIfAborted(); return page([]) })
  const controller = new AbortController(); controller.abort()
  await expect(fetchPluginMarket(controller.signal)).rejects.toThrow()
})
it('uses declared capabilities, including disabled chat commands, settings UI and Agent runtimes', () => {
  expect(matchesPluginCategory(['commands'], 'chat')).toBe(true)
  expect(matchesPluginCategory(['ui'], 'pages')).toBe(true)
  expect(matchesPluginCategory(['agents', 'ui'], 'agents')).toBe(true)
  expect(matchesPluginCategory(['agents'], 'chat')).toBe(false)
  expect(matchesPluginCategory([], 'all')).toBe(true)
})
it('marks installations by repository and manifest identity, including development installs', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(page([row()])))
  const [entry] = await fetchPluginMarket(new AbortController().signal)
  const local: InstalledPlugin = { manifest: { id: 'plugin-1', name: 'Plugin 1', repository: entry.repository, version: '2.0.0', apiVersion: 1, permissions: [] },
    source: '/local/plugin', installedAt: 0, enabled: false, status: 'disabled', config: {}, tools: [], commands: [], actions: [] }
  expect(installedMarketPlugin(entry, [local])).toBe(local)
  const development = { ...local, developmentDirectory: '/work/plugin' }
  expect(installedMarketPlugin(entry, [development])).toBe(development)
  expect(installedMarketPlugin(entry, [{ ...local, source: `github:another/plugin#${'a'.repeat(40)}` }])).toBeUndefined()
  expect(installedMarketPlugin(entry, [{ ...local, manifest: { ...local.manifest, id: 'different' } }])).toBeUndefined()
})

it('requires canonical permissions from the directory instead of accepting removed aliases', async () => {
  const { permissions, ...entry } = row(1)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(page([{ ...entry, capabilities: permissions }])))
  await expect(fetchPluginMarket(new AbortController().signal)).rejects.toThrow('Invalid plugin catalog entry')
})
