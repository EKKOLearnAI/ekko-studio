import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { NConfigProvider, NMessageProvider, NDialogProvider } from 'naive-ui'
import ChatPanel from '../../../packages/client/src/components/hermes/chat/ChatPanel.vue'
import { useChatStore } from '../../../packages/client/src/stores/hermes/chat'
import { useAppStore } from '../../../packages/client/src/stores/hermes/app'
import { useProfilesStore } from '../../../packages/client/src/stores/hermes/profiles'
import { saveNewChatFormPreferences } from '../../../packages/client/src/utils/new-chat-form-preferences'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

localStorage.setItem('hermes_api_key', `test.${btoa(JSON.stringify({ sub: '1', role: 'super_admin' }))}.fixture`)
localStorage.setItem('hermes_locale', 'en')
if (!localStorage.getItem('hermes_new_chat_form_v1:1')) saveNewChatFormPreferences(1, {
  agent: 'codex', mode: 'scoped', profile: 'default', provider: 'custom:fixture', model: 'model-a',
  customModel: false, apiMode: 'chat_completions', reasoningEffort: '', workspace: '', categoryId: null, baseUrl: '', apiKey: '',
})
const pinia = createPinia()
const profiles = useProfilesStore(pinia)
profiles.activeProfileName = 'default'
profiles.profiles = [{ name: 'default', active: true }] as any
const group = { provider: 'custom:fixture', label: 'Fixture', models: ['model-a'], base_url: 'https://fixture.invalid/v1', api_key: '', api_mode: 'chat_completions' as const, credential_configured: new URLSearchParams(location.search).has('configured') }
const store = useAppStore(pinia)
store.modelGroups = [group]
store.profileModelGroups = [{ profile: 'default', groups: [group], default: 'model-a', default_provider: group.provider }]
store.selectedProvider = group.provider; store.selectedModel = 'model-a'
const chat = useChatStore(pinia)
const created: unknown[] = []
chat.newChat = ((options: any) => { created.push(options); return { id: 'created' } }) as any
chat.sendMessage = async () => {}
chat.loadSessions = async () => {}
;(window as any).credentialFixture = { created }
const empty = { render: () => null }
const router = createRouter({ history: createMemoryHistory(), routes: [
  { name: 'hermes.chat', path: '/', component: empty },
  { name: 'hermes.session', path: '/session/:sessionId', component: empty },
] })
await router.push('/')
createApp({ render: () => h(NConfigProvider, {}, { default: () => h(NMessageProvider, {}, { default: () => h(NDialogProvider, {}, { default: () => h('main', { style: 'display:flex;height:100vh' }, [h(ChatPanel)]) }) }) }) })
  .use(pinia).use(await i18nReady).use(router).mount('#app')
