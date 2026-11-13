<script setup lang="ts">
/**
 * GradingScannerPanel — 批改模式右侧的「摄像头 + OCR」实时面板。
 *
 * 完全复用扫描插件的能力，不重复造轮子：
 *   - useScannerCamera：UVC/USB / 移动端摄像头 + 分辨率预设 + 设备选择 + 前后翻转；
 *   - useSmartCapture：动态捕捉（纸张检测 / 选框微调 / 自动拍摄 / AI 兜底）+ 输出比例；
 *   - ScannerQuadOverlay：选框覆盖层（角点拖动）；
 *   - ScannerEnhanceControls：拍摄增强（预设 / 对比度 / 亮度 / 锐化 / 旋转 / 重置）；
 *   - scanner/image-io + vision/enhance：增强与旋转算法，拍摄时应用到图片；
 *   - scanner/api.exportScannerPdf：可搜索 PDF / A4 / DPI 导出。
 *
 * 本面板还负责：
 *   - 扫描件预览：完整显示（object-fit: contain）+ 可旋转；
 *   - 「发给 Agent」：把扫描件图片 + OCR 文本作为一条用户消息发送给左侧对话。
 */
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { NButton, NCollapse, NCollapseItem, NEmpty, NSelect, NSpin, NSwitch, NTag, NTooltip, NIcon } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { SCANNER_RESOLUTION_PRESETS, useScannerCamera } from '../scanner/composables/useScannerCamera'
import { useSmartCapture } from '../scanner/composables/useSmartCapture'
import ScannerQuadOverlay from '../scanner/components/ScannerQuadOverlay.vue'
import ScannerEnhanceControls from '../scanner/components/ScannerEnhanceControls.vue'
import { canvasToDataUrl, enhanceDataUrl, rotateDataUrl } from '../scanner/image-io'
import { ENHANCE_DEFAULTS, type EnhanceParams, type Quad, type WarpAspect } from '../scanner/vision/types'
import { exportScannerPdf } from '../scanner/api'
import { gradingApi, type Submission } from './api'
import { renderPage, renderMarksOnly, download } from './render'

const props = withDefaults(defineProps<{
  /** 点击「发给 Agent」时回调；由宿主（ChatPanel）把图片+OCR 文本发送给左侧对话。 */
  sendToAgent?: (payload: { image: string; ocrText: string; studentName?: string; scanId: string }) => void
  /** 当前对话 sessionId：用于把识别内容按对话记忆，避免切换页面后丢失。 */
  sessionId?: string | null
}>(), { sendToAgent: undefined, sessionId: undefined })

const { t } = useI18n()
const cam = useScannerCamera()
const video = ref<HTMLVideoElement | null>(null)

/**
 * 预览容器按视频真实分辨率撑开（aspect-ratio = videoWidth / videoHeight），
 * 使视频 `object-fit: contain` 正好充满容器——既不产生黑边，也让选框的
 * 归一化坐标与视频画面完全对齐（避免误以为拉框 / 裁剪不对）。与扫描插件一致。
 */
const videoMetaTick = ref(0)
const frameStyle = computed(() => {
  void videoMetaTick.value
  const v = video.value
  const vw = cam.isRunning.value ? v?.videoWidth || 0 : 0
  const vh = cam.isRunning.value ? v?.videoHeight || 0 : 0
  if (vw > 0 && vh > 0) return { aspectRatio: `${vw} / ${vh}` }
  return undefined
})
function onVideoMetadata() {
  videoMetaTick.value += 1
}

const resolutionId = ref('2k')
const resolutionOptions = computed(() =>
  SCANNER_RESOLUTION_PRESETS.map(p => ({ label: t(p.labelKey), value: p.id })),
)

/* ------------------------- 摄像头设备选择 / 翻转 ------------------------- */
const devices = ref<MediaDeviceInfo[]>([])
const selectedDeviceId = ref<string | null>(null)
const deviceOptions = computed(() => devices.value.map(d => ({
  label: d.label || t('scanner.camera.deviceFallback'),
  value: d.deviceId,
})))

/* ----------------------------- 拍摄增强/旋转 ----------------------------- */
/** 拍摄增强参数（默认扫描件去阴影预设，与扫描插件一致）。 */
const enhance = ref<EnhanceParams>({ ...ENHANCE_DEFAULTS.scan })
/** 拍摄前把图片旋转 90° 的次数（0..3）。 */
const rotationTurns = ref(0)
const rotateDeg = computed(() => ((rotationTurns.value % 4) + 4) % 4 * 90)

