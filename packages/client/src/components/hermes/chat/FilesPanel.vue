<script setup lang="ts">
import { computed, defineAsyncComponent, ref, onBeforeUnmount, onMounted, watch } from 'vue'
import { isPreviewableFile, isTextFile, useFilesStore } from '@/stores/hermes/files'
import { useI18n } from 'vue-i18n'
import { NButton, useMessage } from 'naive-ui'
import FileTree from '@/components/hermes/files/FileTree.vue'
import FileToolbar from '@/components/hermes/files/FileToolbar.vue'
import FileTreeToggle from '@/components/hermes/files/FileTreeToggle.vue'
import FileContextMenu from '@/components/hermes/files/FileContextMenu.vue'
import FileUploadModal from '@/components/hermes/files/FileUploadModal.vue'
import FileRenameModal from '@/components/hermes/files/FileRenameModal.vue'
import type { FileEntry } from '@/api/studio/files'
import { fetchSessionWorkspaceAttachmentBlob } from '@/api/studio/sessions'
import { fetchGroupWorkspaceAttachmentBlob } from '@/api/studio/group-chat'

const FileEditor = defineAsyncComponent(async () => (await import('@/components/hermes/files/FileEditor.vue')).default)
const FilePreview = defineAsyncComponent(async () => (await import('@/components/hermes/files/FilePreview.vue')).default)
const WorkspaceFileDiff = defineAsyncComponent(async () => (await import('@/components/hermes/files/WorkspaceFileDiff.vue')).default)

const filesStore = useFilesStore()
const { t } = useI18n()
const message = useMessage()

const props = defineProps<{
  workspaceSessionId?: string | null
  workspaceRoomId?: string | null
  workspace?: string | null
}>()

const emit = defineEmits<{
  (e: 'attach', file: File): void
}>()

const contextMenuRef = ref<InstanceType<typeof FileContextMenu> | null>(null)
const showUpload = ref(false)
const showRenameModal = ref(false)
const renameMode = ref<'newFile' | 'newFolder' | 'rename'>('newFile')
const renameEntry = ref<FileEntry | null>(null)
const renameTargetPath = ref<string | null>(null)
const lastStandardPath = ref('')
const filesPanelRef = ref<HTMLElement | null>(null)
const sidebarWidth = ref(260)
const treeCollapsed = ref(false)
const selectedDiffEntry = ref<FileEntry | null>(null)
const mobileMediaQuery = window.matchMedia(`(max-width: 768px)`)
const isMobileLayout = ref(mobileMediaQuery.matches)
const mobileFileOpen = ref(false)
let stopSidebarResize: (() => void) | null = null
const hasOpenFile = computed(() => Boolean(
  selectedDiffEntry.value || filesStore.editingFile || filesStore.previewFile,
))

function startSidebarResize(event: PointerEvent) {
  if (isMobileLayout.value || treeCollapsed.value) return
  event.preventDefault()
  const startX = event.clientX
  const startWidth = sidebarWidth.value
  const rtl = document.documentElement.dir === 'rtl'
  const previousCursor = document.body.style.cursor
  const previousUserSelect = document.body.style.userSelect
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'

  const handleMove = (moveEvent: PointerEvent) => {
    const panelWidth = filesPanelRef.value?.clientWidth || window.innerWidth
    const maxWidth = Math.max(220, Math.min(520, panelWidth - 280))
    const delta = (moveEvent.clientX - startX) * (rtl ? -1 : 1)
    sidebarWidth.value = Math.min(maxWidth, Math.max(180, startWidth + delta))
  }
  const handleUp = () => stopSidebarResize?.()
  stopSidebarResize = () => {
    window.removeEventListener('pointermove', handleMove)
    window.removeEventListener('pointerup', handleUp)
    window.removeEventListener('pointercancel', handleUp)
    document.body.style.cursor = previousCursor
    document.body.style.userSelect = previousUserSelect
    stopSidebarResize = null
  }
  window.addEventListener('pointermove', handleMove)
  window.addEventListener('pointerup', handleUp)
  window.addEventListener('pointercancel', handleUp)
}

