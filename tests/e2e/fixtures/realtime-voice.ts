import { createApp, h, ref } from 'vue'
import { createPinia } from 'pinia'
import RealtimeVoiceStage from '../../../packages/client/src/components/hermes/chat/RealtimeVoiceStage.vue'
import { useChatStore } from '../../../packages/client/src/stores/hermes/chat'
import { useAppStore } from '../../../packages/client/src/stores/hermes/app'
import { i18nReady } from '../../../packages/client/src/i18n'

const pinia = createPinia()
const chat = useChatStore(pinia)
const appStore = useAppStore(pinia)
appStore.selectedModel = 'test-model'
appStore.selectedProvider = 'fixture'
const session = { id: 'voice-browser', title: 'Voice regression', profile: 'default', source: 'cli',
  agent: 'hermes', messages: [], messageCount: 0 } as NonNullable<typeof chat.activeSession>
chat.sessions = [session]
chat.activeSession = session
chat.activeSessionId = session.id
const stage = ref()
const app = createApp({ setup: () => () => h('main', [
  h('button', { style: { position: 'fixed', zIndex: 10000, bottom: '8px', left: '8px' },
    onClick: () => stage.value.$.setupState.submitTranscript('Test prompt') }, 'Send transcript'),
  h(RealtimeVoiceStage, { ref: stage }),
]) })
app.use(pinia)
app.use(await i18nReady)
app.mount('#app')
// Keep the component, store, Socket.IO dispatch, segmentation and Audio implementation real.
;(window as any).voiceFixture = { chat }
