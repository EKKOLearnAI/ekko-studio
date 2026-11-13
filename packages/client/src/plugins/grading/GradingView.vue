<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { NAlert, NButton, NInput, NInputNumber, NSwitch } from 'naive-ui'
import { io, type Socket } from 'socket.io-client'
import { getActiveProfileName, getApiKey, getBaseUrlValue } from '@/api/client'
import { socketEndpoint } from '@/utils/deployment-url'
import { useI18n } from 'vue-i18n'
import { useScannerCamera } from '../scanner/composables/useScannerCamera'
import { gradingApi, type Submission, type Annotation } from './api'
import { download, pdfPages, renderPage } from './render'
import GradingAnnotator from './GradingAnnotator.vue'

const props = withDefaults(defineProps<{
  /** 嵌入 ChatPanel 使用（由聊天模式切换进入）；隐藏顶部导航，由外部切换模式。 */
  embedded?: boolean
  /** 当前模式：'single' 单张 / 'batch' 批量；缺省时回退到路由推断。 */
  mode?: 'single' | 'batch'
}>(), { embedded: false, mode: undefined })

const emit = defineEmits<{ close: [] }>()

const { t } = useI18n(); const router = useRouter(); const route = useRoute()
const rubric = ref(''); const studentName = ref('')
const rows = ref<Omit<Submission, 'image'>[]>([]); const active = ref<Submission>(); const annotations = ref<Annotation[]>([])
const error = ref(''); const running = ref(false); const paused = ref(false); const busy = ref(false); const rough = ref(true); const settings = ref({ model: 'qwen3.7-plus', ocrModel: 'qwen3.5-ocr', visionModel: 'qwen3.7-flash', threshold: .7 }); const summary = ref<any>()
const filesInput = ref<HTMLInputElement>(); const folderInput = ref<HTMLInputElement>(); const video = ref<HTMLVideoElement>()
const camera = useScannerCamera(); let disposed = false
let socket: Socket | undefined
const captureRequest = ref<string | null>(null)
/** 批量（batch）还是单张：以传入的 mode 优先，否则由路由尾部推断。 */
const isBatch = computed(() => props.mode === 'batch' || (props.mode == null && route.path.endsWith('grading-batch')))
async function attempt(fn: () => Promise<unknown>) { error.value = ''; try { await fn() } catch (e) { error.value = (e as Error).message } }
async function load() { rows.value = await gradingApi('list'); await report() }
async function report() { summary.value = await gradingApi('summary', { scanIds: rows.value.filter(r => r.results.length).map(r => r.id) }) }
async function select(id: string) { if (active.value && active.value.id !== id) await save(); const s = await gradingApi<Submission>('get', { scanId: id }); active.value = s; annotations.value = structuredClone(s.annotations) }
async function add(image: string, name: string) {
  const result = await gradingApi('capture_scan', { image, studentName: name }); await load(); if (!props.embedded) await select(result.scanId)
  if (captureRequest.value) { await gradingApi('client_complete', { requestId: captureRequest.value, result }); captureRequest.value = null }
}
async function importFiles(files: File[]) {
  busy.value = true
  try {
    for (const file of files) {
      if (disposed) return
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) continue
      if (file.size > 4_500_000) throw new Error(`${file.name}: > 4.5 MB`)
      const image = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file) })
      await add(image, file.name.replace(/\.[^.]+$/, ''))
    }
  } finally { busy.value = false }
}
async function drop(event: DragEvent) {
  const entries = Array.from(event.dataTransfer?.items || []).map(item => item.webkitGetAsEntry?.()).filter(Boolean)
  const files: File[] = []
  async function walk(entry: any): Promise<void> {
    if (entry.isFile) { files.push(await new Promise<File>((resolve, reject) => entry.file(resolve, reject))); return }
    const reader = entry.createReader()
    for (;;) { const children = await new Promise<any[]>((resolve, reject) => reader.readEntries(resolve, reject)); if (!children.length) break; for (const child of children) await walk(child) }
  }
  if (entries.length) for (const entry of entries) await walk(entry)
  else files.push(...Array.from(event.dataTransfer?.files || []))
  await importFiles(files)
}
async function openCamera() { await camera.start(); await nextTick(); if (video.value) camera.bindVideo(video.value) }
async function closeCamera() { camera.stop(); if (captureRequest.value) { await gradingApi('client_complete', { requestId: captureRequest.value, result: { cancelled: true } }); captureRequest.value = null } }
async function snap() { const result = await camera.snapshot(); if (result) await add(result.dataUrl, studentName.value || `Scan ${rows.value.length + 1}`) }
async function gradeRow(row: Omit<Submission, 'image'>) {
  try {
    for (const action of ['ocr', 'detect_questions', 'grade', 'apply_edits']) {
      if (disposed) return
      row.status = action === 'ocr' ? 'ocr' : 'grading'
      const result = await gradingApi(action, { scanId: row.id, rubric: rubric.value })
      Object.assign(row, result)
    }
  } catch (e) { row.status = 'error'; row.error = (e as Error).message }
}
async function start(only?: Omit<Submission, 'image'>) {
  if (!rubric.value.trim()) throw new Error(t('grading.rubricRequired'))
  if (running.value) return
  running.value = true; paused.value = false
  const queue = only ? [only] : rows.value.filter(r => ['pending','error','recognized','detected'].includes(r.status))
  if (!isBatch.value && !only) queue.splice(1)
  const worker = async () => { while (!paused.value && !disposed) { const row = queue.shift(); if (!row) return; await gradeRow(row) } }
  try { await Promise.all([worker(), worker()]); await report(); if (active.value) await select(active.value.id) } finally { running.value = false }
}
async function save() { if (!active.value) return; const result = await gradingApi('save_annotations', { scanId: active.value.id, revision: active.value.revision, annotations: annotations.value }); active.value.revision = result.revision; active.value.annotations = structuredClone(annotations.value) }
async function review() {
  if (!active.value) return
  await save()
  const result = await gradingApi('review', { scanId: active.value.id, revision: active.value.revision, results: active.value.results })
  active.value.revision = result.revision; active.value.status = 'done'; await load()
}
async function exportOne(format: 'png' | 'pdf') {
  if (!active.value) return
  await save(); const canvas = await renderPage(active.value.image, annotations.value, rough.value)
  if (format === 'pdf') download(await pdfPages([canvas]), `${active.value.studentName}.pdf`)
  else { const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve)); if (blob) download(blob, `${active.value.studentName}.png`) }
}
async function exportAll() {
  if (active.value) await save()
  const pages = []
  for (const row of rows.value.filter(r => r.results.length)) { const s = await gradingApi<Submission>('get', { scanId: row.id }); pages.push(await renderPage(s.image, s.annotations, rough.value)) }
  if (pages.length) download(await pdfPages(pages), 'grading.pdf')
}
function exportReport() { download(new Blob([JSON.stringify(summary.value, null, 2)], { type: 'application/json' }), 'grading-report.json') }
function goChat() {
  if (props.embedded) { emit('close'); return }
  void router.push({ name: 'hermes.chat' })
}
onMounted(() => void attempt(async () => { settings.value = await gradingApi('settings', { enabled: true }); await load();
  const endpoint = socketEndpoint(getBaseUrlValue(), '/grading')
  socket = io(endpoint.url, { path: endpoint.path, auth: { token: getApiKey() }, query: { profile: getActiveProfileName() || 'default' } })
  socket.on('grading.request', (request: any) => void attempt(async () => {
    if (request.action === 'capture') {
      captureRequest.value = request.requestId
      if (request.examId) { /* 暂不建班级/考试：忽略 examId，直接在当前工作区拍照 */ }
      await openCamera()
    } else if (request.action === 'render') {
      await select(request.scanId); rough.value = request.style !== 'printed'; await exportOne('pdf'); await exportOne('png')
      await gradingApi('client_complete', { requestId: request.requestId, result: { scanId: request.scanId, downloaded: true } })
    }
  }))
}))
onBeforeUnmount(() => { disposed = true; paused.value = true; camera.stop(); socket?.disconnect() })
</script>
<template>
  <main class="grading-view" :class="{ 'is-embedded': embedded }">
    <header>
      <h2>{{ t('grading.title') }}</h2>
      <div class="actions">
        <NButton @click="goChat">{{ t('grading.chat') }}</NButton>
        <template v-if="!embedded">
          <NButton :type="!isBatch ? 'primary' : 'default'" @click="router.push('/hermes/grading')">{{ t('grading.single') }}</NButton>
          <NButton :type="isBatch ? 'primary' : 'default'" @click="router.push('/hermes/grading-batch')">{{ t('grading.batch') }}</NButton>
        </template>
      </div>
    </header>
    <NAlert v-if="error" type="error" closable @close="error = ''">{{ error }}</NAlert>
    <NInput v-model:value="rubric" type="textarea" :disabled="running" :placeholder="t('grading.rubric')" />
    <section class="drop" @dragover.prevent @drop.prevent="!running && !busy && attempt(() => drop($event))">
      <p>{{ t('grading.drop') }}</p><div class="actions">
        <input ref="filesInput" hidden type="file" accept="image/jpeg,image/png,image/webp" multiple @change="attempt(() => importFiles(Array.from(($event.target as HTMLInputElement).files || [])))">
        <input ref="folderInput" hidden type="file" webkitdirectory multiple @change="attempt(() => importFiles(Array.from(($event.target as HTMLInputElement).files || [])))">
        <NButton :disabled="busy || running" @click="filesInput?.click()">{{ t('grading.import') }}</NButton><NButton :disabled="busy || running" @click="folderInput?.click()">{{ t('grading.folder') }}</NButton><NButton @click="attempt(openCamera)">{{ t('grading.camera') }}</NButton>
      </div>
      <div v-if="camera.isRunning.value"><video ref="video" autoplay muted playsinline /><NInput v-model:value="studentName" :placeholder="t('grading.student')" /><NButton @click="attempt(snap)">{{ t('grading.capture') }}</NButton><NButton @click="attempt(closeCamera)">{{ t('grading.close') }}</NButton></div>
      <p v-if="camera.error.value">{{ camera.error.value }}</p>
    </section>
    <div class="actions"><NButton type="primary" :disabled="running || busy || !rows.length" @click="attempt(() => start())">{{ t('grading.start') }}</NButton><NButton :disabled="!running" @click="paused = true">{{ t('grading.pause') }}</NButton><NButton :disabled="running || !rows.some(r => r.results.length)" @click="attempt(exportAll)">{{ t('grading.allPdf') }}</NButton><NButton :disabled="!summary?.total" @click="exportReport">{{ t('grading.report') }}</NButton></div>
    <section class="workspace">
      <div class="queue" data-theme-surface="card"><p v-if="!rows.length">{{ t('grading.empty') }}</p><article v-for="row in rows" :key="row.id" :class="{ selected: active?.id === row.id }"><NButton text @click="attempt(() => select(row.id))">{{ row.studentName }}</NButton><span>{{ t(`grading.${row.status}`) }}</span><strong v-if="row.results.length">{{ row.results.reduce((n,r) => n+r.score,0) }}</strong><p v-if="row.error">{{ row.error }}</p><NButton v-if="row.status === 'error'" :disabled="running" @click="attempt(() => start(row))">{{ t('grading.retry') }}</NButton></article></div>
      <div v-if="active" class="paper" data-theme-surface="card"><div class="actions"><NSwitch v-model:value="rough" />{{ t(rough ? 'grading.rough' : 'grading.printed') }}<NButton @click="attempt(save)">{{ t('grading.save') }}</NButton><NButton @click="attempt(() => exportOne('pdf'))">{{ t('grading.pdf') }}</NButton><NButton @click="attempt(() => exportOne('png'))">{{ t('grading.png') }}</NButton></div><NAlert v-if="active.status === 'review'" type="warning">{{ t('grading.review') }}</NAlert><GradingAnnotator v-model="annotations" :image="active.image" :rough="rough" /><div v-for="result in active.results" :key="result.qid" class="actions"><span>{{ result.qid }} / {{ result.fullMark }}</span><NInputNumber v-model:value="result.score" :min="0" :max="result.fullMark" /><NInput v-model:value="result.feedback" /></div><NButton v-if="active.results.length" @click="attempt(review)">{{ t('grading.confirmReview') }}</NButton></div>
    </section>
    <section v-if="summary?.total" class="report"><span v-for="key in ['average','max','min','passRate']" :key="key">{{ t(`grading.${key}`) }}: {{ Number(summary[key]).toFixed(2) }}</span><p>{{ t('grading.wrongRank') }}: {{ summary.wrongRank.map((q: any) => `${q.qid} (${q.wrongCount})`).join(', ') }}</p></section>
  </main>
