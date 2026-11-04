import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createMemoryHistory, RouterView } from 'vue-router'
import { NConfigProvider, NMessageProvider, NDialogProvider, darkTheme } from 'naive-ui'
import PersonView from '../../../packages/client/src/views/hermes/PersonView.vue'
import { useChatStore } from '../../../packages/client/src/stores/hermes/chat'
import { useFilesStore } from '../../../packages/client/src/stores/hermes/files'
import { useSettingsStore } from '../../../packages/client/src/stores/hermes/settings'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

import { useTheme } from '../../../packages/client/src/composables/useTheme'
import { getThemeOverrides } from '../../../packages/client/src/styles/theme'
const theme = useTheme()
const router = createRouter({ history: createMemoryHistory(), routes: [{ name: 'hermes.person', path: '/person', component: PersonView }] })
await router.push('/person')
const pinia = createPinia()
const app = createApp({ render: () => h(NConfigProvider, { theme: theme.isDark.value ? darkTheme : null, themeOverrides: getThemeOverrides(theme.isDark.value, false, theme.customization.value, theme.hasCustomBackground.value) }, { default: () => h(NMessageProvider, {}, { default: () => h(NDialogProvider, {}, { default: () => h('main', { style: { display: 'flex', height: '100vh', width: '100vw', backgroundImage: 'var(--app-background-image)', backgroundSize: 'cover' } }, [h(RouterView)]) }) }) }) })
app.use(pinia); app.use(await i18nReady); app.use(router)
// Only sending/switching the live chat transport is replaced. Form and picker are real.
const chat = useChatStore(pinia)
const sent: string[] = []
chat.switchSession = async id => { chat.activeSessionId = id }
chat.sendMessage = async text => { sent.push(text) }
;(window as any).personWorkspaceFixture = { sent, router, chat, theme, files: useFilesStore(pinia), settings: useSettingsStore(pinia) }
await router.isReady(); app.mount('#app')