/* ----------------------------- 智能捕捉 ------------------------------- */
const aspect = ref<WarpAspect>('auto')
const aspectOptions = [
  { label: t('scanner.smart.aspectAuto'), value: 'auto' },
  { label: t('scanner.smart.aspectA4'), value: 'a4' },
  { label: t('scanner.smart.aspectA4Landscape'), value: 'a4-landscape' },
]

const pages = ref<any[]>([])
const active = ref<Submission | null>(null)
const busy = ref(false)
const error = ref('')

const pdfLoading = ref(false)
/** 导出选项：includeMarks=true 时把批改痕迹一起导出。 */
const pdfOptions = ref<{ layout: 'image' | 'a4'; dpi: number; searchable: boolean; includeMarks: boolean }>({ layout: 'image', dpi: 200, searchable: false, includeMarks: true })

/** 拍后是否自动跑 OCR：默认关闭，只有点「识别 OCR」才识别。 */
const autoOcr = ref(false)
/** OCR 正在识别中（用于「识别 OCR」按钮 loading）。 */
const ocrRunning = ref(false)

/** 扫描件预览图 = 原图 + 批改批注(rough 手绘/印刷) + 旋转后的渲染结果；用于显示 + 发给 Agent + 导出。 */
const previewImage = ref<string>('')
/** 拍摄原图（只做拍摄方向旋转，不做增强）；预览据此实时套用当前增强参数。 */
const baseImage = ref<string>('')
/** 预览是否全屏（扫描件充满右屏）。 */
const previewExpanded = ref(false)
/** 预览旋转 90° 的次数（0..3）。 */
const previewRotate = ref(0)
/** 批改批注用手绘风（rough）渲染。 */
const handDrawn = ref(true)
/** 可编辑的 OCR 文本，随 active 同步，发给 Agent 时使用。 */
const ocrText = ref('')

/* ------------------- 按对话记忆识别内容（session-scoped） ------------------- */
function sessionKey(kind: string): string {
  return `grading.${kind}.${props.sessionId || 'default'}`
}
function loadSessionScanIds(): string[] {
  try { return JSON.parse(localStorage.getItem(sessionKey('scans')) || '[]') as string[] } catch { return [] }
}
function rememberScan(scanId: string) {
  const ids = loadSessionScanIds()
  if (!ids.includes(scanId)) {
    ids.unshift(scanId)
    try { localStorage.setItem(sessionKey('scans'), JSON.stringify(ids.slice(0, 50))) } catch { /* storage full */ }
  }
}
/** 重置本对话的批改内容：清空队列与 localStorage 记忆（服务端文件保留，避免误删）。 */
function resetContent() {
  try { localStorage.removeItem(sessionKey('scans')) } catch { /* ignore */ }
  pages.value = []
  active.value = null
  previewImage.value = ''
  ocrText.value = ''
  error.value = ''
}

/** 打开面板 / 切换对话时：恢复本对话已识别的扫描件（ID 来自 localStorage 记忆）。 */
async function loadSessionScans() {
  const ids = loadSessionScanIds()
  pages.value = []
  active.value = null
  previewImage.value = ''
  if (!ids.length) return
  busy.value = true
  try {
    for (const id of ids) {
      try {
        const full = await gradingApi<Submission>('get', { scanId: id })
        if (!pages.value.some(p => p.id === id)) {
          pages.value.push({ id: full.id, studentName: full.studentName || `Scan ${pages.value.length + 1}`, status: full.status || 'pending', results: full.results || [], error: full.error || '', wordCount: (full.words || []).length })
        }
      } catch { /* 该扫描件已删除，跳过 */ }
    }
    if (pages.value.length) await selectScan(pages.value[0]!.id)
    else ocrText.value = ''
  } finally { busy.value = false }
}

const smart = useSmartCapture({
  video: () => video.value,
  cameraRunning: () => cam.isRunning.value,
  onAutoCapture: async payload => {
    await captureAndStore(canvasToDataUrl(payload.canvas, 0.92))
  },
  aspectRatio: null,
})
const smartEnabled = computed(() => smart.enabled.value)
const smartQuad = computed(() => smart.quad.value)
const smartManual = computed(() => smart.manual.value)
const autoCaptureOn = computed({ get: () => smart.autoCapture.value, set: v => smart.setAutoCapture(v) })
const aiEnabled = computed({ get: () => smart.aiEnabled.value, set: v => { smart.aiEnabled.value = v } })
const smartStatusText = computed(() => {
  if (smartManual.value && smart.status.value !== 'capturing' && smart.status.value !== 'cooling') {
    return t('scanner.smart.manualLocked')
  }
  switch (smart.status.value) {
    case 'off': return t('scanner.smart.off')
    case 'loading': return t('scanner.smart.loading')
    case 'unavailable': return t('scanner.smart.unavailable')
    case 'searching': return t('scanner.smart.searching')
    case 'detected': return t('scanner.smart.detected')
    case 'held': return t('scanner.smart.held')
    case 'capturing': return t('scanner.smart.capturing')
    case 'cooling': return t('scanner.smart.cooling')
    default: return t('scanner.smart.off')
  }
})