</template>
<style scoped lang="scss">
/* Keep the grading workspace on the shared Studio theme. */
.grading-view {
  /* 主题色 */
  --hacker-bg: var(--theme-content-bg, var(--bg-primary));
  --hacker-bg-soft: var(--theme-input-bg, var(--bg-card));
  --hacker-card: var(--theme-card-bg, var(--bg-card));
  --hacker-border: var(--border-color);
  --hacker-border-strong: var(--accent-primary);
  --hacker-grid: rgba(var(--text-primary-rgb), 0.025);
  --hacker-text: var(--text-primary);
  --hacker-text-dim: var(--text-secondary);
  --hacker-text-mute: var(--text-muted);
  --hacker-accent: var(--accent-info);
  --hacker-warn: var(--warning);
  --hacker-err: var(--error);
  --hacker-mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', ui-monospace, monospace;

  padding: 24px;
  height: 100%;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
  position: relative;
  isolation: isolate;

  /* 双向网格背景：模拟 CRT 终端扫描线 + 矩阵方格 */
  background-color: var(--theme-content-bg, var(--bg-primary));
  background-image:
    /* 水平扫描线 */
    repeating-linear-gradient(0deg, transparent 0 3px, rgba(var(--success-rgb), 0.031) 3px 4px),

    linear-gradient(transparent calc(100% - 1px), var(--hacker-grid) 100%),
    linear-gradient(90deg, transparent calc(100% - 1px), var(--hacker-grid) 100%),

    linear-gradient(transparent calc(100% - 1px), rgba(var(--success-rgb), 0.145) 100%),
    linear-gradient(90deg, transparent calc(100% - 1px), rgba(var(--success-rgb), 0.145) 100%);
  background-size: 100% 100%, 32px 32px, 32px 32px, 128px 128px, 128px 128px;
  background-position: 0 0, 0 0, 0 0, 0 0, 0 0;
  color: var(--hacker-text);
  font-family: var(--hacker-mono);
  font-size: 13px;
  letter-spacing: 0.02em;

  /* 全局滚动条黑客化 */
  &::-webkit-scrollbar { width: 10px; height: 10px; }
  &::-webkit-scrollbar-track { background: var(--theme-content-bg, var(--bg-primary)); }
  &::-webkit-scrollbar-thumb { background: var(--border-color); }
  &::-webkit-scrollbar-thumb:hover { background: var(--hacker-border-strong); }

  /* 顶部 CRT 辉光 */
  &::before {
    content: '';
    position: absolute;
    inset: 0;
    background: radial-gradient(ellipse at top, rgba(var(--success-rgb), 0.063), transparent 60%);
    pointer-events: none;
    z-index: -1;
  }
}

