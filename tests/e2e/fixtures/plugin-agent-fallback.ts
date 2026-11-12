import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createRouter, createMemoryHistory } from 'vue-router'
import { NConfigProvider, NMessageProvider, NDialogProvider, darkTheme } from 'naive-ui'
import HistoryMessageList from '../../../packages/client/src/components/hermes/chat/HistoryMessageList.vue'
import PersonTaskIdentity from '../../../packages/client/src/components/hermes/person/PersonTaskIdentity.vue'
import type { Session } from '../../../packages/client/src/stores/hermes/chat'
import type { PersonTask } from '../../../packages/client/src/api/person'
import { syncPluginAgentOptions } from '../../../packages/client/src/utils/agent-options'
import { useTheme } from '../../../packages/client/src/composables/useTheme'
import { getThemeOverrides } from '../../../packages/client/src/styles/theme'
import zh from '../../../packages/client/src/i18n/locales/zh'
import '../../../packages/client/src/styles/global.scss'

const id = 'plugin:omp/omp'
const session = { id: 'plugin-history', title: '历史消息', source: 'coding_agent', agent: id, profile: 'default', messages: [{ id: 'reply', role: 'assistant', content: '插件删除后，历史仍能查看。', timestamp: 1 }] } as Session
const task = { id: 'plugin-task', title: '历史任务', selection_json: JSON.stringify({ runtime: id, agentName: '开发者' }) } as PersonTask
if (!new URLSearchParams(location.search).has('removed')) syncPluginAgentOptions([{ id, name: 'Oh My Pi', icon: '/coding-agents/pi.svg', origin: 'plugin', vendor: 'Stencil Labs', description: '', modes: ['global'], surfaces: ['chat'], actions: { settings: false, checkUpdate: false, upgrade: false }, status: { installed: true, version: '18' } }])
const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }] })
const theme = useTheme()
await theme.setBrightness('light')
;(window as any).avatarFixture = { dark: () => theme.setBrightness('dark') }
createApp({ setup: () => () => h(NConfigProvider, { theme: theme.isDark.value ? darkTheme : null, themeOverrides: getThemeOverrides(theme.isDark.value, false, theme.customization.value, false) }, { default: () => h(NMessageProvider, {}, { default: () => h(NDialogProvider, {}, { default: () => h('main', [
  h('button', { onClick: () => syncPluginAgentOptions([]) }, '移除 Agent'),
  h('section', { 'data-testid': 'messages', style: 'height:260px;display:flex' }, [h(HistoryMessageList, { session })]),
  h('section', { 'data-testid': 'tasks' }, [h(PersonTaskIdentity, { task })]),
]) }) }) }) }).use(createPinia()).use(createI18n({ legacy: false, locale: 'zh', messages: { zh } })).use(router).mount('#app')
