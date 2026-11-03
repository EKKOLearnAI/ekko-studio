import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { NConfigProvider, NMessageProvider, NDialogProvider, darkTheme } from 'naive-ui'
import PersonView from '../../../packages/client/src/views/hermes/PersonView.vue'
import { useChatStore } from '../../../packages/client/src/stores/hermes/chat'
import { useTheme } from '../../../packages/client/src/composables/useTheme'
import { getThemeOverrides } from '../../../packages/client/src/styles/theme'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

const router = createRouter({ history: createMemoryHistory(), routes: [{ name: 'hermes.person', path: '/person', component: PersonView }] })
await router.push('/person?session=person-main-a')
const pinia = createPinia()
const app = createApp({ setup() {
  const theme = useTheme()
  ;(window as any).scheduleTheme = theme
  return () => h(NConfigProvider, { theme: theme.isDark.value ? darkTheme : null,
    themeOverrides: getThemeOverrides(theme.isDark.value, theme.isComic.value, theme.customization.value, theme.hasCustomBackground.value) },
  { default: () => h(NMessageProvider, {}, { default: () => h(NDialogProvider, {}, {
    default: () => h('main', { style: { display: 'flex', height: '100vh', width: '100vw', backgroundImage: 'var(--app-background-image, var(--app-background-gradient, none))', backgroundSize: 'cover' } }, [h(PersonView)]),
  }) }) })
} })
app.use(pinia); app.use(await i18nReady); app.use(router)
const chat = useChatStore(pinia)
chat.switchSession = async () => {}
await router.isReady(); app.mount('#app')