.grading-view.is-embedded { padding: 16px; gap: 12px; }

/* ─── Header 终端状态栏 ─────────────────────────────────────────────── */
header {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
  padding: 10px 14px;
  background: linear-gradient(180deg, var(--theme-card-bg, var(--theme-card-bg, var(--bg-card))), var(--theme-card-bg, var(--theme-card-bg, var(--bg-card))));
  border: 1px solid var(--hacker-border);
  border-radius: 6px;
  position: relative;
  box-shadow: 0 0 18px rgba(var(--success-rgb), 0.063), inset 0 0 18px rgba(var(--success-rgb), 0.031);

  &::before {
    content: '● grading.terminal [OK]';
    position: absolute;
    top: -10px;
    left: 14px;
    background: var(--theme-content-bg, var(--bg-primary));
    color: var(--hacker-text);
    padding: 0 8px;
    font-size: 11px;
    font-family: var(--hacker-mono);
    text-shadow: 0 0 8px var(--hacker-text);
  }

  h2 {
    margin: 0;
    font-family: var(--hacker-mono);
    font-weight: 600;
    font-size: 16px;
    color: var(--hacker-text);
    text-shadow: 0 0 8px var(--hacker-text-dim);
    &::before { content: '> '; color: var(--hacker-text-dim); }
  }
}

