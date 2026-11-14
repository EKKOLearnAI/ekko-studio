<script setup lang="ts">
import { useId } from 'vue'
import { NButton, NInput } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { CodingAgentToolStatus } from '@/api/coding-agents'
const props = defineProps<{ info?: CodingAgentToolStatus['compatibility']; busy?: boolean; currentVersion?: string }>()
const emit = defineEmits<{ install: [options: { version?: string; rollback?: boolean }] }>()
const version = defineModel<string>('version', { default: '' })
const inputId = useId()
const { t } = useI18n()
</script>
<template>
  <div class="dsh-versions" data-testid="dsh-versions" :aria-busy="busy">
    <div class="version-details">
      <p v-if="currentVersion">{{ t('dshVersions.current', { version: currentVersion }) }}</p>
      <p>{{ t('dshVersions.compatibility', { revision: props.info?.adapterRevision ?? '—' }) }}</p>
      <p>{{ t('dshVersions.verified', { version: props.info?.verifiedVersion || '—' }) }}</p>
      <p>{{ t('dshVersions.pinned', { version: props.info?.pinnedVersion || t('dshVersions.notPinned') }) }}</p>
    </div>
    <form class="version-form" @submit.prevent="!busy && version.trim() && emit('install', { version: version.trim() })">
      <label :for="inputId">{{ t('dshVersions.version') }}</label>
      <NInput v-model:value="version" :input-props="{ id: inputId, 'aria-label': t('dshVersions.version') }" :placeholder="t('dshVersions.version')" :disabled="busy" />
      <NButton attr-type="submit" type="primary" :disabled="busy || !version.trim()">{{ t('dshVersions.pin') }}</NButton>
    </form>
    <div class="version-actions">
      <p class="version-hint">{{ t('dshVersions.latestHint') }}</p>
      <NButton size="small" :disabled="busy" @click="emit('install', { version: 'latest' })">{{ t('dshVersions.latest') }}</NButton>
      <NButton size="small" :disabled="busy || !props.info?.previousVersion" @click="emit('install', { rollback: true })">{{ t('dshVersions.restore', { version: props.info?.previousVersion || '—' }) }}</NButton>
      <p v-if="!props.info?.previousVersion" class="version-hint">{{ t('dshVersions.noPrevious') }}</p>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.dsh-versions { display: flex; flex-direction: column; gap: calc(24px * var(--spacing-scale, 1)); min-width: 0; }
.version-details { display: grid; gap: calc(8px * var(--spacing-scale, 1)); overflow-wrap: anywhere; }
p { margin: 0; }
.version-form, .version-actions { display: flex; flex-direction: column; align-items: stretch; gap: calc(10px * var(--spacing-scale, 1)); min-width: 0; }
.version-hint { font-size: calc(var(--font-size-base, 14px) * 12 / 14); color: $text-secondary; overflow-wrap: anywhere; }
.version-actions :deep(.n-button__content), .version-form :deep(.n-button__content) { white-space: normal; overflow-wrap: anywhere; }
.version-actions :deep(.n-button), .version-form :deep(.n-button) { height: auto; min-height: 34px; padding-block: calc(6px * var(--spacing-scale, 1)); }
</style>
