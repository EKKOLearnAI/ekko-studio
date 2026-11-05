<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ChatPanel from '@/components/hermes/chat/ChatPanel.vue'
import { useAppStore } from '@/stores/hermes/app'
import { useChatStore } from '@/stores/hermes/chat'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSettingsStore } from '@/stores/hermes/settings'

const appStore = useAppStore()
const chatStore = useChatStore()
const profilesStore = useProfilesStore()
const settingsStore = useSettingsStore()
const route = useRoute()
const router = useRouter()

const routeSessionId = computed(() => {
  const value = route.params.sessionId
  return typeof value === 'string' && value.trim() ? value : null
})

const routeProfile = computed(() => {
  const value = route.query.profile
  return typeof value === 'string' && value.trim() ? value : null
})

const isStandaloneChat = computed(() => route.meta?.standaloneChat === true)
type ChatContentMode = 'chat' | 'connections' | 'agents' | 'models'

const contentMode = computed<ChatContentMode>(() => {
  if (route.name === 'hermes.connections') return 'connections'
  if (route.name === 'hermes.agentManager') return 'agents'
  if (route.name === 'hermes.models') return 'models'
  return 'chat'
})
const productTitle = 'Ekko Studio'
const tabTitle = computed(() => {
  if (route.name !== 'hermes.session' && route.name !== 'desktop.chat') return productTitle
  return chatStore.activeSession?.title?.trim() || productTitle
})

watch(tabTitle, (value) => {
  document.title = value
}, { immediate: true })

onUnmounted(() => {
  document.title = productTitle
})

async function loadRouteSession() {
  const targetSessionId = routeSessionId.value
  const targetRouteName = String(route.name)
  await chatStore.loadSessions(chatStore.sessionProfileFilter, targetSessionId)
  // 等待期间路由可能已经切到历史页：`/hermes/history/session/:sessionId` 与原聊天路由
  // 共用 params.sessionId，此时 routeSessionId 会变成历史会话 id，命中下面的 replace
  // 就会把用户从「历史」弹回「单聊」。路由/目标已变就直接放弃这次跳转。
  if (String(route.name) !== targetRouteName || routeSessionId.value !== targetSessionId) return
  if (targetSessionId && chatStore.activeSessionId !== targetSessionId) {
    await router.replace({ name: 'hermes.chat' })
  }
}

async function applyRouteProfile() {
  const profile = routeProfile.value
  if (!profile || profile === profilesStore.activeProfileName) return
  if (!profilesStore.profiles.some(item => item.name === profile)) return
  await profilesStore.switchProfile(profile)
  chatStore.setSessionProfileFilter(profile)
}

onMounted(async () => {
  chatStore.setRuntimeMode('default')
  appStore.loadModels()
  // 先加载 profile，确保缓存 key 使用正确的 profile name；同时预取显示设置，
  // 让聊天完成提示音不依赖用户先打开 Settings 页面。
  await Promise.all([
    profilesStore.fetchProfiles(),
    settingsStore.fetchSettings(),
  ])
  chatStore.validateSessionProfileFilter(profilesStore.profiles.map(profile => profile.name))
  await applyRouteProfile()
  await loadRouteSession()
})

watch([routeSessionId, routeProfile], async ([sessionId]) => {
  if (!chatStore.sessionsLoaded) return
  await applyRouteProfile()
  if (!sessionId) {
    await chatStore.loadSessions(chatStore.sessionProfileFilter)
    return
  }
  if (chatStore.activeSessionId === sessionId) return

  const exists = chatStore.sessions.some(session => session.id === sessionId)
  if (!exists) {
    await loadRouteSession()
    return
  }

  await chatStore.switchSession(sessionId)
})
</script>

<template>
  <div class="chat-view" :class="{ 'chat-view--standalone': isStandaloneChat }">
    <ChatPanel
      :standalone="isStandaloneChat"
      :content-mode="contentMode"
    />
  </div>
</template>

<style scoped lang="scss">
.chat-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;

  &--standalone {
    height: 100%;
  }
}
</style>
