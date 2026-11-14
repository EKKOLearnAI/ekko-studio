import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Context } from 'koa'
import { validateNavigationSettings } from '../../packages/shared/navigation-settings'

const mocks = vi.hoisted(() => ({ db: undefined as unknown as DatabaseSync, plugins: [] as any[] }))
vi.mock('../../packages/server/src/modules/studio/infrastructure/database', () => ({ getDb: () => mocks.db }))
vi.mock('../../packages/server/src/modules/studio/services/plugins/host', () => ({ getPluginManager: () => ({ snapshot: () => ({ plugins: mocks.plugins }) }) }))
import { USER_NAVIGATION_SCHEMA } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { getUserNavigation, updateUserNavigation } from '../../packages/server/src/modules/studio/services/navigation'
import { getNavigation, updateNavigation } from '../../packages/server/src/modules/studio/controllers/navigation'

beforeEach(() => {
  mocks.db = new DatabaseSync(':memory:')
  mocks.db.exec(`CREATE TABLE user_navigation (${Object.entries(USER_NAVIGATION_SCHEMA).map(([key, value]) => `${key} ${value}`).join(', ')})`)
  mocks.plugins = [{ status: 'active', manifest: { id: 'notes', views: [{ id: 'home' }], navigation: { main: [{ viewId: 'home' }] } } }]
})
afterEach(() => mocks.db.close())

it('repairs legacy saved lists with the default plugin center while preserving selection and order', () => {
  const legacy = ['plugin:notes/home', 'chat', 'apiRelay']
  mocks.db.prepare('INSERT INTO user_navigation (user_id, items_json, updated_at) VALUES (?, ?, ?)').run(1, JSON.stringify(legacy), 1)
  expect(getUserNavigation(1).items).toEqual(['plugin:notes/home', 'chat', 'studioPlugins', 'apiRelay'])
  expect(getUserNavigation(1).items).toEqual(['plugin:notes/home', 'chat', 'studioPlugins', 'apiRelay'])
  const stored = mocks.db.prepare('SELECT schema_version, items_json FROM user_navigation WHERE user_id = 1').get()!
  expect(stored.schema_version).toBe(1)
  expect(JSON.parse(stored.items_json as string)).toEqual(['plugin:notes/home', 'chat', 'studioPlugins', 'apiRelay'])
  expect(getUserNavigation(2).items).not.toContain('plugin:notes/home')
})

it('repairs missing legacy defaults once and respects subsequent intentional customizations', () => {
  mocks.db.prepare('INSERT INTO user_navigation (user_id, items_json, updated_at) VALUES (?, ?, ?)').run(1, '[]', 1)
  expect(getUserNavigation(1).items).toEqual(['studioPlugins'])
  updateUserNavigation(1, { items: ['chat'] })
  expect(getUserNavigation(1).items).toEqual(['chat'])
  mocks.db.prepare('INSERT INTO user_navigation (user_id, items_json, updated_at) VALUES (?, ?, ?)').run(2, '["studioPlugins","chat"]', 1)
  expect(getUserNavigation(2).items).toEqual(['studioPlugins', 'chat'])
})

it('preserves a full legacy selection when adding the missing default entry', () => {
  const items = Array.from({ length: 200 }, (_, index) => `plugin:notes/view-${index}`)
  mocks.db.prepare('INSERT INTO user_navigation (user_id, items_json, updated_at) VALUES (?, ?, ?)').run(1, JSON.stringify(items), 1)
  const repaired = getUserNavigation(1)
  expect(repaired.items).toEqual([...items, 'studioPlugins'])
  expect(validateNavigationSettings(repaired)).toEqual(repaired)
})

it('stores ordered opt-in entries per user, including an explicitly empty list', () => {
  expect(getUserNavigation(1).items.every(id => !id.startsWith('plugin:'))).toBe(true)
  updateUserNavigation(1, { items: ['plugin:notes/home', 'chat'] })
  expect(getUserNavigation(1).items).toEqual(['plugin:notes/home', 'chat'])
  expect(getUserNavigation(2).items).not.toContain('plugin:notes/home')
  updateUserNavigation(1, { items: [] })
  expect(getUserNavigation(1).items).toEqual([])
})

it('rejects new unregistered or disabled entries while retaining previous unavailable selections', () => {
  mocks.plugins.push({ status: 'active', manifest: { id: 'pages-only', views: [{ id: 'home' }] } })
  expect(() => updateUserNavigation(1, { items: ['plugin:pages-only/home'] })).toThrow(/registered/)
  updateUserNavigation(1, { items: ['plugin:notes/home'] })
  mocks.plugins[0].status = 'disabled'
  expect(() => updateUserNavigation(2, { items: ['plugin:notes/home'] })).toThrow(/registered/)
  expect(updateUserNavigation(1, { items: ['chat', 'plugin:notes/home'] }).items).toEqual(['chat', 'plugin:notes/home'])
  mocks.plugins[0].status = 'active'; mocks.plugins[0].manifest.navigation.main = []
  expect(() => updateUserNavigation(2, { items: ['plugin:notes/home'] })).toThrow(/registered/)
})

it('uses the authenticated account and denies unauthenticated or shared-session requests', () => {
  for (const state of [{}, { user: { id: 1 }, sessionShare: {} }]) {
    const ctx = { state } as Context
    getNavigation(ctx); expect(ctx.status).toBe(401)
    updateNavigation(ctx); expect(ctx.status).toBe(401)
  }
  const ctx = { state: { user: { id: 2 } }, request: { body: { items: ['chat'], userId: 1 } } } as unknown as Context
  updateNavigation(ctx)
  expect(ctx.status).toBe(400)
  ctx.request.body = { items: ['workflow'] }
  updateNavigation(ctx)
  expect(getUserNavigation(2).items).toEqual(['workflow'])
  expect(getUserNavigation(1).items).not.toEqual(['workflow'])
})
