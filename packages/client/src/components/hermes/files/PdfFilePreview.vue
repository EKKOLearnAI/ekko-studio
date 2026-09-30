<script setup lang="ts">
import { NSpin, NButton, NButtonGroup, NInputNumber } from 'naive-ui'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { useI18n } from 'vue-i18n'

const MAX_PDF_PAGES = 500
const props = defineProps<{ data: ArrayBuffer }>()
const emit = defineEmits<{ (event: 'error', error: Error): void }>()
const { t } = useI18n()
const canvas = ref<HTMLCanvasElement | null>(null)
const loading = ref(true)
const page = ref(1)
const pageCount = ref(0)
const renderedPageCount = ref(0)
const zoom = ref(1)
let documentProxy: any = null
let renderTask: any = null
let loadTask: any = null
let generation = 0

function isRenderCancellation(error: unknown): boolean {
  return (error as { name?: string })?.name === 'RenderingCancelledException'
}

function reportRenderError(error: unknown): void {
  if (!isRenderCancellation(error)) {
    emit('error', error instanceof Error ? error : new Error(String(error)))
  }
}

async function renderPage(): Promise<void> {
  if (!documentProxy || !canvas.value) return
  const currentGeneration = generation
  renderTask?.cancel?.()
  let pdfPage: any
  try {
    pdfPage = await documentProxy.getPage(page.value)
  } catch (error) {
    if (currentGeneration === generation) throw error
    return
  }
  if (currentGeneration !== generation) return
  const viewport = pdfPage.getViewport({ scale: zoom.value })
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
  const target = canvas.value
  target.width = Math.floor(viewport.width * pixelRatio)
  target.height = Math.floor(viewport.height * pixelRatio)
  target.style.width = `${Math.floor(viewport.width)}px`
  target.style.height = `${Math.floor(viewport.height)}px`
  const context = target.getContext('2d')
  if (!context) throw new Error('Canvas is unavailable')
  const task = pdfPage.render({ canvas: target, viewport, transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0] })
  renderTask = task
  try {
    await task.promise
  } catch (error) {
    if (currentGeneration === generation) throw error
  } finally {
    if (renderTask === task) renderTask = null
  }
}

async function loadPdf(): Promise<void> {
  const currentGeneration = ++generation
  loading.value = true
  try {
    renderTask?.cancel?.()
    const previousLoadTask = loadTask
    loadTask = null
    try { await previousLoadTask?.destroy?.() } catch { /* replacing a stale load */ }
    const previousDocument = documentProxy
    documentProxy = null
    try { await previousDocument?.destroy?.() } catch { /* replacing a stale document */ }
    const [pdfjs, workerModule] = await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ])
    if (currentGeneration !== generation) return
    pdfjs.GlobalWorkerOptions.workerSrc = workerModule.default
    const task = pdfjs.getDocument({
      data: new Uint8Array(props.data.slice(0)),
      disableAutoFetch: true,
      disableStream: false,
    })
    loadTask = task
    const loaded = await task.promise
    if (loadTask === task) loadTask = null
    if (currentGeneration !== generation) {
      await loaded.destroy()
      return
    }
    documentProxy = loaded
    pageCount.value = loaded.numPages
    renderedPageCount.value = Math.min(loaded.numPages, MAX_PDF_PAGES)
    page.value = Math.min(page.value, renderedPageCount.value) || 1
    await nextTick()
    await renderPage()
  } catch (error) {
    if (currentGeneration === generation) reportRenderError(error)
  } finally {
    if (currentGeneration === generation) loading.value = false
  }
}

function previousPage() { page.value = Math.max(1, page.value - 1) }
function nextPage() { page.value = Math.min(renderedPageCount.value, page.value + 1) }

watch(() => props.data, loadPdf)
watch([page, zoom], () => {
  if (!loading.value) void renderPage().catch(reportRenderError)
})
onMounted(loadPdf)
onBeforeUnmount(() => {
  generation += 1
  renderTask?.cancel?.()
  loadTask?.destroy?.()
  void documentProxy?.destroy?.()
})
</script>

<template>
  <div class="pdf-preview">
    <div class="pdf-toolbar">
      <NButtonGroup size="small">
        <NButton :disabled="page <= 1" @click="previousPage">{{ t('files.previousPage') }}</NButton>
        <NButton :disabled="page >= renderedPageCount" @click="nextPage">{{ t('files.nextPage') }}</NButton>
      </NButtonGroup>
      <span>{{ t('files.pageStatus', { page, total: pageCount }) }}</span>
      <NInputNumber v-model:value="zoom" size="small" :min="0.5" :max="2" :step="0.1" style="width: 110px" />
      <span>{{ t('files.zoom') }}</span>
    </div>
    <div v-if="pageCount > renderedPageCount" class="preview-limit">{{ t('files.pdfPageLimit', { count: renderedPageCount }) }}</div>
    <NSpin :show="loading" class="pdf-stage">
      <canvas ref="canvas" />
    </NSpin>
  </div>
</template>

<style scoped lang="scss">
.pdf-preview { display: flex; flex-direction: column; width: 100%; min-height: 0; gap: 10px; }
.pdf-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pdf-stage { flex: 1; min-height: 420px; overflow: auto; text-align: center; padding: 12px; background: rgba(127, 127, 127, 0.08); }
.pdf-stage canvas { display: inline-block; background: white; box-shadow: 0 2px 12px rgba(0, 0, 0, 0.16); }
.preview-limit { color: var(--n-warning-color); font-size: 12px; }
</style>
