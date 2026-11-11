import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { NConfigProvider, NDialogProvider, NMessageProvider, darkTheme } from 'naive-ui'
import StudioPluginsView from '../../../packages/client/src/views/StudioPluginsView.vue'
import PluginPageView from '../../../packages/client/src/views/PluginPageView.vue'
import StudioNavigationRail from '../../../packages/client/src/components/layout/StudioNavigationRail.vue'
import { useProfilesStore } from '../../../packages/client/src/stores/hermes/profiles'
import PluginNotifications from '../../../packages/client/src/components/plugins/PluginNotifications.vue'
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
  { path: '/studio/plugins/:pluginId/:viewId?', name: 'studio.pluginPage', component: PluginPageView },
  { path: '/hermes/session/:id', component: placeholder },
  ...['person', 'chat', 'groupChat', 'workflow', 'history', 'connections', 'agentManager', 'models', 'usage', 'apiRelay', 'settings'].map(name => ({ path: '/hermes/' + name, name: 'hermes.' + name, component: placeholder })),
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
createApp({ setup: () => () => h(NConfigProvider, { theme: theme.isDark.value ? darkTheme : null,
  themeOverrides: getThemeOverrides(theme.isDark.value, theme.isComic.value, theme.customization.value, theme.hasCustomBackground.value) },
  () => h(NDialogProvider, null, () => h(NMessageProvider, null, () => [h(PluginNotifications), h('div', { style: 'display:flex;height:100vh;min-width:0;background-image:var(--app-background-image,none);background-size:cover' }, [h(StudioNavigationRail), h(RouterView)])]))) })
  .use(pinia).use(router).use(createI18n({ legacy: false, locale: 'zh', messages: { zh } })).mount('#app')
