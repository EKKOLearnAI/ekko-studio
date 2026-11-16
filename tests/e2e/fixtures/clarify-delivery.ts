import { createApp, h, ref } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { NConfigProvider, NMessageProvider } from 'naive-ui'
import MessageList from '@/components/hermes/chat/MessageList.vue'
import { useChatStore, type Session } from '@/stores/hermes/chat'
import { connectChatRun } from '@/api/studio/chat'
import en from '@/i18n/locales/en'
import '@/styles/global.scss'

localStorage.setItem('hermes_active_profile_name', 'default')
const sid = new URLSearchParams(location.search).get('bot') ? 'person-main-bot' : 'chat-session'
const pinia = createPinia()
const store = useChatStore(pinia)
const session = { id: sid, title: 'Question fixture', profile: new URLSearchParams(location.search).get('profile') || 'default', source: 'builtin_agent', agent: 'ekko-agent', messages: [], createdAt: 1, updatedAt: 1 } as Session
store.sessions = [session]
store.activeSession = session
store.activeSessionId = sid
connectChatRun('default')

createApp({ setup() {
  const visible = ref(true)
  return () => h(NConfigProvider, null, () => h(NMessageProvider, null, () => [
    h('button', { onClick() { visible.value = false; store.activeSessionId = 'elsewhere' } }, 'Other page'),
    h('button', { onClick() { store.activeSessionId = sid; visible.value = true } }, 'Return to chat'),
    visible.value ? h(MessageList) : h('p', 'Other page content'),
  ]))
} }).use(pinia).use(createI18n({ legacy: false, locale: 'en', messages: { en } })).mount('#app')
