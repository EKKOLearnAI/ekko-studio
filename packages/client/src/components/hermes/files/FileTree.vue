<script setup lang="ts">
import { computed, ref, watch, h } from 'vue'
import { NTree } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/hermes/files'
import { gitStatusBadge, gitStatusClass } from '@/utils/hermes/workspace-git-status'
import type { FileEntry, GitFileStatus } from '@/api/studio/files'
import type { TreeOption } from 'naive-ui'

const { t } = useI18n()
const filesStore = useFilesStore()
const props = defineProps<{
  profile?: string | null
  workspaceKey?: string | null
}>()
const emit = defineEmits<{
  (event: 'contextmenu-entry', mouseEvent: MouseEvent, entry: FileEntry): void
  (event: 'open-entry', entry: FileEntry): void
}>()

const effectiveProfile = computed(() => props.profile === undefined ? filesStore.currentProfile : props.profile)
const workspaceMode = computed(() => Boolean(filesStore.currentWorkspaceSessionId || filesStore.currentWorkspaceRoomId))
const rootLabel = computed(() => {
  const workspace = String(props.workspaceKey || '').replace(/[\\/]+$/, '')
  return workspace ? workspace.split(/[\\/]/).pop() || workspace : t('files.breadcrumbRoot')
})

interface GitTreeOption extends TreeOption {
  entry: FileEntry
  gitStatus?: GitFileStatus
  gitStatusCount?: number
}

const treeData = ref<GitTreeOption[]>([])
const selectedKeys = ref<string[]>([])
const treeInstanceKey = ref(0)
const rootGitStatus = ref<GitFileStatus>()
const rootGitStatusCount = ref(0)
let rootLoadSeq = 0

async function loadChildren(path: string): Promise<GitTreeOption[]> {
  try {
    const result = filesStore.currentWorkspaceSessionId || filesStore.currentWorkspaceRoomId
      ? await filesStore.listEntries(path)
      : await filesStore.fetchDirectory(path, { profile: effectiveProfile.value })
    if (!path) {
      rootGitStatus.value = result.gitStatus
      rootGitStatusCount.value = result.gitStatusCount || 0
    }
    return result.entries
      .filter(entry => workspaceMode.value || entry.isDir)
      .sort((a, b) => a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1)
      .map(e => ({
        key: e.path,
        label: e.name,
        isLeaf: !e.isDir,
        entry: e,
        gitStatus: e.gitStatus,
        gitStatusCount: e.gitStatusCount,
      }))
  } catch {
    if (!path) {
      rootGitStatus.value = undefined
      rootGitStatusCount.value = 0
    }
    return []
  }
}

async function handleLoad(node: TreeOption): Promise<void> {
  const seq = rootLoadSeq
  const children = await loadChildren(node.key as string)
  if (seq === rootLoadSeq) node.children = children
}

function findOption(options: GitTreeOption[], key: string): GitTreeOption | undefined {
  for (const option of options) {
    if (String(option.key) === key) return option
    const child = findOption((option.children || []) as GitTreeOption[], key)
    if (child) return child
  }
  return undefined
}

async function handleSelect(keys: string[]) {
  if (!keys.length) return
  selectedKeys.value = keys
  const option = findOption(treeData.value, keys[0])
  if (!option) return
  if (option.entry.isDir) {
    if (workspaceMode.value) filesStore.selectDirectory(option.entry.path)
    else await filesStore.navigateTo(option.entry.path, { profile: effectiveProfile.value })
  }
}

function handleRootClick() {
  selectedKeys.value = []
  if (workspaceMode.value) filesStore.selectDirectory('')
  else void filesStore.navigateTo('', { profile: effectiveProfile.value })
}

function renderLabel({ option }: { option: TreeOption }) {
  const gitOption = option as GitTreeOption
  const label = String(option.label || '')
  return h('span', {
    class: ['tree-node-label', gitStatusClass(gitOption.gitStatus)],
    title: label,
  }, label)
}

function renderSuffix({ option }: { option: TreeOption }) {
  const gitOption = option as GitTreeOption
  const badge = gitStatusBadge(gitOption.gitStatus)
  if (!badge) return null
  const count = gitOption.gitStatusCount || 0
  return h('span', {
    class: ['git-status-badge', gitStatusClass(gitOption.gitStatus)],
    title: count > 1 ? `${badge} · ${count}` : badge,
  }, badge)
}

function renderPrefix({ option }: { option: TreeOption }) {
  const entry = (option as GitTreeOption).entry
  return entry.isDir
    ? h('svg', { class: 'tree-node-icon', viewBox: '0 0 16 16', 'aria-hidden': 'true' }, [
        h('path', { d: 'M1.5 3.5h5l1.5 2h6.5v7.5h-13z' }),
      ])
    : h('svg', { class: 'tree-node-icon', viewBox: '0 0 16 16', 'aria-hidden': 'true' }, [
        h('path', { d: 'M3 1.5h6l4 4v9H3z' }),
        h('path', { d: 'M9 1.5v4h4' }),
      ])
}

