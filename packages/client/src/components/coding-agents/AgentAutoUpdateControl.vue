<script setup lang="ts">
import { NSwitch } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { AgentUpdatePolicyState } from '@/api/coding-agents'
defineProps<{ state: AgentUpdatePolicyState; disabled?: boolean }>()
defineEmits<{ change: [enabled: boolean] }>()
const { t } = useI18n()
</script>

<template>
  <div class="agent-update-policy">
    <div class="agent-update-policy-row">
      <span>{{ t('agentAutoUpdate.label') }}</span>
      <NSwitch class="agent-update-switch" size="small" :aria-label="t('agentAutoUpdate.label')" :aria-disabled="disabled || !state.autoUpdateSupported" :theme-overrides="{ railHeightSmall: '16px', railWidthSmall: '28px', buttonHeightSmall: '12px', buttonWidthSmall: '12px' }" :disabled="disabled || !state.autoUpdateSupported" :value="state.autoUpdate" @update:value="$emit('change', $event)" />
    </div>
    <small v-if="state.autoUpdateSupported && state.error" class="agent-update-error">{{ t('codingAgents.checkUpdateFailed') }}</small>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.agent-update-policy { min-width: 0; width: 100%; box-sizing: border-box; padding-top: calc(10px * var(--spacing-scale, 1)); border-top: var(--border-width, 1px) solid $border-color; }
.agent-update-policy-row { display: flex; justify-content: space-between; align-items: center; gap: calc(12px * var(--spacing-scale, 1)); font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
.agent-update-error { display: block; margin-top: 6px; overflow-wrap: anywhere; color: $error; }
</style>
