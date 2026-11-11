<script setup lang="ts">
import { computed,provide } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Message } from '@/stores/hermes/chat'
import MessageItem from '../chat/MessageItem.vue'
import { chatSessionAgentAvatar } from '@/utils/chat-agent-avatar'
import { personWorkspacePreviewContext } from './task-navigation'
const props = defineProps<{message:Message;session:{id:string;title?:string | null;bot_type?:string | null}}>()
const {t} = useI18n()
provide(personWorkspacePreviewContext,computed(() => ({sessionId:props.session.id})))
const avatar = computed(() => chatSessionAgentAvatar({...props.session,bot_type:props.session.bot_type || undefined}))
</script>

<template>
  <MessageItem :message="message" :assistant-agent="avatar" :user-profile-name="t('person.you')" hide-reasoning hide-run-usage read-only />
</template>
