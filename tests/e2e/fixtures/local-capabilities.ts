import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { NConfigProvider, NDialogProvider, NMessageProvider, NNotificationProvider } from 'naive-ui'
import LocalRealtimeLauncher from '../../../packages/client/src/components/hermes/chat/LocalRealtimeLauncher.vue'
import GroupDiscussionPanel from '../../../packages/client/src/components/hermes/group-chat/GroupDiscussionPanel.vue'
import { useGroupChatStore } from '../../../packages/client/src/stores/hermes/group-chat'
import { RouterView } from 'vue-router'
import router from '../../../packages/client/src/router'
import en from '../../../packages/client/src/i18n/locales/en'
import { BUILTIN_PLUGINS, installClientPlugins } from '../../../packages/client/src/plugins'
import { useProfilesStore } from '../../../packages/client/src/stores/hermes/profiles'
import { getThemeOverrides } from '../../../packages/client/src/styles/theme'
import '../../../packages/client/src/styles/global.scss'
const pinia = createPinia()
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
const surface = new URLSearchParams(location.search).get('surface')
const content = () => surface === 'omni' || surface === 'practice' ? h(LocalRealtimeLauncher, { mode: surface }) : surface === 'discussion' ? h(GroupDiscussionPanel, { canManage: true }) : h(RouterView)
const app = createApp({ setup: () => () => h(NConfigProvider, { themeOverrides: getThemeOverrides(false) }, () => h(NDialogProvider, null, () => h(NMessageProvider, null, () => h(NNotificationProvider, null, content)))) })
app.use(pinia).use(i18n)
const profiles = useProfilesStore(pinia)
if (surface === 'discussion') {
  const group = useGroupChatStore(pinia)
  group.currentRoomId = 'room-1'
  group.agents = [{ id: 'a1', agentId: 'a1', name: 'Planner', agent: 'hermes' }, { id: 'a2', agentId: 'a2', name: 'Reviewer', agent: 'hermes' }] as any
}
profiles.activeProfileName = 'default'
profiles.profiles = [{ name: 'default', active: true, alias: 'Default', model: 'test' }]
await installClientPlugins(app, router, i18n, BUILTIN_PLUGINS)
app.use(router)
await router.isReady()
app.mount('#app')
