<script setup lang="ts">
import { ref, computed, nextTick, onMounted, watch } from 'vue'
import { NSpin, NButton, NDropdown, NInput, NModal, NSpace, useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { request } from '@/api/client'
import { recordWorkspaceDirectory } from '@/api/studio/workspace-directories'
import { copyToClipboard } from '@/utils/clipboard'
import StarIcon from '@/components/common/StarIcon.vue'
import FolderIcon from '@/components/common/FolderIcon.vue'

interface FolderEntry {
  name: string
  path: string
  fullPath: string
  readonly?: boolean
}

interface FolderListResponse {
  base: string
  current: string
  folders: FolderEntry[]
}

/** Flat display node for rendering tree without recursion */
interface FlatNode {
  folder: FolderEntry
  depth: number
  isExpanded: boolean
  isLoading: boolean
  hasChildren: boolean | null  // null = unknown
}

const props = defineProps<{
  modelValue: string | null
  showFavorite?: boolean
  favorite?: boolean
  favoriteDisabled?: boolean
  favoriteTitle?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string | null]
  'toggle-favorite': []
}>()

const { t } = useI18n()
const dialog = useDialog()
const message = useMessage()
const loading = ref(false)
const basePath = ref('')
const folders = ref<FolderEntry[]>([])
const expandedPaths = ref<Set<string>>(new Set())
const childrenCache = ref<Map<string, FolderEntry[]>>(new Map())
const loadingPaths = ref<Set<string>>(new Set())
const selectedPath = ref(props.modelValue || '')
const loadFailed = ref(false)
const contextMenuVisible = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
const contextTarget = ref<FolderEntry | null>(null)
const renameModalVisible = ref(false)
const renameMode = ref<'create' | 'rename'>('create')
const renameInput = ref('')
const actionLoading = ref(false)

watch(() => props.modelValue, (v) => { selectedPath.value = v || '' })

function updateSelectedPath(value: string | null) {
  const next = String(value || '').trim()
  selectedPath.value = next
  emit('update:modelValue', next || null)
}

async function loadFolders(subPath = ''): Promise<FolderListResponse | null> {
  try {
    const query = subPath ? `?path=${encodeURIComponent(subPath)}` : ''
    return await request<FolderListResponse>(`/api/studio/workspace/folders${query}`)
  } catch {
    return null
  }
}

