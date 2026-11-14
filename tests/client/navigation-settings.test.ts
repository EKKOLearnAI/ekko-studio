import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defaultNavigationSettings, validateNavigationSettings } from '../../packages/shared/navigation-settings'
import { navigationCatalog, reorderNavigationEntries, selectedNavigationEntries } from '../../packages/client/src/utils/navigation-entries'
import type { InstalledPlugin } from '../../packages/client/src/api/studio/plugins'
import { invalidateAuth } from '../../packages/client/src/api/auth-invalidation'

const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), user: 1 }))
vi.mock('../../packages/client/src/api/client', () => ({ getBaseUrl: () => '', getStoredUserId: () => mocks.user }))
vi.mock('../../packages/client/src/api/studio/navigation', () => ({ getNavigationSettings: mocks.get, saveNavigationSettings: mocks.save }))
import { useNavigationStore } from '../../packages/client/src/stores/navigation'

const plugin = (id: string, navigation?: InstalledPlugin['manifest']['navigation'], status = 'active') => ({
  manifest: { id, name: id, views: [{ id: 'home', title: 'Home', slot: 'page' }], navigation }, status,
}) as InstalledPlugin

it('offers only active explicit main registrations and never opts them in by default', () => {
  const catalog = navigationCatalog([
    plugin('registered', { main: [{ viewId: 'home', icon: 'grid' }] }),
    plugin('pages-only'), plugin('settings-only', { settings: [{ viewId: 'home', icon: 'settings' }] }),
    plugin('disabled', { main: [{ viewId: 'home', icon: 'grid' }] }, 'disabled'),
    plugin('missing-target', { main: [{ viewId: 'missing', icon: 'grid' }] }),
  ], false)
  expect(catalog.filter(entry => entry.plugin).map(entry => entry.id)).toEqual(['plugin:registered/home'])
  expect(catalog.some(entry => entry.id === 'agents')).toBe(false)
  expect(defaultNavigationSettings().items).toContain('studioPlugins')
  expect(catalog.find(entry => entry.id === 'studioPlugins')?.plugin).toBeUndefined()
  expect(selectedNavigationEntries(catalog, defaultNavigationSettings().items).some(entry => entry.id === 'studioPlugins')).toBe(true)
  expect(selectedNavigationEntries(catalog, defaultNavigationSettings().items).some(entry => entry.plugin)).toBe(false)
  expect(selectedNavigationEntries(catalog, ['plugin:registered/home', 'chat']).map(entry => entry.id)).toEqual(['plugin:registered/home', 'chat'])
  expect(selectedNavigationEntries(catalog, ['plugin:disabled/home'])).toEqual([])
})

it('keeps empty selections and rejects duplicates, arbitrary ids and unknown fields', () => {
  expect(validateNavigationSettings({ items: [] })).toEqual({ items: [] })
  for (const value of [{ items: ['chat', 'chat'] }, { items: ['unknown'] }, { items: [], userId: 2 }, { items: ['plugin:../home'] }]) {
    expect(() => validateNavigationSettings(value)).toThrow()
  }
})

it('preserves permission-hidden entries when reordering the displayed list', () => {
  expect(reorderNavigationEntries(['chat', 'agents', 'plugin:notes/home', 'studioPlugins'], ['studioPlugins', 'chat', 'plugin:notes/home']))
    .toEqual(['studioPlugins', 'agents', 'chat', 'plugin:notes/home'])
})

describe('navigation saves', () => {
  beforeEach(() => {
    vi.resetAllMocks(); mocks.user = 1
    mocks.get.mockResolvedValue(defaultNavigationSettings())
    mocks.save.mockImplementation(async value => value)
    setActivePinia(createPinia())
  })
  it('persists explicit selection, rolls back failures, and can retry a failed load', async () => {
    const store = useNavigationStore()
    mocks.get.mockRejectedValueOnce(new Error('offline'))
    await store.load()
    expect(store.loaded).toBe(false)
    expect(await store.save([])).toBe(false)
    await store.load()
    expect(await store.save(['chat', 'plugin:notes/home'])).toBe(true)
    mocks.save.mockRejectedValueOnce(new Error('offline'))
    expect(await store.save([])).toBe(false)
    expect(store.items).toEqual(['chat', 'plugin:notes/home'])
  })
  it('does not let an old account response overwrite a new account or concurrent edit', async () => {
    const store = useNavigationStore()
    await store.load()
    let resolve!: (value: { items: string[] }) => void
    mocks.save.mockReturnValueOnce(new Promise(done => { resolve = done }))
    const save = store.save(['plugin:notes/home'])
    expect(await store.save([])).toBe(false)
    mocks.user = 2; invalidateAuth()
    mocks.get.mockResolvedValueOnce({ items: ['workflow'] })
    await store.load()
    resolve({ items: ['plugin:notes/home'] })
    expect(await save).toBe(false)
    expect(store.items).toEqual(['workflow'])
  })
})
