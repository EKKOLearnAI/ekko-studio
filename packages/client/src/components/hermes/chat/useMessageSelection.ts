import { computed, ref, watch, type ComputedRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import { fetchMessageSelection, type MessageSelectionGroup } from '@/api/studio/sessions'
import { useChatStore, type Message } from '@/stores/hermes/chat'
import { isBuiltinEkkoSession, isHermesSession } from '@/utils/hermes/session-agent'
import { buildMessageSelectionRows } from './message-selection'

export function useMessageSelection(messages: ComputedRef<Message[]>) {
  const store = useChatStore()
  const { t } = useI18n()
  const toast = useMessage()
  const selecting = ref(false)
  const loading = ref(false)
  const deleting = ref(false)
  const groups = ref<MessageSelectionGroup[]>([])
  const revision = ref(0)
  const selected = ref(new Set<number>())
  let generation = 0
  const supported = computed(() => {
    const session = store.activeSession
    return !!session && !session.isLocalOnly && !session.id.startsWith('person-task-')
      && ['cli', 'api_server', 'desktop', 'builtin_agent'].includes(session.source || '')
      && (isHermesSession(session) || isBuiltinEkkoSession(session))
  })
  const executionBusy = computed(() => !!store.activeSessionId && (
    store.isSessionWorking(store.activeSessionId) || store.isAborting
    || (store.queueLengths?.get(store.activeSessionId) || 0) > 0
    || !!store.compressionState?.compressing
  ))
  const unavailable = computed(() => !store.activeSessionId || executionBusy.value
    || store.isLoadingMessages || loading.value || deleting.value)
  const rows = computed(() => selecting.value
    ? buildMessageSelectionRows(messages.value, groups.value)
    : messages.value.map(message => ({ id: message.id, messages: [message], group: undefined })))
  const visibleGroups = computed(() => rows.value.flatMap(row => row.group && !row.group.deleteBlockedReason ? [row.group.id] : []))

  function cancel() {
    generation += 1
    selecting.value = false
    selected.value = new Set()
    groups.value = []
  }

  async function start() {
    const sid = store.activeSessionId
    if (!sid || unavailable.value) return
    const profile = store.activeSession?.profile
    const token = ++generation
    const canApply = () => generation === token && store.activeSessionId === sid && !executionBusy.value
    loading.value = true
    try {
      // Stream-only IDs are not deletion identities. Hydrate persisted rows first.
      const refreshed = await store.refreshActiveSession({ canApply })
      if (!canApply()) return
      if (!refreshed) throw new Error(t('chat.messageSelectionFailed'))
      const result = await fetchMessageSelection(sid, profile)
      if (!canApply()) return
      groups.value = result.groups
      revision.value = result.historyRevision
      selecting.value = true
    } catch (error: any) {
      if (generation === token) toast.error(error?.message || t('chat.messageSelectionFailed'))
    } finally {
      loading.value = false
    }
  }

  function toggle(id: number, checked: boolean) {
    if (!visibleGroups.value.includes(id) || unavailable.value) return
    const next = new Set(selected.value)
    if (checked) next.add(id)
    else next.delete(id)
    selected.value = next
  }

  async function remove() {
    const sid = store.activeSessionId
    if (!sid || unavailable.value || !selected.value.size) return false
    const token = generation
    deleting.value = true
    try {
      const result = await store.deleteMessages(sid, [...selected.value], revision.value)
      if (generation === token) cancel()
      toast.success(t('chat.messagesDeleted', { count: result.deletedGroups }))
    } catch (error: any) {
      toast.error(error?.message || t('chat.messageDeleteFailed'))
      return false
    } finally {
      deleting.value = false
    }
  }

  watch([
    () => store.activeSessionId,
    () => store.activeSession?.historyRevision,
    () => store.focusMessageId,
    executionBusy,
  ], () => cancel(), { flush: 'sync' })
  return { selecting, loading, deleting, selected, supported, unavailable, rows, start, cancel, toggle, remove }
}
