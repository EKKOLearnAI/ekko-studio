<script setup lang="ts">
import { defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NDrawer, NDrawerContent, NSpin, NTooltip, useMessage } from 'naive-ui'
import { useFilesStore } from '@/stores/hermes/files'
import { isPreviewableFile } from '@/utils/hermes/file-preview'
import { useTaskDrawerLayout } from '@/components/hermes/tasks/useTaskDrawerLayout'

const FilesPanel = defineAsyncComponent(() => import('@/components/hermes/chat/FilesPanel.vue'))
const FilePreview = defineAsyncComponent(() => import('@/components/hermes/files/FilePreview.vue'))
const props = withDefaults(defineProps<{
  sessionId?: string | null
  workspace?: string | null
  active?: boolean
}>(), { active: true })
const emit = defineEmits<{ attach: [file: File] }>()
const { t } = useI18n()
const message = useMessage()
const filesStore = useFilesStore()
const { drawerWidth } = useTaskDrawerLayout()
const show = ref(false)
const previewOnly = ref(false)
const loading = ref(false)
let requestSequence = 0

function reset() {
  requestSequence++
  show.value = false
  if (loading.value || filesStore.previewFile?.workspaceSessionId === props.sessionId) filesStore.closePreview()
  loading.value = false
}

function close() {
  if (filesStore.hasUnsavedChanges) {
    message.warning(t('files.unsavedChanges'))
    return
  }
  reset()
}

function openFiles() {
  if (!props.active || !props.sessionId || !props.workspace) return
  if (filesStore.hasUnsavedChanges) {
    if (filesStore.editingFile?.workspaceSessionId === props.sessionId) {
      previewOnly.value = false
      show.value = true
      return
    }
    message.warning(t('files.unsavedChanges'))
    return
  }
  reset()
  filesStore.closeEditor()
  filesStore.closePreview()
  previewOnly.value = false
  show.value = true
}

function handlePreview(event: Event) {
  const request = event as CustomEvent<{ path?: string; fileName?: string; startLine?: number; endLine?: number }>
  if (event.defaultPrevented || !props.active || !props.sessionId) return
  let path = request.detail?.path
  if (typeof path !== 'string') return
  try { path = decodeURIComponent(path) } catch { /* Preserve malformed escapes for server validation. */ }
  path = path.replace(/\\/g, '/')
  if (!path.startsWith('/') && !/^[a-zA-Z]:\//.test(path)) return
  const fileName = request.detail.fileName || path.split('/').pop() || path
  if (!isPreviewableFile(fileName)) return
  event.preventDefault()
  if (filesStore.hasUnsavedChanges) {
    message.warning(t('files.unsavedChanges'))
    return
  }
  const workspace = props.workspace?.replace(/\\/g, '/').replace(/\/+$/, '')
  const ignoreCase = workspace && /^[a-zA-Z]:\//.test(workspace)
  if (workspace && (ignoreCase ? path.toLowerCase().startsWith(`${workspace.toLowerCase()}/`) : path.startsWith(`${workspace}/`))) {
    path = path.slice(workspace.length + 1)
  }
  const start = request.detail.startLine
  const startLine = Number.isSafeInteger(start) && start! > 0 ? start : undefined
  const end = request.detail.endLine
  const endLine = Number.isSafeInteger(end) && end! >= startLine! ? end : startLine
  reset()
  filesStore.closeEditor()
  filesStore.closePreview()
  const sequence = ++requestSequence
  previewOnly.value = true
  loading.value = true
  show.value = true
  void filesStore.openSessionWorkspacePreview(props.sessionId, path, fileName, -1,
    startLine ? { startLine, endLine } : undefined)
    .catch(error => {
      if (sequence !== requestSequence) return
      show.value = false
      message.error(error instanceof Error ? error.message : t('files.previewFailed'))
    })
    .finally(() => { if (sequence === requestSequence) loading.value = false })
}

watch(() => [props.sessionId, props.workspace, props.active] as const, (_, previous) => {
  reset()
  if (filesStore.previewFile?.workspaceSessionId === previous[0]) filesStore.closePreview()
})
onMounted(() => window.addEventListener('hermes:preview-workspace-file', handlePreview))
onBeforeUnmount(() => {
  window.removeEventListener('hermes:preview-workspace-file', handlePreview)
  reset()
})
</script>

<template>
  <NTooltip trigger="hover">
    <template #trigger>
      <NButton quaternary circle size="small" :aria-label="t('files.title')" :aria-expanded="show"
        :disabled="!active || !sessionId || !workspace" @click="openFiles">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
          <path d="M4 3v16h5M4 7h5M14 3h6v8h-6zM14 15h6v6h-6z" />
        </svg>
      </NButton>
    </template>
    {{ t('files.title') }}
  </NTooltip>
  <NDrawer :show="show" :width="drawerWidth" placement="right" class="person-files-drawer" @update:show="value => { if (!value) close() }">
    <NDrawerContent :title="workspace || t('drawer.files')" closable :native-scrollbar="true"
      :body-content-style="{ padding: '0', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }">
      <template v-if="show">
        <template v-if="previewOnly">
          <div v-if="loading" class="person-file-loading"><NSpin size="small" /></div>
          <FilePreview v-else-if="filesStore.previewFile" :custom-close="close" />
        </template>
        <FilesPanel v-else :workspace-session-id="sessionId" :workspace="workspace" @attach="file => emit('attach', file)" />
      </template>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped lang="scss">
.person-file-loading { flex: 1; display: grid; place-items: center; }
</style>
