import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { RouterView } from 'vue-router'
import { NConfigProvider, NMessageProvider, NDialogProvider } from 'naive-ui'
import router from '../../../packages/client/src/router'
import { useAppStore } from '../../../packages/client/src/stores/hermes/app'
import { useProfilesStore } from '../../../packages/client/src/stores/hermes/profiles'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

const pinia = createPinia()
const app = createApp({ render: () => h(NConfigProvider, {}, { default: () =>
  h(NMessageProvider, {}, { default: () => h(NDialogProvider, {}, { default: () =>
    h('main', { style: { height: '100vh', display: 'flex' } }, [h(RouterView)])
  }) })
}) })
app.use(pinia)
// Model discovery is unrelated to history; session/profile HTTP requests remain real.
useAppStore(pinia).loadModels = async () => {}
;(window as any).historyProfileFixture = { router, profiles: useProfilesStore(pinia) }
app.use(await i18nReady)
app.use(router)
await router.isReady()
app.mount('#app')