/* ─── Actions 按钮组 ─────────────────────────────────────────────────── */
.actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

/* 覆盖 naive-ui 按钮的浅色默认 */
.grading-view :deep(.n-button) {
  font-family: var(--hacker-mono);
  font-weight: 500;
  letter-spacing: 0.03em;
  background: var(--theme-card-bg, var(--theme-card-bg, var(--bg-card))) !important;
  border: 1px solid var(--hacker-border) !important;
  color: var(--hacker-text) !important;
  box-shadow: 0 0 6px transparent;
  transition: all 0.18s ease;

  &:hover {
    border-color: var(--hacker-border-strong) !important;
    color: var(--hacker-text) !important;
    background: var(--theme-card-bg, var(--theme-card-bg, var(--bg-card))) !important;
    box-shadow: 0 0 12px var(--hacker-border);
    text-shadow: 0 0 6px var(--hacker-text);
  }

  &.n-button--primary-type {
    background: linear-gradient(180deg, rgba(var(--success-rgb), 0.133), rgba(var(--success-rgb), 0.067)) !important;
    border-color: var(--hacker-text) !important;
    color: var(--hacker-text) !important;
    text-shadow: 0 0 6px var(--hacker-text);
    &:hover { box-shadow: 0 0 18px var(--hacker-border-strong); }
  }
}

