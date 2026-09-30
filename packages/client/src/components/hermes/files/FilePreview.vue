<script setup lang="ts">
import { NSpin, NAlert, NButton, NIcon, useMessage } from 'naive-ui'
import { computed, defineAsyncComponent, h, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'

import { useI18n } from 'vue-i18n'
import { RecycleScroller } from 'vue-virtual-scroller'
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css'
import { useFilesStore } from '@/stores/hermes/files'
import { fetchFilePreviewBlob } from '@/api/studio/files'
import { fetchAuthenticatedBlob, saveBlob } from '@/api/studio/binary-content'
import { downloadFile } from '@/api/studio/download'
import { downloadSessionWorkspaceFile, fetchSessionWorkspaceFileBlob } from '@/api/studio/sessions'
import { downloadGroupWorkspaceFile, fetchGroupWorkspaceFileBlob } from '@/api/studio/group-chat'
import { handleCodeBlockCopyClick, renderHighlightedCodeBlock } from '@/components/hermes/chat/highlight'
import { previewMimeMatches } from '@/utils/hermes/file-preview'
import { openHtmlInDesktopBrowser } from '@/utils/desktop-browser'
import FileTreeToggle from './FileTreeToggle.vue'

const MarkdownRenderer = defineAsyncComponent(async () => (await import('@/components/hermes/chat/MarkdownRenderer.vue')).default)
const HtmlFilePreview = defineAsyncComponent(async () => (await import('./HtmlFilePreview.vue')).default)
const PdfFilePreview = defineAsyncComponent(async () => (await import('./PdfFilePreview.vue')).default)
const DocxFilePreview = defineAsyncComponent(async () => (await import('./DocxFilePreview.vue')).default)
const PptxFilePreview = defineAsyncComponent(async () => (await import('./PptxFilePreview.vue')).default)
const SpreadsheetFilePreview = defineAsyncComponent(async () => (await import('./SpreadsheetFilePreview.vue')).default)

const { t } = useI18n()
const message = useMessage()
const filesStore = useFilesStore()
const props = withDefaults(defineProps<{
  customClose?: () => void
  showTreeToggle?: boolean
  treeCollapsed?: boolean
}>(), {
  showTreeToggle: false,
  treeCollapsed: false,
})
const emit = defineEmits<{
  'toggle-tree': []
}>()
const loading = ref(false)
const downloading = ref(false)
const previewError = ref('')
const previewText = ref('')
const previewBuffer = shallowRef<ArrayBuffer | null>(null)
const mediaUrl = ref('')
const previewContent = ref<HTMLElement | null>(null)
let requestController: AbortController | null = null
let requestGeneration = 0
let sourceRevealGeneration = 0

function revokeMediaUrl(): void {
  if (mediaUrl.value) URL.revokeObjectURL(mediaUrl.value)
  mediaUrl.value = ''
}

function resetLoadedPreview(): void {
  requestController?.abort()
  requestController = null
  revokeMediaUrl()
  previewText.value = ''
  previewBuffer.value = null
  previewError.value = ''
  loading.value = false
}

async function loadPreview(): Promise<void> {
  const generation = ++requestGeneration
  resetLoadedPreview()
  const file = filesStore.previewFile
  if (!file || file.type === 'markdown' || file.type === 'text') return
  requestController = new AbortController()
  loading.value = true
  try {
    const blob = file.sourceUrl
      ? await fetchAuthenticatedBlob(file.sourceUrl, { profile: null, signal: requestController.signal })
      : file.workspaceRoomId
        ? await fetchGroupWorkspaceFileBlob(file.workspaceRoomId, file.path, requestController.signal)
        : file.workspaceSessionId
          ? await fetchSessionWorkspaceFileBlob(file.workspaceSessionId, file.path, requestController.signal)
          : await fetchFilePreviewBlob(file.path, file.profile, requestController.signal)
    if (generation !== requestGeneration) return
    if (!previewMimeMatches(file.type, blob.type)) {
      throw new Error(t('files.previewMimeMismatch'))
    }
    if (file.type === 'image' || file.type === 'video') {
      mediaUrl.value = URL.createObjectURL(blob)
    } else if (file.type === 'html' || file.type === 'csv') {
      const text = await blob.text()
      if (generation !== requestGeneration) return
      previewText.value = text
      if (file.type === 'html' && !file.startLine && await openHtmlInDesktopBrowser(text, file.name)) return
    } else {
      const buffer = await blob.arrayBuffer()
      if (generation !== requestGeneration) return
      previewBuffer.value = buffer
    }
  } catch (error) {
    if ((error as any)?.name !== 'AbortError' && generation === requestGeneration) {
      previewError.value = error instanceof Error ? error.message : String(error)
    }
  } finally {
    if (generation === requestGeneration) loading.value = false
  }
}

function handleRendererError(error: Error): void {
  previewError.value = error.message || t('files.previewFailed')
}

function handleVideoError(): void {
  previewError.value = t('files.previewFailed')
}

async function handleDownload(): Promise<void> {
  const file = filesStore.previewFile
  if (!file || downloading.value) return
  downloading.value = true
  try {
    if (file.sourceUrl) {
      saveBlob(await fetchAuthenticatedBlob(file.sourceUrl, { profile: null }), file.name)
    } else if (file.workspaceRoomId) {
      await downloadGroupWorkspaceFile(file.workspaceRoomId, file.path, file.name)
    } else if (file.workspaceSessionId) {
      await downloadSessionWorkspaceFile(file.workspaceSessionId, file.path, file.name)
    } else {
      await downloadFile(file.path, file.name, file.profile)
    }
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('download.downloadFailed'))
  } finally {
    downloading.value = false
  }
}

