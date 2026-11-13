import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { NConfigProvider, NMessageProvider, NDialogProvider } from 'naive-ui'
import ChatInput from '../../../packages/client/src/components/hermes/chat/ChatInput.vue'
import { useChatStore, type Session } from '../../../packages/client/src/stores/hermes/chat'
import { useAppStore } from '../../../packages/client/src/stores/hermes/app'
import { useProfilesStore } from '../../../packages/client/src/stores/hermes/profiles'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

localStorage.setItem('hermes_api_key', `test.${btoa(JSON.stringify({ sub: '1', role: 'super_admin' }))}.fixture`)
localStorage.setItem('hermes_locale', 'en')
const pinia = createPinia()
const profiles = useProfilesStore(pinia)
profiles.activeProfileName = 'default'
profiles.profiles = [{ name: 'default', active: true }] as any
const appStore = useAppStore(pinia)
appStore.selectedModel = 'model-a'; appStore.selectedProvider = 'fixture'
const chat = useChatStore(pinia)
chat.sessions.push({ id: 'session-a', title: 'Fixture', source: 'cli', agent: 'hermes', profile: 'default',
  model: 'model-a', provider: 'fixture', messages: [], isLocalOnly: true, createdAt: Date.now(), updatedAt: Date.now(),
} as Session)
chat.activeSessionId = 'session-a'; chat.activeSession = chat.sessions[0]!
;(window as any).pendingSendFixture = chat
const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }] })
await router.push('/')
createApp({ render: () => h(NConfigProvider, {}, { default: () => h(NMessageProvider, {}, { default: () => h(NDialogProvider, {}, { default: () => h('main', { style: 'padding:24px' }, [h(ChatInput)]) }) }) }) })
  .use(pinia).use(await i18nReady).use(router).mount('#app')
