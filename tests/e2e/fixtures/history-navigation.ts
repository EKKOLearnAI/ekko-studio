import { createApp, h, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { RouterView } from 'vue-router'
import { NConfigProvider, NMessageProvider, NDialogProvider } from 'naive-ui'
import router from '../../../packages/client/src/router'
import ProfileSelector from '../../../packages/client/src/components/layout/ProfileSelector.vue'
import { useAppStore } from '../../../packages/client/src/stores/hermes/app'
import { useProfilesStore } from '../../../packages/client/src/stores/hermes/profiles'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

const pinia = createPinia()
const app = createApp({ render: () => h(NConfigProvider, {}, { default: () =>
  h(NMessageProvider, {}, { default: () => h(NDialogProvider, {}, { default: () => [
    h(ProfileSelector),
    h('main', { style: { height: '90vh', display: 'flex' } }, [h(RouterView)]),
  ] }) })
}) })
app.use(pinia)
// Keep real profile switching, routing and HTTP helpers; model discovery is unrelated.
useAppStore(pinia).loadModels = async () => {}
useAppStore(pinia).reloadModels = async () => {}
;(window as any).historyNavigationFixture = { router, profiles: useProfilesStore(pinia), async flush() {
  await nextTick()
  await new Promise(requestAnimationFrame)
  await new Promise(requestAnimationFrame)
} }
app.use(await i18nReady)
app.use(router)
await router.isReady()
app.mount('#app')