function handleClose(): void {
  if (props.customClose) props.customClose()
  else filesStore.closePreview()
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const highlightedPreview = computed(() => {
  const previewFile = filesStore.previewFile
  if (!previewFile || previewFile.type !== 'text') return ''
  return renderHighlightedCodeBlock(previewFile.content || '', previewFile.language, t('common.copy'), {
    maxHighlightLength: 200_000,
  })
})

const locatedSourceContent = computed(() => {
  const previewFile = filesStore.previewFile
  if (!previewFile?.startLine) return null
  if (previewFile.type === 'markdown' || previewFile.type === 'text') {
    return previewFile.content || ''
  }
  if (previewFile.type === 'html' || previewFile.type === 'csv') {
    return previewText.value
  }
  return null
})

const locatedSourceTextLines = computed(() => {
  const content = locatedSourceContent.value
  return content === null ? [] : content.split(/\r?\n/)
})

const effectivePreviewLocation = computed(() => {
  const previewFile = filesStore.previewFile
  const lineCount = locatedSourceTextLines.value.length
  if (!previewFile?.startLine || lineCount === 0) return null

  const startLine = Math.min(Math.max(1, previewFile.startLine), lineCount)
  const requestedEndLine = Math.max(previewFile.startLine, previewFile.endLine ?? previewFile.startLine)
  const endLine = Math.min(Math.max(startLine, requestedEndLine), lineCount)
  return { startLine, endLine }
})

const previewLocationLabel = computed(() => {
  const location = effectivePreviewLocation.value
  if (!location) return ''
  return location.endLine === location.startLine
    ? `L${location.startLine}`
    : `L${location.startLine}–${location.endLine}`
})

const locatedSourceLines = computed(() => {
  const location = effectivePreviewLocation.value
  if (!location) return []
  return locatedSourceTextLines.value.map((text, index) => {
    const number = index + 1
    return {
      number,
      text,
      isTarget: number >= location.startLine && number <= location.endLine,
    }
  })
})

function locatedSourceElement(): HTMLElement | null {
  return previewContent.value?.querySelector<HTMLElement>('.preview-source') ?? null
}

function nextRenderFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()))
}

function revealLocatedSourceNow(): void {
  const startLine = effectivePreviewLocation.value?.startLine
  const element = locatedSourceElement()
  if (!startLine || !element?.classList.contains('ready')) return
  const targetTop = (startLine - 1) * 20
  element.scrollTop = Math.max(0, targetTop - Math.max(0, element.clientHeight - 20) / 2)
  element.dispatchEvent(new Event('scroll'))
  requestAnimationFrame(() => element.focus({ preventScroll: true }))
}

