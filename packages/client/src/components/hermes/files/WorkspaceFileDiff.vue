<script setup lang="ts">
import { NSpin, NAlert, NButton, NTooltip, useMessage } from 'naive-ui'
import { computed, defineAsyncComponent, ref, watch } from 'vue'

import { useI18n } from 'vue-i18n'
import type { FileEntry, WorkspaceFileDiff } from '@/api/studio/files'
import { fetchSessionWorkspaceFileDiff, readSessionWorkspaceFile } from '@/api/studio/sessions'
import { fetchGroupWorkspaceFileDiff, readGroupWorkspaceFile } from '@/api/studio/group-chat'
import { getLanguageFromPath, isMarkdownFile, useFilesStore } from '@/stores/hermes/files'
import { handleCodeBlockCopyClick, renderHighlightedCodeBlock } from '@/components/hermes/chat/highlight'
import FileTreeToggle from './FileTreeToggle.vue'

const MarkdownRenderer = defineAsyncComponent(async () => (await import('@/components/hermes/chat/MarkdownRenderer.vue')).default)

const props = withDefaults(defineProps<{
  entry: FileEntry
  workspace?: string | null
  workspaceSessionId?: string | null
  workspaceRoomId?: string | null
  showTreeToggle?: boolean
  treeCollapsed?: boolean
}>(), {
  showTreeToggle: false,
  treeCollapsed: false,
})
const emit = defineEmits<{
  close: []
  'toggle-tree': []
}>()
const { t } = useI18n()
const message = useMessage()
const filesStore = useFilesStore()
const loading = ref(false)
const error = ref('')
const diff = ref<WorkspaceFileDiff | null>(null)
const fileContent = ref<string | null>(null)
let requestGeneration = 0

const absolutePath = computed(() => {
  const workspace = String(props.workspace || '').replace(/[\\/]+$/, '')
  if (!workspace) return props.entry.path
  const separator = workspace.includes('\\') && !workspace.includes('/') ? '\\' : '/'
  return `${workspace}${separator}${props.entry.path}`
})

const renderedPatch = computed(() => renderHighlightedCodeBlock(
  diff.value?.patch || '',
  'diff',
  t('common.copy'),
  {
    maxHighlightLength: Number.MAX_SAFE_INTEGER,
    formatDiffFoldLabel: hiddenCount => t('chat.unchangedLines', { count: hiddenCount }),
  },
))
const renderedFile = computed(() => renderHighlightedCodeBlock(
  fileContent.value || '',
  getLanguageFromPath(props.entry.path),
  t('common.copy'),
  { maxHighlightLength: Number.MAX_SAFE_INTEGER },
))

async function loadDiff(): Promise<void> {
  const generation = ++requestGeneration
  loading.value = true
  error.value = ''
  diff.value = null
  fileContent.value = null
  try {
    const result = props.workspaceRoomId
      ? await fetchGroupWorkspaceFileDiff(props.workspaceRoomId, props.entry.path)
      : props.workspaceSessionId
        ? await fetchSessionWorkspaceFileDiff(props.workspaceSessionId, props.entry.path)
        : null
    if (generation !== requestGeneration) return
    if (!result) throw new Error(t('chat.diffUnavailable'))
    diff.value = result
    if (!result.patch && !result.binary && !result.truncated) {
      const file = props.workspaceRoomId
        ? await readGroupWorkspaceFile(props.workspaceRoomId, props.entry.path)
        : props.workspaceSessionId
          ? await readSessionWorkspaceFile(props.workspaceSessionId, props.entry.path)
          : null
      if (generation !== requestGeneration) return
      fileContent.value = file?.content ?? ''
    }
  } catch (loadError) {
    if (generation !== requestGeneration) return
    error.value = loadError instanceof Error ? loadError.message : t('chat.diffUnavailable')
  } finally {
    if (generation === requestGeneration) loading.value = false
  }
}

async function editFile(): Promise<void> {
  try {
    if (props.workspaceRoomId) {
      await filesStore.openGroupWorkspaceEditor(props.workspaceRoomId, props.entry.path)
    } else if (props.workspaceSessionId) {
      await filesStore.openSessionWorkspaceEditor(props.workspaceSessionId, props.entry.path)
    }
  } catch (editError) {
    message.error(editError instanceof Error ? editError.message : t('files.backendError'))
  }
}

async function handleDiffClick(event: MouseEvent): Promise<void> {
  const result = await handleCodeBlockCopyClick(event)
  if (result) message.success(t('common.copied'))
  else if (result === false) message.error(t('chat.copyFailed'))
}