watch(aspect, v => { smart.setAspectRatio(v === 'auto' ? null : aspectRatioValue(v)) })
function aspectRatioValue(v: Exclude<WarpAspect, 'auto'>): number {
  if (v === 'a4') return 1 / Math.sqrt(2)
  return Math.sqrt(2)
}

function onQuadEdit(next: Quad) { smart.setQuadManually(next) }

/* ----------------------------- 增强/旋转转换 ----------------------------- */
/** 只做拍摄方向的旋转（不增强）。 */
async function applyRotation(dataUrl: string): Promise<string> {
  let img = dataUrl
  const turns = ((rotationTurns.value % 4) + 4) % 4
  for (let i = 0; i < turns; i++) {
    const rotated = await rotateDataUrl(img, 'right')
    if (rotated) img = rotated.dataUrl
  }
  return img
}

function rotateDir(dir: 'left' | 'right') {
  rotationTurns.value = ((rotationTurns.value + (dir === 'right' ? 1 : -1)) % 4 + 4) % 4
}
function resetEnhance() {
  enhance.value = { ...ENHANCE_DEFAULTS.none }
  rotationTurns.value = 0
}

/**
 * 渲染预览图：以「拍摄原图 baseImage」为底，实时套用当前增强参数，
 * 再叠加批改批注（agent 工具写入的手写 marks）并按 previewRotate 旋转。
 * 这样增强滑杆（二值化/去阴影）和批改痕迹都会实时反映在预览里。
 */
async function renderPreview() {
  const s = active.value
  const base = baseImage.value || s?.image || ''
  if (!base) { previewImage.value = ''; return }
  try {
    const enhanced = enhance.value.preset !== 'none'
      ? ((await enhanceDataUrl(base, enhance.value)) || base)
      : base
    const canvas = await renderPage(enhanced, s?.annotations || [], handDrawn.value)
    let dataUrl = canvas.toDataURL('image/jpeg', 0.9)
    const turns = ((previewRotate.value % 4) + 4) % 4
    for (let i = 0; i < turns; i++) {
      const rotated = await rotateDataUrl(dataUrl, 'right')
      if (rotated) dataUrl = rotated.dataUrl
    }
    previewImage.value = dataUrl
  } catch {
    // 渲染异常时回退为原图
    previewImage.value = s?.image || ''
  }
}

/** 旋转「扫描件预览」90°（重新渲染）。 */
function rotatePreview(dir: 'left' | 'right') {
  previewRotate.value = ((previewRotate.value + (dir === 'right' ? 1 : -1)) % 4 + 4) % 4
  void nextTick(renderPreview)
}

/** 预览全屏覆盖层：只覆盖右侧栏位（用面板的屏幕 getBoundingClientRect 定位），
 *  而非整屏。面板本身会滚动，所以用 fixed + rect 才是"右屏全屏"。 */