function toggleTreeCollapsed(): void {
  if (isMobileLayout.value) return
  treeCollapsed.value = !treeCollapsed.value
}

function handleMobileLayoutChange(event: MediaQueryListEvent): void {
  isMobileLayout.value = event.matches
  if (event.matches) {
    treeCollapsed.value = false
    mobileFileOpen.value = Boolean(selectedDiffEntry.value || filesStore.editingFile || filesStore.previewFile)
  }
}

function handleContextMenu(e: MouseEvent, entry: FileEntry) {
  contextMenuRef.value?.show(e, entry)
}

function handleShowNewFile() {
  renameMode.value = 'newFile'
  renameEntry.value = null
  renameTargetPath.value = null
  showRenameModal.value = true
}

function handleShowNewFolder() {
  renameMode.value = 'newFolder'
  renameEntry.value = null
  renameTargetPath.value = null
  showRenameModal.value = true
}

function handleContextNewFolder(entry: FileEntry) {
  renameMode.value = 'newFolder'
  renameEntry.value = null
  renameTargetPath.value = entry.isDir ? entry.path : filesStore.currentPath
  showRenameModal.value = true
}

function handleRename(entry: FileEntry) {
  renameMode.value = 'rename'
  renameEntry.value = entry
  renameTargetPath.value = null
  showRenameModal.value = true
}

async function handleAttach(entry: FileEntry) {
  if (entry.isDir) return
  try {
    const blob = props.workspaceSessionId
      ? await fetchSessionWorkspaceAttachmentBlob(props.workspaceSessionId, entry.path)
      : props.workspaceRoomId
        ? await fetchGroupWorkspaceAttachmentBlob(props.workspaceRoomId, entry.path)
        : null
    if (!blob) return
    emit('attach', new File([blob], entry.name, {
      type: blob.type || 'application/octet-stream',
      lastModified: Date.parse(entry.modTime) || Date.now(),
    }))
  } catch {
    message.error(t('files.attachFailed'))
  }
}

async function handleOpenEntry(entry: FileEntry): Promise<void> {
  if (entry.isDir) return
  if (filesStore.hasUnsavedChanges) {
    message.warning(t('files.unsavedChanges'))
    return
  }
  if (isMobileLayout.value) mobileFileOpen.value = true

  if (isTextFile(entry.name) || !isPreviewableFile(entry.name)) {
    filesStore.closeEditor()
    filesStore.closePreview()
    selectedDiffEntry.value = entry
    return
  }

  selectedDiffEntry.value = null
  filesStore.closeEditor()
  if (isPreviewableFile(entry.name)) {
    try {
      await filesStore.openPreview(entry)
    } catch (openError) {
      message.error(openError instanceof Error ? openError.message : t('files.previewFailed'))
    }
  } else {
    filesStore.closePreview()
  }
}

function handleMobileBack(): void {
  if (filesStore.hasUnsavedChanges) {
    message.warning(t('files.unsavedChanges'))
    return
  }
  selectedDiffEntry.value = null
  filesStore.closeEditor()
  filesStore.closePreview()
  mobileFileOpen.value = false
}

function handleDiffClose(): void {
  if (isMobileLayout.value) handleMobileBack()
  else selectedDiffEntry.value = null
}

watch(
  () => [props.workspaceSessionId, props.workspaceRoomId, props.workspace] as const,
  ([workspaceSessionId, workspaceRoomId, workspace]) => {
    selectedDiffEntry.value = null
    mobileFileOpen.value = false
    filesStore.closePreview()
    if ((workspaceSessionId || workspaceRoomId) && workspace) {
      if (!filesStore.currentWorkspaceSessionId && !filesStore.currentWorkspaceRoomId) lastStandardPath.value = filesStore.currentPath
      void filesStore.fetchEntries('', { workspaceSessionId, workspaceRoomId })
      return
    }
    if (filesStore.currentWorkspaceSessionId || filesStore.currentWorkspaceRoomId) {
      void filesStore.fetchEntries(lastStandardPath.value, { profile: null, workspaceSessionId: null, workspaceRoomId: null })
    }
  },
)

