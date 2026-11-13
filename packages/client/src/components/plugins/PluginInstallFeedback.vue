<script setup lang="ts">
import { NAlert, NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'

defineProps<{ description?: string; loading?: boolean; error?: string }>()
const { t } = useI18n()
</script>

<template>
  <div class="install-feedback">
    <p v-if="description">{{ description }}</p>
    <div v-if="loading" class="install-progress" role="status" aria-live="polite">
      <NSpin :size="20" aria-hidden="true" />
      <div><strong>{{ t('studioPlugins.installing') }}</strong><p>{{ t('studioPlugins.installWait') }}</p></div>
    </div>
    <NAlert v-if="error" type="error">{{ error }}</NAlert>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.install-feedback { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.install-feedback p { margin: 0; line-height: 1.7; overflow-wrap: anywhere; }
.install-progress { display: flex; align-items: center; gap: 12px; }
.install-progress > :first-child { flex-shrink: 0; }
.install-progress strong { color: $text-primary; font-weight: 500; }
.install-progress p { color: $text-secondary; font-size: 12px; }
</style>
