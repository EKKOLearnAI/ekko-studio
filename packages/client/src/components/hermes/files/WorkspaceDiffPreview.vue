<script setup lang="ts">
import { NSpin, NButton, useMessage } from 'naive-ui'
import { computed, defineAsyncComponent, ref, watch } from 'vue'

import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/hermes/files'
import { useToolPanelStore } from '@/stores/hermes/tool-panel'
import {
  handleCodeBlockCopyClick,
  renderHighlightedCodeBlock,
} from '@/components/hermes/chat/highlight'

const { t } = useI18n()
const FileEditor = defineAsyncComponent(async () => (await import('./FileEditor.vue')).default)
const message = useMessage()
const filesStore = useFilesStore()
const toolPanelStore = useToolPanelStore()
const props = defineProps<{ customClose?: () => void }>()
const mode = ref<'diff' | 'edit'>('diff')

const state = computed(() => toolPanelStore.workspaceDiff)
const fileName = computed(() => {
  const path = state.value?.file.path || ''
  return path.split(/[\\/]/).filter(Boolean).pop() || path
})
const absolutePath = computed(() => {
  const current = state.value
  if (!current) return ''
  const workspace = current.workspace.replace(/[\\/]+$/, '')
  if (!workspace) return current.file.path
  const separator = workspace.includes('\\') && !workspace.includes('/') ? '\\' : '/'
  return `${workspace}${separator}${current.file.path}`
})
const displayedPatch = computed(() => {
  const current = state.value
  if (!current) return ''
  if (current.file.binary) return t('chat.binaryFileDiffUnavailable')
  if (current.unavailable) return t('chat.diffUnavailable')
  return current.patch
})
const renderedPatch = computed(() => renderHighlightedCodeBlock(
  displayedPatch.value,
  'diff',
  t('common.copy'),
  {
    maxHighlightLength: Number.MAX_SAFE_INTEGER,
    formatDiffFoldLabel: hiddenCount => t('chat.unchangedLines', { count: hiddenCount }),
  },
))

watch(() => state.value, () => {
  mode.value = 'diff'
})

async function editFile(): Promise<void> {
  const current = state.value
  if (!current || !current.editable || current.file.binary || !current.file.session_id) return
  try {
    await filesStore.openSessionWorkspaceEditor(current.file.session_id, current.file.path)
    mode.value = 'edit'
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('chat.diffUnavailable'))
  }
}

function closeEditor(): void {
  if (filesStore.hasUnsavedChanges) {
    message.warning(t('files.unsavedChanges'))
    return
  }
  filesStore.closeEditor()
  mode.value = 'diff'
}

function closePreview(): void {
  if (mode.value === 'edit' && filesStore.hasUnsavedChanges) {
    message.warning(t('files.unsavedChanges'))
    return
  }
  if (mode.value === 'edit') filesStore.closeEditor()
  if (props.customClose) props.customClose()
  else toolPanelStore.closeWorkspaceDiff()
}

async function handleDiffClick(event: MouseEvent): Promise<void> {
  const result = await handleCodeBlockCopyClick(event)
  if (result) message.success(t('common.copied'))
  else if (result === false) message.error(t('chat.copyFailed'))
}
</script>

<template>
  <div v-if="state" class="workspace-diff-preview">
    <header class="diff-preview-header">
      <div class="diff-file-info">
        <strong class="diff-file-name">{{ fileName }}</strong>
        <span class="diff-file-path" :title="absolutePath">{{ absolutePath }}</span>
        <span class="diff-stats">
          <span class="diff-add">+{{ state.file.additions }}</span>
          <span class="diff-del">-{{ state.file.deletions }}</span>
        </span>
      </div>
      <div class="diff-actions">
        <NButton
          v-if="state.editable"
          size="small"
          secondary
          :disabled="state.file.binary"
          @click="editFile"
        >
          {{ t('common.edit') }}
        </NButton>
        <NButton size="small" quaternary @click="closePreview">
          {{ t('files.closePreview') }}
        </NButton>
      </div>
    </header>
    <main class="diff-preview-content">
      <NSpin v-if="state.loading" class="diff-loading" />
      <FileEditor
        v-else-if="mode === 'edit' && filesStore.editingFile"
        :custom-close="closeEditor"
      />
      <div
        v-else
        class="diff-code"
        v-html="renderedPatch"
        @click="handleDiffClick"
      />
    </main>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.workspace-diff-preview {
  flex: 1;
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  min-width: 0;
  min-height: 0;
}

.diff-preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex: 0 0 auto;
  padding: 8px 16px;
  border-bottom: 1px solid $border-color;
}

.diff-file-info {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.diff-file-name {
  flex: 0 0 auto;
  color: $text-primary;
  font-size: 13px;
}

.diff-file-path {
  min-width: 0;
  overflow: hidden;
  color: $text-muted;
  font-family: $font-code;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.diff-stats,
.diff-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.diff-add { color: #2da44e; }
.diff-del { color: #cf222e; }

.diff-preview-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.diff-loading {
  display: flex;
  justify-content: center;
  margin-top: 24px;
}

.diff-code {
  height: 100%;
  overflow: auto;
  padding: 12px;

  :deep(.hljs-code-block) {
    min-height: 100%;
    margin: 0;
  }
}

:deep(.file-editor) {
  height: 100%;
  width: 100%;
  min-width: 0;
  min-height: 0;
}

@media (max-width: $breakpoint-mobile) {
  .diff-preview-header {
    align-items: flex-start;
    padding: 8px;
  }

  .diff-file-info {
    align-items: flex-start;
    flex-direction: column;
    gap: 2px;
  }

  .diff-stats {
    gap: 6px;
  }
}
</style>
