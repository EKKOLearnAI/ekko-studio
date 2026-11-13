<script setup lang="ts">
/**
 * USBExplorer - 文件浏览器（主体视图）
 * v2 重设计：文件列表占满主体（80%+），预览改为 slide-over
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { listUSBFiles, downloadUSBFile, type USBFileEntry } from '@/api/studio/usb'
import type { USBDeviceRecord } from '@/api/studio/usb-socket'
import { copyToClipboard } from '@/utils/clipboard'
import { normalizeExplorerPath, parentExplorerPath } from '@/utils/usb-format'
import { useMessage } from '@/composables/useAppMessage'
import USBExplorerToolbar, { type ExplorerViewMode } from './USBExplorerToolbar.vue'
import USBExplorerList from './USBExplorerList.vue'
import USBExplorerPreview from './USBExplorerPreview.vue'
import USBExplorerContextMenu from './USBExplorerContextMenu.vue'
import type { UsbDetailSection } from '../UsbDetailDrawer.vue'

const props = defineProps<{
  device: USBDeviceRecord | null
  agentReadEnabled: boolean
  agentReadBusy: boolean
  agentReadHint: string
}>()

const emit = defineEmits<{
  readWithAgent: [payload: { path: string, name: string }]
  openDrawer: [section: UsbDetailSection]
}>()

const { t } = useI18n()
const message = useMessage()

const currentPath = ref('/')
const entries = ref<USBFileEntry[]>([])
const selectedEntry = ref<USBFileEntry | null>(null)
const loading = ref(false)
const errorMessage = ref('')
const searchTerm = ref('')
const viewMode = ref<ExplorerViewMode>('list')
const addressValue = ref('/')
const addressEditing = ref(false)

const backStack = ref<string[]>([])
const forwardStack = ref<string[]>([])

const contextShow = ref(false)
const contextX = ref(0)
const contextY = ref(0)
const contextEntry = ref<USBFileEntry | null>(null)

const previewOpen = ref(false)

const canBack = computed(() => backStack.value.length > 0)
const canForward = computed(() => forwardStack.value.length > 0)
const canUp = computed(() => currentPath.value !== '/' && currentPath.value !== '')

const entryCount = computed(() => entries.value.length)

function resetNavigation() {
  backStack.value = []
  forwardStack.value = []
  currentPath.value = '/'
  selectedEntry.value = null
  searchTerm.value = ''
  addressEditing.value = false
  addressValue.value = '/'
}

function pushHistory(targetPath: string) {
  if (targetPath === currentPath.value) return
  backStack.value.push(currentPath.value)
  forwardStack.value = []
  currentPath.value = targetPath
  addressValue.value = targetPath
}

function navigateBack() {
  if (!canBack.value) return
  const previous = backStack.value.pop() || '/'
  forwardStack.value.push(currentPath.value)
  currentPath.value = previous
  addressValue.value = previous
}

function navigateForward() {
  if (!canForward.value) return
  const next = forwardStack.value.pop() || '/'
  backStack.value.push(currentPath.value)
  currentPath.value = next
  addressValue.value = next
}

function navigateUp() {
  if (!canUp.value) return
  pushHistory(parentExplorerPath(currentPath.value))
}

function navigateTo(targetPath: string) {
  const normalized = normalizeExplorerPath(targetPath)
  pushHistory(normalized)
}

function startEditAddress() {
  addressValue.value = currentPath.value
  addressEditing.value = true
}

function submitAddress() {
  const normalized = normalizeExplorerPath(addressValue.value)
  addressValue.value = normalized
  addressEditing.value = false
  pushHistory(normalized)
}

function cancelEditAddress() {
  addressEditing.value = false
  addressValue.value = currentPath.value
}

function updateAddress(value: string) {
  addressValue.value = value
}

function updateSearch(value: string) {
  searchTerm.value = value
}

function toggleView(mode: ExplorerViewMode) {
  viewMode.value = mode
}

async function loadCurrent() {
  if (!props.device) {
    entries.value = []
    return
  }
  loading.value = true
  errorMessage.value = ''
  try {
    const response = await listUSBFiles(props.device.uuid, currentPath.value)
    currentPath.value = response.path || currentPath.value
    addressValue.value = currentPath.value
    entries.value = response.entries
    selectedEntry.value = response.entries.find(entry => entry.path === selectedEntry.value?.path) || null
    if (!selectedEntry.value) previewOpen.value = false
  } catch (error: any) {
    errorMessage.value = error?.message || t('usb.explorer.errors.loadFailed')
  } finally {
    loading.value = false
  }
}

function handleSelect(entry: USBFileEntry) {
  selectedEntry.value = entry
  if (entry.isDir) {
    previewOpen.value = false
  } else {
    previewOpen.value = true
  }
}

async function handleOpen(entry: USBFileEntry) {
  if (entry.isDir) {
    navigateTo(entry.path)
    return
  }
  selectedEntry.value = entry
  previewOpen.value = true
}

function handleContext(event: MouseEvent, entry: USBFileEntry) {
  event.preventDefault()
  contextEntry.value = entry
  contextX.value = event.clientX
  contextY.value = event.clientY
  contextShow.value = true
}

function closeContext() {
  contextShow.value = false
}

function refreshCurrent() {
  void loadCurrent()
}

function closePreview() {
  previewOpen.value = false
}

async function copyEntryPath(entry: USBFileEntry) {
  if (!props.device) return
  const absolute = `${props.device.mountPoint}${entry.path}`
  const ok = await copyToClipboard(absolute)
  if (ok) message.success(t('common.copied'))
  else message.error(t('usb.explorer.errors.copyFailed'))
}

async function copyEntryName(entry: USBFileEntry) {
  const ok = await copyToClipboard(entry.name)
  if (ok) message.success(t('common.copied'))
  else message.error(t('usb.explorer.errors.copyFailed'))
}

async function downloadEntry(entry: USBFileEntry) {
  if (!props.device || entry.isDir) return
  try {
    await downloadUSBFile(props.device.uuid, entry.path, entry.name)
    message.success(t('usb.page.downloadStarted'))
  } catch (error: any) {
    message.error(error?.message || t('usb.explorer.errors.downloadFailed'))
  }
}

function readEntryWithAgent(entry: USBFileEntry) {
  if (entry.isDir) return
  emit('readWithAgent', { path: entry.path, name: entry.name })
}

function openDrawer(section: UsbDetailSection = 'details') {
  emit('openDrawer', section)
}

function openAdvanced() {
  openDrawer('details')
}

watch(
  () => props.device?.uuid,
  () => {
    resetNavigation()
    previewOpen.value = false
    void loadCurrent()
  },
  { immediate: true },
)

watch(
  () => currentPath.value,
  () => {
    void loadCurrent()
  },
)

watch(
  () => props.device?.label,
  (label) => {
    if (label && currentPath.value === '/') {
      addressValue.value = label
    }
  },
)
</script>

<template>
  <section class="usb-explorer">
    <div class="explorer-toolbar-wrap">
      <USBExplorerToolbar
        :can-back="canBack"
        :can-forward="canForward"
        :can-up="canUp"
        :search-value="searchTerm"
        :address-value="addressValue"
        :address-editing="addressEditing"
        :view-mode="viewMode"
        :on-advanced="openAdvanced"
        @back="navigateBack"
        @forward="navigateForward"
        @up="navigateUp"
        @refresh="refreshCurrent"
        @update:search="updateSearch"
        @update:address="updateAddress"
        @start-edit-address="startEditAddress"
        @cancel-edit-address="cancelEditAddress"
        @submit-address="submitAddress"
        @toggle-view="toggleView"
      />
    </div>

    <div class="explorer-list-scroll">
      <USBExplorerList
        :entries="entries"
        :loading="loading"
        :selected-path="selectedEntry?.path || ''"
        :view-mode="viewMode"
        :search-term="searchTerm"
        :error-message="errorMessage"
        @select="handleSelect"
        @open="handleOpen"
        @context="handleContext"
      />
    </div>

    <footer class="explorer-status-bar">
      <span class="status-item">
        <strong>{{ entryCount }}</strong>
        <span class="status-meta">{{ t('usb.page.statusBar.entries') }}</span>
      </span>
      <span class="status-divider" />
      <span class="status-item">
        <span class="status-meta">{{ t('usb.page.statusBar.path') }}</span>
        <code class="status-path">{{ currentPath }}</code>
      </span>
      <span class="status-spacer" />
      <span class="status-item">
        <span class="status-dot" :class="`is-${props.device?.status || 'unknown'}`" />
        <span class="status-meta">{{ t(`usb.page.runtime.${props.device ? 'running' : 'idle'}`) }}</span>
      </span>
    </footer>

    <Teleport to="body">
      <Transition name="preview-slide">
        <USBExplorerPreview
          v-if="previewOpen"
          class="explorer-preview-slideover"
          :device="props.device"
          :entry="selectedEntry"
          :agent-read-enabled="props.agentReadEnabled"
          :agent-read-busy="props.agentReadBusy"
          :agent-read-hint="props.agentReadHint"
          @read-with-agent="emit('readWithAgent', $event)"
          @close="closePreview"
        />
      </Transition>
    </Teleport>

    <USBExplorerContextMenu
      :show="contextShow"
      :x="contextX"
      :y="contextY"
      :entry="contextEntry"
      :device-label="props.device?.label || ''"
      :mount-point="props.device?.mountPoint || ''"
      :agent-read-enabled="props.agentReadEnabled"
      :agent-read-busy="props.agentReadBusy"
      @update:show="closeContext"
      @open="handleOpen"
      @copy-path="copyEntryPath"
      @copy-name="copyEntryName"
      @download="downloadEntry"
      @read-with-agent="readEntryWithAgent"
      @refresh="refreshCurrent"
    />
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.usb-explorer {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-height: 0;
  flex: 1;
  background: var(--theme-card-bg, var(--bg-card));
  border: 1px solid $border-light;
  border-radius: $radius-md;
  overflow: hidden;
}

.explorer-toolbar-wrap {
  flex: 0 0 auto;
  border-bottom: 1px solid $border-light;
}

.explorer-list-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
}

.explorer-list-scroll > * {
  flex: 1 1 auto;
  min-height: 0;
}

.explorer-list-scroll :deep(.usb-explorer-list),
.explorer-list-scroll :deep(.list-table),
.explorer-list-scroll :deep(.grid-view) {
  border: none;
  border-radius: 0;
  background: transparent;
}

/* ── Status bar (底部状态行) ─────────────────────────────────────────*/
.explorer-status-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 14px;
  background: var(--theme-card-bg, var(--bg-card));
  border: 1px solid $border-light;
  border-radius: $radius-md;
  font-size: 11.5px;
  color: $text-secondary;
}

