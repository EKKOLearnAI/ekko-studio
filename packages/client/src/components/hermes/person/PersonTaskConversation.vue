<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NSpin } from 'naive-ui'
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
  insertion?: PersonTaskQueueState['insertion']
  requestingInsertion: string
  insert: (queueId: string) => Promise<void>
  stopControl: { active: boolean; allowSend: boolean; pending: boolean; request: () => Promise<void> }
}>()
const { t } = useI18n()
const store = provideScopedChatStore(props.session.id)
const ready = ref(false)
const chatInputRef = ref<InstanceType<typeof ChatInput> | null>(null)
const queueItems = computed(() => props.pending.map(item => ({ id: item.id, text: item.input.map(block => block.text || block.name || '').join(' ') })))
const activeInsertId = computed(() => props.requestingInsertion || props.insertion?.queueId || null)
const insertTitle = () => t(props.insertion?.phase === 'waiting_for_tool_batch' ? 'chat.queueInsertionWaitingTools' : activeInsertId.value ? 'chat.queueInsertionStopping' : 'chat.insertQueuedMessage')
defineExpose({ addFiles: (files: File[]) => chatInputRef.value?.addFiles(files) })
onMounted(async () => {
  store.ensureSessionLoaded(props.session)
  await store.switchSession(props.session.id)
  ready.value = true
})
</script>

<template>
  <NSpin v-if="!ready" />
  <template v-else>
    <MessageList />
    <div v-if="pending.length" class="task-chat-queue" role="status">
      <MessageQueueFloatPanel :items="queueItems" :can-insert="canInsert" :can-remove="false" :active-insert-id="activeInsertId" :insert-title="insertTitle" @insert="insert" />
    </div>
    <ChatInput ref="chatInputRef" hide-settings :submit="send" :send-disabled="disabled" :stop-control="stopControl" :model-label="session.model || ''" model-disabled reasoning-effort-disabled />
  </template>
</template>

<style scoped lang="scss">
.task-chat-queue { flex-shrink: 0; max-height: 180px; overflow: auto; display: flex; justify-content: flex-end; padding: 8px 16px; overflow-wrap: anywhere; }
</style>
