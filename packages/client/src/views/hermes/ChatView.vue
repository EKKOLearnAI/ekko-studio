<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import PageLoading from '@/components/common/PageLoading.vue'
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
const initializing = ref(true)
const routeLoading = ref(false)
let routeLoadSequence = 0
let disposed = false
const pageLoading = computed(() => contentMode.value === 'chat' && (
  initializing.value || routeLoading.value || chatStore.isLoadingSessions || chatStore.isLoadingMessages
))
const tabTitle = computed(() => {
  if (route.name !== 'hermes.session' && route.name !== 'desktop.chat') return productTitle
  return chatStore.activeSession?.title?.trim() || productTitle
})

watch(tabTitle, (value) => {
  document.title = value
}, { immediate: true })

onUnmounted(() => {
  disposed = true
  routeLoadSequence++
  document.title = productTitle
})

async function loadRouteSession() {
  const sessionId = routeSessionId.value
  await chatStore.loadSessions(chatStore.sessionProfileFilter, sessionId)
  if (!disposed && sessionId && routeSessionId.value === sessionId && chatStore.activeSessionId !== sessionId) {
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
  const models = appStore.loadModels()
  // 先加载 profile，确保缓存 key 使用正确的 profile name；同时预取显示设置，
  // 让聊天完成提示音不依赖用户先打开 Settings 页面。
  try {
    await Promise.all([
      profilesStore.fetchProfiles(),
      settingsStore.fetchSettings(),
    ])
    if (disposed) return
    chatStore.validateSessionProfileFilter(profilesStore.profiles.map(profile => profile.name))
    do {
      const target = [routeSessionId.value, routeProfile.value].join(':')
      await applyRouteProfile()
      if (disposed) return
      await Promise.all([models, loadRouteSession()])
      if (target === [routeSessionId.value, routeProfile.value].join(':')) break
    } while (!disposed)
  } catch (error) {
    console.error('Failed to initialize chat page:', error)
  } finally {
    initializing.value = false
  }
})

watch([routeSessionId, routeProfile], async ([sessionId]) => {
  if (initializing.value || !chatStore.sessionsLoaded) return
  const sequence = ++routeLoadSequence
  routeLoading.value = true
  try {
    await applyRouteProfile()
    if (disposed || sequence !== routeLoadSequence) return
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
  } catch (error) {
    console.error('Failed to switch chat page:', error)
  } finally {
    if (sequence === routeLoadSequence) routeLoading.value = false
  }
})
</script>

<template>
  <PageLoading :show="pageLoading" :initial-only="contentMode === 'chat'" class="chat-view" :class="{ 'chat-view--standalone': isStandaloneChat }">
    <ChatPanel
      :standalone="isStandaloneChat"
      :content-mode="contentMode"
    />
  </PageLoading>
</template>

<style scoped lang="scss">
.chat-view {
  height: 100%;
  display: flex;
  flex-direction: column;

  &--standalone {
    height: 100%;
  }
}
</style>
