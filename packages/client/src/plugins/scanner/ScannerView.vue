<script setup lang="ts">
/**
 * ScannerView - UVC USB 摄像头扫描 + DashScope Qwen-VL-OCR 识别
 *
 * 布局：
 *   ┌────────────────────────────────────────────────────────┐
 *   │ Header (摄像头开关 / 设备选择 / 拍摄)                    │
 *   ├──────────────────────────┬─────────────────────────────┤
 *   │ 摄像头预览 + 拍摄控制    │ 扫描结果（多页可切换 / 编辑）│
 *   │  · 动态捕捉（纸张检测 /  │  · 原图 + 增强控件 + 矫正裁剪 │
 *   │    选框微调 / 自动拍摄） │  · OCR 文本（可编辑）        │
 *   │  · 普通拍摄              │  · 整批操作（保存 / 导出 PDF）│
 *   └──────────────────────────┴─────────────────────────────┘
 *
 * 视觉引擎：插件自带的 OpenCV.js + jscanify（vendor/），运行时加载。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NEmpty,
  NInput,
  NSelect,
  NSpin,
  NSwitch,
  NTag,
  NTooltip,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  SCANNER_RESOLUTION_PRESETS,
  useScannerCamera,
} from './composables/useScannerCamera'
import { useSmartCapture } from './composables/useSmartCapture'
import ScannerQuadOverlay from './components/ScannerQuadOverlay.vue'
import ScannerEnhanceControls from './components/ScannerEnhanceControls.vue'
import { isMobileDevice } from '@/utils/device'
import {
  canvasFromImageSource,
  canvasToDataUrl,
  downscaleCanvas,
  encodeEnhanced,
  enhanceCanvas,
  enhanceDataUrl,
  rotateDataUrl,
} from './image-io'
import { createDetector, type Detector } from './vision/detector'
import { warpQuad } from './vision/perspective'
import {
  ENHANCE_DEFAULTS,
  ENHANCE_PRESET_LABEL_KEYS,
  ENHANCE_PRESET_ORDER,
  sameEnhanceParams,
  type EnhanceParams,
  type EnhancePreset,
  type Quad,
  type RotateDirection,
  type WarpAspect,
} from './vision/types'
import {
  exportScannerPdf,
  runScannerOcr,
  saveScannerDocument,
  type ScannerOcrResponse,
  type ScannerSaveResponse,
} from './api'
import { useRealtimeModelStore } from '@/stores/hermes/realtime-model'
import { useMessage as useAppMessage } from '@/composables/useAppMessage'

interface ScannerPage {
  /** 唯一 id，用作 key */
  id: string
  /** 底图（矫正后的 raw / 原始拍摄），增强从此派生 */
  originalImage: string
  /** 当前显示的图（original + enhance） */
  image: string
  width: number
  height: number
  /** OCR 文本（用户可继续编辑） */
  text: string
  /** OCR 状态 */
  status: 'pending' | 'running' | 'done' | 'error'
  error?: string
  /** 当前增强参数 */
  enhance: EnhanceParams
  /** image 实际已应用的增强参数（避免重复重算 / 二次编码） */
  applied: EnhanceParams
}

const { t } = useI18n()
const message = useAppMessage()
const realtimeModelStore = useRealtimeModelStore()

/**
 * 把 vue-i18n 的 `t()` 包一层，强制返回 string。
 */
const tt = ((key: string, ...args: unknown[]) => {
  const value = (t as unknown as (k: string, ...a: unknown[]) => unknown)(key, ...args)
  return typeof value === 'string' ? value : String(key)
}) as (key: string, ...args: unknown[]) => string

const cam = useScannerCamera()
const videoEl = ref<HTMLVideoElement | null>(null)

const devices = ref<MediaDeviceInfo[]>([])
const selectedDeviceId = ref<string | null>(null)

/**
 * 摄像头分辨率预设选择。默认 '2k'——16MP 的 UVC 摄像头大多数能
 * 直接给到 2560×1440；不行则由 composable 内部沿预设降级到 1080p / 720p。
 * 'auto' 则让浏览器/驱动挑默认档（多数 UVC 默认 1280×720）。
 */
const resolutionId = ref<string>('2k')
const resolutionOptions = computed(() =>
  SCANNER_RESOLUTION_PRESETS.map((p) => ({
    label: tt(p.labelKey),
    value: p.id,
  })),
)

/**
 * 移动端判定：iOS/Android 上的 Safari / Chrome / 微信内置浏览器都会
 * 命中 `isMobileDevice()`（UA + 触控 + 屏幕宽度综合判定，
 * 避免「请求桌面版网站」时漏判）。同时监听 viewport resize：
 * 用户横竖屏切换、平板分屏时动态重排。
 */
const isMobile = ref(false)
let mobileQuery: MediaQueryList | null = null
let mobileListener: ((e: MediaQueryListEvent) => void) | null = null
let removeDeviceChange: (() => void) | null = null
function syncMobile() {
  isMobile.value = isMobileDevice() || (mobileQuery?.matches ?? false)
}

const language = ref<string>('auto')
const languageOptions = [
  { label: 'Auto', value: 'auto' },
  { label: '中文 (zh)', value: 'zh' },
  { label: 'English (en)', value: 'en' },
  { label: '日本語 (ja)', value: 'ja' },
  { label: '中英混合 (zh+en)', value: 'zh+en' },
]

const pages = ref<ScannerPage[]>([])
const activePageId = ref<string | null>(null)
const ocrAllLoading = ref(false)
const ocrOneLoading = ref(false)
const saveLoading = ref(false)
const pdfLoading = ref(false)
const correcting = ref(false)
const rotating = ref(false)

/** Realtime 模型里配置的 DashScope key = Scanner 唯一入口。 */
const keyChecked = ref(false)
const dashscopeReady = computed(() => realtimeModelStore.hasApiKey)
const dashscopeMissing = computed(() => keyChecked.value && !dashscopeReady.value)

const cameraRunning = computed(() => cam.isRunning.value)
const cameraStarting = computed(() => cam.isStarting.value)
const cameraErrorCode = computed(() => cam.error.value)

/* ------------------------------------------------------------------ *
 * 智能捕捉（动态捕捉）
 * ------------------------------------------------------------------ */
const capturePreset = ref<EnhancePreset>('scan')
const capturePresetOptions = ENHANCE_PRESET_ORDER.map(preset => ({
  label: tt(ENHANCE_PRESET_LABEL_KEYS[preset]),
  value: preset,
}))
const aspect = ref<WarpAspect>('auto')
const aspectOptions = [
  { label: tt('scanner.smart.aspectAuto'), value: 'auto' },
  { label: tt('scanner.smart.aspectA4'), value: 'a4' },
  { label: tt('scanner.smart.aspectA4Landscape'), value: 'a4-landscape' },
]

const smart = useSmartCapture({
  video: () => videoEl.value,
  cameraRunning: () => cameraRunning.value,
  onAutoCapture: onSmartAutoCapture,
  aspectRatio: null,
})

const smartEnabled = computed(() => smart.enabled.value)
const smartQuad = computed(() => smart.quad.value)
const smartManual = computed(() => smart.manual.value)
const smartStatus = computed(() => smart.status.value)
const autoCaptureOn = computed({
  get: () => smart.autoCapture.value,
  set: (v: boolean) => smart.setAutoCapture(v),
})
/** AI 识别开关（默认关闭，仅用经典识别；点开才启用 AI 兜底）。 */
const aiEnabled = computed({
  get: () => smart.aiEnabled.value,
  set: (v: boolean) => { smart.aiEnabled.value = v },
})

watch(aspect, (v) => {
  smart.setAspectRatio(v === 'auto' ? null : aspectRatioValue(v))
})

function aspectRatioValue(v: Exclude<WarpAspect, 'auto'>): number {
  if (v === 'a4') return 1 / Math.sqrt(2)
  return Math.sqrt(2)
}

const smartStatusText = computed(() => {
  // 手动调整过的选框已冻结，状态栏优先提示如何恢复实时跟随。
  if (smartManual.value && smartStatus.value !== 'capturing' && smartStatus.value !== 'cooling') {
    return tt('scanner.smart.manualLocked')
  }
  switch (smartStatus.value) {
    case 'off': return tt('scanner.smart.off')
    case 'loading': return tt('scanner.smart.loading')
    case 'unavailable': return tt('scanner.smart.unavailable')
    case 'searching': return tt('scanner.smart.searching')
    case 'detected': return tt('scanner.smart.detected')
    case 'held': return tt('scanner.smart.held')
    case 'capturing': return tt('scanner.smart.capturing')
    case 'cooling': return tt('scanner.smart.cooling')
    default: return tt('scanner.smart.off')
  }
})
const smartStatusTone = computed<'default' | 'info' | 'success' | 'error'>(() => {
  switch (smartStatus.value) {
    case 'unavailable': return 'error'
    case 'detected':
    case 'capturing': return 'success'
    case 'loading':
    case 'held':
    case 'searching': return 'info'
    default: return 'default'
  }
})

