import { computed, createApp, h, onBeforeUnmount, provide, ref, shallowRef } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { NConfigProvider, NDialogProvider, NMessageProvider, darkTheme } from 'naive-ui'
import StudioPluginsView from '../../../packages/client/src/views/StudioPluginsView.vue'
import PluginPageView from '../../../packages/client/src/views/PluginPageView.vue'
import StudioNavigationRail from '../../../packages/client/src/components/layout/StudioNavigationRail.vue'
import { useProfilesStore } from '../../../packages/client/src/stores/hermes/profiles'
import PluginNotifications from '../../../packages/client/src/components/plugins/PluginNotifications.vue'
import PluginWorkspaceSidebar from '../../../packages/client/src/components/layout/PluginWorkspaceSidebar.vue'
import AppSidebar from '../../../packages/client/src/components/layout/AppSidebar.vue'
import PluginAgentsPanel from '../../../packages/client/src/components/plugins/PluginAgentsPanel.vue'
import MobileNavigationDrawer from '../../../packages/client/src/components/layout/MobileNavigationDrawer.vue'
import { mobileNavigationKey } from '../../../packages/client/src/composables/usePageSidebar'
import { pageHeaderTargetKey } from '../../../packages/client/src/composables/usePageHeader'
import { navigationRailKey } from '../../../packages/client/src/composables/useNavigationRail'
import { usePluginCatalog, pluginPages } from '../../../packages/client/src/composables/usePluginCatalog'
import { useAppStore } from '../../../packages/client/src/stores/hermes/app'
import { createRouter, createWebHashHistory, RouterView } from 'vue-router'
import zh from '../../../packages/client/src/i18n/locales/zh'
import { useTheme } from '../../../packages/client/src/composables/useTheme'
import { getThemeOverrides } from '../../../packages/client/src/styles/theme'
import '../../../packages/client/src/styles/global.scss'
localStorage.setItem('hermes_api_key', `test.${btoa(localStorage.getItem('plugin_fixture_account') || JSON.stringify({ sub: '1', role: 'super_admin' }))}.fixture`)
if (!localStorage.getItem('hermes_active_profile_name')) localStorage.setItem('hermes_active_profile_name', 'default')
const theme = useTheme()
const placeholder = { render: () => h('div', 'Session destination') }
const router = createRouter({ history: createWebHashHistory(), routes: [
  { path: '/', redirect: '/studio/plugins' },
  { path: '/studio/plugins', name: 'studio.plugins', component: StudioPluginsView },
  { path: '/studio/plugin-settings/:pluginId/:viewId', name: 'studio.pluginSettings', component: PluginPageView },
  { path: '/studio/plugin-agent-settings/:pluginId/:viewId?', name: 'studio.pluginAgentSettings', component: PluginPageView },
  { path: '/studio/plugins/:pluginId/:viewId?', name: 'studio.pluginPage', component: PluginPageView },
  { path: '/hermes/session/:id', component: placeholder },
  ...['person', 'chat', 'groupChat', 'workflow', 'history', 'connections', 'agentManager', 'models', 'usage', 'apiRelay', 'settings', 'logs', 'performance', 'skillsUsage', 'theme', 'petdex', 'profiles'].map(name => ({ path: '/hermes/' + name, name: 'hermes.' + name, component: name === 'agentManager' ? PluginAgentsPanel : placeholder })),
] })
const pinia = createPinia()
await theme.setBrightness('light')
;(window as any).pluginFixture = { route: () => router.currentRoute.value.fullPath, navigate: (path: string) => router.push(path),
  profile(name: string) { useProfilesStore(pinia).activeProfileName = name; localStorage.setItem('hermes_active_profile_name', name) }, changed() { window.dispatchEvent(new Event('studio.plugins.changed')) },
  account(id: number, role: string) { localStorage.setItem('plugin_fixture_account', JSON.stringify({ sub: String(id), role })); location.reload() },
  appearance: theme.previewThemeSettings,
  wallpaper(enabled: boolean) {
    const image = 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><rect width="1200" height="900" fill="#46758a"/><circle cx="600" cy="700" r="500" fill="#ddc79f"/></svg>') + '")'
    theme.backgroundImageUrl.value = enabled ? image : null
    if (enabled) document.documentElement.style.setProperty('--app-background-image', image)
    else document.documentElement.style.removeProperty('--app-background-image')
  },
  async theme(dark: boolean) { await theme.setBrightness(dark ? 'dark' : 'light'); theme.previewThemeSettings({ brightness: dark ? 'dark' : 'light', appearance: { global: { opacity: 0.7, gradientColor: '#4267a8' }, regions: {} } }) } }
