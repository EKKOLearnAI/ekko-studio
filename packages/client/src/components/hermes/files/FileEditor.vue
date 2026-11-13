<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { useTheme } from '@/composables/useTheme'
import { editorTheme } from '@/styles/theme-integrations'
import { NButton, NSpace, useMessage, useDialog } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/hermes/files'
import FileTreeToggle from './FileTreeToggle.vue'
import * as monaco from 'monaco-editor'

// Configure Monaco workers using import.meta.url
;(self as any).MonacoEnvironment = {
  getWorker(_: any, _label: string) {
    return new Worker(
      new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
      { type: 'module' }
    )
  },
}

const { t } = useI18n()
const message = useMessage()
const dialogApi = useDialog()
const filesStore = useFilesStore()
const props = withDefaults(defineProps<{
  customClose?: () => void
  showTreeToggle?: boolean
  treeCollapsed?: boolean
}>(), {
  showTreeToggle: false,
  treeCollapsed: false,
})
const emit = defineEmits<{
  'toggle-tree': []
}>()

const editorContainer = ref<HTMLElement | null>(null)
let editor: monaco.editor.IStandaloneCodeEditor | null = null
const saving = ref(false)
const { isDark, customization } = useTheme()

function syncEditorTheme() {
  if (!editor) return
  monaco.editor.defineTheme('studio', editorTheme(customization.value, isDark.value))
  monaco.editor.setTheme('studio')
  editor.updateOptions({
    fontSize: customization.value.fontSize * 13 / 14,
    lineHeight: customization.value.appearance?.global.lineHeight ?? 0,
    letterSpacing: customization.value.appearance?.global.letterSpacing ?? 0,
  })
}
watch([isDark, customization], syncEditorTheme)

onMounted(() => {
  if (!editorContainer.value || !filesStore.editingFile) return

  editor = monaco.editor.create(editorContainer.value, {
    value: filesStore.editingFile.content,
    language: filesStore.editingFile.language,
    theme: document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs',
    minimap: { enabled: false },
    fontSize: 13,
    lineNumbers: 'on',
    scrollBeyondLastLine: false,
    automaticLayout: true,
    tabSize: 2,
    wordWrap: 'on',
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    overviewRulerBorder: false,
    scrollbar: {
      vertical: 'hidden',
      horizontal: 'hidden',
      handleMouseWheel: true,
      alwaysConsumeMouseWheel: false,
      verticalScrollbarSize: 0,
      horizontalScrollbarSize: 0,
    },
  })

  syncEditorTheme()
  editor.onDidChangeModelContent(() => {
    if (filesStore.editingFile) {
      filesStore.editingFile.content = editor!.getValue()
    }
  })

  // Ctrl/Cmd + S to save
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    handleSave()
  })
})

onBeforeUnmount(() => {
  editor?.dispose()
  editor = null
})

async function handleSave() {
  saving.value = true
  try {
    await filesStore.saveEditor()
    message.success(t('files.saved'))
  } catch {
    message.error(t('files.saveFailed'))
  } finally {
    saving.value = false
  }
}

function handleClose() {
  if (props.customClose) {
    props.customClose()
    return
  }

  if (filesStore.hasUnsavedChanges) {
    dialogApi.warning({
      title: t('files.unsavedChanges'),
      positiveText: t('common.ok'),
      negativeText: t('common.cancel'),
      onPositiveClick: () => {
        filesStore.closeEditor()
      },
    })
  } else {
    filesStore.closeEditor()
  }
}
</script>

<template>
  <div class="file-editor">
    <div class="editor-header">
      <div class="editor-file-info">
        <FileTreeToggle
          v-if="props.showTreeToggle"
          :collapsed="props.treeCollapsed"
          @toggle="emit('toggle-tree')"
        />
        <span class="editor-filename">{{ filesStore.editingFile?.path }}</span>
      </div>
      <NSpace>
        <NButton size="small" type="primary" :loading="saving" @click="handleSave">
          {{ t('files.saveFile') }}
        </NButton>
        <NButton size="small" @click="handleClose">
          {{ t('files.closeEditor') }}
        </NButton>
      </NSpace>
    </div>
    <div ref="editorContainer" class="editor-container" />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.file-editor {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: calc(8px * var(--spacing-scale, 1)) calc(16px * var(--spacing-scale, 1));
  border-bottom: var(--border-width, 1px) solid $border-color;
  background-color: var(--theme-card-bg, $bg-card);
}

.editor-file-info {
  display: flex;
  align-items: center;
  gap: calc(8px * var(--spacing-scale, 1));
  min-width: 0;
}

.editor-filename {
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  color: $text-secondary;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 300px;

  @media (max-width: $breakpoint-mobile) {
    max-width: 120px;
    font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  }
}

.editor-container {
  flex: 1;
  width: 100%;
  min-width: 0;
  min-height: 0;
}
</style>
