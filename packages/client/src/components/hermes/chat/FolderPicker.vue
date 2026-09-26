<script setup lang="ts">
import { ref, computed, nextTick, onMounted, watch } from 'vue'
import { NButton, NDropdown, NInput, NModal, NSpace, NSpin, useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { request } from '@/api/client'
import { copyToClipboard } from '@/utils/clipboard'
import PinIcon from '@/components/common/PinIcon.vue'

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
}

function selectBase() {
  updateSelectedPath(basePath.value)
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
    <NInput
      :value="selectedPath"
      :placeholder="t('chat.workspacePlaceholder')"
      clearable
      size="small"
      class="folder-path-input"
      @update:value="updateSelectedPath"
    />
    <div v-if="loading" class="folder-picker-loading">
      <NSpin size="small" />
    </div>
    <div v-else class="folder-tree">
      <!-- Base path as root -->
      <div
        v-if="basePath"
        class="folder-item root"
        :class="{ selected: selectedPath === basePath }"
        @click="selectBase"
        @contextmenu="showContextMenu($event, null)"
      >
        <span class="folder-icon">📂</span>
        <span class="folder-name">{{ basePath || '/' }}</span>
      </div>

      <!-- Flat rendered tree -->
      <div
        v-for="node in flatNodes"
        :key="node.folder.path"
        class="folder-item"
        :class="{ selected: selectedPath === node.folder.fullPath }"
        :style="{ paddingLeft: `${12 + node.depth * 16}px` }"
        @click="selectFolder(node.folder)"
        @contextmenu="showContextMenu($event, node.folder)"
      >
        <span class="folder-expand" @click.stop="toggleExpand(node.folder)">
          <template v-if="node.isLoading">⏳</template>
          <template v-else>{{ node.isExpanded ? '▼' : '▶' }}</template>
        </span>
        <span class="folder-icon">📁</span>
        <span class="folder-name">{{ node.folder.name }}</span>
      </div>

      <!-- Empty children indicator for expanded folders with no children -->
      <template v-for="node in flatNodes" :key="'empty-' + node.folder.path">
        <div
          v-if="node.isExpanded && !node.isLoading && node.hasChildren === false"
          class="folder-item empty"
          :style="{ paddingLeft: `${28 + node.depth * 16}px` }"
        >
          <span class="folder-empty-text">{{ t('chat.folderPickerEmpty') }}</span>
        </div>
      </template>

      <div v-if="(folders.length === 0 || loadFailed) && !loading" class="folder-empty">
        {{ t('chat.folderPickerNoFolders') }}
      </div>
    </div>

    <!-- Selected path display -->
    <div v-if="selectedPath" class="folder-selected">
      <span class="folder-selected-label">{{ t('chat.folderPickerSelected') }}</span>
      <span class="folder-selected-path" :title="selectedPath">{{ selectedPath }}</span>
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
        <PinIcon :filled="props.favorite" />
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
.folder-picker {
  max-height: 360px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 8px;
  background: rgba(0, 0, 0, 0.2);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.folder-path-input {
  margin-bottom: 8px;
  flex-shrink: 0;
}

.folder-tree {
  max-height: 260px;
  overflow-y: auto;
}

.folder-picker-loading {
  display: flex;
  justify-content: center;
  padding: 24px;
}

.folder-tree {
  font-size: 13px;
}

.folder-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.15s;

  &:hover {
    background: rgba(255, 255, 255, 0.06);
  }

  &.selected {
    background: rgba(64, 158, 255, 0.15);
    outline: 1px solid rgba(64, 158, 255, 0.4);
  }

  &.root {
    font-weight: 600;
    margin-bottom: 4px;
  }

  &.empty {
    opacity: 0.5;
    cursor: default;
  }
}

.folder-expand {
  width: 14px;
  font-size: 10px;
  text-align: center;
  flex-shrink: 0;
  user-select: none;
  opacity: 0.6;
}

.folder-icon {
  flex-shrink: 0;
}

.folder-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.folder-empty-text {
  font-size: 11px;
  opacity: 0.5;
  font-style: italic;
}

.folder-empty {
  text-align: center;
  padding: 16px;
  opacity: 0.5;
}

.folder-selected {
  margin-top: 8px;
  padding: 6px 8px;
  background: rgba(64, 158, 255, 0.08);
  border-radius: 4px;
  font-size: 12px;
  display: flex;
  gap: 8px;
  align-items: center;
  min-width: 0;
  flex-shrink: 0;
}

.folder-selected-label {
  opacity: 0.6;
  flex-shrink: 0;
}

.folder-selected-path {
  font-family: monospace;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.folder-selected-favorite {
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 4px;
  padding: 0;
  margin-inline-start: 2px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  background: transparent;
  cursor: pointer;
  transition: background 0.15s, transform 0.15s, color 0.15s;

  &:hover:not(:disabled) {
    color: var(--accent-primary);
    background: rgba(var(--accent-primary-rgb), 0.08);
    transform: scale(1.08);
  }

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  &.is-pinned {
    color: var(--accent-primary);
  }
}
</style>