const Layout = { setup() {
  const { snapshot, profile } = usePluginCatalog(), app = useAppStore()
  const narrow = ref(innerWidth <= 768), open = ref(false), target = shallowRef<HTMLElement | null>(null), headerTarget = shallowRef<HTMLElement | null>(null)
  const resize = () => { narrow.value = innerWidth <= 768 }
  window.addEventListener('resize', resize); onBeforeUnmount(() => window.removeEventListener('resize', resize))
  provide(mobileNavigationKey, { open, target: computed(() => narrow.value ? target.value : null) })
  provide(pageHeaderTargetKey, computed(() => narrow.value ? null : headerTarget.value))
  provide(navigationRailKey, computed(() => true))
  return () => {
    const route = router.currentRoute.value
    const plugin = snapshot.value.plugins.find(plugin => plugin.manifest.id === route.params.pluginId && plugin.status === 'active')
    const view = plugin && pluginPages(plugin).find(view => view.id === route.params.viewId)
    const agentSettings = route.name === 'studio.pluginAgentSettings'
    const workspace = route.name === 'studio.pluginPage' && view?.slot === 'workspace' || agentSettings && view?.slot === 'agent-settings'
    const settings = route.name === 'studio.pluginSettings' || route.name === 'hermes.settings'
    return h('div', { style: 'display:flex;height:100vh;min-width:0;background-image:var(--app-background-image,none);background-size:cover' }, [
      narrow.value ? h('button', { onClick: () => { open.value = true }, style: 'position:fixed;top:16px;left:8px;z-index:2000;width:32px;height:32px;font-size:10px;padding:0' }, 'Menu') : h(StudioNavigationRail),
      narrow.value && h(MobileNavigationDrawer, { show: open.value, hasSidebar: Boolean(workspace || settings), 'onUpdate:show': (value: boolean) => { open.value = value }, onTarget: (value: HTMLElement | null) => { target.value = value } }),
      workspace && plugin ? h(PluginWorkspaceSidebar, { plugin, profile: profile.value, agentSettings }) : settings ? h(AppSidebar) : null,
      h('div', { style: 'display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;overflow:hidden' }, [
        !narrow.value && h('header', { ref: headerTarget, class: 'studio-page-header', style: 'height:64px;display:flex;align-items:center;flex-shrink:0' }, [
          workspace ? h('button', { onClick: () => app.toggleSidebarCollapsed(), style: 'flex-shrink:0' }, 'Toggle sidebar') : null,
        ]),
        h('div', { style: 'flex:1;min-height:0;min-width:0;overflow:hidden' }, [h(RouterView)]),
      ]),
    ])
  }
} }
const fixtureRoot = { setup: () => () => h(NConfigProvider, { theme: theme.isDark.value ? darkTheme : null,
  themeOverrides: getThemeOverrides(theme.isDark.value, theme.isComic.value, theme.customization.value, theme.hasCustomBackground.value) },
  () => h(NDialogProvider, null, () => h(NMessageProvider, null, () => [h(PluginNotifications), h(Layout)]))) }
const root = new URLSearchParams(location.search).has('shell') ? (await import('../../../packages/client/src/App.vue')).default : fixtureRoot
createApp(root)
  .use(pinia).use(router).use(createI18n({ legacy: false, locale: 'zh', messages: { zh } })).mount('#app')
