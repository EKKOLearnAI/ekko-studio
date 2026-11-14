<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AgentUpdatePolicyState } from '@/api/coding-agents'

const props = defineProps<{
  operation?: '' | 'install' | 'rollback' | 'delete' | 'check' | 'policy'
  error?: string
  state?: AgentUpdatePolicyState
  compact?: boolean
}>()
const { t } = useI18n()
const failure = computed(() => props.error || (!props.operation && props.state?.status === 'failed'
  ? props.state.error || t('codingAgents.checkUpdateFailed') : ''))
const status = computed(() => {
  if (props.operation) return t({
    install: 'codingAgents.installing', rollback: 'dshVersions.restoring',
    delete: 'codingAgents.deleting', check: 'codingAgents.checkingUpdate', policy: 'dshVersions.saving',
  }[props.operation])
  switch (props.state?.status) {
    case 'checking': return t('codingAgents.checkingUpdate')
    case 'updating': return t('dshVersions.updating')
    case 'waiting': return t('dshVersions.waiting')
    case 'available': return t('agentManager.updateToVersion', { version: props.state.latestVersion })
    default: return ''
  }
})
</script>

<template>
  <div v-if="status || failure" class="dsh-management-status" :class="{ compact }" data-testid="dsh-management-status">
    <p v-if="status" role="status">{{ status }}</p>
    <p v-if="failure" role="alert" class="failure" :title="compact ? failure : undefined">{{ failure }}</p>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.dsh-management-status { min-width: 0; font-size: calc(var(--font-size-base, 14px) * 12 / 14); color: $text-secondary; overflow-wrap: anywhere; }
p { margin: 0; }
.failure { color: $error; }
.compact p { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
</style>