const panelEl = ref<HTMLElement | null>(null)
const overlayStyle = ref<Record<string, string> | undefined>(undefined)
function openPreview() {
  const rect = panelEl.value?.getBoundingClientRect()
  if (rect) overlayStyle.value = { top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px` }
  previewExpanded.value = true
}
function closePreview() {
  previewExpanded.value = false
  overlayStyle.value = undefined
}
function togglePreviewExpanded() {
  previewExpanded.value ? closePreview() : openPreview()
}

/** 重新拉取当前扫描件（含 agent 最新的批改批注/结果）并重绘。 */
async function refreshAnnotations() {
  if (!active.value) return
  await selectScan(active.value.id)
}

/* ----------------------------- 摄像头基础 ------------------------------ */
async function refreshVideoInputs() {
  devices.value = await cam.listVideoInputs()
  if (!selectedDeviceId.value && devices.value.length) selectedDeviceId.value = devices.value[0]!.deviceId
}

async function startCamera() {
  await cam.start({
    deviceId: selectedDeviceId.value || undefined,
    facingMode: selectedDeviceId.value ? 'auto' : undefined,
    resolutionId: resolutionId.value,
  })
  if (cam.error.value) error.value = String(cam.error.value)
  if (cam.isRunning.value) await refreshVideoInputs()
}
function stopCamera() { cam.stop() }
async function onResolutionChange(next: string) {
  resolutionId.value = next
  if (cam.isRunning.value) await cam.start({ resolutionId: next, deviceId: selectedDeviceId.value || undefined })
}
async function switchCamera(next: string) {
  selectedDeviceId.value = next
  if (cam.isRunning.value) await cam.start({ deviceId: next, facingMode: 'auto', resolutionId: resolutionId.value })
}
async function flipCamera() {
  await cam.flipCamera()
  if (cam.error.value) error.value = String(cam.error.value)
}

/* ----------------------------- 拍摄与识别 ------------------------------ */
async function handleCapture(dataUrl: string, base = '') {
  if (busy.value) return
  busy.value = true; error.value = ''
  try {
    const captured: any = await gradingApi('capture_scan', { image: dataUrl, studentName: `Scan ${pages.value.length + 1}` })
    const row: any = { id: captured.scanId, studentName: `Scan ${pages.value.length + 1}`, status: 'pending', results: [], error: '', wordCount: 0, baseImage: base }
    pages.value.unshift(row)
    rememberScan(captured.scanId)
    await selectScan(captured.scanId)
    // 默认不立即 OCR：只有当「拍后自动识别」开启时才自动识别。
    if (autoOcr.value) await runOcr(captured.scanId)
  } catch (e) { error.value = (e as Error).message } finally { busy.value = false }
}

async function attempt(fn: () => Promise<unknown>) {
  error.value = ''
  try { await fn() } catch (e) { error.value = (e as Error).message }
}

async function selectScan(id: string) {
  const full = await gradingApi<Submission>('get', { scanId: id })
  const row = pages.value.find(p => p.id === id)
  active.value = full
  // 恢复该扫描件的拍摄原图（若有）；否则回退到服务端图。
  baseImage.value = (row as any)?.baseImage || ''
  previewRotate.value = 0
  ocrText.value = (full.words || []).map((w: any) => w.text).join('\n')
  await renderPreview()
}

/** 手动/自动对某张扫描件跑 OCR，并把结果同步到队列与预览。 */
async function runOcr(scanId: string) {
  if (ocrRunning.value) return
  ocrRunning.value = true; error.value = ''
  try {
    const ocr: any = await gradingApi('ocr', { scanId })
    const row = pages.value.find(p => p.id === scanId)
    if (row) {
      row.status = ocr.status || 'recognized'
      row.wordCount = (ocr.words?.length || 0)
    }
    await selectScan(scanId)
  } catch (e) { error.value = (e as Error).message } finally { ocrRunning.value = false }
}

/** 普通拍摄（未启用智能捕捉时的兜底）。 */
async function capturePlain() {
  const shot = await cam.snapshot()
  if (shot) await captureAndStore(shot.dataUrl)
}

/** 智能拍摄：按当前选框矫正 + 增强。 */
async function snap() {
  const shot = await smart.captureNow()
  if (shot) await captureAndStore(shot.dataUrl)
}

/**
 * 拍摄入库：保留「拍摄原图(仅旋转)」作为 baseImage（供预览实时套增强），
 * 同时把「增强后的图」传给服务端（OCR/agent 视觉用增强版）。
 */
async function captureAndStore(rawDataUrl: string) {
  const rotated = await applyRotation(rawDataUrl)
  const stored = enhance.value.preset !== 'none'
    ? ((await enhanceDataUrl(rotated, enhance.value)) || rotated)
    : rotated
  await handleCapture(stored, rotated)
}

/** 对当前选中扫描件跑 OCR（供模板按钮调用）。 */
async function recognize() {
  if (!active.value) return
  await runOcr(active.value.id)
}

/** 复制当前扫描件 scanId，便于把「批改这一张」的信息交到 agent 手里。 */
async function copyScanId() {
  if (!active.value) return
  try { await navigator.clipboard.writeText(active.value.id) } catch { /* clipboard unavailable */ }
}

/** 把「扫描件预览图 + 可编辑 OCR 文本」发给左侧 Agent。 */
function sendToAgent() {
  if (!active.value || !previewImage.value) return
  props.sendToAgent?.({
    image: previewImage.value,
    ocrText: ocrText.value,
    studentName: active.value.studentName,
    scanId: active.value.id,
  })
}

async function exportPdf() {
  if (!active.value || !previewImage.value) return
  pdfLoading.value = true; error.value = ''
  try {
    // 默认导出「原图 + 批改痕迹 + 旋转」；关闭 includeMarks 则只导出原图 + 旋转。
    let image = previewImage.value
    if (!pdfOptions.value.includeMarks) {
      image = active.value.image
      const turns = ((previewRotate.value % 4) + 4) % 4
      for (let i = 0; i < turns; i++) { const r = await rotateDataUrl(image, 'right'); if (r) image = r.dataUrl }
    }
    const { url, filename } = await exportScannerPdf(
      [{ image, text: ocrText.value }],
      { layout: pdfOptions.value.layout, dpi: pdfOptions.value.dpi, searchable: pdfOptions.value.searchable },
    )
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
    URL.revokeObjectURL(url)
  } catch (e) { error.value = (e as Error).message } finally { pdfLoading.value = false }
}

/** 只导出批改痕迹（不含原识别件）：白底 PNG，位置与扫描件一致，可直接打印。 */
async function exportMarks() {
  if (!active.value) return
  const base = baseImage.value || active.value.image
  if (!base) return
  busy.value = true; error.value = ''
  try {
    const canvas = await renderMarksOnly(base, active.value.annotations || [], handDrawn.value, false)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
    if (blob) download(blob, `${active.value.studentName || 'scan'}-marks.png`)
  } catch (e) { error.value = (e as Error).message } finally { busy.value = false }
}

// 当扫描件切换 / 批改批注变化 / 手绘风格切换时，重绘预览（把 agent 的修改痕迹画上去）。
watch(() => [active.value?.id, active.value?.annotations, handDrawn.value], () => { if (active.value) void nextTick(renderPreview) }, { deep: true })

// 增强参数变化时，实时重绘预览（防抖，避免滑杆频繁重算大图）。
let enhanceDebounce = 0
watch(enhance, () => {
  if (!active.value) return
  window.clearTimeout(enhanceDebounce)
  enhanceDebounce = window.setTimeout(() => void renderPreview(), 250)
}, { deep: true })

/* --------------------- 实时拉取 agent 的批改痕迹（轮询） --------------------- */
let pollTimer = 0
async function pollAnnotations() {
  const id = active.value?.id
  if (!id || busy.value || ocrRunning.value) return
  try {
    // 用 omitImage 轻量拉取，避免每 4s 传一整个 base64 大图。
    const meta = await gradingApi<Submission>('get', { scanId: id, omitImage: true })
    if (!meta || !active.value || meta.revision === active.value.revision) return
    const idx = pages.value.findIndex(p => p.id === id)
    if (idx >= 0) pages.value[idx] = { ...pages.value[idx]!, status: meta.status, results: meta.results || [], error: meta.error || '', wordCount: (meta.words || []).length, baseImage: (pages.value[idx] as any)?.baseImage }
    active.value = { ...active.value, ...meta, image: active.value.image }
    ocrText.value = (meta.words || []).map((w: any) => w.text).join('\n')
    await renderPreview()
  } catch { /* 网络/权限问题静默，等下一轮 */ }
}
function startPoll() { stopPoll(); pollTimer = window.setInterval(() => void pollAnnotations(), 4000) }
function stopPoll() { if (pollTimer) { window.clearInterval(pollTimer); pollTimer = 0 } }

// 预览全屏时按 ESC 关闭。
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') closePreview()
}
onMounted(() => {
  void nextTick(); if (video.value) cam.bindVideo(video.value)
  if (typeof window !== 'undefined') window.addEventListener('keydown', onKeydown)
  // 打开面板即把批改插件标记为启用，避免 agent 走 MCP 工具时被 403（"插件未启用"）。
  void attempt(async () => { await gradingApi('settings', { enabled: true }); await loadSessionScans() })
  startPoll()
})
onBeforeUnmount(() => {
  cam.stop()
  stopPoll()
  if (typeof window !== 'undefined') window.removeEventListener('keydown', onKeydown)
})
watch(video, el => { if (el) cam.bindVideo(el) })
watch(() => props.sessionId, () => { void loadSessionScans() })
</script>

<template>
  <aside ref="panelEl" class="grading-scanner" role="region" :aria-label="t('grading.title')">
    <div class="gs-toolbar">
      <NSelect :value="resolutionId" :options="resolutionOptions" size="small" style="width:130px" @update:value="onResolutionChange" />
      <NSelect
        v-if="deviceOptions.length > 0"
        :value="selectedDeviceId || undefined"
        :options="deviceOptions"
        size="small"
        clearable
        :placeholder="t('scanner.camera.selectDevice')"
        style="width:150px"
        @update:value="next => next ? switchCamera(next) : undefined"
      />
      <NButton size="small" :type="cam.isRunning.value ? 'default' : 'primary'" @click="cam.isRunning.value ? stopCamera() : startCamera()">
        {{ cam.isRunning.value ? t('scanner.camera.stop') : t('scanner.camera.start') }}
      </NButton>
      <NTooltip>
        <template #trigger>
          <NButton size="small" quaternary circle :disabled="!cam.isRunning.value" @click="flipCamera">
            <template #icon>
              <NIcon>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M3 7h11l-3-3" /><path d="M21 17H10l3 3" />
                </svg>
              </NIcon>
            </template>
          </NButton>
        </template>
        {{ t('scanner.camera.flip') }}
      </NTooltip>
      <NSwitch v-if="cam.isRunning.value" v-model:value="aiEnabled" size="small" />
      <span v-if="cam.isRunning.value" class="gs-option">{{ t('scanner.smart.aiLabel') }}</span>
    </div>

    <div class="gs-camera" :style="frameStyle">
      <video
        ref="video"
        autoplay
        playsinline
        muted
        class="gs-video"
        :style="rotateDeg ? { transform: `rotate(${rotateDeg}deg)` } : undefined"
        @loadedmetadata="onVideoMetadata"
        @resize="onVideoMetadata"
      />
      <ScannerQuadOverlay v-if="cam.isRunning.value && smartEnabled && smartQuad" :quad="smartQuad" :manual="smartManual" @update:quad="onQuadEdit" @drag-start="smart.lockSelection()" />
      <div v-if="!cam.isRunning.value" class="gs-empty">
        <NEmpty :description="t('scanner.camera.idleHint')">
          <template #extra><NButton size="small" type="primary" :loading="busy" @click="startCamera">{{ t('scanner.camera.start') }}</NButton></template>
        </NEmpty>
      </div>
    </div>

    <!-- 动态捕捉：复用扫描插件的智能捕捉 -->
    <div v-if="cam.isRunning.value" class="gs-smart">
      <NButton size="small" :type="smartEnabled ? 'warning' : 'default'" @click="smart.setEnabled(!smartEnabled)">{{ t('scanner.smart.mode') }}</NButton>
      <template v-if="smartEnabled">
        <label class="gs-option"><NSwitch v-model:value="autoCaptureOn" size="small" /><span>{{ t('scanner.smart.auto') }}</span></label>
        <NButton size="small" type="primary" :disabled="!smartQuad" @click="snap">{{ t('scanner.smart.shoot') }}</NButton>
        <NButton v-if="smartQuad" size="small" quaternary type="error" @click="smart.rescan()">{{ t('scanner.smart.resetBox') }}</NButton>
      </template>
      <span v-if="smartEnabled" class="gs-status">{{ smartStatusText }}</span>
    </div>
    <NButton v-else size="small" quaternary @click="capturePlain">{{ t('scanner.capture.snapshot') }}</NButton>

    <!-- 拉杆/选项收进折叠面板，保持面板紧凑 -->
    <NCollapse class="gs-colls">
      <NCollapseItem :title="t('grading.collapseEnhance')" name="enhance">
        <div v-if="cam.isRunning.value && smartEnabled" class="gs-smart">
          <NSelect :value="aspect" :options="aspectOptions" size="small" style="width:150px" @update:value="v => aspect = v" />
        </div>
        <ScannerEnhanceControls
          :params="enhance"
          :rotating="busy"
          :correcting="busy"
          :show-apply-all="false"
          @update:params="enhance = $event"
          @rotate-left="rotateDir('left')"
          @rotate-right="rotateDir('right')"
          @reset="resetEnhance"
          @correct="smart.rescan()"
        />
        <p v-if="rotateDeg" class="gs-option">已旋转 {{ rotateDeg }}°</p>
      </NCollapseItem>
      <NCollapseItem :title="t('grading.collapseExport')" name="export">
        <div class="gs-pdf">
          <NSelect v-model:value="pdfOptions.layout" :options="[{ label: t('scanner.pdf.layoutImage'), value: 'image' }, { label: t('scanner.pdf.layoutA4'), value: 'a4' }]" size="small" style="width:150px" />
          <NSelect v-model:value="pdfOptions.dpi" :options="[72,150,200,300,600].map(d => ({ label: `${d} DPI`, value: d }))" size="small" style="width:110px" />
          <label class="gs-option"><NSwitch v-model:value="pdfOptions.searchable" size="small" /><span>{{ t('scanner.pdf.searchable') }}</span></label>
          <label class="gs-option"><NSwitch v-model:value="pdfOptions.includeMarks" size="small" /><span>{{ t('grading.includeMarks') }}</span></label>
          <NButton size="small" type="primary" :loading="pdfLoading" :disabled="!active" @click="exportPdf">{{ t('scanner.pdf.action') }}</NButton>
          <NButton size="small" :disabled="!active || !(active.annotations?.length)" :loading="busy" @click="attempt(exportMarks)">{{ t('grading.exportMarks') }}</NButton>
        </div>
      </NCollapseItem>
    </NCollapse>

    <NSpin :show="busy || pdfLoading">
      <div v-if="error" class="gs-error">{{ error }}</div>

      <div v-if="active" class="gs-ocr">
        <div class="gs-ocr-head">
          <span>{{ t('grading.scanPreview') }}</span>
          <NTag v-if="active.status" size="tiny" :type="active.status === 'error' ? 'error' : 'info'">{{ t(`grading.${active.status}`) }}</NTag>
          <NTag v-if="active.annotations?.length" size="tiny" type="warning">{{ active.annotations.length }} {{ t('grading.marks') }}</NTag>
        </div>
        <!-- OCR：默认不自动识别，点「识别 OCR」才识别；可开关拍后自动识别 -->
        <div class="gs-ocr-actions">
          <label class="gs-option"><NSwitch v-model:value="autoOcr" size="small" /><span>{{ t('scanner.ocr.autoOcr') }}</span></label>
          <NButton size="small" type="primary" :loading="ocrRunning" :disabled="!active || ocrRunning || busy" @click="attempt(recognize)">{{ t('grading.recognizeOcr') }}</NButton>
        </div>
        <!-- 扫描件预览：完整显示 + 可旋转 + 刷新批改痕迹 + 全屏 -->
        <div class="gs-preview">
          <img :src="previewImage" :alt="active.studentName" />
          <div class="gs-rotate">
            <NTooltip>
              <template #trigger>
                <NButton size="tiny" quaternary circle @click="rotatePreview('left')">
                  <template #icon><NIcon><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7" /><polyline points="3 3 3 9 9 9" /></svg></NIcon></template>
                </NButton>
              </template>
              {{ t('scanner.enhance.rotateLeft') }}
            </NTooltip>
            <NTooltip>
              <template #trigger>
                <NButton size="tiny" quaternary circle @click="rotatePreview('right')">
                  <template #icon><NIcon><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><polyline points="21 3 21 9 15 9" /></svg></NIcon></template>
                </NButton>
              </template>
              {{ t('scanner.enhance.rotateRight') }}
            </NTooltip>
            <NTooltip>
              <template #trigger>
                <NButton size="tiny" quaternary circle :disabled="busy || ocrRunning" title="刷新批改痕迹" :aria-label="t('grading.refreshMarks')" @click="attempt(refreshAnnotations)">
                  <template #icon><NIcon><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><polyline points="21 3 21 9 15 9" /></svg></NIcon></template>
                </NButton>
              </template>
              {{ t('grading.refreshMarks') }}
            </NTooltip>
            <NTooltip>
              <template #trigger>
                <NButton size="tiny" quaternary circle @click="togglePreviewExpanded">
                  <template #icon><NIcon><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M16 3h3a2 2 0 0 1 2 2v3" /><path d="M8 21H5a2 2 0 0 1-2-2v-3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" /></svg></NIcon></template>
                </NButton>
              </template>
              {{ t('grading.fullscreen') }}
            </NTooltip>
          </div>
        </div>
        <textarea v-model="ocrText" class="gs-ocr-text" :placeholder="t('grading.empty')" />

        <div class="gs-send">
          <div v-if="active" class="gs-scanid">
            <code class="gs-scanid-code">{{ active.id }}</code>
            <NButton size="tiny" quaternary @click="attempt(copyScanId)">{{ t('grading.copyScanId') }}</NButton>
          </div>
          <NButton type="primary" block :disabled="!active" @click="sendToAgent">{{ t('grading.sendToAgent') }}</NButton>
        </div>
      </div>

      <div v-if="pages.length" class="gs-reset">
        <NButton size="tiny" quaternary type="error" @click="resetContent">{{ t('grading.resetContent') }}</NButton>
        <span class="gs-option">{{ t('grading.resetContentHint') }}</span>
      </div>
      <div v-if="pages.length === 0 && !active" class="gs-no-scan">{{ t('grading.empty') }}</div>
      <div v-else class="gs-queue" role="list">
        <article
          v-for="row in pages"
          :key="row.id"
          :class="{ selected: active?.id === row.id }"
          role="listitem"
          @click="attempt(() => selectScan(row.id))"
        >
          <span>{{ row.studentName }}</span>
          <NTag size="tiny">{{ t(`grading.${row.status}`) }}</NTag>
        </article>
      </div>
    </NSpin>

    <!-- 全屏预览：把扫描件（含批改痕迹）充满右侧栏位，可实时看 agent 的修改痕迹。
         用面板屏幕 rect 定位，覆盖的是"右侧栏"而非整屏。 -->
    <div v-if="previewExpanded" class="gs-fullscreen" :style="overlayStyle" @click.self="closePreview">
      <div class="gs-fullscreen-head">
        <span class="gs-fullscreen-title">{{ active?.studentName || t('grading.scanPreview') }}</span>
        <NButton size="small" type="primary" @click="sendToAgent">{{ t('grading.sendToAgent') }}</NButton>
        <NButton size="small" @click="closePreview">{{ t('scanner.mobile.close') }}</NButton>
      </div>
      <div class="gs-fullscreen-body">
        <img :src="previewImage" :alt="active?.studentName || t('grading.scanPreview')" />
      </div>
    </div>
  </aside>
</template>

<style scoped lang="scss">
.grading-scanner { width: 100%; height: 100%; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 12px; }
.gs-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
.gs-camera { position: relative; width: 100%; aspect-ratio: 4 / 3;
  /* theme-exception: preview -- Fixed contrast keeps camera and paper preview controls visible. */
  background: #0d0d10; border-radius: 8px; overflow: hidden; margin-bottom: 10px; display: flex; align-items: center; justify-content: center; }
.gs-camera video { transition: transform 0.15s ease; }
.gs-video { width: 100%; height: 100%; object-fit: contain; display: block; }
.gs-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
.gs-smart { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
.gs-option { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-color-2); }
.gs-status { font-size: 12px; color: var(--text-color-2); }
.gs-error { color: var(--warning); font-size: 12px; margin: 4px 0; }
.gs-colls { margin-bottom: 8px; }
.gs-ocr { display: flex; flex-direction: column; gap: 8px; }
.gs-ocr-head { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; }
.gs-ocr-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.gs-preview { position: relative; width: 100%; height: 320px; background: var(--theme-card-bg, var(--theme-card-bg, var(--bg-card))); border-radius: 8px; overflow: hidden; display: flex; align-items: center; justify-content: center; }
.gs-preview img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
.gs-rotate { position: absolute; top: 6px; right: 6px; display: flex; gap: 4px; background: rgba(var(--text-primary-rgb), 0.35); border-radius: 999px; padding: 2px; }
.gs-ocr-text { width: 100%; min-height: 110px; resize: vertical; border-radius: 8px; border: 1px solid rgba(var(--text-primary-rgb), 0.333); background: transparent; color: inherit; padding: 10px; font: inherit; }
.gs-send { margin-top: 4px; display: flex; flex-direction: column; gap: 6px; }
.gs-scanid { display: flex; align-items: center; gap: 8px; }
.gs-scanid-code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--text-color-2); }
.gs-pdf { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.gs-reset { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.gs-no-scan { font-size: 12.5px; color: var(--text-color-2); padding: 12px; border: 1px dashed rgba(var(--text-primary-rgb), 0.333); border-radius: 8px; text-align: center; margin: 8px 0; }
.gs-queue { display: flex; flex-direction: column; gap: 0; border: 1px solid rgba(var(--text-primary-rgb), 0.267); border-radius: 8px; overflow: hidden; margin-top: 8px; }
.gs-queue article { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid rgba(var(--text-primary-rgb), 0.267); cursor: pointer; }
.gs-queue article:last-child { border-bottom: none; }
.gs-queue article:hover { background: rgba(var(--text-primary-rgb), 0.133); }
.gs-queue .selected { background: rgba(var(--text-primary-rgb), 0.133); font-weight: 600; }

/* 全屏预览：覆盖右侧栏位（top/left/width/height 由面板 rect 提供），而非整屏 */
.gs-fullscreen { position: fixed; z-index: 3000; background: rgba(var(--text-primary-rgb), 0.94); display: flex; flex-direction: column; border-radius: 8px; }
.gs-fullscreen-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; flex-shrink: 0; }
.gs-fullscreen-title { flex: 1; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gs-fullscreen-body { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 0 16px 16px; }
.gs-fullscreen-body img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; border-radius: 8px; }
</style>
