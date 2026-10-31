<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NSpin } from 'naive-ui'
import type { SessionSummary } from '@/api/studio/sessions'
import MessageList from '@/components/hermes/chat/MessageList.vue'
import ChatInput from '@/components/hermes/chat/ChatInput.vue'
import MessageQueueFloatPanel from '@/components/hermes/chat/MessageQueueFloatPanel.vue'
import type { PersonTaskQueueState } from '@/api/person'
import { provideScopedChatStore, type Attachment } from '@/stores/hermes/chat'
const props = defineProps<{
  session: SessionSummary
  pending: { id: string; input: { type: string; text?: string; name?: string }[] }[]
  send: (text: string, attachments?: Attachment[]) => Promise<boolean>
  disabled: boolean
  canInsert: boolean
  canRemove: boolean
  insertion?: PersonTaskQueueState['insertion']
  requestingInsertion: string
  requestingRemoval: string
  queueDisabled: boolean
  insert: (queueId: string) => Promise<void>
  remove: (queueId: string) => Promise<void>
  stopControl: { active: boolean; allowSend: boolean; pending: boolean; request: () => Promise<void> }
}>()
const { t } = useI18n()
const store = provideScopedChatStore(props.session.id)
const ready = ref(false)
const loading = ref(true)
const failed = ref(false)
let disposed = false
const chatInputRef = ref<InstanceType<typeof ChatInput> | null>(null)
const activeInsertId = computed(() => props.requestingInsertion || props.insertion?.queueId || null)
const queueItems = computed(() => props.pending.map(item => ({ id: item.id, text: item.input.map(block => block.text || block.name || '').join(' '), removeDisabled: activeInsertId.value === item.id })))
const insertTitle = () => t(props.insertion?.phase === 'waiting_for_tool_batch' ? 'chat.queueInsertionWaitingTools' : activeInsertId.value ? 'chat.queueInsertionStopping' : 'chat.insertQueuedMessage')
defineExpose({ addFiles: (files: File[]) => chatInputRef.value?.addFiles(files) })
async function load() {
  loading.value = true; failed.value = false
  try {
    store.ensureSessionLoaded(props.session)
    const loaded = await store.switchSession(props.session.id)
    if (!disposed) { ready.value = loaded; failed.value = !loaded }
  } catch { if (!disposed) failed.value = true }
  finally { if (!disposed) loading.value = false }
}
onMounted(load)
onBeforeUnmount(() => { disposed = true })
</script>

<template>
  <NSpin v-if="loading" />
  <NAlert v-else-if="failed" type="error">
    {{ t('sessionTasks.loadFailed') }} <NButton size="small" @click="load">{{ t('sessionTasks.retry') }}</NButton>
  </NAlert>
  <template v-else-if="ready">
    <MessageList />
    <div v-if="pending.length" class="task-chat-queue" role="status" :aria-busy="!!requestingRemoval">
      <MessageQueueFloatPanel :items="queueItems" :can-insert="canInsert" :can-remove="canRemove" :remove-disabled="queueDisabled" :active-insert-id="activeInsertId" :insert-title="insertTitle" @insert="insert" @remove="remove" />
    </div>
    <ChatInput ref="chatInputRef" hide-settings :submit="send" :send-disabled="disabled" :stop-control="stopControl" :model-label="session.model || ''" model-disabled reasoning-effort-disabled />
  </template>
</template>

<style scoped lang="scss">
.task-chat-queue { flex-shrink: 0; max-height: 180px; overflow: auto; display: flex; justify-content: flex-end; padding: 8px 16px; overflow-wrap: anywhere; }
</style>