const smartEngineError = computed(() => smart.engineError.value)

watch(smartStatus, (next) => {
  if (next === 'unavailable') {
    // eslint-disable-next-line no-console
    console.warn('[scanner] 检测器不可用：', smartEngineError.value || '(无详细原因)')
  }
})

async function toggleSmart() {
  if (smartEnabled.value) {
    await smart.setEnabled(false)
  } else {
    await smart.setEnabled(true)
  }
}

/** ML pipeline 加载状态（worker 镜像回主线程）。 */
const mlStatus = smart.mlStatus
const mlStatusText = computed(() => {
  switch (mlStatus.value.state) {
    case 'off': return ''
    case 'loading': return tt('scanner.smart.mlLoading')
    case 'ready': return tt('scanner.smart.mlReady')
    case 'failed': return tt('scanner.smart.mlFailed')
    default: return ''
  }
})
const mlStatusTone = computed<'default' | 'info' | 'success' | 'error'>(() => {
  switch (mlStatus.value.state) {
    case 'loading': return 'info'
    case 'ready': return 'success'
    case 'failed': return 'error'
    default: return 'default'
  }
})

function onQuadEdit(next: Quad) {
  smart.setQuadManually(next)
}

function pushCorrectedPage(canvas: HTMLCanvasElement) {
  const original = canvasToDataUrl(canvas, 0.92)
  const enhance = ENHANCE_DEFAULTS[capturePreset.value]
  const image = enhance.preset === 'none'
    ? original
    : encodeEnhanced(enhanceCanvas(canvas, enhance), enhance)
  pushPage(original, image, canvas.width, canvas.height, enhance)
}

async function onSmartAutoCapture(payload: { canvas: HTMLCanvasElement; quad: Quad; ms: number }) {
  try {
    pushCorrectedPage(payload.canvas)
    smart.markCaptured(payload.quad)
    message.success(tt('scanner.smart.captured', { n: smart.autoCount.value }))
  } catch {
    smart.markCaptured(payload.quad)
    message.error(tt('scanner.smart.shootFailed'))
  }
}

async function smartShoot() {
  const shot = await smart.captureNow()
  if (!shot) {
    message.warning(tt('scanner.smart.noDoc'))
    return
  }
  try {
    const enhance = ENHANCE_DEFAULTS[capturePreset.value]
    const image = enhance.preset === 'none'
      ? shot.dataUrl
      : (await enhanceDataUrl(shot.dataUrl, enhance)) || shot.dataUrl
    pushPage(shot.dataUrl, image, shot.width, shot.height, enhance)
  } catch {
    message.error(tt('scanner.smart.shootFailed'))
  }
}

/** 清除当前选框/手动锁定并重新搜索（「重置选框」按钮）。 */
function smartRescan() {
  smart.rescan()
}

/* ------------------------------------------------------------------ *
 * 摄像头基础操作
 * ------------------------------------------------------------------ */
