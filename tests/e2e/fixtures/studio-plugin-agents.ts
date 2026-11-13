import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createRouter, createWebHashHistory, RouterView } from 'vue-router'
import { NConfigProvider, NDialogProvider, NMessageProvider, darkTheme } from 'naive-ui'
import PluginAgentsPanel from '../../../packages/client/src/components/plugins/PluginAgentsPanel.vue'
import PluginPageView from '../../../packages/client/src/views/PluginPageView.vue'
import AgentManagerView from '../../../packages/client/src/views/hermes/AgentManagerView.vue'
import { AGENT_OPTIONS } from '../../../packages/client/src/utils/agent-options'
import { useTheme } from '../../../packages/client/src/composables/useTheme'
import { getThemeOverrides } from '../../../packages/client/src/styles/theme'
import zh from '../../../packages/client/src/i18n/locales/zh'
import '../../../packages/client/src/styles/global.scss'

localStorage.setItem('hermes_api_key', `test.${btoa(JSON.stringify({ sub: '1', role: 'super_admin' }))}.fixture`)
const theme = useTheme()
await theme.setBrightness('light')
;(window as any).agentFixture = {
  async theme(dark: boolean) { await theme.setBrightness(dark ? 'dark' : 'light') },
  appearance: theme.previewThemeSettings,
  background(image: string | null) { theme.backgroundImageUrl.value = image },
}
const manager = { setup() { return () => h('main', { style: 'padding:24px;max-width:960px' }, [h(PluginAgentsPanel), h('select', { 'aria-label': 'Agent picker' }, AGENT_OPTIONS.map(option => h('option', { value: option.value }, option.label)))]) } }
const router = createRouter({ history: createWebHashHistory(), routes: [
  { path: '/', component: manager },
  { path: '/agents', component: AgentManagerView },
  { path: '/studio/plugins', name: 'studio.plugins', component: manager },
  { path: '/studio/plugin-settings/:pluginId/:viewId', name: 'studio.pluginSettings', component: PluginPageView },
] })
createApp({ setup() { return () => h(NConfigProvider, { theme: theme.isDark.value ? darkTheme : null,
  style: { height: '100vh', backgroundImage: theme.backgroundImageUrl.value ? `url("${theme.backgroundImageUrl.value}")` : undefined },
  themeOverrides: getThemeOverrides(theme.isDark.value, theme.isComic.value, theme.customization.value, theme.hasCustomBackground.value),
}, { default: () => h(NDialogProvider, {}, { default: () => h(NMessageProvider, {}, { default: () => h(RouterView) }) }) }) } })
  .use(createPinia()).use(createI18n({ legacy: false, locale: 'zh', messages: { zh } })).use(router).mount('#app')
