import { createApp, h, ref } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { NConfigProvider } from 'naive-ui'
import PersonAgentSettings from '../../../packages/client/src/components/hermes/person/PersonAgentSettings.vue'
import { personRequest, type PersonAgentPreset } from '../../../packages/client/src/api/person'
import zh from '../../../packages/client/src/i18n/locales/zh'
import '../../../packages/client/src/styles/global.scss'

localStorage.setItem('hermes_api_key', `test.${btoa(JSON.stringify({ sub: '1', role: 'admin' }))}.fixture`)
const initial = (window as unknown as { initialProtocolAgents?: PersonAgentPreset[] }).initialProtocolAgents || []
const agents = ref(initial), saving = ref(false)
async function save(value: PersonAgentPreset[]) {
  saving.value = true
  try {
    const result = await personRequest<{ agents: PersonAgentPreset[] }>('/settings', { agents: value }, 'PUT')
    agents.value = result.agents
  } finally { saving.value = false }
}
createApp({ setup: () => () => h(NConfigProvider, {}, { default: () => h(PersonAgentSettings, {
  agents: agents.value, saving: saving.value, onSave: save,
}) }) }).use(createPinia()).use(createI18n({ legacy: false, locale: 'zh', messages: { zh } })).mount('#app')
