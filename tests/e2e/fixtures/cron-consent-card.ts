import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { NConfigProvider, NMessageProvider, NDialogProvider } from 'naive-ui'
import CronConsentCard from '../../../packages/client/src/components/hermes/chat/CronConsentCard.vue'
import { connectChatRun } from '../../../packages/client/src/api/studio/chat'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

// Real consent card and real chat-run socket client; the spec answers /api locally and delivers the
// content-free `cron_consent.updated` hint through the socket's own registered listener.
const sid = 'chat-1'
const app = createApp({ setup: () => () => h(NConfigProvider, {}, {
  default: () => h(NMessageProvider, {}, { default: () => h(NDialogProvider, {}, {
    default: () => h('main', { style: { maxWidth: '100vw', padding: '8px', boxSizing: 'border-box' } },
      [h(CronConsentCard, { sessionId: sid, profile: 'default' })]),
  }) }),
}) })
app.use(createPinia())
app.use(await i18nReady)
app.mount('#app')
const socket = connectChatRun('default')
;(window as any).cronConsentFixture = {
  sid,
  hint: (sessionId = sid) => { for (const listener of socket.listeners('cron_consent.updated')) listener({ session_id: sessionId }) },
}