.status-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.status-item strong {
  font-weight: 600;
  color: $text-primary;
  font-variant-numeric: tabular-nums;
}

.status-meta {
  color: $text-muted;
}

.status-divider {
  width: 1px;
  height: 12px;
  background: $border-light;
}

.status-spacer {
  flex: 1;
}

.status-path {
  font-family: $font-code;
  font-size: 11px;
  color: $text-secondary;
  background: var(--theme-card-bg, var(--bg-card));
  padding: 1px 6px;
  border-radius: $radius-sm;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: $text-muted;

  &.is-mounted { background: $success; }
  &.is-mount_failed { background: $error; }
  &.is-ejecting,
  &.is-removing,
  &.is-removed { background: $warning; }
}

/* ── Slide-over preview (Teleport) ────────────────────────────────────*/
.preview-slide-enter-active,
.preview-slide-leave-active {
  transition: transform $transition-normal, opacity $transition-normal;
}

.preview-slide-enter-from,
.preview-slide-leave-to {
  transform: translateX(100%);
  opacity: 0;
}

.explorer-preview-slideover {
  position: fixed;
  top: 64px;
  right: 0;
  bottom: 0;
  width: min(420px, 38vw);
  z-index: 1000;
  box-shadow: -8px 0 24px rgba(var(--text-primary-rgb), 0.18);
}

@media (max-width: $breakpoint-mobile) {
  .explorer-preview-slideover {
    width: min(360px, 90vw);
  }
}
</style>