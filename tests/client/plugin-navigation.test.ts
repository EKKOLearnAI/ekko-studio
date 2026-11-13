import { expect, it } from 'vitest'
import { pluginNavigation, pluginPageLocation, pluginPages } from '../../packages/client/src/plugins/navigation'
import type { InstalledPlugin } from '../../packages/client/src/api/studio/plugins'

const plugin = (navigation?: InstalledPlugin['manifest']['navigation']) => ({ manifest: { id: 'demo', name: 'Demo', version: '1.0.0', apiVersion: 1,
  permissions: ['ui'], client: 'client.mjs', views: [
    { id: 'home', title: 'Home', slot: 'page' }, { id: 'preferences', title: 'Preferences', slot: 'settings' },
    { id: 'skills', title: 'Skills', slot: 'agent-settings', icon: 'skills' },
  ], navigation }, status: 'active' } as InstalledPlugin)

it('keeps all declared pages reachable without adding either global sidebar entry', () => {
  const value = plugin()
  expect(pluginPages(value)).toHaveLength(3)
  expect(pluginNavigation(value)).toEqual([])
  expect(pluginNavigation(value, 'settings')).toEqual([])
  expect(pluginPageLocation(value, 'preferences').name).toBe('studio.pluginSettings')
  expect(pluginPageLocation(value, 'skills')).toEqual({ name: 'studio.pluginAgentSettings', params: { pluginId: 'demo', viewId: 'skills' } })
})

it('uses independent titles, icons and ordering for each sidebar even when they target the same page', () => {
  const value = plugin({ main: [{ viewId: 'preferences', title: 'Main entry', icon: 'data:image/png;base64,aWNvbg==', order: 2 }, { viewId: 'home', icon: 'grid' }],
    settings: [{ viewId: 'preferences', title: 'Settings entry', icon: 'settings' }] })
  expect(pluginNavigation(value).map(view => [view.id, view.title, view.icon])).toEqual([
    ['home', 'Home', 'grid'], ['preferences', 'Main entry', 'data:image/png;base64,aWNvbg=='],
  ])
  expect(pluginNavigation(value, 'settings').map(view => [view.id, view.title, view.icon])).toEqual([['preferences', 'Settings entry', 'settings']])
  value.manifest.navigation!.main = []
  expect(pluginNavigation(value)).toEqual([])
  expect(pluginNavigation(value, 'settings')).toHaveLength(1)
})