watch(() => filesStore.previewFile, previewFile => {
  if (!previewFile || !isMobileLayout.value) return
  const matchesSession = props.workspaceSessionId && previewFile.workspaceSessionId === props.workspaceSessionId
  const matchesRoom = props.workspaceRoomId && previewFile.workspaceRoomId === props.workspaceRoomId
  if (matchesSession || matchesRoom || (!props.workspaceSessionId && !props.workspaceRoomId)) {
    mobileFileOpen.value = true
  }
})

onMounted(() => {
  mobileMediaQuery.addEventListener('change', handleMobileLayoutChange)
  if ((props.workspaceSessionId || props.workspaceRoomId) && props.workspace) {
    void filesStore.fetchEntries('', { workspaceSessionId: props.workspaceSessionId, workspaceRoomId: props.workspaceRoomId })
  } else if (filesStore.currentWorkspaceSessionId || filesStore.currentWorkspaceRoomId) {
    void filesStore.fetchEntries(lastStandardPath.value, { profile: null, workspaceSessionId: null, workspaceRoomId: null })
  } else if (!filesStore.entries.length && !filesStore.loading) {
    void filesStore.fetchEntries('', { profile: null, workspaceSessionId: null, workspaceRoomId: null })
  }
})

onBeforeUnmount(() => {
  stopSidebarResize?.()
  mobileMediaQuery.removeEventListener('change', handleMobileLayoutChange)
})
</script>

<template>
  <div
    ref="filesPanelRef"
    class="files-panel-drawer"
    :class="{ 'mobile-file-open': mobileFileOpen }"
  >
    <div
      class="files-tree-panel"
      :class="{ 'tree-collapsed': treeCollapsed }"
      :style="{ width: isMobileLayout ? '100%' : treeCollapsed ? '0px' : `${sidebarWidth}px` }"
    >
      <div v-show="!treeCollapsed" class="explorer-header">
        <span class="explorer-title">{{ t('files.fileTree') }}</span>
        <FileToolbar
          :allow-upload="false"
          @show-new-file="handleShowNewFile"
          @show-new-folder="handleShowNewFolder"
        />
      </div>
      <FileTree
        v-show="!treeCollapsed"
        :workspace-key="workspace"
        @contextmenu-entry="handleContextMenu"
        @open-entry="handleOpenEntry"
      />
    </div>
    <div v-if="treeCollapsed && !hasOpenFile" class="collapsed-tree-fallback">
      <FileTreeToggle :collapsed="true" @toggle="toggleTreeCollapsed" />
    </div>
    <div
      class="explorer-resize-handle"
      :class="{ 'tree-collapsed': treeCollapsed }"
      @pointerdown="startSidebarResize"
    />
    <div class="files-main-panel">
      <div class="main-toolbar">
        <NButton
          size="small"
          @click="handleMobileBack"
          class="sidebar-toggle"
        >
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </template>
          {{ t('files.fileTree') }}
        </NButton>
      </div>
      <div class="files-content">
        <FileEditor
          v-if="filesStore.editingFile"
          :custom-close="isMobileLayout ? handleMobileBack : undefined"
          :show-tree-toggle="!isMobileLayout"
          :tree-collapsed="treeCollapsed"
          @toggle-tree="toggleTreeCollapsed"
        />
        <WorkspaceFileDiff
          v-else-if="selectedDiffEntry"
          :entry="selectedDiffEntry"
          :workspace="workspace"
          :workspace-session-id="workspaceSessionId"
          :workspace-room-id="workspaceRoomId"
          :show-tree-toggle="!isMobileLayout"
          :tree-collapsed="treeCollapsed"
          @toggle-tree="toggleTreeCollapsed"
          @close="handleDiffClose"
        />
        <FilePreview
          v-else-if="filesStore.previewFile"
          :custom-close="isMobileLayout ? handleMobileBack : undefined"
          :show-tree-toggle="!isMobileLayout"
          :tree-collapsed="treeCollapsed"
          @toggle-tree="toggleTreeCollapsed"
        />
        <div v-else class="workspace-empty-editor" />
      </div>
    </div>
    <FileContextMenu
      ref="contextMenuRef"
      :allow-attach="Boolean(workspaceSessionId || workspaceRoomId)"
      @attach="handleAttach"
      @rename="handleRename"
      @new-folder="handleContextNewFolder"
    />
    <FileUploadModal v-model:show="showUpload" />
    <FileRenameModal
      v-model:show="showRenameModal"
      :mode="renameMode"
      :entry="renameEntry"
      :target-path="renameTargetPath"
    />
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.files-panel-drawer {
  display: flex;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  position: relative;
  background: inherit;
}

