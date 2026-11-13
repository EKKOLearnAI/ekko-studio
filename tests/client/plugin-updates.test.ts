import { afterEach, expect, it, vi } from 'vitest'
import { fetchPluginRelease, normalizePluginRepository, repositoryStars, type PluginRelease } from '../../packages/client/src/api/studio/plugin-releases'
import { availablePluginUpdate, comparePluginVersions, installedPluginRepository, pluginRepository, pluginUpdateState, pluginInstallationKind, publishedPluginAction, samePluginInstallation } from '../../packages/client/src/plugins/updates'
import type { InstalledPlugin } from '../../packages/client/src/api/studio/plugins'

const repository = 'https://github.com/example/notes'
const release: PluginRelease = { id: 'a'.repeat(64), repository, manifestId: 'notes', version: '1.10.0', apiVersion: 1,
  sourceCommit: 'b'.repeat(40), installSource: 'github:example/notes#' + 'b'.repeat(40) }
const plugin = (): InstalledPlugin => ({ manifest: { id: 'notes', name: 'Notes', version: '1.9.0', apiVersion: 1, permissions: [], repository },
  source: 'github:Example/Notes#' + 'c'.repeat(40), installedAt: 0, enabled: true, status: 'active', config: {}, tools: [], commands: [], actions: [] })
afterEach(() => vi.unstubAllGlobals())