function nodeProps({ option }: { option: TreeOption }) {
  const gitOption = option as GitTreeOption
  return {
    class: gitStatusClass(gitOption.gitStatus),
    onClick: () => {
      if (gitOption.entry.isDir) return
      selectedKeys.value = [String(gitOption.key)]
      emit('open-entry', gitOption.entry)
    },
    onContextmenu: (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      emit('contextmenu-entry', event, gitOption.entry)
    },
  }
}

const treeThemeOverrides = {
  fontSize: 'calc(var(--font-size-base, 14px) * 13 / 14)',
  nodeHeight: '24px',
  nodeWrapperPadding: '0',
  nodeBorderRadius: '0',
  nodeColorHover: 'rgba(var(--accent-primary-rgb), 0.06)',
  nodeColorPressed: 'rgba(var(--accent-primary-rgb), 0.1)',
  nodeColorActive: 'rgba(var(--accent-primary-rgb), 0.1)',
}

watch([effectiveProfile, () => filesStore.currentWorkspaceSessionId, () => filesStore.currentWorkspaceRoomId, () => props.workspaceKey], async () => {
  const seq = ++rootLoadSeq
  selectedKeys.value = []
  treeInstanceKey.value += 1
  const nextTreeData = await loadChildren('')
  if (seq === rootLoadSeq) treeData.value = nextTreeData
}, { immediate: true })

watch(() => filesStore.entries, async () => {
  if (!workspaceMode.value) return
  const seq = ++rootLoadSeq
  treeInstanceKey.value += 1
  const nextTreeData = await loadChildren('')
  if (seq === rootLoadSeq) treeData.value = nextTreeData
})
</script>

<template>
  <div class="file-tree">
    <div class="tree-header" :class="gitStatusClass(rootGitStatus)" :title="workspaceKey || rootLabel" @click="handleRootClick">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round">
        <path d="M1.5 3.5h5l1.5 2h6.5v7.5h-13z" />
      </svg>
      <span class="tree-root-label">{{ rootLabel }}</span>
      <span
        v-if="rootGitStatus"
        class="git-status-badge root-status-badge"
        :class="gitStatusClass(rootGitStatus)"
        :title="rootGitStatusCount > 1 ? `${gitStatusBadge(rootGitStatus)} · ${rootGitStatusCount}` : gitStatusBadge(rootGitStatus)"
      >{{ gitStatusBadge(rootGitStatus) }}</span>
    </div>
    <NTree
      :key="treeInstanceKey"
      :data="treeData"
      :selected-keys="selectedKeys"
      :on-load="handleLoad"
      :render-label="renderLabel"
      :render-prefix="renderPrefix"
      :render-suffix="renderSuffix"
      :node-props="nodeProps"
      :theme-overrides="treeThemeOverrides"
      :indent="6"
      expand-on-click
      block-line
      @update:selected-keys="handleSelect"
    />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.file-tree {
  padding: 0 calc(4px * var(--spacing-scale, 1)) calc(8px * var(--spacing-scale, 1));
}

.tree-header {
  display: flex;
  align-items: center;
  gap: calc(6px * var(--spacing-scale, 1));
  min-height: 24px;
  padding: 0 calc(6px * var(--spacing-scale, 1));
  cursor: pointer;
  border-radius: 0;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  font-weight: 600;
  color: $text-primary;

  &:hover {
    background-color: rgba(var(--accent-primary-rgb), 0.06);
  }
}

.tree-root-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.tree-node-label) {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}

:deep(.n-tree-node-content__prefix) {
  margin-inline-end: 6px;
}

:deep(.n-tree-node-content__text) {
  min-width: 0;
}

:deep(.n-tree-node-content__suffix) {
  margin-inline-start: auto;
}

:deep(.tree-node-icon) {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: $text-muted;
  stroke-width: 1.15;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.git-status-modified,
:deep(.git-status-modified) {
  color: var(--git-decoration-modified);
}

.git-status-added,
:deep(.git-status-added) {
  color: var(--git-decoration-added);
}

.git-status-untracked,
:deep(.git-status-untracked) {
  color: var(--git-decoration-untracked);
}

.git-status-deleted,
:deep(.git-status-deleted) {
  color: var(--git-decoration-deleted);
}

.git-status-conflicted,
:deep(.git-status-conflicted) {
  color: var(--git-decoration-conflicting);
}

.git-status-renamed,
:deep(.git-status-renamed) {
  color: var(--git-decoration-renamed);
}

.git-status-badge,
:deep(.git-status-badge) {
  flex: 0 0 auto;
  min-width: 14px;
  margin-inline-start: 8px;
  font-family: var(--font-code, $font-code);
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  font-weight: 600;
  text-align: center;
}

.root-status-badge {
  margin-inline-start: auto;
}
</style>
