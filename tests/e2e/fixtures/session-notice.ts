import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { NConfigProvider, NMessageProvider, NDialogProvider } from 'naive-ui'
import MessageItem from '../../../packages/client/src/components/hermes/chat/MessageItem.vue'
import { connectChatRun } from '../../../packages/client/src/api/studio/chat'
import { useChatStore } from '../../../packages/client/src/stores/hermes/chat'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

// Real chat store and real chat-run socket client. The spec delivers raw server `session.notice` events through
// the socket's own registered listener, so ingestion, server-to-client mapping and rendering are all real; only
// the network transport is absent (the page guard blocks it).
const pinia = createPinia()
const chat = useChatStore(pinia)
const sid = 'notice-session'
chat.sessions = [{ id: sid, title: 'Notices', profile: 'default', source: 'cli', agent: 'hermes', messages: [],
  messagesLoaded: true, messageCount: 0 } as any]
chat.activeSessionId = sid
const app = createApp({ setup: () => () => h(NConfigProvider, {}, {
  default: () => h(NMessageProvider, {}, { default: () => h(NDialogProvider, {}, {
    default: () => h('main', { style: { maxWidth: '100vw', padding: '8px', boxSizing: 'border-box' } },
      (chat.sessions.find(session => session.id === sid)?.messages || []).map(message => h(MessageItem, { key: message.id, message }))),
  }) }),
}) })
app.use(pinia)
app.use(await i18nReady)
app.mount('#app')
const socket = connectChatRun('default')
;(window as any).sessionNoticeFixture = {
  sid,
  deliver: (event: unknown) => { for (const listener of socket.listeners('session.notice')) listener(event) },
}
