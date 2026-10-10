<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAppStore } from '@/stores/hermes/app'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useI18n } from 'vue-i18n'
import ModelCascader from '@/components/hermes/models/ModelCascader.vue'

const { t } = useI18n()
const appStore = useAppStore()
const profilesStore = useProfilesStore()
const activeModelGroups = computed(() => appStore.profileModelGroups.find(
  entry => entry.profile === (profilesStore.activeProfileName || 'default'),
)?.groups || [])
const selectedDisplayName = computed(() => activeModelGroups.value.some(group =>
  group.provider === appStore.selectedProvider && [...group.models, ...(appStore.customModels[group.provider] || [])].includes(appStore.selectedModel),
) ? appStore.displayModelName(appStore.selectedModel, appStore.selectedProvider) : '')
const refreshing = ref(false)

async function handleRefresh() {
  if (refreshing.value) return
  refreshing.value = true
  const startedAt = Date.now()
  try { await appStore.reloadModels({ preserveSelection: true }) }
  finally {
    const remaining = 600 - (Date.now() - startedAt)
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining))
    refreshing.value = false
  }
}
</script>

<template>
  <div class="model-selector">
    <div class="model-label-row">
      <div class="model-label">{{ t('models.title') }}</div>
      <button class="model-refresh" type="button" :disabled="refreshing" :title="t('models.refresh')" :aria-label="t('models.refresh')" @click="handleRefresh">
        <svg :class="{ spinning: refreshing }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
      </button>
    </div>
    <ModelCascader :groups="activeModelGroups" :provider="appStore.selectedProvider" :model="appStore.selectedModel" removable-custom
      @select="appStore.switchModel($event.model, $event.provider)">
      <template #trigger="{ show, openWithKeyboard }">
        <button class="model-trigger" type="button" aria-haspopup="menu" :aria-expanded="show" @keydown.down="openWithKeyboard">
          <span class="model-name" :title="appStore.selectedModel">{{ selectedDisplayName || '—' }}</span>
          <svg class="model-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
        </button>
      </template>
    </ModelCascader>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.model-selector { padding: 0 12px; margin-bottom: 8px; }
.model-label-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.model-label { font-size: 11px; font-weight: 600; color: $text-muted; text-transform: uppercase; letter-spacing: 0.5px; }
.model-refresh { display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0; border: 0; border-radius: $radius-sm; background: transparent; color: $text-muted; cursor: pointer;
  &:hover:not(:disabled) { background: $bg-secondary; color: $text-primary; }
  &:disabled { cursor: default; opacity: 0.7; }
  svg.spinning { animation: model-refresh-spin 0.8s linear infinite; }
}
@keyframes model-refresh-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.model-trigger { display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 8px; background: $bg-input; border: 1px solid $border-color; border-radius: $radius-sm; color: $text-primary; font-size: 13px; cursor: pointer;
  &:hover { border-color: $accent-muted; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 2px; }
}
.model-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: start; }
.model-arrow { flex-shrink: 0; color: $text-muted; }
</style>