it('reads only the matching public repository without transmitting local credentials', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true, data: { list: [release] } })); vi.stubGlobal('fetch', fetch)
  expect(await fetchPluginRelease('https://github.com/Example/Notes.git/')).toEqual(release)
  const [url, options] = fetch.mock.calls[0]
  expect(new URL(url).searchParams.get('repository')).toBe(repository)
  expect(options).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', headers: { Accept: 'application/json' } })
  expect(options.headers).not.toHaveProperty('Authorization')
})
it('accepts an empty directory or a legacy entry without release metadata', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ ok: true, data: { list: [] } }))
    .mockResolvedValueOnce(Response.json({ ok: true, data: { list: [{ id: release.id, repository }] } }))
  vi.stubGlobal('fetch', fetch)
  expect(await fetchPluginRelease(repository)).toBeNull()
  expect(await fetchPluginRelease(repository)).toBeNull()
})
it.each([{ repository: 'https://github.com/other/notes' }, { installSource: '/tmp/malicious' }, { sourceCommit: 'main' }, { apiVersion: 2 }])('rejects a mismatched or mutable release %j', async change => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ok: true, data: { list: [{ ...release, ...change }] } })))
  await expect(fetchPluginRelease(repository)).rejects.toThrow()
})
it.each([['1.10.0', '1.9.0', 1], ['1.0.0', '1.0.0-rc.1', 1], ['1.0.0-beta.10', '1.0.0-beta.2', 1], ['1.0.0-alpha', '1.0.0-beta', -1], ['1.0.0', '1.0.0', 0], ['latest', '1.0.0', null]])('compares %s and %s', (a, b, expected) => {
  expect(comparePluginVersions(a, b)).toBe(expected)
})
it('matches repository and manifest identity and prefers the actual installation source', () => {
  expect(availablePluginUpdate(plugin(), release)).toBe(release)
  expect(availablePluginUpdate({ ...plugin(), manifest: { ...plugin().manifest, repository: 'https://github.com/other/repo' } }, release)).toBe(release)
  expect(availablePluginUpdate(plugin(), { ...release, manifestId: 'different' })).toBeUndefined()
  expect(availablePluginUpdate(plugin(), { ...release, version: '1.8.0' })).toBeUndefined()
  expect(availablePluginUpdate(plugin(), { ...release, version: '1.9.0' })).toBeUndefined()
  expect(availablePluginUpdate({ ...plugin(), developmentDirectory: '/work/notes' }, release)).toBeUndefined()
  expect(installedPluginRepository({ ...plugin(), source: 'git+https://gitlab.com/team/notes.git#' + 'a'.repeat(40) })).toBe('https://gitlab.com/team/notes')
})
it('normalizes repository identities and refuses unsupported or credential-bearing locations', () => {
  expect(normalizePluginRepository('https://GITHUB.com/Example/Notes.GIT/')).toBe(repository)
  for (const url of ['https://github.com.evil.test/a/b', 'https://user:pass@github.com/a/b', 'https://github.com/a/b#main', 'https://github.com/a/b/blob/main', '/tmp/plugin']) expect(normalizePluginRepository(url)).toBeNull()
})
it.each([[0, 0], [12345, 12345], [4_294_967_295, 4_294_967_295], [null, null], [undefined, null], [-1, null], [1.5, null], ['12', null], [4_294_967_296, null]])('validates the cached repository star count %s', (input, expected) => {
  expect(repositoryStars(input, repository)).toBe(expected)
})
it('only displays GitHub star metadata and preserves zero through release parsing', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ok: true, data: { list: [{ ...release, repositoryStars: 0 }] } })))
  expect((await fetchPluginRelease(repository))?.repositoryStars).toBe(0)
  expect(repositoryStars(8, 'https://gitlab.com/example/notes')).toBeNull()
  expect(repositoryStars(8, 'http://github.com/example/notes')).toBe(8)
})
it('distinguishes available, current and unknown updates without treating failed checks as current', () => {
  expect(pluginUpdateState(plugin(), release)).toBe('available')
  expect(pluginUpdateState(plugin(), { ...release, version: '1.9.0' })).toBe('current')
  expect(pluginUpdateState(plugin(), { ...release, version: '1.8.0' })).toBe('ahead')
  expect(pluginUpdateState(plugin(), { ...release, version: '1.9.0' }, false, true)).toBe('unknown')
  expect(pluginUpdateState(plugin(), { ...release, manifestId: 'another' })).toBe('unknown')
  expect(pluginUpdateState(plugin(), { ...release, repository: 'https://github.com/other/notes' })).toBe('unknown')
  expect(pluginUpdateState(plugin())).toBe('unknown')
  expect(pluginUpdateState(plugin(), undefined, true)).toBe('checking')
  expect(pluginUpdateState(plugin(), release, false, true)).toBe('available')
})
it('distinguishes retained local snapshots from released packages and explicitly switches instead of upgrading backwards', () => {
  const local = { ...plugin(), source: '/projects/notes', manifest: { ...plugin().manifest, version: '0.1.6' } }
  const published = { ...release, version: '0.1.4' }
  expect(pluginInstallationKind(local)).toBe('local')
  expect(pluginInstallationKind({ ...local, source: 'C:\\projects\\notes' })).toBe('local')
  expect(pluginInstallationKind({ ...local, source: '\\\\server\\notes' })).toBe('local')
  expect(pluginUpdateState(local, published)).toBe('ahead')
  expect(pluginUpdateState(local, release)).toBe('local')
  expect(availablePluginUpdate(local, release)).toBeUndefined()
  expect(publishedPluginAction(local, published)).toBe('switch')
  expect(publishedPluginAction({ ...local, developmentDirectory: local.source }, published)).toBe('switch')
  expect(publishedPluginAction({ ...local, source: plugin().source }, published)).toBeUndefined()
  expect(publishedPluginAction(undefined, published)).toBe('install')
  expect(publishedPluginAction(plugin(), release)).toBe('upgrade')
  expect(publishedPluginAction({ ...plugin(), status: 'failed' }, { ...release, version: '1.9.0' })).toBe('reinstall')
  expect(publishedPluginAction(local, { ...published, manifestId: 'other' })).toBeUndefined()
  expect(publishedPluginAction(local, { ...published, repository: 'https://github.com/other/repo' })).toBeUndefined()
})
it('rejects stale operations even when a different installation has the same version', () => {
  expect(samePluginInstallation(plugin(), { ...plugin() })).toBe(true)
  expect(samePluginInstallation(plugin(), { ...plugin(), installedAt: 42 })).toBe(false)
  expect(samePluginInstallation(plugin(), { ...plugin(), source: '/project/notes' })).toBe(false)
  expect(samePluginInstallation(plugin(), undefined)).toBe(false)
  expect(samePluginInstallation(undefined, undefined)).toBe(true)
})
it('shows metadata for development sources while leaving upgrades disabled and local-only sources manual', () => {
  const development = { ...plugin(), developmentDirectory: '/work/plugin' }
  expect(pluginRepository(development)).toBe(repository)
  expect(installedPluginRepository(development)).toBeNull()
  expect(pluginUpdateState(development, release)).toBe('development')
  expect(pluginUpdateState({ ...plugin(), source: '/local/notes', manifest: { ...plugin().manifest, repository: undefined } })).toBe('manual')
})
