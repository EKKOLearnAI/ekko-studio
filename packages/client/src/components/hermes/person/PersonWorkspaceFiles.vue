<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NDrawer, NDrawerContent, NSpin, useMessage } from 'naive-ui'
import { useFilesStore } from '@/stores/hermes/files'
import { isPreviewableFile } from '@/utils/hermes/file-preview'
import { useTaskDrawerLayout } from '@/components/hermes/tasks/useTaskDrawerLayout'
import HeaderToolPanelToggle from '@/components/layout/HeaderToolPanelToggle.vue'
import ChatToolsPanel from '@/components/hermes/chat/ChatToolsPanel.vue'
import { hasDesktopBrowserBridge } from '@/utils/desktop-bridge'
import { OPEN_DESKTOP_BROWSER_PANEL_EVENT } from '@/utils/desktop-browser'
import { createBrowserAnnotationAttachment, type BrowserAnnotationSubmission } from '@/utils/browser-annotation-submit'
import type { Attachment } from '@/stores/hermes/chat'

const FilePreview = defineAsyncComponent(() => import('@/components/hermes/files/FilePreview.vue'))
const props = withDefaults(defineProps<{
  sessionId?: string | null
  workspace?: string | null
  active?: boolean
  submit: (text: string, attachments?: Attachment[]) => Promise<boolean>
}>(), { active: true })
const emit = defineEmits<{ attach: [file: File] }>()
const { t } = useI18n()
const message = useMessage()
const filesStore = useFilesStore()
const { drawerWidth } = useTaskDrawerLayout()
const panelId = `person-files-panel-${useId()}`
const show = ref(false)
const panelReady = ref(false)
const activePanel = ref<'files' | 'terminal' | 'browser'>('files')
const browserAvailable = hasDesktopBrowserBridge()
const tooltip = computed(() => [t('drawer.files'), t('drawer.terminal'), ...(browserAvailable ? [t('browser.title')] : [])].join(' / '))
const previewOnly = ref(false)
const loading = ref(false)
let requestSequence = 0

function reset() {
  requestSequence++
  show.value = false
  panelReady.value = false
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

function openPanel(panel = activePanel.value) {
  if (!props.active || !props.sessionId) return
  const alreadyOpen = show.value
  if (filesStore.hasUnsavedChanges) {
    if (filesStore.editingFile?.workspaceSessionId === props.sessionId) {
      activePanel.value = panel
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
  activePanel.value = panel
  previewOnly.value = false
  show.value = true
  panelReady.value = alreadyOpen
}

function openBrowser() {
  if (browserAvailable) openPanel('browser')
}

async function submitBrowserAnnotations(submission: BrowserAnnotationSubmission) {
  if (!props.active || !props.sessionId) return false
  return props.submit('', [createBrowserAnnotationAttachment(submission)])
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
  activePanel.value = 'files'
  if (filesStore.previewFile?.workspaceSessionId === previous[0]) filesStore.closePreview()
})
onMounted(() => {
  window.addEventListener('hermes:preview-workspace-file', handlePreview)
  window.addEventListener(OPEN_DESKTOP_BROWSER_PANEL_EVENT, openBrowser)
})
onBeforeUnmount(() => {
  window.removeEventListener('hermes:preview-workspace-file', handlePreview)
  window.removeEventListener(OPEN_DESKTOP_BROWSER_PANEL_EVENT, openBrowser)
  reset()
})
</script>

<template>
  <HeaderToolPanelToggle :expanded="show" :controls="panelId" :tooltip="tooltip"
    :disabled="!active || !sessionId" @toggle="show ? close() : openPanel()" />
  <NDrawer :show="show" :width="drawerWidth" placement="right" class="person-files-drawer" @after-enter="panelReady = true"
    @update:show="value => { if (!value) close() }">
    <NDrawerContent :id="panelId" :title="workspace || t('drawer.files')" closable :native-scrollbar="true"
      :body-content-style="{ padding: '0', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }">
      <template v-if="show">
        <template v-if="previewOnly">
          <div v-if="loading" class="person-file-loading"><NSpin size="small" /></div>
          <FilePreview v-else-if="filesStore.previewFile" :custom-close="close" />
        </template>
        <ChatToolsPanel v-else v-model:active-panel="activePanel" :workspace-session-id="sessionId" :workspace="workspace"
          :visible="show" :browser-visible="panelReady" :browser-available="browserAvailable"
          :submit="submitBrowserAnnotations" @attach="file => emit('attach', file)" />
      </template>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped lang="scss">
.person-file-loading { flex: 1; display: grid; place-items: center; }
</style>
