<script setup lang="ts">
import { NButton, NSpace, NTooltip, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/hermes/files'

const { t } = useI18n()
const message = useMessage()
const filesStore = useFilesStore()

withDefaults(defineProps<{
  allowUpload?: boolean
}>(), {
  allowUpload: true,
})

const emit = defineEmits<{
  (e: 'showNewFile'): void
  (e: 'showNewFolder'): void
  (e: 'showUpload'): void
}>()

async function handleRefresh() {
  try {
    await filesStore.fetchEntries()
  } catch {
    message.error(t('files.backendError'))
  }
}
</script>

<template>
  <div class="file-toolbar">
    <NSpace :size="8" :wrap="true" class="toolbar-space">
      <NTooltip trigger="hover">
        <template #trigger>
          <NButton
            class="toolbar-btn"
            size="small"
            circle
            :aria-label="t('files.newFile')"
            @click="emit('showNewFile')"
          >
            <template #icon>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 3h8l4 4v14H6z" />
                <path d="M14 3v5h5M12 11v6M9 14h6" />
              </svg>
            </template>
          </NButton>
        </template>
        {{ t('files.newFile') }}
      </NTooltip>
      <NTooltip trigger="hover">
        <template #trigger>
          <NButton
            class="toolbar-btn"
            size="small"
            circle
            :aria-label="t('files.newFolder')"
            @click="emit('showNewFolder')"
          >
            <template #icon>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <path d="M12 10v6M9 13h6" />
              </svg>
            </template>
          </NButton>
        </template>
        {{ t('files.newFolder') }}
      </NTooltip>
      <NTooltip v-if="allowUpload" trigger="hover">
        <template #trigger>
          <NButton
            class="toolbar-btn"
            size="small"
            circle
            :aria-label="t('files.upload')"
            @click="emit('showUpload')"
          >
            <template #icon>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 16V4M7 9l5-5 5 5M5 15v5h14v-5" />
              </svg>
            </template>
          </NButton>
        </template>
        {{ t('files.upload') }}
      </NTooltip>
      <NTooltip trigger="hover">
        <template #trigger>
          <NButton
            class="toolbar-btn"
            size="small"
            circle
            :aria-label="t('files.refresh')"
            @click="handleRefresh"
          >
            <template #icon>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M20 12a8 8 0 1 1-2.34-5.66L20 8" />
                <path d="M20 4v4h-4" />
              </svg>
            </template>
          </NButton>
        </template>
        {{ t('files.refresh') }}
      </NTooltip>
    </NSpace>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.file-toolbar {
  padding: calc(12px * var(--spacing-scale, 1)) calc(16px * var(--spacing-scale, 1));

  @media (max-width: $breakpoint-mobile) {
    padding: calc(8px * var(--spacing-scale, 1)) calc(4px * var(--spacing-scale, 1));
  }
}

.toolbar-space {
  @media (max-width: $breakpoint-mobile) {
    :deep(.n-space) {
      gap: 4px !important;
    }
  }
}

.toolbar-btn {
  :deep(svg) {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  @media (max-width: $breakpoint-mobile) {
    height: 32px;
    width: 32px;
  }
}
</style>
