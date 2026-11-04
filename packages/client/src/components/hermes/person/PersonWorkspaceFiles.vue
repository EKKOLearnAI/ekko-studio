<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NSpin, useMessage } from 'naive-ui'
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
  panelTarget: string
  reservedWidth?: number
  submit: (text: string, attachments?: Attachment[]) => Promise<boolean>
}>(), { active: true, reservedWidth: 0 })
const emit = defineEmits<{ attach: [file: File]; 'update:show': [show: boolean] }>()
const { t } = useI18n()
const message = useMessage()
const filesStore = useFilesStore()
const { isMobile } = useTaskDrawerLayout()
const layoutWidth = ref(window.innerWidth)
const width = ref(loadWidth())
function loadWidth() {
  try {
    const saved = Number(localStorage.getItem('hermes.person.toolDrawerWidth'))
    return Number.isFinite(saved) && saved >= 320 ? saved : 1200
  } catch { return 1200 }
}
const maxWidth = computed(() => Math.max(80, Math.min(layoutWidth.value * .8,
  layoutWidth.value - props.reservedWidth - Math.min(320, layoutWidth.value * .25))))
const panelWidth = computed(() => isMobile.value ? layoutWidth.value : Math.min(maxWidth.value, width.value))
let resizeStart: { x: number; width: number } | undefined
let observer: ResizeObserver | undefined
function measure() {
  const target = document.querySelector(props.panelTarget)
  layoutWidth.value = target?.clientWidth || window.innerWidth
}
function resize(event: PointerEvent) {
  if (!resizeStart) return
  const direction = document.documentElement.dir === 'rtl' ? 1 : -1
  width.value = Math.max(Math.min(320, maxWidth.value), Math.min(maxWidth.value,
    resizeStart.width + (event.clientX - resizeStart.x) * direction))
}
function stopResize() {
  if (!resizeStart) return
  resizeStart = undefined
  window.removeEventListener('pointermove', resize)
  window.removeEventListener('pointerup', stopResize)
  window.removeEventListener('pointercancel', stopResize)
  try { localStorage.setItem('hermes.person.toolDrawerWidth', String(width.value)) } catch { /* Storage may be unavailable. */ }
}
function startResize(event: PointerEvent) {
  if (isMobile.value || event.button !== 0) return
  event.preventDefault()
  resizeStart = { x: event.clientX, width: panelWidth.value }
  window.addEventListener('pointermove', resize)
  window.addEventListener('pointerup', stopResize)
  window.addEventListener('pointercancel', stopResize)
}
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
  stopResize()
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
function handleEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented || !show.value
    || [...document.querySelectorAll('.n-drawer, .n-modal, .n-dialog, [role="listbox"]')]
      .some(element => element.getClientRects().length > 0)) return
  event.preventDefault()
  close()
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
  const request = event as CustomEvent<{ path?: string; fileName?: string; startLine?: number; endLine?: number; workspaceContext?: { sessionId: string; workspace?: string | null } }>
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
  const sessionId = request.detail.workspaceContext?.sessionId || props.sessionId
  const workspace = (request.detail.workspaceContext ? request.detail.workspaceContext.workspace : props.workspace)?.replace(/\\/g, '/').replace(/\/+$/, '')
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
  void filesStore.openSessionWorkspacePreview(sessionId, path, fileName, -1,
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
watch(show, async value => {
  emit('update:show', value)
  observer?.disconnect()
  if (!value) return
  await nextTick()
  measure()
  const target = document.querySelector(props.panelTarget)
  if (target) observer?.observe(target)
})
onMounted(() => {
  observer = new ResizeObserver(measure)
  window.addEventListener('resize', measure)
  window.addEventListener('keydown', handleEscape)
  window.addEventListener('hermes:preview-workspace-file', handlePreview)
  window.addEventListener(OPEN_DESKTOP_BROWSER_PANEL_EVENT, openBrowser)
})
onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('resize', measure)
  window.removeEventListener('keydown', handleEscape)
  window.removeEventListener('hermes:preview-workspace-file', handlePreview)
  window.removeEventListener(OPEN_DESKTOP_BROWSER_PANEL_EVENT, openBrowser)
  reset()
})
</script>

<template>
  <HeaderToolPanelToggle :expanded="show" :controls="panelId" :tooltip="tooltip"
    :disabled="!active || !sessionId" @toggle="show ? close() : openPanel()" />
  <Teleport v-if="show" :to="panelTarget">
    <Transition appear @after-enter="panelReady = true">
    <aside v-if="show" :id="panelId" class="person-files-drawer person-tools-panel" data-theme-surface="card"
      role="region" :aria-label="tooltip" :style="{ width: `${panelWidth}px` }" @keydown.esc.stop.prevent="close">
      <div v-if="!isMobile" class="person-tools-resize" @pointerdown="startResize" />
      <button class="person-tools-close" type="button" :aria-label="t('common.close')" @click="close">×</button>
      <template v-if="show">
        <template v-if="previewOnly">
          <div v-if="loading" class="person-file-loading"><NSpin size="small" /></div>
          <FilePreview v-else-if="filesStore.previewFile" :custom-close="close" />
        </template>
        <ChatToolsPanel v-else v-model:active-panel="activePanel" :workspace-session-id="sessionId" :workspace="workspace"
          :visible="show" :browser-visible="panelReady" :browser-available="browserAvailable"
          :submit="submitBrowserAnnotations" @attach="file => emit('attach', file)" />
      </template>
    </aside>
    </Transition>
  </Teleport>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.person-tools-panel { position: relative; display: flex; flex-direction: column; flex-shrink: 0; min-width: 0; min-height: 0; height: 100%; border-inline-start: var(--border-width, 1px) solid $border-color; }
.person-tools-resize { position: absolute; inset-inline-start: -3px; top: 0; bottom: 0; width: 6px; cursor: col-resize; touch-action: none; z-index: 3; }
.person-tools-close { position: absolute; inset-inline-end: 8px; bottom: 8px; z-index: 3; border: 0; border-radius: 4px; color: $text-secondary; background: transparent; font-size: 24px; cursor: pointer; }
.person-file-loading { flex: 1; display: grid; place-items: center; }
@media (max-width: 768px) { .person-tools-panel { position: absolute; inset: 0; z-index: 90; border-inline-start: 0; } }
</style>
