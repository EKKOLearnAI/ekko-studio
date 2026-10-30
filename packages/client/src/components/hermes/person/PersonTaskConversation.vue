<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NSpin } from 'naive-ui'
import type { SessionSummary } from '@/api/studio/sessions'
import MessageList from '@/components/hermes/chat/MessageList.vue'
import ChatInput from '@/components/hermes/chat/ChatInput.vue'
import { provideScopedChatStore, type Attachment } from '@/stores/hermes/chat'
const props = defineProps<{
  session: SessionSummary
  pending: { id: string; input: { type: string; text?: string; name?: string }[] }[]
  send: (text: string, attachments?: Attachment[]) => Promise<boolean>
  disabled: boolean
  stopControl: { active: boolean; allowSend: boolean; pending: boolean; request: () => Promise<void> }
}>()
const { t } = useI18n()
const store = provideScopedChatStore(props.session.id)
const ready = ref(false)
const chatInputRef = ref<InstanceType<typeof ChatInput> | null>(null)
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
      <span>{{ t('person.followupsQueued', { count: pending.length }) }}</span>
      <ol><li v-for="item in pending" :key="item.id">{{ item.input.map(block => block.text || block.name || '').join(' ') }}</li></ol>
    </div>
    <ChatInput ref="chatInputRef" hide-settings :submit="send" :send-disabled="disabled" :stop-control="stopControl" :model-label="session.model || ''" model-disabled reasoning-effort-disabled />
  </template>
</template>

<style scoped lang="scss">
.task-chat-queue { flex-shrink: 0; max-height: 120px; overflow: auto; padding: 8px 16px; overflow-wrap: anywhere; }
.task-chat-queue ol { margin: 4px 0; padding-inline-start: 20px; }
</style>
