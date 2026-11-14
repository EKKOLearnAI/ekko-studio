import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ navigation: { items: [] as string[], loaded: true, load: vi.fn() }, plugins: vi.fn(), admin: true }))
vi.mock('../../packages/client/src/api/client', () => ({ isStoredSuperAdmin: () => mocks.admin }))
vi.mock('../../packages/client/src/api/studio/plugins', () => ({ pluginCatalog: mocks.plugins }))
vi.mock('../../packages/client/src/stores/navigation', () => ({ useNavigationStore: () => mocks.navigation }))
import { resolveNavigationStartup } from '../../packages/client/src/utils/navigation-startup'
import { resolveLoginRedirect } from '../../packages/client/src/utils/login-redirect'

beforeEach(() => {
  vi.resetAllMocks(); mocks.admin = true; mocks.navigation.loaded = true; mocks.navigation.items = ['person', 'chat']
  mocks.navigation.load.mockResolvedValue(undefined)
  mocks.plugins.mockResolvedValue({ plugins: [] })
})

it('waits for the saved order and opens its first builtin without waiting for plugins', async () => {
  mocks.navigation.load.mockImplementation(async () => { mocks.navigation.items = ['workflow', 'person', 'plugin:notes/home'] })
  expect(await resolveNavigationStartup()).toEqual({ name: 'hermes.workflow' })
  expect(mocks.plugins).not.toHaveBeenCalled()
})

it('opens a selected registered plugin first and skips disabled or unregistered entries', async () => {
  mocks.navigation.items = ['plugin:notes/home', 'chat', 'person']
  const plugin = { status: 'active', manifest: { id: 'notes', views: [{ id: 'home', title: 'Notes', slot: 'page' }], navigation: { main: [{ viewId: 'home', icon: 'book' }] } } }
  mocks.plugins.mockResolvedValue({ plugins: [plugin] })
  expect(await resolveNavigationStartup()).toEqual({ name: 'studio.pluginPage', params: { pluginId: 'notes', viewId: 'home' } })
  plugin.status = 'disabled'
  expect(await resolveNavigationStartup()).toEqual({ name: 'hermes.chat' })
  plugin.status = 'active'; plugin.manifest.navigation.main = []
  expect(await resolveNavigationStartup()).toEqual({ name: 'hermes.chat' })
})

it('skips inaccessible builtins and unavailable catalogs, and falls back when no entry is usable', async () => {
  mocks.admin = false; mocks.navigation.items = ['agents', 'plugin:notes/home', 'chat']
  mocks.plugins.mockRejectedValue(new Error('offline'))
  expect(await resolveNavigationStartup()).toEqual({ name: 'hermes.chat' })
  mocks.navigation.items = []
  expect(await resolveNavigationStartup()).toEqual({ name: 'hermes.settings' })
  mocks.navigation.loaded = false; mocks.navigation.items = ['person']
  expect(await resolveNavigationStartup()).toEqual({ name: 'hermes.settings' })
})

it('keeps explicit internal links and sends default or external redirects through startup resolution', () => {
  expect(resolveLoginRedirect('/hermes/session/example?profile=work')).toBe('/hermes/session/example?profile=work')
  for (const value of [undefined, '', '//example.com', 'https://example.com', ['person']]) expect(resolveLoginRedirect(value)).toBe('/home')
})
