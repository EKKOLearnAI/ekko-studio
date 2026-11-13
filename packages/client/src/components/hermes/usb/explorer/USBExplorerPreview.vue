<script setup lang="ts">
/**
 * USBExplorerPreview - 文件预览（slide-over 形态）
 * 选中文件即从右侧滑入，可关闭
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NButton, NEmpty, NSpin, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { copyToClipboard } from '@/utils/clipboard'
import { downloadUSBFile, fetchUSBFileBlob, statUSBPath, type USBFileStat } from '@/api/studio/usb'
import type { USBDeviceRecord } from '@/api/studio/usb-socket'
import { formatExplorerBytes, formatExplorerTime, getExplorerEntryKind, isImageKind, isTextPreviewKind } from '@/utils/usb-format'
import { useMessage } from '@/composables/useAppMessage'

const props = defineProps<{
  device: USBDeviceRecord | null
  entry: { name: string, path: string, isDir: boolean, size: number, modTime: string } | null
  agentReadEnabled: boolean
  agentReadBusy: boolean
  agentReadHint: string
}>()

const emit = defineEmits<{
  readWithAgent: [payload: { path: string, name: string }]
  close: []
}>()

const { t } = useI18n()
const message = useMessage()

const loading = ref(false)
const stat = ref<USBFileStat | null>(null)
const previewText = ref('')
const previewImageUrl = ref('')
const previewError = ref('')

const entryKind = computed(() => {
  if (!props.entry) return 'unknown'
  return getExplorerEntryKind(props.entry.name, props.entry.isDir)
})

const displayName = computed(() => props.entry?.name || '')
const isImage = computed(() => !!props.entry && isImageKind(entryKind.value))
const isText = computed(() => !!props.entry && isTextPreviewKind(entryKind.value))
const isLargeText = computed(() => !!props.entry && isText.value && props.entry.size > 512 * 1024)
const isDir = computed(() => !!props.entry?.isDir)

function resetPreview() {
  previewText.value = ''
  if (previewImageUrl.value) {
    URL.revokeObjectURL(previewImageUrl.value)
  }
  previewImageUrl.value = ''
  previewError.value = ''
  stat.value = null
}

async function load() {
  if (!props.device || !props.entry || props.entry.isDir) {
    resetPreview()
    return
  }
  loading.value = true
  previewError.value = ''
  resetPreview()
  try {
    const statResponse = await statUSBPath(props.device.uuid, props.entry.path)
    stat.value = statResponse.stat
    if (isImage.value) {
      const blob = await fetchUSBFileBlob(props.device.uuid, props.entry.path)
      previewImageUrl.value = URL.createObjectURL(blob)
    } else if (isText.value && !isLargeText.value) {
      const blob = await fetchUSBFileBlob(props.device.uuid, props.entry.path)
      previewText.value = await blob.text()
    }
  } catch (error: any) {
    previewError.value = error?.message || t('usb.explorer.errors.loadPreviewFailed')
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.device?.uuid, props.entry?.path],
  () => {
    resetPreview()
    void load()
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  resetPreview()
})

function handleClose() {
  emit('close')
}

async function handleCopyPath() {
  if (!props.entry) return
  const absolute = props.device
    ? `${props.device.mountPoint}${props.entry.path === '/' ? '' : props.entry.path}`
    : props.entry.path
  const ok = await copyToClipboard(absolute)
  if (ok) message.success(t('common.copied'))
  else message.error(t('usb.explorer.errors.copyFailed'))
}

async function handleCopyName() {
  if (!props.entry) return
  const ok = await copyToClipboard(props.entry.name)
  if (ok) message.success(t('common.copied'))
  else message.error(t('usb.explorer.errors.copyFailed'))
}

async function handleDownload() {
  if (!props.device || !props.entry || props.entry.isDir) return
  try {
    await downloadUSBFile(props.device.uuid, props.entry.path, props.entry.name)
    message.success(t('usb.page.downloadStarted'))
  } catch (error: any) {
    message.error(error?.message || t('usb.explorer.errors.downloadFailed'))
  }
}

function handleReadWithAgent() {
  if (!props.entry || props.entry.isDir) return
  emit('readWithAgent', { path: props.entry.path, name: props.entry.name })
}
</script>

<template>
  <aside class="usb-explorer-preview">
    <header class="preview-head">
      <span class="preview-title">{{ displayName || t('usb.explorer.preview.selectFile') }}</span>
      <div class="preview-head-actions">
        <NTag v-if="props.entry" size="small" round :type="isDir ? 'default' : 'info'">
          {{ isDir ? t('usb.page.browser.folder') : t('usb.page.browser.file') }}
        </NTag>
        <NButton size="tiny" quaternary class="preview-close" @click="handleClose">
          ✕
        </NButton>
      </div>
    </header>

    <div v-if="!props.entry" class="preview-empty">
      <NEmpty :description="t('usb.explorer.preview.selectFile')" />
    </div>

    <NSpin v-else :show="loading">
      <div v-if="previewError" class="preview-error">
        <NEmpty :description="previewError" />
      </div>
      <div v-else class="preview-body">
        <dl class="preview-stats">
          <div>
            <dt>{{ t('usb.page.name') }}</dt>
            <dd>{{ displayName }}</dd>
          </div>
          <div>
            <dt>{{ t('usb.page.type') }}</dt>
            <dd>{{ isDir ? t('usb.page.browser.folder') : t('usb.page.browser.file') }}</dd>
          </div>
          <div>
            <dt>{{ t('usb.page.size') }}</dt>
            <dd>{{ formatExplorerBytes(props.entry.size) }}</dd>
          </div>
          <div>
            <dt>{{ t('usb.page.modifiedAt') }}</dt>
            <dd>{{ formatExplorerTime(props.entry.modTime) }}</dd>
          </div>
          <div v-if="stat?.path">
            <dt>{{ t('usb.page.mountPoint') }}</dt>
            <dd>{{ props.device ? `${props.device.mountPoint}${stat.path}` : stat.path }}</dd>
          </div>
        </dl>

        <div v-if="!isDir" class="preview-content">
          <img v-if="previewImageUrl" :src="previewImageUrl" :alt="displayName" class="image-preview" />
          <pre v-else-if="previewText" class="text-preview">{{ previewText }}</pre>
          <div v-else class="preview-placeholder">
            {{ t('usb.explorer.preview.noPreview') }}
          </div>
        </div>
        <div v-else class="preview-placeholder">
          {{ t('usb.explorer.preview.noPreview') }}
        </div>

        <div class="preview-actions">
          <NButton size="small" ghost :disabled="!props.entry || isDir" @click="handleCopyPath">
            {{ t('usb.explorer.preview.copyPath') }}
          </NButton>
          <NButton size="small" ghost :disabled="!props.entry || isDir" @click="handleCopyName">
            {{ t('usb.explorer.preview.copyFileName') }}
          </NButton>
          <NButton size="small" ghost :disabled="!props.entry || isDir" @click="handleDownload">
            {{ t('usb.explorer.preview.download') }}
          </NButton>
          <NButton
            size="small"
            type="primary"
            :disabled="!props.entry || isDir || !props.agentReadEnabled || props.agentReadBusy"
            :title="props.agentReadHint"
            @click="handleReadWithAgent"
          >
            {{ t('usb.explorer.preview.readWithAgent') }}
          </NButton>
        </div>
      </div>
    </NSpin>
  </aside>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.usb-explorer-preview {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  background: var(--theme-card-bg, var(--bg-card));
  border-left: 1px solid $border-light;
  border-radius: 0;
  padding: 14px 16px;
}

.preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid $border-light;
}

.preview-title {
  font-size: 13px;
  font-weight: 600;
  color: $text-primary;
  word-break: break-word;
  flex: 1;
  min-width: 0;
}

.preview-head-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.preview-close {
  font-size: 14px;
}

.preview-empty,
.preview-error {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
}

.preview-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  flex: 1;
  overflow: auto;
}

.preview-stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin: 0;

  div {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 8px 10px;
    border: 1px solid $border-light;
    border-radius: $radius-sm;
    background: var(--theme-card-bg, var(--bg-card));
  }

  dt {
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: $text-muted;
  }

  dd {
    margin: 0;
    font-size: 12.5px;
    color: $text-primary;
    word-break: break-word;
  }
}

.preview-content {
  flex: 1;
  min-height: 120px;
  max-height: 100%;
  overflow: auto;
  display: flex;
  flex-direction: column;
}

.image-preview {
  max-width: 100%;
  max-height: 320px;
  object-fit: contain;
  align-self: center;
  border-radius: $radius-sm;
}

.text-preview {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid $border-light;
  border-radius: $radius-sm;
  background: var(--theme-input-bg, var(--bg-input));
  color: $text-primary;
  font-family: $font-code;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  flex: 1;
  overflow: auto;
}

.preview-placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: $text-muted;
  font-size: 12.5px;
  text-align: center;
}

.preview-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid $border-light;
}

@media (max-width: $breakpoint-mobile) {
  .preview-stats {
    grid-template-columns: 1fr;
  }
}
</style>