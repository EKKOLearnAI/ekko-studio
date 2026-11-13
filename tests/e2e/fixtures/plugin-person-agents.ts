import { createApp, h, ref } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { NConfigProvider } from 'naive-ui'
import PersonAgentSettings from '../../../packages/client/src/components/hermes/person/PersonAgentSettings.vue'
import type { PersonAgentPreset } from '../../../packages/client/src/api/person'
import zh from '../../../packages/client/src/i18n/locales/zh'
import '../../../packages/client/src/styles/global.scss'

localStorage.setItem('hermes_api_key', `test.${btoa(JSON.stringify({ sub: '1', role: 'admin' }))}.fixture`)
const agents = ref<PersonAgentPreset[]>([])
;(window as any).agentFixture = { get agents() { return agents.value } }
createApp({ setup: () => () => h(NConfigProvider, {}, { default: () => h(PersonAgentSettings, {
  agents: agents.value, saving: false, onSave: (value: PersonAgentPreset[]) => { agents.value = value },
}) }) }).use(createPinia()).use(createI18n({ legacy: false, locale: 'zh', messages: { zh } })).mount('#app')
