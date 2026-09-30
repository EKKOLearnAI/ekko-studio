<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import PageLoading from '@/components/common/PageLoading.vue'
import { useRoute, useRouter } from 'vue-router'
import GroupChatPanel from '@/components/hermes/group-chat/GroupChatPanel.vue'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSettingsStore } from '@/stores/hermes/settings'

const store = useGroupChatStore()
const profilesStore = useProfilesStore()
const settingsStore = useSettingsStore()
const route = useRoute()
const router = useRouter()
const initializing = ref(true)
const routeLoading = ref(false)
const pageLoading = computed(() => initializing.value || routeLoading.value || store.isJoining)
let routeLoadSequence = 0
let disposed = false
onUnmounted(() => { disposed = true; routeLoadSequence++ })

const routeRoomId = computed(() => {
    const value = route.params.roomId
    return typeof value === 'string' && value.trim() ? value : null
})

const routeProfile = computed(() => {
    const value = route.query?.profile
    return typeof value === 'string' && value.trim() ? value : null
})

async function applyRouteProfile() {
    const profile = routeProfile.value
    if (!profile || profile === profilesStore.activeProfileName) return
    if (!profilesStore.profiles.some(item => item.name === profile)) return
    await profilesStore.switchProfile(profile)
}

async function syncRouteRoom() {
    const roomId = routeRoomId.value
    if (!roomId) {
        if (!store.currentRoomId && store.rooms.length > 0) {
            const firstRoomId = store.rooms[0].id
            await router.replace({ name: 'hermes.groupChatRoom', params: { roomId: firstRoomId } })
            if (!disposed && routeRoomId.value === firstRoomId && store.currentRoomId !== firstRoomId) await store.joinRoom(firstRoomId)
        }
        return
    }

    if (!store.rooms.some(room => room.id === roomId)) {
        await router.replace({ name: 'hermes.groupChat' })
        return
    }

    if (store.currentRoomId !== roomId || store.isJoining) {
        await store.joinRoom(roomId)
    }
}

onMounted(async () => {
    try {
        await profilesStore.fetchProfiles()
        if (disposed) return
        await applyRouteProfile()
        await Promise.all([
            store.connect(),
            store.loadRooms(),
            settingsStore.fetchSettings(),
        ])
        if (disposed) return
        do {
            const target = [routeRoomId.value, routeProfile.value].join(':')
            await applyRouteProfile()
            if (disposed) return
            await syncRouteRoom()
            if (target === [routeRoomId.value, routeProfile.value].join(':')) break
        } while (!disposed)
    } catch (error) {
        console.error('Failed to initialize group chat page:', error)
    } finally {
        initializing.value = false
    }
})

watch([routeRoomId, routeProfile], async () => {
    if (initializing.value) return
    const sequence = ++routeLoadSequence
    routeLoading.value = true
    try {
        await applyRouteProfile()
        if (disposed || sequence !== routeLoadSequence || store.rooms.length === 0) return
        await syncRouteRoom()
    } catch (error) {
        console.error('Failed to switch group chat page:', error)
    } finally {
        if (sequence === routeLoadSequence) routeLoading.value = false
    }
})
</script>

<template>
    <PageLoading :show="pageLoading" initial-only class="group-chat-view">
        <GroupChatPanel />
    </PageLoading>
</template>

<style scoped lang="scss">
.group-chat-view {
    height: 100%;
    display: flex;
    flex-direction: column;
}
</style>