/* ─── Alert ──────────────────────────────────────────────────────────── */
.grading-view :deep(.n-alert) {
  font-family: var(--hacker-mono);
  border-radius: 4px;
  border: 1px solid currentColor;
  background: var(--theme-card-bg, var(--theme-card-bg, var(--bg-card))) !important;
}

/* ─── Rubric Input ──────────────────────────────────────────────────── */
.grading-view :deep(.n-input) {
  font-family: var(--hacker-mono);

  .n-input__input-el,
  .n-input__textarea-el {
    background: var(--theme-card-bg, var(--theme-card-bg, var(--bg-card))) !important;
    color: var(--hacker-text) !important;
    caret-color: var(--hacker-text);
    font-family: var(--hacker-mono);
  }
  .n-input__border,
  .n-input__state-border {
    border-color: var(--hacker-border) !important;
  }
  &:hover .n-input__border { border-color: var(--hacker-border-strong) !important; }
}

/* ─── Drop Zone ─────────────────────────────────────────────────────── */
.drop {
  border: 2px dashed var(--hacker-border);
  padding: 20px;
  border-radius: 6px;
  background:
    repeating-linear-gradient(45deg, transparent 0 8px, rgba(var(--success-rgb), 0.02) 8px 9px),
    var(--theme-card-bg, var(--theme-card-bg, var(--bg-card)));
  position: relative;
  transition: all 0.2s ease;

  p { margin: 0 0 8px; color: var(--hacker-text); }
  p:first-child::before { content: '> '; color: var(--hacker-text-dim); }
  p:first-child::after {
    content: '_';
    color: var(--hacker-text);
    animation: blink 1s steps(1) infinite;
    margin-left: 4px;
  }

  &:hover {
    border-color: var(--hacker-border-strong);
    box-shadow: 0 0 18px var(--hacker-border);
  }

  video {
    display: block;
    max-width: 480px;
    width: 100%;
    margin-top: 10px;
    border: 1px solid var(--hacker-border);
    border-radius: 4px;
  }
}

@keyframes blink {
  50% { opacity: 0; }
}

/* ─── Workspace (Queue + Paper) ────────────────────────────────────── */
.workspace {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: 16px;
}

