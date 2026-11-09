<script setup lang="ts">
import { ref } from 'vue'
import { NButton, NInput, NSpace } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { CodingAgentToolStatus } from '@/api/coding-agents'
const props = defineProps<{ info?: CodingAgentToolStatus['compatibility']; busy?: boolean }>()
const emit = defineEmits<{ install: [options: { version?: string; rollback?: boolean }] }>()
const version = ref('')
const { t } = useI18n()
</script>
<template>
  <NSpace vertical data-testid="dsh-versions">
    <small>{{ t('dshVersions.compatibility', { revision: props.info?.adapterRevision ?? 5 }) }}</small>
    <small>{{ t('dshVersions.verified', { version: props.info?.verifiedVersion || '—' }) }}</small>
    <small>{{ t('dshVersions.pinned', { version: props.info?.pinnedVersion || '—' }) }}</small>
    <NInput v-model:value="version" :aria-label="t('dshVersions.version')" :placeholder="t('dshVersions.version')" :disabled="busy" />
    <NSpace>
      <NButton size="small" :disabled="busy || !version.trim()" @click="emit('install', { version: version.trim() })">{{ t('dshVersions.pin') }}</NButton>
      <NButton size="small" :disabled="busy" @click="emit('install', { version: 'latest' })">{{ t('dshVersions.latest') }}</NButton>
      <NButton size="small" :disabled="busy || !props.info?.previousVersion" @click="emit('install', { rollback: true })">{{ t('dshVersions.restore', { version: props.info?.previousVersion || '—' }) }}</NButton>
    </NSpace>
  </NSpace>
</template>
