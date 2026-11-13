<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NModal, useDialogReactiveList } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { AvailableModelGroup } from '@/api/hermes/system'
import { usePageLoadingState } from '@/composables/usePageLoading'

defineProps<{ show: boolean; providers: AvailableModelGroup[] }>()
const emit = defineEmits<{ 'update:show': [value: boolean]; manage: [provider: string] }>()
const { t } = useI18n()
const pageLoading = usePageLoadingState()
const dialogs = useDialogReactiveList()
const confirmationOpen = computed(() => dialogs.value.length > 0)
</script>

<template>
  <NModal
    :show="show && !pageLoading && !confirmationOpen"
    preset="dialog"
    type="warning"
    :title="t('models.largeCatalogTitle')"
    :style="{ width: 'min(560px, calc(100vw - 32px))' }"
    :negative-text="t('models.largeCatalogLater')"
    @negative-click="emit('update:show', false)"
    @update:show="emit('update:show', $event)"
  >
    <div data-testid="large-model-catalog-notice">
      <p class="large-catalog-hint">{{ t('models.largeCatalogHint') }}</p>
      <ul class="large-catalog-list">
        <li v-for="provider in providers" :key="provider.provider">
          <span>{{ t('models.largeCatalogProviderCount', { name: provider.label, count: provider.models.length }) }}</span>
          <NButton size="small" @click="emit('manage', provider.provider)">
            {{ t('models.manageVisibleModels') }}
          </NButton>
        </li>
      </ul>
    </div>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.large-catalog-hint {
  margin: 0 0 16px;
  color: $text-secondary;
  line-height: var(--line-height, 1.6);
}

.large-catalog-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 50vh;
  overflow-y: auto;

  li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: calc(8px * var(--spacing-scale, 1));
    padding: calc(10px * var(--spacing-scale, 1)) 0;
    border-bottom: var(--border-width, 1px) solid $border-light;
  }

  span {
    min-width: 0;
    overflow-wrap: anywhere;
  }
}

</style>
