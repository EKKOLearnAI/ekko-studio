<script setup lang="ts">
import { NSpin, NButton, NButtonGroup, NInputNumber } from 'naive-ui'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { useI18n } from 'vue-i18n'

type PptxViewerInstance = {
  slideCount: number
  currentSlideIndex: number
  goToSlide(index: number): Promise<void>
  setZoom(percent: number): Promise<void>
  destroy(): void
}

const props = defineProps<{ data: ArrayBuffer }>()
const emit = defineEmits<{ (event: 'error', error: Error): void }>()
const { t } = useI18n()
const host = ref<HTMLElement | null>(null)
const loading = ref(true)
const page = ref(1)
const pageCount = ref(0)
const zoom = ref(1)
let viewer: PptxViewerInstance | null = null
let abortController: AbortController | null = null
let generation = 0

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function neutralizeActiveContent(root: HTMLElement): void {
  root.querySelectorAll('iframe, frame, object, embed, applet, form, audio, video, source').forEach(node => node.remove())
  root.querySelectorAll('style').forEach(style => {
    style.textContent = (style.textContent || '')
      .replace(/@import[\s\S]*?;/gi, '')
      .replace(/url\(\s*(['"]?)(?!data:|blob:)[^)]+\)/gi, 'none')
  })
  root.querySelectorAll('*').forEach(element => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on')) element.removeAttribute(attribute.name)
      if (['href', 'xlink:href', 'action', 'formaction', 'srcset'].includes(name)) {
        element.removeAttribute(attribute.name)
      }
      if (name === 'src' && !/^(?:data:|blob:)/i.test(attribute.value.trim())) {
        element.removeAttribute(attribute.name)
      }
      if (name === 'style') {
        element.setAttribute('style', attribute.value.replace(/url\(\s*(['"]?)(?!data:|blob:)[^)]+\)/gi, 'none'))
      }
    }
    if (element instanceof HTMLElement && /url\(\s*['"]?(?:https?:)?\/\//i.test(element.style.backgroundImage)) {
      element.style.backgroundImage = 'none'
    }
  })
}

function cleanupViewer(): void {
  abortController?.abort()
  abortController = null
  try { viewer?.destroy() } catch { /* stale third-party renderers must not block cleanup */ }
  viewer = null
  host.value?.replaceChildren()
}

async function loadPresentation(): Promise<void> {
  const currentGeneration = ++generation
  cleanupViewer()
  loading.value = true
  page.value = 1
  pageCount.value = 0
  await nextTick()
  if (!host.value || currentGeneration !== generation) return

  abortController = new AbortController()
  try {
    const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = await import('@aiden0z/pptx-renderer')
    if (!host.value || currentGeneration !== generation) return
    const loadedViewer = await PptxViewer.open(props.data.slice(0), host.value, {
      renderMode: 'slide',
      fitMode: 'contain',
      zoomPercent: zoom.value * 100,
      zipLimits: RECOMMENDED_ZIP_LIMITS,
      lazySlides: true,
      lazyMedia: true,
      pdfjs: false,
      signal: abortController.signal,
      onSlideChange: index => {
        if (currentGeneration === generation) page.value = index + 1
      },
      onSlideRendered: (_index, element) => { neutralizeActiveContent(element) },
      onSlideError: (_index, error) => {
        if (currentGeneration === generation) emit('error', asError(error))
      },
    })
    if (currentGeneration !== generation) {
      loadedViewer.destroy()
      return
    }
    viewer = loadedViewer
    pageCount.value = loadedViewer.slideCount
    page.value = loadedViewer.currentSlideIndex + 1
    neutralizeActiveContent(host.value)
  } catch (error) {
    if ((error as { name?: string })?.name !== 'AbortError' && currentGeneration === generation) {
      emit('error', asError(error))
    }
  } finally {
    if (currentGeneration === generation) loading.value = false
  }
}

async function goToPage(nextPage: number): Promise<void> {
  if (!viewer || loading.value) return
  const activeViewer = viewer
  const target = Math.min(Math.max(nextPage, 1), pageCount.value)
  try {
    await activeViewer.goToSlide(target - 1)
    if (viewer !== activeViewer) return
    page.value = target
    if (host.value) neutralizeActiveContent(host.value)
  } catch (error) {
    if (viewer === activeViewer) emit('error', asError(error))
  }
}

watch(() => props.data, () => { void loadPresentation() })
watch(zoom, value => {
  if (!viewer || !Number.isFinite(value)) return
  const activeViewer = viewer
  void activeViewer.setZoom(value * 100).catch(error => {
    if (viewer === activeViewer) emit('error', asError(error))
  })
})
onMounted(() => { void loadPresentation() })
onBeforeUnmount(() => {
  generation += 1
  cleanupViewer()
})
</script>

<template>
  <div class="pptx-preview">
    <div class="pptx-toolbar">
      <NButtonGroup size="small">
        <NButton :disabled="page <= 1 || loading" @click="goToPage(page - 1)">{{ t('files.previousPage') }}</NButton>
        <NButton :disabled="page >= pageCount || loading" @click="goToPage(page + 1)">{{ t('files.nextPage') }}</NButton>
      </NButtonGroup>
      <span>{{ t('files.pageStatus', { page, total: pageCount }) }}</span>
      <NInputNumber v-model:value="zoom" size="small" :min="0.5" :max="2" :step="0.1" style="width: 110px" />
      <span>{{ t('files.zoom') }}</span>
    </div>
    <NSpin :show="loading" :description="t('files.previewLoading')" class="pptx-stage">
      <div ref="host" class="pptx-renderer-host" />
    </NSpin>
  </div>
</template>

<style scoped lang="scss">
.pptx-preview {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-height: 0;
  gap: 10px;
}

.pptx-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.pptx-stage {
  flex: 1;
  min-height: 420px;
  overflow: auto;
  padding: 12px;
  background: rgba(127, 127, 127, 0.08);
}

.pptx-renderer-host {
  width: 100%;
  min-height: 390px;
  overflow: hidden;
}
</style>