/* Queue 侧栏 */
.queue {
  background: var(--theme-card-bg, var(--bg-card));
  border: 1px solid var(--hacker-border);
  border-radius: 6px;
  padding: 12px;
  min-height: 120px;
  max-height: 480px;
  overflow: auto;

  & > p {
    margin: 0;
    color: var(--hacker-text-mute);
    font-style: italic;
    &::before { content: '// '; }
  }

  article {
    padding: 10px 8px;
    border-bottom: 1px dashed var(--hacker-border);
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
    cursor: pointer;
    transition: background 0.15s ease, box-shadow 0.15s ease;
    border-radius: 4px;
    position: relative;

    &:hover { background: rgba(var(--success-rgb), 0.082); box-shadow: inset 2px 0 0 var(--hacker-text); }

    &.selected {
      background: linear-gradient(90deg, rgba(var(--success-rgb), 0.125), transparent);
      box-shadow: inset 2px 0 0 var(--hacker-text), 0 0 12px rgba(var(--success-rgb), 0.125);
      &::before {
        content: '▸';
        position: absolute;
        left: -4px;
        top: 50%;
        transform: translateY(-50%);
        color: var(--hacker-text);
        text-shadow: 0 0 8px var(--hacker-text);
      }
    }

    /* 状态 chip */
    span {
      font-size: 11px;
      padding: 1px 6px;
      border: 1px solid var(--hacker-border);
      border-radius: 3px;
      color: var(--hacker-text-dim);
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }

    strong {
      margin-inline-start: auto;
      color: var(--hacker-accent);
      text-shadow: 0 0 6px var(--hacker-accent);
      font-family: var(--hacker-mono);
    }

    p { margin: 0; flex-basis: 100%; color: var(--hacker-err); font-size: 11px; }
  }
}

/* Paper 主区 */
.paper {
  min-width: 0;
  background: var(--theme-card-bg, var(--bg-card));
  border: 1px solid var(--hacker-border);
  border-radius: 6px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  position: relative;

  &::before {
    content: '// scan.7cea8cf3.png  ·  cols 1|2|3';
    display: block;
    font-family: var(--hacker-mono);
    font-size: 11px;
    color: var(--hacker-text-mute);
    margin-bottom: 4px;
    letter-spacing: 0.1em;
  }
}

/* 题目反馈行 */
.paper .actions:has(.n-input-number),
.paper .actions:has(.n-input) {
  background: var(--theme-card-bg, var(--theme-card-bg, var(--bg-card)));
  border: 1px dashed var(--hacker-border);
  border-radius: 4px;
  padding: 8px;
}

/* ─── 报告面板 ─────────────────────────────────────────────────────── */
.report {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  padding: 10px 14px;
  background: var(--theme-card-bg, var(--theme-card-bg, var(--bg-card)));
  border: 1px solid var(--hacker-border);
  border-radius: 6px;
  font-family: var(--hacker-mono);

  span {
    color: var(--hacker-text-dim);
    &::before { content: '['; color: var(--hacker-text-mute); }
    &::after { content: ']'; color: var(--hacker-text-mute); }
  }

  p {
    flex-basis: 100%;
    margin: 4px 0 0;
    color: var(--hacker-text-dim);
    &::before { content: '// '; color: var(--hacker-text-mute); }
  }
}

/* ─── 22 条 badge 的 hover/分组渐变提示 ─────────────────────────────── */
/* 由于 badge 在 Konva 画布里以 annotation.color 渲染，CSS 不可直接作用。
   这里在画布外层覆一层 hover 高亮投影：当队列 active 时 paper 整块微亮 */
.paper {
  transition: box-shadow 0.2s ease;
}
.paper:has(article.selected),
.workspace:has(.selected) .paper {
  box-shadow: 0 0 24px rgba(var(--success-rgb), 0.125), inset 0 0 24px rgba(var(--success-rgb), 0.063);
}

/* ─── 响应式 ───────────────────────────────────────────────────────── */
@media (max-width: 800px) {
  .workspace { grid-template-columns: 1fr; }
}
</style>
