<script setup lang="ts">
import PageLoading from '@/components/common/PageLoading.vue'
import { computed, ref, onMounted, onUnmounted, watch } from 'vue'
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

async function loadRouteSession() {
  await chatStore.loadSessions(chatStore.sessionProfileFilter, routeSessionId.value)
  if (routeSessionId.value && chatStore.activeSessionId !== routeSessionId.value) {
    await router.replace({ name: 'hermes.globalAgent' })
  }
}

async function applyRouteProfile() {
  const profile = routeProfile.value
  if (!profile || profile === profilesStore.activeProfileName) return
  if (!profilesStore.profiles.some(item => item.name === profile)) return
  await profilesStore.switchProfile(profile)
  chatStore.setSessionProfileFilter(profile)
}

const initializing = ref(true)

onMounted(async () => {
  try {
    chatStore.setRuntimeMode('global_agent')
    await Promise.all([
      appStore.loadModels(),
      profilesStore.fetchProfiles(),
      settingsStore.fetchSettings(),
    ])
    chatStore.validateSessionProfileFilter(profilesStore.profiles.map(profile => profile.name))
    await applyRouteProfile()
    await loadRouteSession()
  } finally {
    initializing.value = false
  }
})

onUnmounted(() => {
  chatStore.setRuntimeMode('default')
})

watch([routeSessionId, routeProfile], async ([sessionId]) => {
  if (chatStore.runtimeMode !== 'global_agent' || !chatStore.sessionsLoaded) return
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
  <PageLoading :show="initializing || chatStore.isLoadingSessions || chatStore.isLoadingMessages" class="global-agent-view">
    <ChatPanel />
  </PageLoading>
</template>

<style scoped lang="scss">
.global-agent-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}
</style>
