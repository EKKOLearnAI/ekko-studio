import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { NConfigProvider, NMessageProvider, NDialogProvider } from 'naive-ui'
import PersonView from '../../../packages/client/src/views/hermes/PersonView.vue'
import { useChatStore } from '../../../packages/client/src/stores/hermes/chat'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

const router = createRouter({ history: createMemoryHistory(), routes: [{ name: 'hermes.person', path: '/person', component: PersonView }] })
await router.push('/person')
const pinia = createPinia()
const app = createApp({ render: () => h(NConfigProvider, {}, { default: () => h(NMessageProvider, {}, { default: () => h(NDialogProvider, {}, { default: () => h('main', { style: { display: 'flex', height: '100vh', width: '100vw' } }, [h(PersonView)]) }) }) }) })
app.use(pinia); app.use(await i18nReady); app.use(router)
// Only sending/switching the live chat transport is replaced. Form and picker are real.
const chat = useChatStore(pinia)
const sent: string[] = []
chat.switchSession = async () => {}
chat.sendMessage = async text => { sent.push(text) }
;(window as any).personWorkspaceFixture = { sent }
await router.isReady(); app.mount('#app')
