<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NSpin, NEmpty, NIcon } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { listUSBFiles, type USBFileEntry } from '@/api/studio/usb'
import { useMessage } from '@/composables/useAppMessage'

interface TreeNode {
  key: string
  label: string
  path: string
  isDir: boolean
}

interface NodeState {
  loading: boolean
  loaded: boolean
  error?: string
  children: TreeNode[]
}

const props = defineProps<{
  uuid: string
  currentPath: string
}>()

const emit = defineEmits<{
  navigate: [path: string]
}>()

const { t } = useI18n()
const message = useMessage()

const root = ref<TreeNode | null>(null)
const loadingRoot = ref(false)
const rootError = ref('')
const nodeState = ref(new Map<string, NodeState>())

function makeLeaf(entry: USBFileEntry): TreeNode {
  return {
    key: entry.path,
    label: entry.name,
    path: entry.path,
    isDir: entry.isDir,
  }
}

function ensureNode(path: string): NodeState {
  if (!nodeState.value.has(path)) {
    nodeState.value.set(path, { loading: false, loaded: false, children: [] })
  }
  return nodeState.value.get(path)!
}

async function loadRoot() {
  loadingRoot.value = true
  rootError.value = ''
  try {
    const response = await listUSBFiles(props.uuid, '/')
    const folders = response.entries.filter(entry => entry.isDir)
    const rootState = ensureNode('/')
    rootState.loaded = true
    rootState.children = folders.map(makeLeaf)
    root.value = {
      key: '/',
      label: t('usb.explorer.breadcrumb.root'),
      path: '/',
      isDir: false,
    }
  } catch (error: any) {
    rootError.value = error?.message || t('usb.explorer.errors.loadFailed')
    message.error(rootError.value)
  } finally {
    loadingRoot.value = false
  }
}

async function loadChildren(path: string) {
  const state = ensureNode(path)
  if (state.loaded || state.loading) return
  state.loading = true
  state.error = undefined
  try {
    const response = await listUSBFiles(props.uuid, path)
    const folders = response.entries.filter(entry => entry.isDir)
    state.children = folders.map(makeLeaf)
    state.loaded = true
  } catch (error: any) {
    const errMsg = error?.message || t('usb.explorer.errors.loadFailed')
    state.error = errMsg
    message.error(errMsg)
  } finally {
    state.loading = false
  }
}

function handleToggle(node: TreeNode) {
  if (!node.isDir) return
  void loadChildren(node.path)
}

function handleSelect(node: TreeNode) {
  emit('navigate', node.path)
}

const expandedKeys = computed(() => {
  if (!root.value) return [] as string[]
  const collected: string[] = []
  let cursor = props.currentPath
  while (cursor && cursor !== '/') {
    collected.push(cursor)
    const lastSlash = cursor.lastIndexOf('/')
    if (lastSlash <= 0) break
    cursor = cursor.slice(0, lastSlash)
  }
  return collected
})

watch(
  () => [props.uuid],
  () => {
    nodeState.value = new Map()
    root.value = null
    void loadRoot()
  },
  { immediate: true },
)
</script>

<template>
  <div class="usb-explorer-tree">
    <div class="tree-head">
      <span class="tree-title">{{ t('usb.explorer.tree.title') }}</span>
    </div>
    <NSpin :show="loadingRoot">
      <div v-if="rootError" class="tree-empty">
        <NEmpty :description="rootError" size="small" />
      </div>
      <div v-else-if="!root || !nodeState.get('/')?.children?.length" class="tree-empty">
        <NEmpty :description="t('usb.explorer.tree.empty')" size="small" />
      </div>
      <ul v-else class="tree-list">
        <li class="tree-root">
          <button
            type="button"
            class="tree-row tree-row--root"
            :class="{ active: props.currentPath === '/' }"
            @click="handleSelect(root!)"
          >
            <NIcon class="tree-icon">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 7l8-4 8 4-8 4-8-4z" />
                <path d="M4 12l8 4 8-4" />
                <path d="M4 17l8 4 8-4" />
              </svg>
            </NIcon>
            <span class="tree-label">{{ root.label }}</span>
          </button>
          <ul v-if="(nodeState.get('/')?.children?.length ?? 0) > 0" class="tree-list tree-list--nested">
            <li v-for="node in nodeState.get('/')?.children ?? []" :key="node.key">
              <details
                :open="expandedKeys.includes(node.path)"
                @toggle="handleToggle(node)"
              >
                <summary
                  class="tree-row"
                  :class="{ active: props.currentPath === node.path || props.currentPath.startsWith(node.path + '/') }"
                  @click.prevent="handleSelect(node)"
                >
                  <NIcon class="tree-icon">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                    </svg>
                  </NIcon>
                  <span class="tree-label">{{ node.label }}</span>
                </summary>
                <ul
                  v-if="(nodeState.get(node.path)?.children?.length ?? 0) > 0"
                  class="tree-list tree-list--nested"
                >
                  <li v-for="child in nodeState.get(node.path)?.children ?? []" :key="child.key">
                    <button
                      type="button"
                      class="tree-row"
                      :class="{ active: props.currentPath === child.path || props.currentPath.startsWith(child.path + '/') }"
                      @click="handleSelect(child)"
                    >
                      <NIcon class="tree-icon">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                        </svg>
                      </NIcon>
                      <span class="tree-label">{{ child.label }}</span>
                    </button>
                  </li>
                </ul>
              </details>
            </li>
          </ul>
        </li>
      </ul>
    </NSpin>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.usb-explorer-tree {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  background: var(--theme-card-bg, var(--bg-card));
  border: 1px solid $border-light;
  border-radius: $radius-md;
  padding: 10px 8px;
}

.tree-head {
  padding: 4px 6px;
  border-bottom: 1px solid $border-light;
}

.tree-title {
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: $text-muted;
}

.tree-list,
.tree-list--nested {
  list-style: none;
  margin: 0;
  padding: 0;
}

.tree-list--nested {
  padding-inline-start: 16px;
  margin-top: 2px;
}

details > summary {
  list-style: none;
  cursor: pointer;
}

details > summary::-webkit-details-marker {
  display: none;
}

.tree-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 8px;
  border: none;
  background: transparent;
  color: $text-primary;
  font-family: inherit;
  font-size: 12.5px;
  text-align: start;
  border-radius: $radius-sm;
  cursor: pointer;
  transition: background $transition-fast;

  &:hover {
    background: var(--theme-card-bg, var(--bg-card));
  }

  &.active {
    background: rgba(var(--accent-info-rgb), 0.12);
    color: var(--accent-info);
  }
}

.tree-row--root {
  font-weight: 600;
}

.tree-icon {
  flex: 0 0 auto;
  color: $text-muted;
}

.tree-row.active .tree-icon {
  color: var(--accent-info);
}

.tree-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-empty {
  padding: 16px 8px;
}
</style>