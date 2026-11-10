import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { NConfigProvider, NMessageProvider } from 'naive-ui'
import SessionTasksDrawer from '../../../packages/client/src/components/hermes/tasks/SessionTasksDrawer.vue'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

const router = createRouter({ history: createMemoryHistory(), routes: [
  { path: '/', component: { render: () => null } },
  { name: 'hermes.session', path: '/session/:sessionId', component: { render: () => null } },
] })
await router.push('/')
const app = createApp({ render: () => h(NConfigProvider, {}, { default: () => h(NMessageProvider, {}, {
  default: () => h(SessionTasksDrawer, { show: true }),
}) }) })
app.use(createPinia()); app.use(await i18nReady); app.use(router)
await router.isReady(); app.mount('#app')
