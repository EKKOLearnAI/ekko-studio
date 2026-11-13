import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { NConfigProvider, NMessageProvider, NDialogProvider } from 'naive-ui'
import WorkflowView from '../../../packages/client/src/views/hermes/WorkflowView.vue'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

const router = createRouter({ history: createMemoryHistory(), routes: [
  { name: 'hermes.workflow', path: '/workflow', component: WorkflowView },
] })
await router.push('/workflow')
const app = createApp({ setup: () => () => h(NConfigProvider, {}, {
  default: () => h(NMessageProvider, {}, { default: () => h(NDialogProvider, {}, {
    default: () => h('main', { style: { height: '100vh', width: '100vw' } }, [h(WorkflowView)]),
  }) }),
}) })
app.use(createPinia())
app.use(await i18nReady)
app.use(router)
await router.isReady()
app.mount('#app')
