import { computed, ref, watch, type ComputedRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import { getGroupMessageSelection, type ChatMessage, type GroupMessageSelectionGroup } from '@/api/studio/group-chat'
import { useGroupChatStore } from '@/stores/hermes/group-chat'

export function useGroupMessageSelection(messages: ComputedRef<ChatMessage[]>, supported: ComputedRef<boolean>) {
    const store = useGroupChatStore()
    const { t } = useI18n()
    const toast = useMessage()
    const selecting = ref(false)
    const loading = ref(false)
    const deleting = ref(false)
    const selected = ref(new Set<string>())
    const groups = ref<GroupMessageSelectionGroup[]>([])
    const revision = ref('')
    let generation = 0
    const busy = computed(() => !!store.currentRoomId && (
        store.activeAgentRunsForRoom(store.currentRoomId).length > 0
        || store.contextStatuses.size > 0 || store.executionQueue.length > 0
        || store.messages.some(message => message.isStreaming || message.finish_reason === 'streaming')
        || store.roomSummaryStates.get(store.currentRoomId)?.status === 'summarizing'
    ))
    const unavailable = computed(() => !supported.value || !store.currentRoomId || busy.value
        || store.isJoining || store.isLoadingOlderMessages || loading.value || deleting.value)
    const byMessage = computed(() => new Map(groups.value.flatMap(group => group.messageIds.map(id => [id, group] as const))))
    function groupFor(message: ChatMessage) {
        return (message.runItems || [message]).map(item => byMessage.value.get(item.id)).find(Boolean)
    }
    const visibleGroups = computed(() => new Set(messages.value.flatMap(message => {
        const group = groupFor(message)
        return group && !group.deleteBlockedReason ? [group.id] : []
    })))
    function cancel() {
        generation++
        selecting.value = false
        groups.value = []
        selected.value = new Set()
    }
    async function start() {
        const roomId = store.currentRoomId
        if (!roomId || unavailable.value) return
        const token = ++generation
        loading.value = true
        try {
            const result = await getGroupMessageSelection(roomId)
            if (generation !== token || store.currentRoomId !== roomId || busy.value || !supported.value) return
            groups.value = result.groups
            revision.value = result.historyRevision
            selecting.value = true
        } catch (error: any) {
            if (generation === token) toast.error(error?.message || t('chat.messageSelectionFailed'))
        } finally { loading.value = false }
    }
    function toggle(id: string, checked: boolean) {
        if (unavailable.value || !visibleGroups.value.has(id)) return
        const next = new Set(selected.value)
        if (checked) next.add(id)
        else next.delete(id)
        selected.value = next
    }
    async function remove() {
        const roomId = store.currentRoomId
        if (!roomId || unavailable.value || !selected.value.size) return false
        const token = generation
        deleting.value = true
        try {
            const result = await store.deleteMessages(roomId, [...selected.value], revision.value)
            if (generation === token) cancel()
            toast.success(t('chat.messagesDeleted', { count: result.deletedGroups }))
        } catch (error: any) {
            if (generation === token) cancel()
            toast.error(error?.message || t('chat.messageDeleteFailed'))
            return false
        } finally { deleting.value = false }
    }
    watch([
        () => store.currentRoomId, supported, busy,
        () => store.currentRoomId ? store.messageDeletionRevisions.get(store.currentRoomId) : 0,
        () => store.currentRoomId ? store.roomSummaryStates.get(store.currentRoomId)?.version : 0,
        // New messages invalidate selection; loading older pages keeps it intact.
        () => store.messages.at(-1)?.id,
    ], cancel, { flush: 'sync' })
    return { selecting, loading, deleting, selected, unavailable, groupFor, start, cancel, toggle, remove }
}