function relativeParentPath(path: string) {
  const windowsPath = path.replace(/\//g, '\\')
  const driveRoot = windowsPath.match(/^([a-zA-Z]:)\\?$/)
  if (driveRoot) return `${driveRoot[1].toUpperCase()}\\`
  const driveChild = windowsPath.match(/^([a-zA-Z]:)\\(.+)$/)
  if (driveChild) {
    const trimmed = windowsPath.replace(/\\+$/, '')
    const idx = trimmed.lastIndexOf('\\')
    return idx <= 2 ? `${driveChild[1].toUpperCase()}\\` : trimmed.slice(0, idx)
  }
  const parts = path.split('/').filter(Boolean)
  parts.pop()
  return parts.join('/')
}

async function refreshFolderList(subPath = '') {
  const res = await loadFolders(subPath)
  if (!res) {
    loadFailed.value = true
    return
  }
  loadFailed.value = false
  if (!subPath) {
    basePath.value = res.base
    folders.value = res.folders
    return
  }
  childrenCache.value.set(subPath, res.folders)
  childrenCache.value = new Map(childrenCache.value)
}

onMounted(async () => {
  loading.value = true
  await refreshFolderList()
  loading.value = false
})

async function toggleExpand(folder: FolderEntry) {
  if (expandedPaths.value.has(folder.path)) {
    expandedPaths.value.delete(folder.path)
    expandedPaths.value = new Set(expandedPaths.value)
    return
  }

  expandedPaths.value.add(folder.path)
  expandedPaths.value = new Set(expandedPaths.value)

  if (!childrenCache.value.has(folder.path)) {
    loadingPaths.value.add(folder.path)
    loadingPaths.value = new Set(loadingPaths.value)
    const res = await loadFolders(folder.path)
    childrenCache.value.set(folder.path, res?.folders || [])
    childrenCache.value = new Map(childrenCache.value)
    loadingPaths.value.delete(folder.path)
    loadingPaths.value = new Set(loadingPaths.value)
  }
}

function selectFolder(folder: FolderEntry) {
  updateSelectedPath(folder.fullPath)
  void rememberSelection()
}

function selectBase() {
  updateSelectedPath(basePath.value)
  void rememberSelection()
}

async function rememberSelection() {
  const path = selectedPath.value.trim()
  if (!path) return
  try { await recordWorkspaceDirectory(path) }
  catch { message.error(t('chat.workspaceSetFailed')) }
}

async function openFolder(folder: FolderEntry | null) {
  if (!folder) {
    selectBase()
    return
  }
  selectFolder(folder)
  if (!expandedPaths.value.has(folder.path)) {
    await toggleExpand(folder)
  }
}

function showContextMenu(event: MouseEvent, folder: FolderEntry | null) {
  event.preventDefault()
  event.stopPropagation()
  contextTarget.value = folder
  contextMenuX.value = event.clientX
  contextMenuY.value = event.clientY
  contextMenuVisible.value = false
  void nextTick(() => {
    contextMenuVisible.value = true
  })
}

const contextOptions = computed(() => {
  const options: any[] = [
    { label: t('files.open'), key: 'open' },
    { type: 'divider', key: 'd1' },
    { label: t('files.copyPath'), key: 'copyPath' },
    { label: t('files.newFolder'), key: 'newFolder' },
  ]
  if (contextTarget.value) {
    if (!contextTarget.value.readonly) {
      options.push({ label: t('files.rename'), key: 'rename' })
      options.push({ type: 'divider', key: 'd2' })
      options.push({ label: t('files.delete'), key: 'delete' })
    }
  }
  return options
})

function handleContextOutside() {
  contextMenuVisible.value = false
}

function openRenameModal(mode: 'create' | 'rename') {
  renameMode.value = mode
  renameInput.value = mode === 'rename' ? contextTarget.value?.name || '' : ''
  renameModalVisible.value = true
}

async function handleContextSelect(key: string) {
  contextMenuVisible.value = false
  const folder = contextTarget.value
  switch (key) {
    case 'open':
      await openFolder(folder)
      break
    case 'copyPath': {
      const path = folder?.fullPath || basePath.value
      const ok = await copyToClipboard(path)
      message[ok ? 'success' : 'error'](ok ? t('files.pathCopied') : `${t('files.pathCopied')} ✗`)
      break
    }
    case 'newFolder':
      openRenameModal('create')
      break
    case 'rename':
      if (folder) openRenameModal('rename')
      break
    case 'delete':
      if (!folder) return
      dialog.warning({
        title: t('files.delete'),
        content: t('files.confirmDeleteDir', { name: folder.name }),
        positiveText: t('common.delete'),
        negativeText: t('common.cancel'),
        onPositiveClick: async () => {
          try {
            await request('/api/studio/workspace/folders', {
              method: 'DELETE',
              body: JSON.stringify({ path: folder.path }),
            })
            if (selectedPath.value === folder.fullPath || selectedPath.value.startsWith(`${folder.fullPath}/`)) {
              updateSelectedPath(null)
            }
            expandedPaths.value.delete(folder.path)
            expandedPaths.value = new Set(expandedPaths.value)
            childrenCache.value.delete(folder.path)
            childrenCache.value = new Map(childrenCache.value)
            await refreshFolderList(relativeParentPath(folder.path))
            message.success(t('files.deleted'))
          } catch {
            message.error(t('files.deleteFailed'))
          }
        },
      })
      break
  }
}

async function submitRenameModal() {
  const name = renameInput.value.trim()
  if (!name) return
  actionLoading.value = true
  try {
    if (renameMode.value === 'create') {
      const parentPath = contextTarget.value?.path || ''
      await request('/api/studio/workspace/folders', {
        method: 'POST',
        body: JSON.stringify({ parentPath, name }),
      })
      if (parentPath) {
        expandedPaths.value.add(parentPath)
        expandedPaths.value = new Set(expandedPaths.value)
      }
      await refreshFolderList(parentPath)
      message.success(t('files.created'))
    } else if (contextTarget.value) {
      const oldFolder = contextTarget.value
      await request('/api/studio/workspace/folders/rename', {
        method: 'POST',
        body: JSON.stringify({ path: oldFolder.path, name }),
      })
      const parentPath = relativeParentPath(oldFolder.path)
      await refreshFolderList(parentPath)
      if (selectedPath.value === oldFolder.fullPath || selectedPath.value.startsWith(`${oldFolder.fullPath}/`)) {
        updateSelectedPath(null)
      }
      message.success(t('files.renamed'))
    }
    renameModalVisible.value = false
  } catch {
    message.error(renameMode.value === 'rename' ? t('files.renameFailed') : t('files.createFailed'))
  } finally {
    actionLoading.value = false
  }
}

/** Build a flat list by DFS traversal of expanded nodes */
const flatNodes = computed<FlatNode[]>(() => {
  const result: FlatNode[] = []

  function traverse(entries: FolderEntry[], depth: number) {
    for (const folder of entries) {
      const isExpanded = expandedPaths.value.has(folder.path)
      const isLoading = loadingPaths.value.has(folder.path)
      const children = childrenCache.value.get(folder.path)
      result.push({
        folder,
        depth,
        isExpanded,
        isLoading,
        hasChildren: children ? children.length > 0 : null,
      })
      if (isExpanded && children && children.length > 0) {
        traverse(children, depth + 1)
      }
    }
  }

  traverse(folders.value, 0)
  return result
})
</script>

<template>
  <div class="folder-picker">
    <div class="folder-path-bar">
      <NInput
        :value="selectedPath"
        :placeholder="t('chat.workspacePlaceholder')"
        :input-props="{ 'aria-label': t('chat.workspacePlaceholder') }"
        clearable
        class="folder-path-input"
        @update:value="updateSelectedPath"
        @blur="rememberSelection"
      >
        <template #prefix><FolderIcon class="folder-path-icon" /></template>
      </NInput>
    </div>
    <div v-if="loading" class="folder-picker-loading">
      <NSpin size="small" />
      <span>{{ t('common.loading') }}</span>
    </div>
    <div v-else class="folder-tree">
      <button
        v-if="basePath"
        class="folder-item root"
        type="button"
        :class="{ selected: selectedPath === basePath }"
        :aria-pressed="selectedPath === basePath"
        :title="basePath"
        @click="selectBase"
        @contextmenu="showContextMenu($event, null)"
      >
        <FolderIcon class="folder-icon" open />
        <span class="folder-name">{{ basePath }}</span>
        <svg v-if="selectedPath === basePath" class="folder-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m5 12 4 4L19 6" />
        </svg>
      </button>

      <template v-for="node in flatNodes" :key="node.folder.path">
        <div
          class="folder-item"
          :class="{ selected: selectedPath === node.folder.fullPath }"
          :style="{ paddingInlineStart: `${4 + node.depth * 20}px` }"
          @contextmenu="showContextMenu($event, node.folder)"
        >
          <button
            class="folder-expand"
            type="button"
            :aria-label="`${t(node.isExpanded ? 'common.collapse' : 'common.expand')}: ${node.folder.name}`"
            :aria-expanded="node.isExpanded"
            :aria-busy="node.isLoading"
            @click.stop="toggleExpand(node.folder)"
          >
            <NSpin v-if="node.isLoading" :size="14" />
            <svg v-else class="folder-chevron" :class="{ expanded: node.isExpanded }" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m9 5 7 7-7 7" />
            </svg>
          </button>
          <button
            class="folder-select"
            type="button"
            :aria-pressed="selectedPath === node.folder.fullPath"
            :title="node.folder.fullPath"
            @click="selectFolder(node.folder)"
          >
            <FolderIcon class="folder-icon" :open="node.isExpanded" />
            <span class="folder-name">{{ node.folder.name }}</span>
            <svg v-if="selectedPath === node.folder.fullPath" class="folder-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m5 12 4 4L19 6" />
            </svg>
          </button>
        </div>
        <div
          v-if="node.isExpanded && !node.isLoading && node.hasChildren === false"
          class="folder-item empty"
          :style="{ paddingInlineStart: `${58 + node.depth * 20}px` }"
        >
          <span class="folder-empty-text">{{ t('chat.folderPickerEmpty') }}</span>
        </div>
      </template>

      <div v-if="folders.length === 0 || loadFailed" class="folder-empty">
        <FolderIcon open />
        <span>{{ t('chat.folderPickerNoFolders') }}</span>
      </div>
    </div>

    <div v-if="selectedPath" class="folder-selected">
      <div class="folder-selected-info">
        <span class="folder-selected-label">{{ t('chat.folderPickerSelected') }}</span>
        <span class="folder-selected-path" :title="selectedPath">{{ selectedPath }}</span>
      </div>
      <button
        v-if="props.showFavorite"
        class="folder-selected-favorite"
        :class="{ 'is-pinned': props.favorite }"
        type="button"
        :disabled="props.favoriteDisabled"
        :title="props.favoriteTitle"
        :aria-label="props.favoriteTitle"
        :aria-pressed="Boolean(props.favorite)"
        @click.stop="emit('toggle-favorite')"
      >
        <StarIcon :filled="props.favorite" />
      </button>
    </div>

    <NDropdown
      :show="contextMenuVisible"
      :x="contextMenuX"
      :y="contextMenuY"
      :options="contextOptions"
      placement="bottom-start"
      trigger="manual"
      @select="handleContextSelect"
      @clickoutside="handleContextOutside"
    />

    <NModal
      v-model:show="renameModalVisible"
      preset="dialog"
      :title="renameMode === 'rename' ? t('files.rename') : t('files.newFolder')"
      style="width: 400px;"
    >
      <NInput
        v-model:value="renameInput"
        :placeholder="renameMode === 'rename' ? t('files.renameTo') : t('files.newFolderName')"
      />
      <template #action>
        <NSpace justify="end">
          <NButton size="small" @click="renameModalVisible = false">
            {{ t('common.cancel') }}
          </NButton>
          <NButton size="small" type="primary" :loading="actionLoading" :disabled="!renameInput.trim()" @click="submitRenameModal">
            {{ t('common.confirm') }}
          </NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.folder-picker {
  max-height: 360px;
  min-width: 0;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  background: $bg-card;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.folder-path-bar {
  padding: 10px;
  border-bottom: 1px solid $border-light;
  flex-shrink: 0;
}

.folder-path-input {
  font-family: $font-code;
  font-size: 12px;

  :deep(.n-input__prefix) {
    margin-inline-end: 8px;
  }
}

.folder-path-icon {
  color: $text-muted;
}

.folder-tree {
  max-height: 260px;
  min-height: 0;
  padding: 6px;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
  font-size: 13px;
}

.folder-picker-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 32px 16px;
  color: $text-muted;
  font-size: 12px;
}

.folder-item {
  display: flex;
  align-items: center;
  min-height: 36px;
  min-width: 0;
  border-radius: $radius-sm;
  color: $text-secondary;
  transition: background $transition-fast, color $transition-fast;

  &:hover {
    background: $bg-card-hover;
    color: $text-primary;
  }

  &.selected {
    background: rgba(var(--accent-primary-rgb), 0.08);
    color: $accent-primary;
    box-shadow: inset 0 0 0 1px rgba(var(--accent-primary-rgb), 0.12);
  }

  &.root {
    width: 100%;
    gap: 10px;
    padding: 8px 10px;
    border: 0;
    background: $bg-secondary;
    font: inherit;
    text-align: start;
    cursor: pointer;
    margin-bottom: 6px;

    &.selected {
      background: rgba(var(--accent-primary-rgb), 0.08);
    }

    .folder-name {
      font-family: $font-code;
      font-size: 12px;
    }
  }

  &.empty {
    min-height: 28px;
    color: $text-muted;
    background: transparent;
  }
}

.folder-select,
.folder-expand,
.folder-selected-favorite {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  border-radius: $radius-sm;
}

.folder-select:focus-visible,
.folder-expand:focus-visible,
.folder-selected-favorite:focus-visible,
.folder-item.root:focus-visible {
  outline: 2px solid $accent-primary;
  outline-offset: -2px;
}

.folder-select {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  min-height: 36px;
  padding: 6px 10px 6px 4px;
  font: inherit;
  text-align: start;
}

.folder-expand {
  width: 26px;
  height: 30px;
  flex: 0 0 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: $text-muted;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;
  }
}

.folder-chevron {
  transition: transform $transition-fast;

  &.expanded {
    transform: rotate(90deg);
  }
}

.folder-icon,
.folder-check {
  flex-shrink: 0;
}

.folder-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.folder-empty-text {
  font-size: 12px;
}

.folder-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
  padding: 24px 16px;
  color: $text-muted;
}

.folder-selected {
  padding: 8px 12px;
  border-top: 1px solid $border-light;
  background: $bg-secondary;
  display: flex;
  gap: 12px;
  align-items: center;
  min-width: 0;
  flex-shrink: 0;
}

.folder-selected-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.folder-selected-label {
  font-size: 11px;
  line-height: 16px;
  color: $text-muted;
}

.folder-selected-path {
  font: 12px/18px $font-code;
  color: $text-primary;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.folder-selected-favorite {
  width: 30px;
  height: 30px;
  padding: 0;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: $text-muted;
  transition: background $transition-fast, color $transition-fast;

  &:hover:not(:disabled) {
    color: $accent-primary;
    background: rgba(var(--accent-primary-rgb), 0.08);
  }

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  &.is-pinned {
    color: $accent-primary;
  }
}

@media (prefers-reduced-motion: reduce) {
  .folder-chevron {
    transition: none;
  }
}
</style>