watch(
  () => [props.entry.path, props.workspaceSessionId, props.workspaceRoomId],
  () => { void loadDiff() },
  { immediate: true },
)
</script>

<template>
  <div class="workspace-file-diff">
    <header class="diff-header">
      <div class="diff-file-info">
        <FileTreeToggle
          v-if="props.showTreeToggle"
          :collapsed="props.treeCollapsed"
          @toggle="emit('toggle-tree')"
        />
        <strong class="diff-file-name">{{ entry.name }}</strong>
        <span class="diff-file-path" :title="absolutePath">{{ absolutePath }}</span>
        <span v-if="diff?.patch" class="diff-stats">
          <span class="diff-add">+{{ diff.additions }}</span>
          <span class="diff-del">-{{ diff.deletions }}</span>
        </span>
      </div>
      <div class="diff-actions">
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton
              class="diff-action-button"
              size="small"
              quaternary
              circle
              :aria-label="t('common.edit')"
              @click="editFile"
            >
              <template #icon>
                <svg data-icon="edit" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
              </template>
            </NButton>
          </template>
          {{ t('common.edit') }}
        </NTooltip>
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton
              class="diff-action-button"
              size="small"
              quaternary
              circle
              :aria-label="t('files.closePreview')"
              @click="emit('close')"
            >
              <template #icon>
                <svg data-icon="close" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m18 6-12 12M6 6l12 12" />
                </svg>
              </template>
            </NButton>
          </template>
          {{ t('files.closePreview') }}
        </NTooltip>
      </div>
    </header>
    <main class="diff-content">
      <NSpin v-if="loading" class="diff-loading" />
      <NAlert v-else-if="error" type="error">{{ error }}</NAlert>
      <NAlert v-else-if="diff?.binary || diff?.truncated" type="warning">
        {{ diff.binary ? t('chat.binaryFileDiffUnavailable') : t('chat.diffUnavailable') }}
      </NAlert>
      <div
        v-else-if="diff?.patch"
        class="diff-code"
        v-html="renderedPatch"
        @click="handleDiffClick"
      />
      <div
        v-else-if="fileContent !== null && isMarkdownFile(entry.name)"
        class="workspace-markdown-preview"
      >
        <MarkdownRenderer :content="fileContent" />
      </div>
      <div
        v-else-if="fileContent !== null"
        class="file-code"
        v-html="renderedFile"
        @click="handleDiffClick"
      />
    </main>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.workspace-file-diff {
  flex: 1;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.diff-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex: 0 0 auto;
  padding: 8px 16px;
  border-bottom: 1px solid $border-color;
}

.diff-file-info,
.diff-actions,
.diff-stats {
  display: flex;
  align-items: center;
  gap: 8px;
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
.diff-actions { flex: 0 0 auto; }
.diff-add { color: #2da44e; }
.diff-del { color: #cf222e; }

.diff-action-button {
  :deep(svg) {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
}

.diff-content {
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

.workspace-markdown-preview {
  width: 100%;
  height: 100%;
  overflow: auto;
  box-sizing: border-box;
  padding: 24px clamp(16px, 4vw, 48px);
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }

  :deep(.markdown-body) {
    width: min(800px, 100%);
    margin: 0 auto;
  }
}

.diff-code,
.file-code {
  width: 100%;
  height: 100%;
  overflow: auto;
  box-sizing: border-box;
  min-height: 100%;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }

  :deep(.hljs-code-block) {
    width: 100%;
    min-height: 100%;
    margin: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
  }

  :deep(.hljs-code-block .code-header) {
    display: none;
  }

  :deep(.hljs-code-block code.hljs) {
    scrollbar-width: none;

    &::-webkit-scrollbar {
      display: none;
    }
  }
}

.diff-code {
  :deep(.hljs-code-block.hljs-unified-diff code.hljs) {
    overflow-x: hidden;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  :deep(.hljs-code-block.hljs-unified-diff .diff-line) {
    grid-template-columns: 58px minmax(0, 1fr);
    min-width: 0;
    white-space: normal;
  }

  :deep(.hljs-code-block.hljs-unified-diff .diff-line-content) {
    min-width: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
}

@media (max-width: $breakpoint-mobile) {
  .diff-header {
    align-items: flex-start;
    padding: 8px;
  }

  .diff-file-info {
    align-items: flex-start;
    flex-direction: column;
    gap: 2px;
  }
}
</style>