watch(
  () => [
    filesStore.previewFile?.path,
    effectivePreviewLocation.value?.startLine,
    locatedSourceContent.value,
  ],
  async () => {
    const generation = ++sourceRevealGeneration
    const startLine = effectivePreviewLocation.value?.startLine
    if (!startLine) return
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await nextTick()
      await nextRenderFrame()
      if (generation !== sourceRevealGeneration) return
      const element = locatedSourceElement()
      if (!element?.classList.contains('ready')) continue
      revealLocatedSourceNow()
      await nextRenderFrame()
      if (generation !== sourceRevealGeneration) return
      element.focus({ preventScroll: true })
      return
    }
  },
  { flush: 'post', immediate: true },
)

async function handlePreviewClick(event: MouseEvent) {
  const copyResult = await handleCodeBlockCopyClick(event)
  if (copyResult) {
    message.success(t('common.copied'))
  } else if (copyResult === false) {
    message.error(t('chat.copyFailed'))
  }
}

const CloseIcon = () =>
  h(
    'svg',
    { viewBox: '0 0 24 24', width: '14', height: '14', fill: 'currentColor' },
    [h('path', { d: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z' })],
  )

watch(() => filesStore.previewFile, () => { void loadPreview() }, { immediate: true })
onBeforeUnmount(() => {
  requestGeneration += 1
  sourceRevealGeneration += 1
  resetLoadedPreview()
})
</script>

<template>
  <div class="file-preview" v-if="filesStore.previewFile">
    <div class="preview-header">
      <div class="preview-file-info">
        <FileTreeToggle
          v-if="props.showTreeToggle"
          :collapsed="props.treeCollapsed"
          @toggle="emit('toggle-tree')"
        />
        <span class="preview-filename">{{ filesStore.previewFile.path }}</span>
        <span v-if="previewLocationLabel" class="preview-location" aria-live="polite">{{ previewLocationLabel }}</span>
        <span class="preview-size">{{ formatSize(filesStore.previewFile.size) }}</span>
      </div>
      <div class="preview-actions">
        <NButton size="small" secondary :loading="downloading" @click="handleDownload">{{ t('files.download') }}</NButton>
        <NButton size="small" quaternary @click="handleClose">
          <template #icon>
            <NIcon><CloseIcon /></NIcon>
          </template>
          {{ t('files.closePreview') }}
        </NButton>
      </div>
    </div>
    <div ref="previewContent" class="preview-content">
      <NSpin v-if="loading" :description="t('files.previewLoading')" />
      <NAlert v-else-if="previewError" type="error" class="preview-error">
        <template #header>{{ t('files.previewFailed') }}</template>
        <div class="preview-error-message">{{ previewError }}</div>
        <div class="preview-error-action">
          <NButton size="small" :loading="downloading" @click="handleDownload">{{ t('files.downloadInstead') }}</NButton>
        </div>
      </NAlert>
      <img
        v-else-if="filesStore.previewFile.type === 'image' && mediaUrl"
        :src="mediaUrl"
        class="preview-image"
        :alt="filesStore.previewFile.path"
      />
      <video
        v-else-if="filesStore.previewFile.type === 'video' && mediaUrl"
        :src="mediaUrl"
        class="preview-video"
        controls
        playsinline
        preload="metadata"
        @error="handleVideoError"
      />
      <RecycleScroller
        v-else-if="locatedSourceLines.length"
        class="preview-source"
        :items="locatedSourceLines"
        :item-size="20"
        key-field="number"
        role="region"
        tabindex="0"
        :aria-label="`${t('files.preview')}: ${filesStore.previewFile.path}`"
        @resize="revealLocatedSourceNow"
        @visible="revealLocatedSourceNow"
      >
        <template #default="{ item: line }">
          <div
            class="preview-source-line"
            :class="{ 'is-target-line': line.isTarget }"
            :data-line="line.number"
            :aria-current="line.isTarget ? 'location' : undefined"
          >
            <span class="preview-source-line-number" aria-hidden="true">{{ line.number }}</span>
            <code class="preview-source-line-text">{{ line.text || ' ' }}</code>
          </div>
        </template>
      </RecycleScroller>
      <div v-else-if="filesStore.previewFile.type === 'markdown'" class="preview-markdown">
        <MarkdownRenderer :content="filesStore.previewFile.content || ''" />
      </div>
      <div
        v-else-if="filesStore.previewFile.type === 'text'"
        class="preview-code"
        v-html="highlightedPreview"
        @click="handlePreviewClick"
      />
      <HtmlFilePreview
        v-else-if="filesStore.previewFile.type === 'html'"
        :content="previewText"
      />
      <PdfFilePreview
        v-else-if="filesStore.previewFile.type === 'pdf' && previewBuffer"
        :data="previewBuffer"
        @error="handleRendererError"
      />
      <DocxFilePreview
        v-else-if="filesStore.previewFile.type === 'docx' && previewBuffer"
        :data="previewBuffer"
        @error="handleRendererError"
      />
      <PptxFilePreview
        v-else-if="filesStore.previewFile.type === 'presentation' && previewBuffer"
        :data="previewBuffer"
        @error="handleRendererError"
      />
      <SpreadsheetFilePreview
        v-else-if="filesStore.previewFile.type === 'spreadsheet' && previewBuffer"
        kind="spreadsheet"
        :data="previewBuffer"
        @error="handleRendererError"
      />
      <SpreadsheetFilePreview
        v-else-if="filesStore.previewFile.type === 'csv'"
        kind="csv"
        :source="previewText"
        @error="handleRendererError"
      />
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.file-preview {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  min-height: 0;
  background: inherit;
}

.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  border-bottom: 1px solid $border-color;
}

.preview-file-info,
.preview-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.preview-filename {
  font-size: 13px;
  color: $text-secondary;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-size {
  flex: none;
  font-size: 12px;
  color: $text-muted;
}

.preview-location {
  flex: none;
  padding: 1px 6px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.24);
  border-radius: 999px;
  color: var(--accent-primary);
  background: rgba(var(--accent-primary-rgb), 0.08);
  font-family: $font-code;
  font-size: 11px;
}

.preview-content {
  flex: 1;
  overflow: auto;
  padding: 16px;
  display: flex;
  justify-content: center;
  width: 100%;
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

.preview-error { width: min(680px, 100%); align-self: flex-start; }
.preview-error-message { overflow-wrap: anywhere; }
.preview-error-action { margin-top: 12px; }

.preview-image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.preview-video {
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: 100%;
  background: #000;
  object-fit: contain;
}

.preview-markdown {
  max-width: 800px;
  width: 100%;
}

.preview-source {
  align-self: stretch;
  min-width: 0;
  width: 100%;
  height: 100%;
  overflow: auto;
  font-family: $font-code;
  font-size: 13px;
  line-height: 1.55;
  scrollbar-width: none;

  // Let long rows contribute to the scroller's horizontal overflow.
  :deep(.vue-recycle-scroller__item-wrapper) {
    overflow: visible;
  }

  &:focus-visible {
    outline: 2px solid rgba(var(--accent-primary-rgb), 0.72);
    outline-offset: -2px;
  }

  &::-webkit-scrollbar {
    display: none;
  }
}

.preview-source-line {
  display: grid;
  grid-template-columns: 52px minmax(max-content, 1fr);
  min-width: max-content;
  height: 20px;
  border-radius: 3px;
  line-height: 20px;
  white-space: pre;
}

.preview-source-line.is-target-line {
  background: rgba(var(--accent-primary-rgb), 0.14);
  box-shadow: inset 2px 0 0 var(--accent-primary);
}

.preview-source-line-number {
  position: sticky;
  left: 0;
  padding-inline: 8px 12px;
  color: $text-muted;
  background: $bg-secondary;
  text-align: end;
  user-select: none;
}

.preview-source-line.is-target-line .preview-source-line-number {
  color: var(--accent-primary);
  background: rgba(var(--accent-primary-rgb), 0.12);
}

.preview-source-line-text {
  padding-inline: 12px;
  color: $text-primary;
  font: inherit;
}

.preview-code {
  height: 100%;
  width: 100%;
  overflow: auto;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }

  :deep(.hljs-code-block) {
    width: 100%;
    min-height: 100%;
    margin: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
  }

  :deep(.hljs-code-block .code-header) {
    display: none;
  }

  :deep(.hljs-code-block code.hljs) {
    scrollbar-width: none;

    &::-webkit-scrollbar {
      display: none;
    }
  }
}
</style>