.files-tree-panel {
  width: 260px;
  min-width: 180px;
  max-width: 520px;
  border-inline-end: var(--border-width, 1px) solid $border-color;
  overflow-y: auto;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: inherit;
  transition: width $transition-fast;

  &.tree-collapsed {
    min-width: 0;
    border-inline-end: 0;
    overflow: hidden;
  }

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }

  @media (max-width: $breakpoint-mobile) {
    width: 100% !important;
    min-width: 0;
    max-width: none;
    height: 100%;
    border-inline-end: 0;

    &.tree-collapsed {
      min-width: 0;
    }
  }
}

@media (max-width: $breakpoint-mobile) {
  .files-panel-drawer:not(.mobile-file-open) .files-main-panel {
    display: none;
  }

  .files-panel-drawer.mobile-file-open .files-tree-panel {
    display: none;
  }
}

.explorer-resize-handle {
  position: relative;
  z-index: 2;
  width: 5px;
  margin-inline-start: -3px;
  margin-inline-end: -2px;
  cursor: col-resize;
  flex: 0 0 5px;
  touch-action: none;

  &.tree-collapsed {
    display: none;
  }

  &::after {
    content: '';
    position: absolute;
    inset-block: 0;
    inset-inline-start: 2px;
    width: 1px;
    background: transparent;
    transition: background-color $transition-fast;
  }

  &:hover::after,
  &:active::after {
    background: var(--accent-info);
  }

  @media (max-width: $breakpoint-mobile) {
    display: none;
  }
}

.explorer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  min-height: 34px;
  padding: 0 calc(8px * var(--spacing-scale, 1)) 0 calc(12px * var(--spacing-scale, 1));
  border-bottom: var(--border-width, 1px) solid $border-color;

  :deep(.file-toolbar) {
    padding: 0;
  }

  :deep(.n-button) {
    width: 26px;
    height: 26px;
  }
}

.collapsed-tree-fallback {
  position: absolute;
  inset-block-start: 8px;
  inset-inline-start: 0;
  z-index: 4;
  pointer-events: none;

  :deep(.file-tree-toggle) {
    pointer-events: auto;
  }
}

.explorer-title {
  color: $text-secondary;
  font-size: calc(var(--font-size-base, 14px) * 11 / 14);
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.files-main-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  background: inherit;
}

.main-toolbar {
  display: flex;
  align-items: center;
  gap: calc(6px * var(--spacing-scale, 1));
  padding: calc(5px * var(--spacing-scale, 1)) calc(10px * var(--spacing-scale, 1));
  border-bottom: var(--border-width, 1px) solid $border-color;
  flex-shrink: 0;
  background: inherit;

  @media (min-width: $breakpoint-mobile + 1) {
    display: none;
  }

  @media (max-width: $breakpoint-mobile) {
    gap: calc(4px * var(--spacing-scale, 1));
    padding: calc(4px * var(--spacing-scale, 1)) calc(8px * var(--spacing-scale, 1));
    flex-wrap: wrap;
  }
}

.sidebar-toggle {
  @media (min-width: $breakpoint-mobile + 1) {
    display: none;
  }

  @media (max-width: $breakpoint-mobile) {
    font-size: calc(var(--font-size-base, 14px) * 12 / 14);
    padding: 0 calc(8px * var(--spacing-scale, 1));
    height: 32px;
  }
}

.files-content {
  flex: 1;
  display: flex;
  overflow: hidden;
  min-height: 0;
  background: inherit;
}

.workspace-empty-editor {
  width: 100%;
  height: 100%;
  background: inherit;
}
</style>
