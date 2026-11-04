<script setup lang="ts">
import { NButton, NPopconfirm } from 'naive-ui'
import { useI18n } from 'vue-i18n'

defineProps<{ selectedCount: number; canSelectAll: boolean; deleting: boolean }>()
const showConfirm = defineModel<boolean>('showConfirm', { default: false })
const emit = defineEmits<{ 'select-all': []; delete: []; cancel: [] }>()
const { t } = useI18n()
function confirmDelete() { emit('delete'); return false }
</script>

<template>
  <div class="session-list-toolbar">
    <span class="session-selection-count" role="status">{{ t('chat.selectedSessions', { count: selectedCount }) }}</span>
    <div class="session-list-actions">
      <NButton quaternary size="tiny" :disabled="!canSelectAll || deleting" :title="t('chat.selectAll')" :aria-label="t('chat.selectAll')" @click="emit('select-all')">
        <template #icon>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M9 11l3 3L22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
        </template>
      </NButton>
      <NPopconfirm v-if="selectedCount > 0" v-model:show="showConfirm"
        :positive-button-props="{ loading: deleting, disabled: deleting }" :negative-button-props="{ disabled: deleting }" @positive-click="confirmDelete">
        <template #trigger>
          <NButton quaternary size="tiny" :title="t('common.delete')" :aria-label="t('common.delete')" :loading="deleting" :disabled="deleting">
            <template #icon>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </template>
          </NButton>
        </template>
        {{ t('chat.confirmBatchDelete', { count: selectedCount }) }}
      </NPopconfirm>
      <NButton quaternary size="tiny" :disabled="deleting" :title="t('common.cancel')" :aria-label="t('common.cancel')" @click="emit('cancel')">
        <template #icon>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m18 6-12 12M6 6l12 12" /></svg>
        </template>
      </NButton>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.session-list-toolbar {
  display: flex;
  align-items: center;
  gap: calc(8px * var(--spacing-scale, 1));
  margin-top: 8px;
  justify-content: space-between;
}
.session-selection-count {
  min-width: 0;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  color: $text-secondary;
}
.session-list-actions {
  display: flex;
  align-items: center;
  gap: calc(4px * var(--spacing-scale, 1));
  height: 22px;

  .n-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 22px;
    min-height: 22px;
  }
}
</style>
