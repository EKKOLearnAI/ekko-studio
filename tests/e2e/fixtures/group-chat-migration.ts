import { createApp, h, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { NConfigProvider, darkTheme } from 'naive-ui'
import { createI18n } from 'vue-i18n'
import GroupChatView from '../../../packages/client/src/views/hermes/GroupChatView.vue'
import { useGroupChatStore } from '../../../packages/client/src/stores/hermes/group-chat'
import { useProfilesStore } from '../../../packages/client/src/stores/hermes/profiles'
import { useSettingsStore } from '../../../packages/client/src/stores/hermes/settings'
import type { RoomInfo } from '../../../packages/client/src/api/studio/group-chat'
import { useTheme } from '../../../packages/client/src/composables/useTheme'
import { getThemeOverrides } from '../../../packages/client/src/styles/theme'
import { loadLocaleMessages } from '../../../packages/client/src/i18n/messages'
import '../../../packages/client/src/styles/global.scss'

const locale = new URLSearchParams(location.search).get('locale') || 'zh'
const messages = await loadLocaleMessages(locale as 'zh' | 'en' | 'ar')
document.documentElement.lang = locale
document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
const router = createRouter({ history: createMemoryHistory(), routes: [
  { path: '/', component: { render: () => h('p', 'Other Studio page') } },
  { path: '/groups', name: 'hermes.groupChat', component: GroupChatView },
  { path: '/groups/:roomId', name: 'hermes.groupChatRoom', component: GroupChatView },
] })
const pinia = createPinia()
const group = useGroupChatStore(pinia)
const profiles = useProfilesStore(pinia)
const settings = useSettingsStore(pinia)
group.rooms = new URLSearchParams(location.search).has('empty') ? [] : [
  { id: 'room-a', name: 'Existing group A' },
  { id: 'room-b', name: 'Existing group B' },
] as RoomInfo[]
let ready!: () => void
const loading = new Promise<void>(resolve => { ready = resolve })
profiles.fetchProfiles = async () => { await loading }
group.connect = async () => {}
group.loadRooms = async () => {}
group.joinRoom = async roomId => { group.currentRoomId = roomId }
settings.fetchSettings = async () => true
await router.push('/groups')
const theme = useTheme()
await theme.setBrightness('light')
;(window as any).migrationFixture = {
  ready,
  navigate: (path: string) => router.push(path),
  async theme(dark: boolean, wallpaper = false, opacity?: number) {
    await theme.setBrightness(dark ? 'dark' : 'light')
    theme.previewThemeSettings({ brightness: dark ? 'dark' : 'light', appearance: {
      global: { opacity: 0.7, ...(wallpaper ? { gradientColor: '#4267a8', gradientAngle: 130 } : {}) },
      regions: opacity === undefined ? {} : { overlay: { opacity, radius: 20, blur: 12 } },
    } })
    await nextTick()
  },
  async resetTheme() {
    await theme.setBrightness('light')
    theme.previewThemeSettings({ brightness: 'light', appearance: { global: {}, regions: {} } })
    await nextTick()
  },
}
createApp({ setup: () => () => h(NConfigProvider, {
  theme: theme.isDark.value ? darkTheme : null,
  themeOverrides: getThemeOverrides(theme.isDark.value, theme.isComic.value, theme.customization.value, theme.hasCustomBackground.value),
}, () => h('main', { style: { minHeight: '100vh', background: 'var(--app-background-gradient, var(--bg-primary))' } }, [h(RouterView)])) })
  .use(pinia).use(router).use(createI18n({ legacy: false, locale, messages: { [locale]: messages } })).mount('#app')
