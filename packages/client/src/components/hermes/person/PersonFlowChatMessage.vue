<script setup lang="ts">
import { computed,provide } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PersonFlowMessage } from '@/api/person'
import type { Message } from '@/stores/hermes/chat'
import MessageItem from '../chat/MessageItem.vue'
import { chatSessionAgentAvatar } from '@/utils/chat-agent-avatar'
import { personWorkspacePreviewContext } from './task-navigation'
const props = defineProps<{entry:PersonFlowMessage}>()
const {t} = useI18n()
provide(personWorkspacePreviewContext,computed(() => ({sessionId:props.entry.session_id})))
const message = computed<Message>(() => ({id:`flow-chat:${props.entry.session_id}:${props.entry.id}`,role:props.entry.role,content:props.entry.content,timestamp:props.entry.timestamp*1000}))
const avatar = computed(() => chatSessionAgentAvatar({id:props.entry.session_id,title:props.entry.session_title,bot_type:props.entry.bot_type || undefined}))
</script>

<template>
  <MessageItem :message="message" :assistant-agent="avatar" :user-profile-name="t('person.you')" hide-reasoning hide-run-usage read-only />
</template>
