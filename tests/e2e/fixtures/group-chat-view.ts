import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { createI18n } from 'vue-i18n'
import GroupChatView from '../../../packages/client/src/views/hermes/GroupChatView.vue'
import { useGroupChatStore } from '../../../packages/client/src/stores/hermes/group-chat'
import { useProfilesStore } from '../../../packages/client/src/stores/hermes/profiles'
import { useSettingsStore } from '../../../packages/client/src/stores/hermes/settings'
import type { RoomInfo } from '../../../packages/client/src/api/studio/group-chat'
import zh from '../../../packages/client/src/i18n/locales/zh'

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/hermes/group-chat', name: 'hermes.groupChat', component: GroupChatView },
    { path: '/hermes/group-chat/room/:roomId', name: 'hermes.groupChatRoom', component: GroupChatView },
  ],
})
const pinia = createPinia()
const group = useGroupChatStore(pinia)
const profiles = useProfilesStore(pinia)
const settings = useSettingsStore(pinia)
group.rooms = new URLSearchParams(location.search).has('empty') ? [] : [
  { id: 'room-a', name: 'Existing group' },
] as RoomInfo[]
profiles.fetchProfiles = async () => {}
group.connect = async () => {}
group.loadRooms = async () => {}
group.joinRoom = async roomId => { group.currentRoomId = roomId }
settings.fetchSettings = async () => true

await router.push('/hermes/group-chat')
createApp(RouterView)
  .use(pinia)
  .use(router)
  .use(createI18n({ legacy: false, locale: 'zh', messages: { zh } }))
  .mount('#app')
