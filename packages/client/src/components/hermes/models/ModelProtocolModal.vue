<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NModal, NSelect } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { CodingAgentApiMode } from '@/api/coding-agents'

withDefaults(defineProps<{ show: boolean; value: CodingAgentApiMode; loading?: boolean }>(), { loading: false })
const emit = defineEmits<{
  'update:show': [value: boolean]
  'update:value': [value: CodingAgentApiMode]
  confirm: []
  cancel: []
}>()
const { t } = useI18n()
const options = computed(() => [
  { label: t('codingAgents.protocolOpenAiChat'), value: 'chat_completions' },
  { label: t('codingAgents.protocolOpenAiResponses'), value: 'codex_responses' },
  { label: t('codingAgents.protocolAnthropicMessages'), value: 'anthropic_messages' },
])
function cancel() { emit('update:show', false); emit('cancel') }
</script>

<template>
  <NModal :show="show" preset="dialog" :title="t('codingAgents.protocolScope')" :aria-label="t('codingAgents.protocolScope')"
    :mask-closable="!loading" :close-on-esc="!loading" :closable="!loading"
    style="width: min(420px, calc(100vw - 32px))" @update:show="value => { if (!value) cancel() }">
    <NSelect :value="value" :options="options" :disabled="loading" :aria-label="t('codingAgents.protocolScope')"
      @update:value="emit('update:value', $event)" />
    <template #action>
      <NButton size="small" :disabled="loading" @click="cancel">{{ t('common.cancel') }}</NButton>
      <NButton size="small" type="primary" :loading="loading" @click="emit('confirm')">
        {{ loading ? t('chat.modelSwitching') : t('common.confirm') }}
      </NButton>
    </template>
  </NModal>
</template>