function pushPage(original: string, image: string, width: number, height: number, enhance: EnhanceParams) {
  const page: ScannerPage = {
    id: `page-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    originalImage: original,
    image,
    width,
    height,
    text: '',
    status: 'pending',
    enhance,
    applied: { ...enhance },
  }
  pages.value.push(page)
  activePageId.value = page.id
  maybeAutoRecognize(page)
}
async function refreshVideoInputs() {
  devices.value = await cam.listVideoInputs()
  if (devices.value.length === 0) return
  if (!selectedDeviceId.value) {
    selectedDeviceId.value = devices.value[0]?.deviceId ?? null
  }
}

async function startCamera() {
  await cam.start({
    deviceId: selectedDeviceId.value || undefined,
    facingMode: selectedDeviceId.value ? 'auto' : undefined,
    resolutionId: resolutionId.value,
  })
  if (cam.error.value) {
    message.error(tt(`scanner.camera.${cameraErrorCode.value}` as any))
  } else {
    await refreshVideoInputs()
  }
}

/** 移动端翻转前后摄像头；不可用时（无 stream 或单镜头）静默忽略。 */
async function flipCamera() {
  await cam.flipCamera()
  if (cam.error.value) {
    message.error(tt(`scanner.camera.${cameraErrorCode.value}` as any))
  }
}

/** 移动端：点页码 → 全屏查看 / 编辑 OCR 文本。 */
const mobileDetailOpen = ref(false)
function openMobileDetail(pageId: string) {
  activePageId.value = pageId
  mobileDetailOpen.value = true
}
function closeMobileDetail() {
  mobileDetailOpen.value = false
}

function stopCamera() {
  cam.stop()
}

async function switchCamera(deviceId: string | null) {
  selectedDeviceId.value = deviceId
  if (cam.isRunning.value) {
    await cam.start({ deviceId: deviceId || undefined, resolutionId: resolutionId.value })
  }
}

/**
 * 摄像头开着的时候切换分辨率 → 重新申请一次流（同一个 deviceId，
 * 只是宽高约束不同）。未开时只更新 ref，等下次 startCamera() 用上。
 */
async function onResolutionChange(next: string) {
  resolutionId.value = next
  if (cam.isRunning.value) {
    await cam.start({ deviceId: selectedDeviceId.value || undefined, resolutionId: next })
    if (cam.error.value) {
      message.error(tt(`scanner.camera.${cameraErrorCode.value}` as any))
    }
  }
}

async function capture() {
  const shot = await cam.snapshot()
  if (!shot) {
    message.warning(tt('scanner.capture.empty'))
    return
  }
  pushPage(
    shot.dataUrl,
    shot.dataUrl,
    shot.width,
    shot.height,
    { ...ENHANCE_DEFAULTS.none },
  )
}

async function deletePage(id: string) {
  pages.value = pages.value.filter(p => p.id !== id)
  if (activePageId.value === id) activePageId.value = pages.value[0]?.id ?? null
}

/** 上移 / 下移排序（导出 PDF 与保存的顺序即页面列表顺序）。 */
function movePage(id: string, direction: -1 | 1) {
  const index = pages.value.findIndex(p => p.id === id)
  const target = index + direction
  if (index < 0 || target < 0 || target >= pages.value.length) return
  const next = [...pages.value]
  const [item] = next.splice(index, 1)
  next.splice(target, 0, item!)
  pages.value = next
}

const movePageUp = (id: string) => movePage(id, -1)
const movePageDown = (id: string) => movePage(id, 1)

/** 把当前页的增强参数批量套用到所有页，并逐页重算增强图。 */
const applyAllLoading = ref(false)
async function applyEnhanceToAll() {
  const source = activePage.value
  if (!source || applyAllLoading.value) return
  applyAllLoading.value = true
  try {
    for (const page of pages.value) {
      if (page.id === source.id) continue
      page.enhance = { ...source.enhance }
      const url = await enhanceDataUrl(page.originalImage, page.enhance)
      if (url && pages.value.some(p => p.id === page.id)) {
        page.image = url
        page.applied = { ...page.enhance }
      }
    }
    if (!sameEnhanceParams(source.applied, source.enhance)) scheduleEnhance()
    message.success(tt('scanner.enhance.applyAllDone', { count: Math.max(0, pages.value.length - 1) }))
  } finally {
    applyAllLoading.value = false
  }
}

function clearAll() {
  pages.value = []
  activePageId.value = null
}

const activePage = computed(() => pages.value.find(p => p.id === activePageId.value) || null)

/** 预览容器按成品真实比例撑开，避免 object-fit 留下的黑边让人误以为裁剪不对。 */
const activePageAspectStyle = computed(() => {
  const page = activePage.value
  if (!page || !page.width || !page.height) return undefined
  return { aspectRatio: `${page.width} / ${page.height}` }
})

const activePageAspectLabel = computed(() => {
  const page = activePage.value
  if (!page || !page.height) return ''
  return `${(page.width / page.height).toFixed(2)} : 1`
})

/* ------------------------------------------------------------------ *
 * 页面增强 / 矫正
 * ------------------------------------------------------------------ */
let enhanceDebounce = 0

async function recomputePageImage(page: ScannerPage) {
  const params = { ...page.enhance }
  const url = await enhanceDataUrl(page.originalImage, params)
  if (!url || !pages.value.some(p => p.id === page.id)) return
  if (!sameEnhanceParams(page.enhance, params)) {
    // 计算期间参数又被改过：按最新参数再算一次
    scheduleEnhance()
    return
  }
  page.image = url
  page.applied = params
}

function scheduleEnhance() {
  const page = activePage.value
  if (!page || sameEnhanceParams(page.applied, page.enhance)) return
  window.clearTimeout(enhanceDebounce)
  enhanceDebounce = window.setTimeout(() => {
    void recomputePageImage(page)
  }, 220)
}

watch(
  () => activePage.value?.enhance,
  () => {
    scheduleEnhance()
  },
  { deep: true },
)

function onEnhanceParams(params: EnhanceParams) {
  const page = activePage.value
  if (!page) return
  page.enhance = { ...params }
}

function resetEnhance() {
  const page = activePage.value
  if (!page) return
  page.enhance = { ...ENHANCE_DEFAULTS.none }
}

async function rotateActivePage(direction: RotateDirection) {
  const page = activePage.value
  if (!page || rotating.value || correcting.value) return
  rotating.value = true
  try {
    const rotated = await rotateDataUrl(page.originalImage, direction)
    if (!rotated) {
      message.error(tt('scanner.enhance.rotateFail'))
      return
    }
    const params = { ...page.enhance }
    const image = await enhanceDataUrl(rotated.dataUrl, params)
    if (!image || !pages.value.some(p => p.id === page.id)) {
      message.error(tt('scanner.enhance.rotateFail'))
      return
    }
    page.originalImage = rotated.dataUrl
    page.image = image
    page.width = rotated.width
    page.height = rotated.height
    page.applied = params
  } catch {
    message.error(tt('scanner.enhance.rotateFail'))
  } finally {
    rotating.value = false
  }
}

/** 对当前页原图做「自动矫正裁剪」（重新检测纸张边缘 + 透视拉伸）。 */
async function correctActivePage() {
  const page = activePage.value
  if (!page) {
    message.warning(tt('scanner.enhance.none'))
    return
  }
  if (correcting.value || rotating.value) return
  correcting.value = true
  let detectorHandle: Detector | null = null
  try {
    const fullCanvas = await canvasFromImageSource(page.originalImage, 2600)
    if (!fullCanvas) {
      message.error(tt('scanner.enhance.correctFail'))
      return
    }
    const detectCanvas = downscaleCanvas(fullCanvas, 900)
    const ctx = detectCanvas.getContext('2d')
    if (!ctx) {
      message.error(tt('scanner.enhance.correctFail'))
      return
    }
    const img = ctx.getImageData(0, 0, detectCanvas.width, detectCanvas.height)
    const rgba = new Uint8ClampedArray(img.data)
    detectorHandle = createDetector()
    const detect = await detectorHandle.detect(
      { width: detectCanvas.width, height: detectCanvas.height, data: rgba },
      { minAreaRatio: 0.05 },
    )
    if (!detect) {
      message.warning(tt('scanner.enhance.correctFail'))
      return
    }
    const cornersPx: [import('./vision/types').Pt, import('./vision/types').Pt, import('./vision/types').Pt, import('./vision/types').Pt] = [
      { x: detect.quad[0].x * fullCanvas.width, y: detect.quad[0].y * fullCanvas.height },
      { x: detect.quad[1].x * fullCanvas.width, y: detect.quad[1].y * fullCanvas.height },
      { x: detect.quad[2].x * fullCanvas.width, y: detect.quad[2].y * fullCanvas.height },
      { x: detect.quad[3].x * fullCanvas.width, y: detect.quad[3].y * fullCanvas.height },
    ]
    const fullCtx = fullCanvas.getContext('2d')
    if (!fullCtx) {
      message.error(tt('scanner.enhance.correctFail'))
      return
    }
    const fullImg = fullCtx.getImageData(0, 0, fullCanvas.width, fullCanvas.height)
    const warped = warpQuad(
      { width: fullCanvas.width, height: fullCanvas.height, data: new Uint8ClampedArray(fullImg.data) },
      cornersPx,
      { maxEdge: 2200 },
    )
    const out = document.createElement('canvas')
    out.width = warped.width
    out.height = warped.height
    const outCtx = out.getContext('2d')
    if (!outCtx) {
      message.error(tt('scanner.enhance.correctFail'))
      return
    }
    outCtx.putImageData(new ImageData(new Uint8ClampedArray(warped.data), warped.width, warped.height), 0, 0)
    page.originalImage = canvasToDataUrl(out, 0.92)
    page.width = out.width
    page.height = out.height
    await recomputePageImage(page)
  } catch {
    message.error(tt('scanner.enhance.correctFail'))
  } finally {
    detectorHandle?.terminate()
    correcting.value = false
  }
}

/* ------------------------------------------------------------------ *
 * OCR / 保存 / PDF
 * ------------------------------------------------------------------ */
/** 调单页 OCR 并把结果写回页面（页面可能在请求期间被删除，写回前重新查找）。 */
async function fetchOcrIntoPage(pageId: string) {
  const requestPage = pages.value.find(p => p.id === pageId)
  if (!requestPage) return null
  const response: ScannerOcrResponse = await runScannerOcr({
    pages: [{ image: requestPage.image }],
    language: language.value,
  })
  const target = pages.value.find(p => p.id === pageId)
  if (!target) return null
  const first = response.pages[0]
  target.text = first?.text || ''
  target.status = 'done'
  target.error = ''
  return first
}

async function recognizeActivePage() {
  const page = activePage.value
  if (!page) return
  ocrOneLoading.value = true
  page.status = 'running'
  page.error = ''
  try {
    const first = await fetchOcrIntoPage(page.id)
    page.status = 'done'
    if (!first?.hasContent) {
      message.warning(tt('scanner.ocr.empty'))
    }
  } catch (err: any) {
    page.status = 'error'
    page.error = err?.message || tt('scanner.ocr.failed')
    message.error(page.error || tt('scanner.ocr.failed'))
  } finally {
    ocrOneLoading.value = false
  }
}

/** 批量 OCR 每次请求的页数：服务端单请求上限 30 页，但少页一批更稳、
 *  也能逐批反馈进度；单批失败只影响这一批，继续识别剩余页。 */
const OCR_CHUNK_SIZE = 4
const ocrProgress = ref<{ done: number; total: number } | null>(null)

async function recognizeAll() {
  if (pages.value.length === 0) {
    message.warning(tt('scanner.pages.empty'))
    return
  }
  const pending = pages.value.filter(p => p.status !== 'done')
  if (pending.length === 0) {
    message.info(tt('scanner.ocr.allDone'))
    return
  }
  ocrAllLoading.value = true
  ocrProgress.value = { done: 0, total: pending.length }
  try {
    let failed = 0
    for (let i = 0; i < pending.length; i += OCR_CHUNK_SIZE) {
      const chunk = pending.slice(i, i + OCR_CHUNK_SIZE)
      for (const page of chunk) {
        page.status = 'running'
        page.error = ''
      }
      try {
        const response = await runScannerOcr({
          pages: chunk.map(p => ({ image: p.image })),
          language: language.value,
        })
        for (const [index, page] of chunk.entries()) {
          const result = response.pages[index]
          if (!pages.value.some(p => p.id === page.id)) continue
          page.text = result?.text || ''
          page.status = 'done'
        }
      } catch (err: any) {
        failed += chunk.length
        const msg = err?.message || tt('scanner.ocr.failed')
        for (const page of chunk) {
          if (!pages.value.some(p => p.id === page.id)) continue
          page.status = 'error'
          page.error = msg
        }
        message.error(msg)
      }
      ocrProgress.value = { done: Math.min(pending.length, i + OCR_CHUNK_SIZE), total: pending.length }
    }
    if (failed === 0) {
      message.success(tt('scanner.ocr.batchDone', { count: pending.length }))
    }
  } finally {
    ocrAllLoading.value = false
    ocrProgress.value = null
  }
}

/* ----------------------- 拍摄后自动识别 ----------------------- */
const AUTO_OCR_STORAGE_KEY = 'hermes.scanner.autoOcr'

function readAutoOcrPref(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(AUTO_OCR_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

const autoOcr = ref(readAutoOcrPref())
watch(autoOcr, (v) => {
  try {
    localStorage.setItem(AUTO_OCR_STORAGE_KEY, v ? '1' : '0')
  } catch { /* ignore */ }
})

// 串行队列：连拍多页时逐页识别，不并发轰服务端
let autoOcrQueue: Promise<void> = Promise.resolve()

function enqueueAutoOcr(pageId: string) {
  autoOcrQueue = autoOcrQueue
    .then(async () => { await fetchOcrIntoPage(pageId) })
    .catch((err: any) => {
      const target = pages.value.find(p => p.id === pageId)
      if (target) {
        target.status = 'error'
        target.error = err?.message || tt('scanner.ocr.failed')
      }
    })
}

function maybeAutoRecognize(page: ScannerPage) {
  if (!autoOcr.value || !dashscopeReady.value) return
  page.status = 'running'
  enqueueAutoOcr(page.id)
}

async function saveToWorkspace() {
  if (rotating.value || correcting.value) return
  if (pages.value.length === 0) {
    message.warning(tt('scanner.pages.empty'))
    return
  }
  saveLoading.value = true
  try {
    const response: ScannerSaveResponse = await saveScannerDocument({
      pages: pages.value.map(p => ({ image: p.image, text: p.text })),
      title: tt('scanner.save.defaultTitle'),
    })
    message.success(tt('scanner.save.success', { dir: response.directory }))
  } catch (err: any) {
    message.error(err?.message || tt('scanner.save.failed'))
  } finally {
    saveLoading.value = false
  }
}

async function exportPdf() {
  if (rotating.value || correcting.value) return
  if (pages.value.length === 0) {
    message.warning(tt('scanner.pages.empty'))
    return
  }
  pdfLoading.value = true
  let url: string | null = null
  try {
    const result = await exportScannerPdf(
      pages.value.map(p => ({ image: p.image, text: p.text })),
      {
        layout: pdfLayout.value,
        dpi: pdfLayout.value === 'image' ? pdfDpi.value : undefined,
        searchable: pdfSearchable.value,
      },
    )
    url = result.url
    const link = document.createElement('a')
    link.href = result.url
    link.download = result.filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    message.success(tt('scanner.pdf.success', { filename: result.filename }))
  } catch (err: any) {
    message.error(err?.message || tt('scanner.pdf.failed'))
  } finally {
    pdfLoading.value = false
    if (url) {
      setTimeout(() => URL.revokeObjectURL(url!), 5000)
    }
  }
}

/* ----------------------- PDF 导出选项 ----------------------- */
const pdfLayout = ref<'image' | 'a4'>('image')
const pdfDpi = ref<number>(200)
/** 把 OCR 文本作为隐藏文字层嵌进 PDF（可搜索、可复制），默认开启。 */
const pdfSearchable = ref(true)
const pdfOptionsOpen = ref(false)
const pdfLayoutOptions = [
  { label: tt('scanner.pdf.layoutImage'), value: 'image' },
  { label: tt('scanner.pdf.layoutA4'), value: 'a4' },
]
const pdfDpiOptions = [
  { label: '150 DPI', value: 150 },
  { label: '200 DPI', value: 200 },
  { label: '300 DPI', value: 300 },
]
const pdfSearchableCount = computed(() => pages.value.filter(p => (p.text || '').trim().length > 0).length)

async function ensureKeyLoaded() {
  await realtimeModelStore.loadFromServer().catch(() => undefined)
  keyChecked.value = true
}

onMounted(async () => {
  await nextTick()
  if (videoEl.value) cam.bindVideo(videoEl.value)
  await refreshVideoInputs()
  // 移动端：先按后置摄像头走默认；桌面无 facingMode，由浏览器忽略。
  // 不在 mount 时直接 start，避免未授权时弹权限框 + 占位画面打架。
  mobileQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(max-width: 768px)')
    : null
  syncMobile()
  if (mobileQuery) {
    mobileListener = () => syncMobile()
    if (mobileQuery.addEventListener) mobileQuery.addEventListener('change', mobileListener)
    else mobileQuery.addListener(mobileListener) // Safari < 14
  }
  // 热插拔：USB 摄像头接入 / 蓝牙断开时自动刷新设备列表。
  removeDeviceChange = cam.onDeviceChange(() => {
    void refreshVideoInputs()
  })
  void ensureKeyLoaded()
})

onBeforeUnmount(() => {
  stopCamera()
  if (mobileQuery && mobileListener) {
    if (mobileQuery.removeEventListener) mobileQuery.removeEventListener('change', mobileListener)
    else mobileQuery.removeListener(mobileListener)
  }
  removeDeviceChange?.()
})

watch(videoEl, (el) => {
  cam.bindVideo(el)
})

/** 摄像头开启后把预览框比例切换为视频比例，保证选框与画面一一对应。
 *  移动端：摄像头还没拿到真实分辨率前先按 3:4 竖版占位（文档/发票多数竖向），
 *  拿到 videoWidth/Height 后再切回真实比例，避免一开始是 16:9 把竖向画面压扁。 */
const videoMetaTick = ref(0)

const frameStyle = computed(() => {
  void videoMetaTick.value
  const v = videoEl.value
  const vw = cameraRunning.value ? v?.videoWidth || 0 : 0
  const vh = cameraRunning.value ? v?.videoHeight || 0 : 0
  if (vw > 0 && vh > 0) {
    return { aspectRatio: `${vw} / ${vh}` }
  }
  if (isMobile.value) {
    return { aspectRatio: '3 / 4' }
  }
  return undefined
})

// videoWidth/Height 是非响应式属性：元数据就绪/流切换时用 tick 触发重算
function onVideoMetadata() {
  videoMetaTick.value += 1
}

const deviceOptions = computed(() => devices.value.map((d, idx) => ({
  label: d.label || `${tt('scanner.camera.deviceFallback')} ${idx + 1}`,
  value: d.deviceId,
})))

const cameraHint = computed(() => {
  if (cameraErrorCode.value) return tt(`scanner.camera.${cameraErrorCode.value}` as any)
  if (cameraRunning.value) return tt('scanner.camera.live')
  return tt('scanner.camera.idle')
})

const cameraHintTone = computed(() => {
  if (cameraErrorCode.value) return 'error'
  if (cameraRunning.value) return 'success'
  return 'info'
})
</script>

<template>
  <div class="scanner-view" :class="{ 'is-mobile': isMobile }">
    <header class="page-header">
      <div class="header-title-block">
        <div class="title-row">
          <h2 class="header-title">{{ tt('scanner.page.title') }}</h2>
          <NTag round size="small" :type="cameraHintTone">
            {{ cameraHint }}
          </NTag>
          <NTag v-if="smartEnabled" round size="small" :type="smartStatusTone">
            {{ smartStatusText }}
          </NTag>
        </div>
        <span v-if="!isMobile" class="header-subtitle">{{ tt('scanner.page.subtitle') }}</span>
      </div>
      <div class="header-actions">
        <NSelect
          v-if="!isMobile && deviceOptions.length > 0"
          v-model:value="selectedDeviceId"
          :options="deviceOptions"
          size="small"
          :disabled="cameraStarting"
          :placeholder="tt('scanner.camera.selectDevice')"
          class="header-device-select"
          @update:value="switchCamera"
        />
        <NSelect
          v-if="!isMobile"
          :value="resolutionId"
          :options="resolutionOptions"
          size="small"
          :disabled="cameraStarting"
          :placeholder="tt('scanner.camera.resolutionLabel')"
          class="header-resolution-select"
          @update:value="onResolutionChange"
        />
        <NButton
          size="small"
          :type="cameraRunning ? 'default' : 'primary'"
          :loading="cameraStarting"
          @click="cameraRunning ? stopCamera() : startCamera()"
        >
          {{ cameraRunning ? tt('scanner.camera.stop') : tt('scanner.camera.start') }}
        </NButton>
        <NButton
          v-if="!isMobile"
          size="small"
          type="primary"
          :disabled="!cameraRunning"
          @click="capture"
        >
          {{ tt('scanner.capture.snapshot') }}
        </NButton>
      </div>
    </header>

    <div class="scanner-content">
      <div class="scanner-left">
        <section class="camera-stage">
          <div class="camera-frame" :style="frameStyle">
            <video
              ref="videoEl"
              autoplay
              playsinline
              muted
              class="camera-video"
              @loadedmetadata="onVideoMetadata"
              @resize="onVideoMetadata"
            />
            <ScannerQuadOverlay
              v-if="cameraRunning && smartEnabled && smartQuad"
              :quad="smartQuad"
              :manual="smartManual"
              @update:quad="onQuadEdit"
              @drag-start="smart.lockSelection()"
            />
            <div v-if="!cameraRunning" class="camera-empty">
              <NEmpty :description="tt('scanner.camera.idleHint')">
                <template #extra>
                  <NButton size="small" type="primary" :loading="cameraStarting" @click="startCamera">
                    {{ tt('scanner.camera.start') }}
                  </NButton>
                </template>
              </NEmpty>
            </div>

            <!-- 移动端悬浮控件：翻转 + 拍摄 FAB。一拇指可达，不挡选框。 -->
            <template v-if="isMobile && cameraRunning">
              <button
                type="button"
                class="camera-flip-btn"
                :title="tt('scanner.camera.flip')"
                :aria-label="tt('scanner.camera.flip')"
                @click="flipCamera"
              >
                <span class="camera-flip-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 7h11l-3-3" />
                    <path d="M21 17H10l3 3" />
                  </svg>
                </span>
              </button>
              <button
                type="button"
                class="camera-fab"
                :title="tt('scanner.capture.snapshot')"
                :aria-label="tt('scanner.capture.snapshot')"
                @click="capture"
              >
                <span class="camera-fab-ring" aria-hidden="true" />
                <span class="camera-fab-core" aria-hidden="true" />
              </button>
            </template>
          </div>

          <div v-if="!isMobile" class="camera-toolbar">
            <span class="camera-toolbar-label">{{ tt('scanner.camera.languageLabel') }}</span>
            <NSelect
              v-model:value="language"
              :options="languageOptions"
              size="small"
              class="toolbar-lang-select"
            />
            <label class="smart-option smart-auto" :title="tt('scanner.ocr.autoOcrHint')">
              <NSwitch v-model:value="autoOcr" size="small" data-testid="scanner-auto-ocr" />
              <span>{{ tt('scanner.ocr.autoOcr') }}</span>
            </label>
            <NTooltip>
              <template #trigger>
                <NButton
                  size="small"
                  type="primary"
                  :loading="ocrAllLoading"
                  :disabled="pages.length === 0"
                  @click="recognizeAll"
                >
                  {{ ocrProgress
                    ? tt('scanner.ocr.progress', ocrProgress)
                    : tt('scanner.ocr.recognizeAll') }}
                </NButton>
              </template>
              {{ tt('scanner.ocr.recognizeAllHint') }}
            </NTooltip>
          </div>

          <!-- 移动端：把语言选择 + 一键识别压成一行紧凑的工具条（隐藏在 FAB 旁） -->
          <div v-else class="mobile-toolbar">
            <NSelect
              v-model:value="language"
              :options="languageOptions"
              size="small"
              class="mobile-lang-select"
            />
            <label class="smart-option smart-auto" :title="tt('scanner.ocr.autoOcrHint')">
              <NSwitch v-model:value="autoOcr" size="small" />
              <span>{{ tt('scanner.ocr.autoOcr') }}</span>
            </label>
            <NButton
              size="small"
              type="primary"
              :loading="ocrAllLoading"
              :disabled="pages.length === 0"
              block
              @click="recognizeAll"
            >
              {{ ocrProgress
                ? tt('scanner.ocr.progress', ocrProgress)
                : tt('scanner.ocr.recognizeAll') }}
            </NButton>
          </div>

          <!-- 动态捕捉控制条 -->
          <div v-if="cameraRunning" class="smart-toolbar">
            <NTooltip :disabled="isMobile">
              <template #trigger>
                <NButton
                  size="small"
                  :type="smartEnabled ? 'warning' : 'default'"
                  @click="toggleSmart"
                >
                  {{ tt('scanner.smart.mode') }}
                </NButton>
              </template>
              {{ tt('scanner.smart.modeHint') }}
            </NTooltip>

            <span
              v-if="aiEnabled && smartEnabled && mlStatus.state !== 'off' && mlStatus.state !== 'ready'"
              class="smart-live"
              :class="`tone-${mlStatusTone}`"
              :title="mlStatus.error ?? ''"
            >
              {{ mlStatusText }}
            </span>

            <template v-if="smartEnabled">
              <label class="smart-option smart-ai" :title="tt('scanner.smart.aiHint')">
                <NSwitch v-model:value="aiEnabled" size="small" />
                <span v-if="!isMobile">{{ tt('scanner.smart.aiLabel') }}</span>
              </label>
              <label class="smart-option smart-auto">
                <NSwitch v-model:value="autoCaptureOn" size="small" />
                <span v-if="!isMobile">{{ tt('scanner.smart.auto') }}</span>
              </label>
              <span v-if="!isMobile" class="smart-option smart-preset">
                <span class="smart-option-label">{{ tt('scanner.smart.preset') }}</span>
                <NSelect
                  v-model:value="capturePreset"
                  :options="capturePresetOptions"
                  size="small"
                  class="smart-preset-select"
                />
              </span>
              <span v-if="!isMobile" class="smart-option smart-aspect">
                <span class="smart-option-label">{{ tt('scanner.smart.aspect') }}</span>
                <NSelect
                  v-model:value="aspect"
                  :options="aspectOptions"
                  size="small"
                  class="smart-aspect-select"
                />
              </span>
              <NTooltip :disabled="isMobile">
                <template #trigger>
                  <NButton
                    size="small"
                    type="primary"
                    :disabled="!smartQuad"
                    @click="smartShoot"
                  >
                    {{ tt('scanner.smart.shoot') }}
                  </NButton>
                </template>
                {{ tt('scanner.smart.shootHint') }}
              </NTooltip>
              <NButton
                v-if="smartQuad"
                size="small"
                quaternary
                type="error"
                @click="smartRescan"
              >
                {{ tt('scanner.smart.resetBox') }}
              </NButton>
              <span
                v-if="smartStatus === 'searching' || smartStatus === 'detected'"
                class="smart-live"
                :class="`tone-${smartStatusTone}`"
              >
                {{ smartStatusText }}
              </span>
            </template>

            <NAlert
              v-if="smartStatus === 'unavailable'"
              type="error"
              size="small"
              :show-icon="false"
              class="smart-unavailable"
            >
              {{ tt('scanner.smart.unavailable') }}
            </NAlert>
          </div>
        </section>

        <!-- 桌面：保留原 page-strip（侧栏列表） -->
        <section v-if="!isMobile" class="page-strip">
          <div class="page-strip-header">
            <span class="page-strip-title">{{ tt('scanner.pages.title') }}</span>
            <span class="page-strip-count">{{ pages.length }}</span>
            <NButton
              v-if="pages.length > 0"
              size="tiny"
              quaternary
              type="error"
              @click="clearAll"
            >
              {{ tt('scanner.pages.clearAll') }}
            </NButton>
          </div>
          <div v-if="pages.length === 0" class="page-strip-empty">
            {{ tt('scanner.pages.emptyHint') }}
          </div>
          <div v-else class="page-strip-list">
            <button
              v-for="(page, idx) in pages"
              :key="page.id"
              type="button"
              class="page-thumb"
              :class="{ 'is-active': page.id === activePageId }"
              @click="activePageId = page.id"
            >
              <img :src="page.image" :alt="`page-${idx + 1}`" />
              <span class="page-thumb-index">{{ idx + 1 }}</span>
              <NTag
                v-if="page.status === 'done'"
                size="tiny"
                type="success"
                class="page-thumb-tag"
                round
              >
                {{ tt('scanner.pages.statusDone') }}
              </NTag>
              <NTag
                v-else-if="page.status === 'running'"
                size="tiny"
                type="info"
                class="page-thumb-tag"
                round
              >
                {{ tt('scanner.pages.statusRunning') }}
              </NTag>
              <NTag
                v-else-if="page.status === 'error'"
                size="tiny"
                type="error"
                class="page-thumb-tag"
                round
              >
                {{ tt('scanner.pages.statusError') }}
              </NTag>
              <span
                class="page-thumb-delete"
                role="button"
                tabindex="0"
                :title="tt('scanner.pages.delete')"
                @click.stop="deletePage(page.id)"
                @keydown.enter.stop.prevent="deletePage(page.id)"
              >
                ×
              </span>
              <span class="page-thumb-reorder">
                <span
                  role="button"
                  tabindex="0"
                  class="page-thumb-move"
                  :class="{ 'is-disabled': idx === 0 }"
                  :title="tt('scanner.pages.moveUp')"
                  :aria-label="tt('scanner.pages.moveUp')"
                  :aria-disabled="idx === 0"
                  :data-testid="`scanner-page-up-${idx}`"
                  @click.stop="idx > 0 && movePageUp(page.id)"
                  @keydown.enter.stop.prevent="idx > 0 && movePageUp(page.id)"
                >↑</span>
                <span
                  role="button"
                  tabindex="0"
                  class="page-thumb-move"
                  :class="{ 'is-disabled': idx === pages.length - 1 }"
                  :title="tt('scanner.pages.moveDown')"
                  :aria-label="tt('scanner.pages.moveDown')"
                  :aria-disabled="idx === pages.length - 1"
                  :data-testid="`scanner-page-down-${idx}`"
                  @click.stop="idx < pages.length - 1 && movePageDown(page.id)"
                  @keydown.enter.stop.prevent="idx < pages.length - 1 && movePageDown(page.id)"
                >↓</span>
              </span>
            </button>
          </div>
        </section>

        <!-- 移动端：横向滚动的页码条，覆盖在底部。thumb = 当前选中态。 -->
        <section v-if="isMobile" class="mobile-thumbs">
          <div v-if="pages.length === 0" class="mobile-thumbs-empty">
            {{ tt('scanner.pages.emptyHint') }}
          </div>
          <div v-else class="mobile-thumbs-row">
            <button
              v-for="(page, idx) in pages"
              :key="page.id"
              type="button"
              class="mobile-thumb"
              :class="{ 'is-active': page.id === activePageId }"
              @click="openMobileDetail(page.id)"
            >
              <img :src="page.image" :alt="`page-${idx + 1}`" />
              <span class="mobile-thumb-index">{{ idx + 1 }}</span>
            </button>
            <NButton
              v-if="pages.length > 0"
              size="tiny"
              quaternary
              type="error"
              class="mobile-thumbs-clear"
              @click="clearAll"
            >
              {{ tt('scanner.pages.clearAll') }}
            </NButton>
          </div>
        </section>
      </div>

      <div v-if="!isMobile" class="scanner-right">
        <NSpin :show="ocrOneLoading || correcting || rotating" class="detail-spin">
          <div v-if="!activePage" class="scanner-right-empty">
            <NEmpty :description="tt('scanner.detail.emptyHint')" />
          </div>
          <div v-else class="scanner-detail">
            <figure class="scanner-detail-image" :style="activePageAspectStyle">
              <img :src="activePage.image" :alt="activePage.id" />
              <figcaption class="scanner-detail-caption">
                {{ activePage.width }} × {{ activePage.height }} px · {{ activePageAspectLabel }}
              </figcaption>
            </figure>
            <ScannerEnhanceControls
              :params="activePage.enhance"
              :correcting="correcting"
              :rotating="rotating"
              :apply-all-loading="applyAllLoading"
              @update:params="onEnhanceParams"
              @correct="correctActivePage"
              @rotate-left="rotateActivePage('left')"
              @rotate-right="rotateActivePage('right')"
              @reset="resetEnhance"
              @apply-all="applyEnhanceToAll"
            />
            <div class="scanner-detail-text">
              <div class="scanner-detail-toolbar">
                <span class="scanner-detail-title">{{ tt('scanner.detail.textTitle') }}</span>
                <span class="scanner-detail-toolbar-actions">
                  <NButton
                    size="tiny"
                    quaternary
                    :disabled="activePageId === pages[0]?.id"
                    :title="tt('scanner.pages.moveUp')"
                    @click="activePageId && movePageUp(activePageId)"
                  >
                    ↑ {{ tt('scanner.pages.moveUp') }}
                  </NButton>
                  <NButton
                    size="tiny"
                    quaternary
                    :disabled="activePageId === pages[pages.length - 1]?.id"
                    :title="tt('scanner.pages.moveDown')"
                    @click="activePageId && movePageDown(activePageId)"
                  >
                    ↓ {{ tt('scanner.pages.moveDown') }}
                  </NButton>
                  <NButton
                    size="tiny"
                    type="primary"
                    :loading="ocrOneLoading"
                    @click="recognizeActivePage"
                  >
                    {{ activePage.text ? tt('scanner.ocr.recognizeAgain') : tt('scanner.ocr.recognize') }}
                  </NButton>
                </span>
              </div>
              <NAlert
                v-if="activePage.status === 'error' && activePage.error"
                type="error"
                size="small"
                :show-icon="false"
                class="scanner-detail-error"
              >
                {{ activePage.error }}
              </NAlert>
              <NInput
                v-model:value="activePage.text"
                type="textarea"
                :autosize="{ minRows: 8, maxRows: 20 }"
                :placeholder="tt('scanner.detail.placeholder')"
              />
              <div class="scanner-detail-meta">
                {{ tt('scanner.detail.size', {
                  width: activePage.width,
                  height: activePage.height,
                  chars: activePage.text.length,
                }) }}
              </div>
            </div>
          </div>
        </NSpin>

        <footer v-if="pages.length > 0" class="scanner-actions">
          <div class="pdf-options">
            <button
              type="button"
              class="pdf-options-toggle"
              data-testid="scanner-pdf-options-toggle"
              @click="pdfOptionsOpen = !pdfOptionsOpen"
            >
              <span class="advanced-chevron" :class="{ open: pdfOptionsOpen }">▸</span>
              {{ tt('scanner.pdf.options') }}
              <span v-if="pdfSearchable" class="pdf-options-badge">
                {{ tt('scanner.pdf.searchableBadge', { count: pdfSearchableCount }) }}
              </span>
            </button>
            <div v-if="pdfOptionsOpen" class="pdf-options-body" data-testid="scanner-pdf-options">
              <div class="pdf-options-row">
                <span class="pdf-options-label">{{ tt('scanner.pdf.layout') }}</span>
                <NSelect
                  v-model:value="pdfLayout"
                  :options="pdfLayoutOptions"
                  size="tiny"
                  class="pdf-options-select"
                />
              </div>
              <div v-if="pdfLayout === 'image'" class="pdf-options-row">
                <span class="pdf-options-label">{{ tt('scanner.pdf.dpi') }}</span>
                <NSelect
                  v-model:value="pdfDpi"
                  :options="pdfDpiOptions"
                  size="tiny"
                  class="pdf-options-select"
                />
              </div>
              <label class="pdf-options-row pdf-options-switch" :title="tt('scanner.pdf.searchableHint')">
                <NSwitch v-model:value="pdfSearchable" size="small" data-testid="scanner-pdf-searchable" />
                <span>{{ tt('scanner.pdf.searchable') }}</span>
              </label>
            </div>
          </div>
          <div class="scanner-actions-buttons">
            <NButton :loading="saveLoading" :disabled="rotating || correcting" @click="saveToWorkspace">
              {{ tt('scanner.save.action') }}
            </NButton>
            <NButton :loading="pdfLoading" :disabled="rotating || correcting" type="primary" @click="exportPdf">
              {{ tt('scanner.pdf.action') }}
            </NButton>
          </div>
        </footer>

        <NAlert
          v-if="dashscopeMissing"
          type="warning"
          size="small"
          :show-icon="false"
          class="scanner-warn"
        >
          {{ tt('scanner.apiKey.warn') }}
        </NAlert>
      </div>
    </div>

    <!-- 移动端：底部 sheet 显示当前页大图 / 增强控件 / OCR 文本。 -->
    <div v-if="isMobile" class="mobile-detail-sheet" :class="{ 'is-open': mobileDetailOpen }">
      <div class="mobile-detail-backdrop" @click="closeMobileDetail" />
      <div class="mobile-detail-panel" role="dialog" :aria-label="tt('scanner.detail.textTitle')">
        <div class="mobile-detail-header">
          <span class="mobile-detail-title">{{ tt('scanner.detail.textTitle') }}</span>
          <NButton size="small" quaternary @click="closeMobileDetail">
            {{ tt('scanner.mobile.close') }}
          </NButton>
        </div>
        <NSpin :show="ocrOneLoading || correcting || rotating" class="mobile-detail-spin">
          <div v-if="!activePage" class="mobile-detail-empty">
            <NEmpty :description="tt('scanner.detail.emptyHint')" />
          </div>
          <div v-else class="mobile-detail-body">
            <div class="mobile-detail-image" :style="activePageAspectStyle">
              <img :src="activePage.image" :alt="activePage.id" />
            </div>
            <ScannerEnhanceControls
              :params="activePage.enhance"
              :correcting="correcting"
              :rotating="rotating"
              :apply-all-loading="applyAllLoading"
              @update:params="onEnhanceParams"
              @correct="correctActivePage"
              @rotate-left="rotateActivePage('left')"
              @rotate-right="rotateActivePage('right')"
              @reset="resetEnhance"
              @apply-all="applyEnhanceToAll"
            />
            <div class="mobile-detail-text">
              <div class="mobile-detail-text-toolbar">
                <NButton
                  size="small"
                  quaternary
                  :disabled="activePageId === pages[0]?.id"
                  :title="tt('scanner.pages.moveUp')"
                  @click="activePageId && movePageUp(activePageId)"
                >
                  ↑
                </NButton>
                <NButton
                  size="small"
                  quaternary
                  :disabled="activePageId === pages[pages.length - 1]?.id"
                  :title="tt('scanner.pages.moveDown')"
                  @click="activePageId && movePageDown(activePageId)"
                >
                  ↓
                </NButton>
                <NButton
                  size="small"
                  type="primary"
                  :loading="ocrOneLoading"
                  @click="recognizeActivePage"
                >
                  {{ activePage.text ? tt('scanner.ocr.recognizeAgain') : tt('scanner.ocr.recognize') }}
                </NButton>
                <NButton
                  size="small"
                  quaternary
                  type="error"
                  :title="tt('scanner.pages.delete')"
                  @click="activePage && deletePage(activePage.id)"
                >
                  {{ tt('scanner.pages.delete') }}
                </NButton>
              </div>
              <NAlert
                v-if="activePage.status === 'error' && activePage.error"
                type="error"
                size="small"
                :show-icon="false"
                class="mobile-detail-error"
              >
                {{ activePage.error }}
              </NAlert>
              <NInput
                v-model:value="activePage.text"
                type="textarea"
                :autosize="{ minRows: 6, maxRows: 14 }"
                :placeholder="tt('scanner.detail.placeholder')"
              />
              <div class="mobile-detail-meta">
                {{ tt('scanner.detail.size', {
                  width: activePage.width,
                  height: activePage.height,
                  chars: activePage.text.length,
                }) }}
              </div>
            </div>
          </div>
        </NSpin>
        <footer v-if="pages.length > 0" class="mobile-detail-actions">
          <div class="pdf-options">
            <button
              type="button"
              class="pdf-options-toggle"
              @click="pdfOptionsOpen = !pdfOptionsOpen"
            >
              <span class="advanced-chevron" :class="{ open: pdfOptionsOpen }">▸</span>
              {{ tt('scanner.pdf.options') }}
              <span v-if="pdfSearchable" class="pdf-options-badge">
                {{ tt('scanner.pdf.searchableBadge', { count: pdfSearchableCount }) }}
              </span>
            </button>
            <div v-if="pdfOptionsOpen" class="pdf-options-body">
              <div class="pdf-options-row">
                <span class="pdf-options-label">{{ tt('scanner.pdf.layout') }}</span>
                <NSelect
                  v-model:value="pdfLayout"
                  :options="pdfLayoutOptions"
                  size="tiny"
                  class="pdf-options-select"
                />
              </div>
              <div v-if="pdfLayout === 'image'" class="pdf-options-row">
                <span class="pdf-options-label">{{ tt('scanner.pdf.dpi') }}</span>
                <NSelect
                  v-model:value="pdfDpi"
                  :options="pdfDpiOptions"
                  size="tiny"
                  class="pdf-options-select"
                />
              </div>
              <label class="pdf-options-row pdf-options-switch" :title="tt('scanner.pdf.searchableHint')">
                <NSwitch v-model:value="pdfSearchable" size="small" />
                <span>{{ tt('scanner.pdf.searchable') }}</span>
              </label>
            </div>
          </div>
          <div class="mobile-detail-actions-buttons">
            <NButton :loading="saveLoading" :disabled="rotating || correcting" block @click="saveToWorkspace">
              {{ tt('scanner.save.action') }}
            </NButton>
            <NButton :loading="pdfLoading" :disabled="rotating || correcting" type="primary" block @click="exportPdf">
              {{ tt('scanner.pdf.action') }}
            </NButton>
          </div>
        </footer>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.scanner-view {
  display: flex;
  flex-direction: column;
  height: calc(100 * var(--vh));
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 20px 12px;
  border-bottom: 1px solid $border-light;
}

.header-title-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.header-title {
  font-size: 18px;
  font-weight: 600;
  margin: 0;
}

.header-subtitle {
  font-size: 12px;
  color: $text-muted;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.header-device-select {
  width: 200px;
}

.header-resolution-select {
  width: 168px;
}

.scanner-content {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
  /* 行高钉死在容器内：否则 auto 行会随内容撑高、被 overflow: hidden 裁掉，
   * 左右两列各自的内部滚动（page-strip-list / scanner-detail）永远不触发。 */
  grid-template-rows: minmax(0, 1fr);
  gap: 16px;
  padding: 16px 20px 20px;
  overflow: hidden;
}

.scanner-left,
.scanner-right {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
}

.camera-stage {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 1px solid $border-light;
  border-radius: $radius-md;
  background: var(--theme-card-bg, var(--bg-card));
  padding: 12px;
}

.camera-frame {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;

  /* theme-exception: preview -- Fixed contrast keeps camera and paper preview controls visible. */
  background: #0d0d10;
  border-radius: $radius-sm;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

.camera-video {
  width: 100%;
  height: 100%;
  object-fit: contain;

  /* theme-exception: preview -- Fixed contrast keeps camera and paper preview controls visible. */
  background: #0d0d10;
  display: block;
}

.camera-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 移动端 FAB / 翻转按钮：绝对定位覆盖在 camera-frame 之上。
 * 不挡选框：FAB 居中底部（避开四角拖柄），翻转按钮放右上角。
 * safe-area-inset 让 iPhone 刘海/底部小白条不遮按钮。 */
.camera-fab {
  position: absolute;
  left: 50%;
  bottom: calc(20px + env(safe-area-inset-bottom, 0px));
  transform: translateX(-50%);
  width: 68px;
  height: 68px;
  border-radius: 50%;
  border: 0;
  background: transparent;
  padding: 0;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  z-index: 4;
  touch-action: manipulation;
}

.camera-fab-ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;

  /* theme-exception: preview -- Fixed contrast keeps camera and paper preview controls visible. */
  border: 3px solid #fff;

  /* theme-exception: preview -- Fixed contrast keeps camera and paper preview controls visible. */
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.45);
}

.camera-fab-core {
  position: absolute;
  inset: 8px;
  border-radius: 50%;

  /* theme-exception: preview -- Fixed contrast keeps camera and paper preview controls visible. */
  background: #fff;
  transition: transform 120ms ease;
}

.camera-fab:active .camera-fab-core {
  transform: scale(0.92);
}

.camera-flip-btn {
  position: absolute;
  top: calc(12px + env(safe-area-inset-top, 0px));
  right: 12px;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 0;

  /* theme-exception: preview -- Fixed contrast keeps camera and paper preview controls visible. */
  background: rgba(0, 0, 0, 0.45);

  /* theme-exception: preview -- Fixed contrast keeps camera and paper preview controls visible. */
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 4;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
  backdrop-filter: blur(4px);
}

.camera-flip-btn:active {

  /* theme-exception: preview -- Fixed contrast keeps camera and paper preview controls visible. */
  background: rgba(0, 0, 0, 0.7);
}

.camera-flip-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.camera-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.toolbar-lang-select {
  width: 160px;
}

.camera-toolbar-label {
  font-size: 12.5px;
  color: $text-muted;
}

/* 移动端：把「语言」+「一键识别」压成两行紧凑工具条，避免挤掉 FAB 区域。 */
.mobile-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr);
  gap: 8px;
}

.mobile-lang-select {
  min-width: 0;
}

/* 动态捕捉控制条 */
.smart-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border: 1px dashed $border-light;
  border-radius: $radius-sm;
  background: var(--theme-card-bg, var(--bg-card));
}

.smart-preset-select {
  /* 预设名带括号说明（如「扫描件（去阴影）」），窄了会被截断 */
  width: 150px;
}

.smart-aspect-select {
  width: 116px;
}

.smart-option {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: $text-muted;
}

.smart-option-label {
  white-space: nowrap;
}

.smart-live {
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--theme-card-bg, var(--bg-card));

  &.tone-success { color: var(--color-success, var(--success)); }
  &.tone-info { color: var(--color-info, var(--accent-info)); }
  &.tone-error { color: var(--color-error, var(--error)); }
}

.smart-unavailable {
  width: 100%;
  font-size: 12px;
}

.page-strip {
  border: 1px solid $border-light;
  border-radius: $radius-md;
  background: var(--theme-card-bg, var(--bg-card));
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1;
  min-height: 0;
}

.page-strip-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.page-strip-title {
  font-size: 13px;
  font-weight: 600;
}

.page-strip-count {
  font-size: 12px;
  color: $text-muted;
  padding: 0 6px;
  background: var(--theme-card-bg, var(--bg-card));
  border-radius: 999px;
}

.page-strip-empty {
  font-size: 12.5px;
  color: $text-muted;
  padding: 12px;
  border: 1px dashed $border-light;
  border-radius: $radius-sm;
  text-align: center;
}

.page-strip-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 10px;
  overflow-y: auto;
}

.page-thumb {
  position: relative;
  width: 100%;
  aspect-ratio: 3 / 4;
  border: 1px solid $border-light;
  border-radius: $radius-sm;
  background: var(--theme-card-bg, var(--bg-card));
  padding: 0;
  cursor: pointer;
  overflow: hidden;
  transition: border-color 120ms ease, transform 120ms ease;

  &:hover {
    border-color: var(--accent-info);
  }

  &.is-active {
    border-color: var(--accent-info);
    box-shadow: 0 0 0 2px rgba(var(--accent-info-rgb), 0.25);
  }

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
}

.page-thumb-index {
  position: absolute;
  left: 4px;
  bottom: 4px;
  padding: 1px 6px;
  font-size: 11px;
  border-radius: 999px;

  /* theme-exception: preview -- Fixed contrast keeps camera and paper preview controls visible. */
  background: rgba(0, 0, 0, 0.6);

  /* theme-exception: preview -- Fixed contrast keeps camera and paper preview controls visible. */
  color: #fff;
}

.page-thumb-tag {
  position: absolute;
  right: 4px;
  top: 4px;
}

.page-thumb-delete {
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 22px;
  height: 22px;
  border-radius: 999px;

  /* theme-exception: preview -- Fixed contrast keeps camera and paper preview controls visible. */
  background: rgba(0, 0, 0, 0.55);

  /* theme-exception: preview -- Fixed contrast keeps camera and paper preview controls visible. */
  color: #fff;
  border: 0;
  cursor: pointer;
  font-size: 14px;
  line-height: 22px;
  display: none;
  text-align: center;
  user-select: none;
}

.page-thumb:hover .page-thumb-delete {
  display: block;
}

.page-thumb-reorder {
  position: absolute;
  left: 4px;
  bottom: 4px;
  display: none;
  gap: 2px;
}

.page-thumb:hover .page-thumb-reorder {
  display: flex;
}

.page-thumb-move {
  width: 20px;
  height: 20px;
  border-radius: 999px;

  /* theme-exception: preview -- Fixed contrast keeps camera and paper preview controls visible. */
  background: rgba(0, 0, 0, 0.55);

  /* theme-exception: preview -- Fixed contrast keeps camera and paper preview controls visible. */
  color: #fff;
  border: 0;
  cursor: pointer;
  font-size: 12px;
  line-height: 20px;
  text-align: center;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}

.page-thumb-move:hover:not(.is-disabled) {

  /* theme-exception: preview -- Fixed contrast keeps camera and paper preview controls visible. */
  background: rgba(0, 0, 0, 0.8);
}

.page-thumb-move.is-disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

/* 移动端：横向滚动条覆盖在 camera-stage 下方，hover/active 区分选中。
 * 与 FAB 不冲突：thumbs 高度 76px，FAB 直径 68px，左右各留 12px padding。 */
.mobile-thumbs {
  flex-shrink: 0;
  border: 1px solid $border-light;
  border-radius: $radius-md;
  background: var(--theme-card-bg, var(--bg-card));
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mobile-thumbs-row {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: thin;
  padding-bottom: 2px;
}

.mobile-thumbs-clear {
  flex-shrink: 0;
  align-self: center;
}

.mobile-thumbs-empty {
  font-size: 12.5px;
  color: $text-muted;
  padding: 8px 4px;
  text-align: center;
}

.mobile-thumb {
  position: relative;
  flex-shrink: 0;
  width: 56px;
  height: 76px;
  border: 1px solid $border-light;
  border-radius: $radius-sm;
  background: var(--theme-card-bg, var(--bg-card));
  padding: 0;
  cursor: pointer;
  overflow: hidden;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  &.is-active {
    border-color: var(--accent-info);
    box-shadow: 0 0 0 2px rgba(var(--accent-info-rgb), 0.25);
  }
}

.mobile-thumb-index {
  position: absolute;
  left: 2px;
  bottom: 2px;
  padding: 0 5px;
  font-size: 10px;
  border-radius: 999px;

  /* theme-exception: preview -- Fixed contrast keeps camera and paper preview controls visible. */
  background: rgba(0, 0, 0, 0.6);

  /* theme-exception: preview -- Fixed contrast keeps camera and paper preview controls visible. */
  color: #fff;
  line-height: 14px;
}

/* 桌面右侧详情：NSpin 的 .n-spin-container/.n-spin-content 默认是普通块级盒，
 * 会打断 flex 高度链，导致 .scanner-detail 的 flex:1 + overflow-y:auto 失效、
 * 整列内容被裁切。参照 mobile-detail-spin 把两层都变成可收缩的 flex 列。 */
.detail-spin {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;

  :deep(.n-spin-content) {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
}

.scanner-detail {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  border: 1px solid $border-light;
  border-radius: $radius-md;
  background: var(--theme-card-bg, var(--bg-card));
  padding: 12px;
  min-height: 0;
  overflow-y: auto;
}

/* 成品预览：容器按页面真实比例撑开（aspectRatio 由行内 style 给出），
 * 图片满铺，纸面用白底 + 投影模拟一张真实纸 —— 用户可以直接对比左侧选框，
 * 一眼看出矫正后的形状是不是就是自己拉的框。 */
.scanner-detail-image {
  position: relative;
  flex-shrink: 0;
  align-self: center;
  margin: 0;
  width: 100%;
  max-height: 52vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--theme-card-bg, var(--bg-card));
  border-radius: $radius-sm;
  overflow: hidden;

  img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    background: var(--theme-card-bg, var(--theme-card-bg, var(--bg-card)));
    box-shadow: 0 1px 8px rgba(var(--text-primary-rgb), 0.3);
  }
}

.scanner-detail-caption {
  position: absolute;
  right: 6px;
  bottom: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 16px;
  color: var(--text-primary);
  background: rgba(var(--text-primary-rgb), 0.45);
  pointer-events: none;
}

.scanner-detail-text {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
}

.scanner-detail-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.scanner-detail-title {
  font-size: 13px;
  font-weight: 600;
}

.scanner-detail-error {
  font-size: 12px;
}

.scanner-detail-meta {
  font-size: 11.5px;
  color: $text-muted;
}

.scanner-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
}

.scanner-actions-buttons {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}

.scanner-detail-toolbar-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* PDF 导出选项（布局 / DPI / 可搜索文字层） */
.pdf-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid $border-light;
  border-radius: $radius-sm;
  padding: 6px 8px;
}

.pdf-options-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: none;
  padding: 2px 0;
  font-size: 12px;
  color: $text-muted;
  cursor: pointer;
  text-align: left;
}

.pdf-options-toggle:hover {
  color: inherit;
}

.advanced-chevron {
  display: inline-block;
  transition: transform 0.15s ease;
}

.advanced-chevron.open {
  transform: rotate(90deg);
}

.pdf-options-badge {
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 999px;
  background: $border-light;
}

.pdf-options-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-left: 16px;
}

.pdf-options-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pdf-options-label {
  font-size: 12px;
  color: $text-muted;
  min-width: 64px;
}

.pdf-options-select {
  width: 140px;
}

.pdf-options-switch {
  cursor: pointer;
  font-size: 12px;
}

.scanner-warn {
  font-size: 12px;
  flex-shrink: 0;
}

.scanner-right-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed $border-light;
  border-radius: $radius-md;
}

/* 移动端：底部 sheet（不是 modal，避免遮住摄像头本身）。 */
.mobile-detail-sheet {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 50;
}

.mobile-detail-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(var(--text-primary-rgb), 0.5);
  opacity: 0;
  transition: opacity 180ms ease;
  pointer-events: none;
}

.mobile-detail-sheet.is-open .mobile-detail-backdrop {
  opacity: 1;
  pointer-events: auto;
}

.mobile-detail-panel {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  max-height: 88vh;
  background: var(--theme-card-bg, var(--bg-card));
  border-top-left-radius: 14px;
  border-top-right-radius: 14px;
  box-shadow: 0 -10px 32px rgba(var(--text-primary-rgb), 0.28);
  display: flex;
  flex-direction: column;
  transform: translateY(100%);
  transition: transform 220ms cubic-bezier(0.22, 0.61, 0.36, 1);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  pointer-events: auto;
}

.mobile-detail-sheet.is-open .mobile-detail-panel {
  transform: translateY(0);
}

.mobile-detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid $border-light;
  flex-shrink: 0;
}

.mobile-detail-title {
  font-size: 14px;
  font-weight: 600;
}

.mobile-detail-spin {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.mobile-detail-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.mobile-detail-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 0;
}

.mobile-detail-image {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--theme-card-bg, var(--bg-card));
  border-radius: $radius-sm;
  overflow: hidden;
  flex-shrink: 0;
  max-height: 44vh;

  img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    background: var(--theme-card-bg, var(--theme-card-bg, var(--bg-card)));
  }
}

.mobile-detail-text {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mobile-detail-text-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mobile-detail-error {
  font-size: 12px;
}

.mobile-detail-meta {
  font-size: 11.5px;
  color: $text-muted;
}

.mobile-detail-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 14px 14px;
  border-top: 1px solid $border-light;
  flex-shrink: 0;
}

.mobile-detail-actions-buttons {
  display: flex;
  gap: 8px;

  :deep(.n-button) {
    flex: 1;
  }
}

@media (max-width: $breakpoint-mobile) {
  .scanner-view {
    /* 移动端：去掉桌面外边距，给摄像头满屏；保留安全区内边距。 */
    height: 100dvh;
  }

  .page-header {
    padding: 10px 14px 8px;
    gap: 8px;
  }

  .header-title {
    font-size: 16px;
  }

  .header-actions {
    gap: 6px;
  }

  .scanner-content {
    grid-template-columns: 1fr;
    /* 移动端单列沿用旧的 auto 行为，保持原布局不受桌面行约束影响。 */
    grid-template-rows: auto;
    padding: 10px 12px 12px;
    gap: 10px;
  }

  .camera-stage {
    padding: 8px;
    gap: 8px;
  }

  .smart-toolbar {
    flex-wrap: nowrap;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    padding: 6px 8px;

    &::-webkit-scrollbar {
      display: none;
    }
  }

  .smart-unavailable {
    flex-basis: 100%;
  }
}
</style>
