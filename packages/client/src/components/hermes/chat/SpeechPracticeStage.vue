<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NSelect, NSwitch, type SelectOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useOmniRealtime, type OmniDialogToolCall, type OmniUserTurnAudio } from '@/composables/useOmniRealtime'
import OmniVisualizer from '@/components/hermes/chat/OmniVisualizer.vue'
import MarkdownRenderer from '@/components/hermes/chat/MarkdownRenderer.vue'
import { meetingASRApi } from '@/utils/meeting-asr-api'
import { executeOmniTool, OMNI_REALTIME_TOOLS } from '@/api/studio/omni-tools'
import { fetchPracticeSkills } from '@/api/hermes/skills'
import {
  savePracticeReport,
  streamOmniPracticeAnalysis,
  type OmniAnalysisMediaMeta,
  type OmniAnalysisPayload,
} from '@/api/studio/practice-report'
import { getDownloadUrl } from '@/api/studio/download'
import { uid, useChatStore, type Message } from '@/stores/hermes/chat'
import { useMeetingStore } from '@/stores/hermes/meeting'
import { useRealtimeModelStore } from '@/stores/hermes/realtime-model'
import {
  buildRealtimeInstructions,
  serializeChatHistory,
  countUserTurns,
  CONTEXT_WARNING_RATIO,
} from '@/utils/realtime-instructions'
import {
  buildPracticeClosingReviewPrompt,
  buildPracticeFeedbackToolFor,
  buildSkillCriteriaMarkdown,
  defaultPracticeSkill,
  findPracticeSkillEntry,
  normalizePracticeSkill,
  isClosingUtteranceLike,
  type PracticeSkill,
  type PracticeSkillManifest,
} from '@/utils/practice-skill'
import {
  buildPracticeInstructionBlock,
  buildPracticeReportMarkdown,
  composePracticeReportWithOmniAnalysis,
  encodePcm16ToWavBase64,
  formatPracticeCountdown,
  pickPracticeReportFrames,
  practiceReportFileStem,
  trimPcm16Silence,
  PRACTICE_AUDIO_SEGMENT_MAX_COUNT,
  PRACTICE_DIFFICULTY_LABELS,
  PRACTICE_LANGUAGE_LABELS,
  type PracticeFeedbackRecord,
  type PracticeSessionConfig,
  type PracticeTurnRecord,
} from '@/utils/practice-mode'

/**
 * 口语对练舞台（Chat 侧全屏）。
 *
 * 复用与实时对话（OmniRealtimeStage）完全相同的 Omni-Realtime 音频链路
 * （/ws/omni-realtime → Qwen-Omni-Realtime），差异点：
 *   - 会话指令 = buildRealtimeInstructions(soul, { scenario: 对练守则 })，
 *     模型扮演目标语言口语教练，围绕用户填写的练习方向引导对话；
 *   - 工具集 = PRACTICE_REALTIME_TOOLS：既有工作台工具全部保留（含
 *     query_hermes_agent 的 Agent 能力），并追加 submit_practice_feedback——
 *     模型每轮用户发言后调用它提交结构化打分（1-10 分）；
 *   - 右侧评分卡实时展示「最新一轮打分」，历史轮次累积；
 *   - 结束后可把「逐轮评分 + 点评 + 完整对话」保存为 Markdown 分析报告
 *     （服务端落盘 + 下载链接），分析内容不再只留在会话里。
 */

const props = defineProps<{
  /** 与会议实时对话一致：未配置 DashScope Key 时提示先去配置。 */
  hasDashscopeKey: boolean
  /** 新建对话抽屉里手动填写的练习配置（语言 / 方向 / 难度）。 */
  config: PracticeSessionConfig
}>()

const emit = defineEmits<{
  close: []
}>()

const { t } = useI18n()

const chatStore = useChatStore()
const meetingStore = useMeetingStore()
const realtimeModelStore = useRealtimeModelStore()

// Tina is verified with the default qwen3.8 model. Other voices remain
// selectable for model-specific configurations.
const voiceOptions: SelectOption[] = [
  { label: 'Tina (女声 · 中文 · 默认)', value: 'Tina' },
  { label: 'Serena (女声 · 中文)', value: 'Serena' },
  { label: 'Jennifer (女声 · 中文)', value: 'Jennifer' },
  { label: 'Ryan (男声 · 中文)', value: 'Ryan' },
]
const selectedVoice = ref('Tina')
selectedVoice.value = realtimeModelStore.config.voice || 'Tina'
/** 用户是否在本场手动改过音色（true 后技能建议音色不再覆盖）。 */
const userVoicePicked = ref(false)

const languageLabel = computed(() =>
  PRACTICE_LANGUAGE_LABELS[props.config.language] || props.config.language,
)
const difficultyLabel = computed(() =>
  PRACTICE_DIFFICULTY_LABELS[props.config.difficulty] || props.config.difficulty,
)

// --- 练习技能（跨场景）：config.skillRef 指向已安装的 SKILL.md 技能 ----------
// 解析结果驱动：connect 的教练人格/守则、submit_practice_feedback 工具 schema、
// 收尾总评指令与报告「技能与评价标准」。解析失败/无引用 → 通用口语教练。

/** 按技能生成工具集：工作台工具（可按技能收窄）+ 动态 submit_practice_feedback。 */
type OmniToolEntry = Record<string, unknown> | {
  type: 'function'
  name: string
  description: string
  parameters: unknown
}
function buildSessionTools(skill: PracticeSkill, cameraOn: boolean): OmniToolEntry[] {
  const workspace: OmniToolEntry[] = skill.workspaceTools && skill.workspaceTools.length > 0
    ? OMNI_REALTIME_TOOLS.filter(tool => (skill.workspaceTools as readonly string[]).includes(tool.name))
    : OMNI_REALTIME_TOOLS
  return [
    ...workspace,
    buildPracticeFeedbackToolFor(skill, { camera: cameraOn }) as unknown as Record<string, unknown>,
  ]
}

const activeSkill = ref<PracticeSkill>(defaultPracticeSkill())
const skillNotice = computed(() => {
  const skill = activeSkill.value
  if (skill.kind !== 'skill') return ''
  return skill.displayName
})
let practiceSkillResolvePromise: Promise<void> | null = null
async function resolvePracticeSkill(): Promise<void> {
  const skillRef = props.config.skillRef
  if (!skillRef) return
  try {
    const items = await fetchPracticeSkills()
    const entry = findPracticeSkillEntry(
      items.map(item => ({
        category: item.category,
        name: item.name,
        description: item.description,
        enabled: item.enabled,
        source: item.source,
        manifest: item.manifest ? (item.manifest as unknown as PracticeSkillManifest) : null,
      })),
      skillRef,
    )
    if (!entry) return // 技能已被删除/停用 → 回退通用教练
    activeSkill.value = normalizePracticeSkill(
      { kind: 'skill', category: entry.category, name: entry.name, description: entry.description },
      entry.manifest,
      '',
    )
    // 技能建议音色：仅当用户本场尚未手动改过音色时应用
    const suggested = activeSkill.value.voice
    if (suggested && !userVoicePicked && voiceOptions.some(option => option.value === suggested)) {
      selectedVoice.value = suggested
    }
  } catch {
    // 拉取失败 → 默认技能（练习本身不阻塞）
  }
}
function ensurePracticeSkill(): Promise<void> {
  if (!props.config.skillRef) return Promise.resolve()
  if (!practiceSkillResolvePromise) practiceSkillResolvePromise = resolvePracticeSkill()
  return practiceSkillResolvePromise
}

const omni = useOmniRealtime({
  handsFree: true,
  autoBargeIn: true,
  tools: buildSessionTools(defaultPracticeSkill(), false),
  onToolCall: handlePracticeTool,
  onError: () => undefined,
  onUserTurnAudio: handleUserTurnAudio,
})

const phase = omni.phase
const isActive = computed(() => phase.value !== 'idle' && phase.value !== 'closed')
const canStart = computed(() => props.hasDashscopeKey && !isActive.value && !ended.value)

const preparing = ref(false)
const backendError = ref('')

// --- 摄像头（可选）：开启后模型「看得到」用户，评分维度会加入肢体语言 ---

const cameraEnabled = ref(false)
/** 本次会话是否开启过摄像头（素材证据行 / 报告来源说明用）。 */
const cameraWasOn = ref(false)
const cameraStream = ref<MediaStream | null>(null)
const videoRef = ref<HTMLVideoElement | null>(null)
const cameraNotice = ref('')
const FRAME_INTERVAL_MS = 1000
const MAX_FRAME_DIM = 640
let captureTimer: number | null = null
let framesCaptured = 0
/**
 * 舞台已卸载（用户在授权弹窗还开着时就返回/关闭）。
 * getUserMedia 的 await 可能在卸载之后才 resolve，那时 stopCamera() 早就跑完了，
 * 流会挂在页面外继续亮着摄像头灯，而且后续还会去 connect 一个没人看的会话。
 */
let stageDisposed = false

/** 摄像头约束档位：先要前置 720p，被驱动拒绝时退到「随便给个视频轨」。 */
const CAMERA_CONSTRAINTS: MediaStreamConstraints[] = [
  { video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
  { video: true, audio: false },
]

/** 约束类错误（分辨率/朝向不支持）才值得降级重试；权限拒绝重试也没用。 */
function isConstraintError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name || ''
  return name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError' || name === 'NotFoundError'
}

async function startCamera(): Promise<void> {
  if (cameraStream.value || typeof navigator.mediaDevices?.getUserMedia !== 'function') return
  let lastError: unknown = null
  for (const [index, constraints] of CAMERA_CONSTRAINTS.entries()) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      if (stageDisposed) {
        // 授权在卸载之后才回来：立刻关掉，别让摄像头灯留在亮着的状态
        stream.getTracks().forEach(track => track.stop())
        return
      }
      cameraStream.value = stream
      // 流建立后 <video> 可能刚挂载（预览在 <main> 顶层，v-if 随流出现），
      // 等 DOM 渲染完再绑一次 srcObject，作为 watch(cameraStream) 的兜底。
      await bindCameraPreview()
      return
    } catch (error) {
      lastError = error
      const hasFallback = index < CAMERA_CONSTRAINTS.length - 1
      if (!hasFallback || !isConstraintError(error)) break
      // 约束不被支持：继续下一档，音频对练不受影响
    }
  }
  void lastError
  if (stageDisposed) return
  cameraNotice.value = t('omniRealtime.cameraFailed')
  cameraEnabled.value = false
  setTimeout(() => { cameraNotice.value = '' }, 4000)
}

/** 把当前摄像头流绑到预览 <video>（若已绑定则跳过）。 */
async function bindCameraPreview(): Promise<void> {
  await nextTick()
  const el = videoRef.value
  if (el && cameraStream.value && el.srcObject !== cameraStream.value) {
    el.srcObject = cameraStream.value
  }
}

function stopCamera(): void {
  cameraStream.value?.getTracks().forEach(track => track.stop())
  cameraStream.value = null
}

function captureAndSendFrame(): void {
  const video = videoRef.value
  if (!video || !cameraStream.value) return
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) return
  const scale = Math.min(1, MAX_FRAME_DIM / Math.max(video.videoWidth, video.videoHeight))
  const width = Math.max(1, Math.round(video.videoWidth * scale))
  const height = Math.max(1, Math.round(video.videoHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.translate(width, 0)
  ctx.scale(-1, 1)
  ctx.drawImage(video, 0, 0, width, height)
  try {
    framesCaptured += 1
    if (framesCaptured === 1) {
      console.log(`[speech-practice] camera capture started (${width}x${height})`)
    }
    const dataUrl = canvas.toDataURL('image/jpeg', 0.6)
    omni.sendImage(dataUrl)
    // 保留画面帧供结束后的 AI 全模态分析（抽样收集，最多保留 24 张；
    // 发送时每 5 秒取一帧，避免把 1fps 全量帧都攒下来）。
    if (framesCaptured % 5 === 1 || reportFrames.value.length === 0) {
      const kept = [...reportFrames.value, dataUrl]
      reportFrames.value = kept.length > MAX_REPORT_FRAMES_KEPT ? kept.slice(-MAX_REPORT_FRAMES_KEPT) : kept
    }
  } catch {
    // canvas tainted or toDataURL unavailable — keep the voice session going
  }
}

function startFrameCapture(): void {
  stopFrameCapture()
  captureTimer = window.setInterval(captureAndSendFrame, FRAME_INTERVAL_MS)
}

function stopFrameCapture(): void {
  if (captureTimer !== null) {
    window.clearInterval(captureTimer)
    captureTimer = null
  }
}

// --- 素材收集：用户每轮语音录音 + 摄像头帧（供结束后的 AI 全模态分析） -----
// 录音来自 useOmniRealtime 的 onUserTurnAudio（服务端 VAD 打开用户轮次时
// 采集的 16 kHz PCM16）。只存在内存里、随舞台关闭丢弃；报告保存时才随请求
// 上传。帧在 captureAndSendFrame 里抽样收集（同上）。

interface PracticeAudioSegment {
  index: number
  text: string
  wavBase64: string
}

const audioSegments = ref<PracticeAudioSegment[]>([])
/** 保留的原始帧上限（发送给 Omni 前会再均匀抽到 6 张）。 */
const MAX_REPORT_FRAMES_KEPT = 24
const reportFrames = ref<string[]>([])

/** 每轮用户发言结束后：裁静音 → WAV base64 → 缓存（保留最近 N 段）。 */
function handleUserTurnAudio(segment: OmniUserTurnAudio): void {
  const trimmed = trimPcm16Silence(segment.pcm16, { sampleRate: 16000 })
  if (trimmed.length === 0) return
  const wavBase64 = encodePcm16ToWavBase64(trimmed, 16000)
  const next = [
    ...audioSegments.value,
    { index: segment.index, text: segment.text.slice(0, 600), wavBase64 },
  ]
  audioSegments.value = next.length > PRACTICE_AUDIO_SEGMENT_MAX_COUNT
    ? next.slice(-PRACTICE_AUDIO_SEGMENT_MAX_COUNT)
    : next
}

function resetCollectedMedia(): void {
  audioSegments.value = []
  reportFrames.value = []
}

/** 会话已结束（disconnect 完成），展示总结 / 报告面板。 */
const ended = ref(false)
/** 倒计时到点后的优雅收尾进行中：先等当前音频播完再断开，避免句子被掐断。 */
const ending = ref(false)
const sessionStartedAt = ref(0)
const sessionEndedAt = ref(0)

// --- 练习时长 / 倒计时（定时练习：到点自动结束并生成报告） ----------------

/** 配置的练习时长（毫秒）；0 = 不限时。 */
const durationTotalMs = computed(() => {
  const minutes = Number(props.config.durationMinutes) || 0
  return minutes > 0 ? minutes * 60_000 : 0
})
/** 剩余毫秒（仅在定时练习且会话进行中持续更新）。 */
const timeLeftMs = ref(0)
/** 本次会话是被倒计时自动结束的（结束时自动保存报告）。 */
const autoFinished = ref(false)
const countdownActive = computed(() => durationTotalMs.value > 0 && isActive.value && !ended.value && !ending.value)
const countdownText = computed(() => formatPracticeCountdown(timeLeftMs.value))
const countdownWarning = computed(() => countdownActive.value && timeLeftMs.value <= 60_000)

let countdownHandle: number | null = null
let countdownDeadline = 0

function stopCountdown(): void {
  if (countdownHandle !== null) {
    window.clearTimeout(countdownHandle)
    countdownHandle = null
  }
}

function startCountdown(): void {
  stopCountdown()
  if (durationTotalMs.value <= 0) {
    timeLeftMs.value = 0
    return
  }
  countdownDeadline = Date.now() + durationTotalMs.value
  const tick = (): void => {
    const left = countdownDeadline - Date.now()
    timeLeftMs.value = Math.max(0, left)
    if (left <= 0) {
      stopCountdown()
      autoFinishByTimer()
      return
    }
    countdownHandle = window.setTimeout(tick, 250)
  }
  tick()
}

/** 模型经 submit_practice_feedback 提交的逐轮评分（过程数据，报告来源）。 */
const feedbacks = ref<PracticeFeedbackRecord[]>([])
const latestFeedback = computed(() => {
  const list = feedbacks.value
  return list.length > 0 ? list[list.length - 1] : null
})

// --- 会话标题 / 上下文告警 ------------------------------------------------

const sessionTitle = computed(() => {
  const sessionTitleText = chatStore.activeSession?.title?.trim()
  if (sessionTitleText) return sessionTitleText
  const direction = (props.config.direction || '').trim()
  return direction ? `${t('speechPractice.entry')} · ${direction}` : t('speechPractice.entry')
})

const usedUserTurns = computed(() => countUserTurns(omni.turns.value))
const contextLimitTotal = computed(() => realtimeModelStore.limits?.audioTurns ?? null)
const nearContextLimit = computed(() => {
  const total = contextLimitTotal.value
  if (!total) return false
  return usedUserTurns.value >= Math.floor(total * CONTEXT_WARNING_RATIO)
})

const statusLabel = computed(() => t(`meeting.realtime.phase.${phase.value}`))

const orbPhase = computed(() => {
  switch (phase.value) {
    case 'connecting': return 'connecting'
    case 'listening': return 'listening'
    case 'speaking': return 'speaking'
    case 'error': return 'error'
    default: return 'idle'
  }
})

// --- 气泡层（与 OmniRealtimeStage 相同，最近几条 + live 文本） -----------

interface StageBubble {
  key: string
  role: 'user' | 'assistant'
  text: string
  live: boolean
}

const bubbles = computed<StageBubble[]>(() => {
  const turns = [...omni.turns.value]
  const liveAssistant = omni.liveAssistantText.value.trim()
  if (liveAssistant) {
    const last = turns[turns.length - 1]
    if (last && last.role === 'assistant' && last.text.trim() === liveAssistant) {
      turns.pop()
    }
  }
  const list: StageBubble[] = turns.slice(-3).map(turn => ({
    key: `${turn.role}:${turn.timestamp}`,
    role: turn.role,
    text: turn.text,
    live: false,
  }))
  if (omni.liveUserText.value) {
    list.push({ key: 'live-user', role: 'user', text: omni.liveUserText.value, live: true })
  }
  if (liveAssistant) {
    list.push({ key: 'live-assistant', role: 'assistant', text: liveAssistant, live: true })
  }
  return list.slice(-4)
})

const caption = computed(() => {
  if (reviewingEnd.value) return t('speechPractice.reviewingEnd')
  if (backendError.value) return backendError.value
  if (displayError.value) return displayError.value
  if (omni.isOutputPlaying.value) return ''
  if (phase.value === 'speaking') return ''
  if (phase.value === 'idle' || phase.value === 'closed') return t('speechPractice.liveHint')
  return t('speechPractice.handsFreeHint')
})

const displayError = computed(() => {
  const raw = omni.errorMessage.value
  if (!raw) return ''
  if (/realtime session error/i.test(raw)) return t('omniRealtime.sessionError')
  return raw
})

// --- 对话气泡滚动（对练舞台）：内容超高时可滚动，且新内容到来时贴底 ------
// 舞台左栏（.practice-stage__stage）在窄高 / 小屏 Linux 显示上会装不下
// 「视觉球 + 气泡 + 提示 + 控件」，此前整栏 overflow:hidden，最新气泡被裁在
// 视口外且无法滚动。现在左栏纵向可滚；用户停在底部时新气泡自动把它推到
// 最底（最新可见），用户上翻历史时则保持不动。

const stageScrollRef = ref<HTMLElement | null>(null)
const bubbleListRef = ref<HTMLElement | null>(null)
let stickStageBottom = true

function handleStageScroll(): void {
  const el = stageScrollRef.value
  if (!el) return
  stickStageBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 28
}

/** 新气泡 / live 文本更新后把滚动容器钉到最底（仅当用户本来就在底部）。 */
function scrollLiveToLatest(): void {
  void nextTick(() => {
    if (bubbleListRef.value) {
      bubbleListRef.value.scrollTop = bubbleListRef.value.scrollHeight
    }
    const el = stageScrollRef.value
    if (el && stickStageBottom) {
      el.scrollTop = el.scrollHeight
    }
  })
}

watch(
  () => bubbles.value.map(b => `${b.key}:${b.text}`).join('|'),
  () => scrollLiveToLatest(),
)

// --- 工具执行：对练评分工具本地处理，其余工具保留原 Agent 能力 ----------

const PRACTICE_TOOL_NAME = 'submit_practice_feedback'

function toScore(value: unknown): number | null {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(1, Math.min(10, Math.round(n)))
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 600) : ''
}

/** 收尾总评的 Markdown（整段报告级文本，长度上限比逐轮点评宽得多）。 */
function cleanMarkdown(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 20_000) : ''
}

function recordPracticeFeedback(args: Record<string, unknown>): string {
  // 归属到「当前正在被点评」的用户轮次：工具调用通常紧随该轮 user 转写提交，
  // 以此刻已提交的 user 轮次数作为轮次号（从 1 起）；无 user 轮次时记 0（不归属）。
  // 例外：收尾总评的指令要求模型显式传 round=0（整场评分），此时尊重模型的
  // 声明，否则整场总评会被算到最后一轮头上、把那轮的逐轮点评顶掉。
  const explicitRound = Number(args.round)
  const isSessionReview = Number.isFinite(explicitRound) && explicitRound === 0
  const userTurnCount = omni.turns.value.filter(turn => turn.role === 'user').length
  const round = isSessionReview ? 0 : userTurnCount

  const record: PracticeFeedbackRecord = {
    round,
    overall: toScore(args.overall) ?? 0,
    fluency: toScore(args.fluency),
    pronunciation: toScore(args.pronunciation),
    grammar: toScore(args.grammar),
    vocabulary: toScore(args.vocabulary),
    content: toScore(args.content),
    // 只有真的抓到过画面帧才接受 bodyLanguage：摄像头开关打开但授权失败、
    // 或 <video> 一直没就绪时一帧都没发出去，模型「看不到却打分」属于编造。
    bodyLanguage: framesCaptured > 0 ? toScore(args.bodyLanguage) : null,
    comment: cleanText(args.comment),
    strengths: cleanText(args.strengths),
    improvements: cleanText(args.improvements),
    example: cleanText(args.example),
    at: Date.now(),
  }
  // 技能自定义维度：按技能 dimensions 把数值写入记录顶层（id 即键），
  // 报告表格/聚合/评分卡统一按 id 读取；语言类技能与上方固定字段一致。
  const recordWithDims = record as PracticeFeedbackRecord & Record<string, unknown>
  const skill = activeSkill.value
  for (const dim of skill.evaluation.dims) {
    recordWithDims[dim.id] = toScore(args[dim.id])
  }
  // 同一轮重复提交 = 模型自我修正（先给了草稿分又改口），覆盖而不是追加：
  // 否则评分卡会出现两条同轮记录，报告里也会重复计分。
  const sameRoundAt = feedbacks.value.findIndex(item => item.round === round)
  if (sameRoundAt >= 0) {
    const next = [...feedbacks.value]
    next[sameRoundAt] = recordWithDims
    feedbacks.value = next
  } else {
    feedbacks.value = [...feedbacks.value, recordWithDims]
  }

  // 收尾总评可以顺带把整场书面总评写进 reportMarkdown：拿到它就不用再花
  // 一次离线 Omni 深度分析（同一份素材、同一个模型，已经在会话里评过了）。
  const review = cleanMarkdown(args.reportMarkdown)
  if (review) closingReviewMarkdown.value = review

  const scored = record.overall > 0
  const when = round > 0 ? t('speechPractice.scoredRound', { n: round }) : t('speechPractice.scoredUnattached')
  return `${when}，${scored ? t('speechPractice.scoredOverall', { score: record.overall }) : t('speechPractice.scoredNoOverall')}`
}

async function handlePracticeTool(name: string, argsJson: string): Promise<string> {
  if (name !== PRACTICE_TOOL_NAME) {
    // 保留既有 Agent 能力：记忆 / 技能 / 会话 / 任务 / query_hermes_agent 等
    return executeOmniTool(name, argsJson)
  }
  let args: Record<string, unknown> = {}
  try {
    const parsed: unknown = argsJson ? JSON.parse(argsJson) : {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>
    }
  } catch {
    return JSON.stringify({ error: '无效的工具参数 JSON' })
  }
  try {
    return recordPracticeFeedback(args)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return JSON.stringify({ error: message })
  }
}

// 最新一次工具调用的 inline 提示（正在评分 / 已完成）
const latestToolCall = computed<OmniDialogToolCall | null>(() => {
  const list = omni.toolCalls.value
  return list.length > 0 ? list[list.length - 1] : null
})

const toolPillText = computed(() => {
  const call = latestToolCall.value
  if (!call) return ''
  const isScoring = call.name === PRACTICE_TOOL_NAME
  if (call.status === 'running') {
    return isScoring
      ? t('speechPractice.scoringRunning')
      : t('omniRealtime.toolRunningInline', { tool: call.name })
  }
  if (call.status === 'error') {
    return isScoring
      ? t('speechPractice.scoringFailed')
      : t('omniRealtime.toolFailedInline', { tool: call.name })
  }
  if (isScoring) return t('speechPractice.scoringDone')
  const snippet = (call.output || '').trim().replace(/\s+/g, ' ').slice(0, 120)
  return snippet ? `${t('omniRealtime.toolCompletedInline', { tool: call.name })} · ${snippet}` : t('omniRealtime.toolCompletedInline', { tool: call.name })
})

// --- 会话建立 / 结束 -------------------------------------------------------

async function ensureBackendAvailable(timeoutMs = 30_000): Promise<boolean> {
  try {
    const status = await meetingASRApi.getStatus()
    if (status.isRunning) return true
    await meetingASRApi.start({
      dashscopeApiKey: meetingStore.asrConfig.dashscopeApiKey || realtimeModelStore.config.apiKey || undefined,
    })
  } catch {
    // fall through to polling — status/start failures are surfaced below
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 800))
    try {
      const status = await meetingASRApi.getStatus()
      if (status.isRunning) return true
    } catch {
      // keep polling until the deadline
    }
  }
  return false
}

function buildHistoryContext(): string {
  const session = chatStore.activeSession
  if (!session?.messages?.length) return ''
  return serializeChatHistory(session.messages)
}

/**
 * 摄像头授权是 startSession 里最慢的一步（慢设备上要好几秒）。用户可能在
 * 弹窗还开着时就退出舞台，此时不能再往下 connect —— 会开一个没人看的实时
 * 会话并持续计费。所有 await 之后都要过一次这个闸门。
 */
async function connectWithCoachPersona(): Promise<boolean> {
  // 不注入用户 Agent 的 SOUL.md——工作台助理人格与「目标语言口语教练」
  // 人格直接冲突（中文回复 vs 全程目标语言、助理行为 vs 陪练行为）。对练
  // 用练习技能（默认=通用教练人格）作为 soul 位输入，工具守则/历史摘要/
  // 对练守则照常叠加。
  const ready = await ensureBackendAvailable()
  if (!ready) {
    backendError.value = t('omniRealtime.backendUnavailable')
    return false
  }
  if (stageDisposed) return false
  // 技能解析（异步拉取已安装技能契约；无引用时立即返回，用默认技能）。
  await ensurePracticeSkill()
  const skill = activeSkill.value
  // 摄像头在连接前打开，模型从第一轮起就能看到用户画面
  if (cameraEnabled.value) await startCamera()
  if (stageDisposed) {
    stopCamera()
    return false
  }
  // 按技能生成工具集（工作台子集 + 动态评分工具），连接前注入同一份。
  omni.setTools(buildSessionTools(skill, cameraEnabled.value))
  await omni.connect({
    voice: selectedVoice.value,
    model: realtimeModelStore.config.model || undefined,
    instructions: buildRealtimeInstructions(skill.coachSoul, {
      history: buildHistoryContext(),
      scenario: buildPracticeInstructionBlock(props.config, {
        cameraOn: cameraEnabled.value,
        skill,
      }),
    }),
  })
  // 音频流已开始推流后（DashScope 要求先有音频再补图像），启动取帧
  if (cameraStream.value) startFrameCapture()
  return true
}

async function startSession(): Promise<void> {
  if (!canStart.value || preparing.value) return
  // 用户手势内预建播放 AudioContext：ws.onopen 时后端可能仍在启动，浏览器
  // 自动播放策略会拒绝在非手势回调里恢复音频 → AI 无声。见
  // useOmniRealtime.prearmPlayback。
  void omni.prearmPlayback()
  writtenTurnIds.clear()
  writtenToolCallIds.clear()
  backendError.value = ''
  ended.value = false
  autoFinished.value = false
  feedbacks.value = []
  resetCollectedMedia()
  aiSection.value = ''
  closingReviewMarkdown.value = ''
  analysisState.value = 'idle'
  preparing.value = true
  try {
    const ok = await connectWithCoachPersona()
    if (ok) {
      sessionStartedAt.value = Date.now()
      startCountdown()
    }
  } finally {
    preparing.value = false
  }
}

async function resumeSession(): Promise<void> {
  if (phase.value !== 'error' || preparing.value || ended.value) return
  void omni.prearmPlayback()
  backendError.value = ''
  preparing.value = true
  try {
    await connectWithCoachPersona()
  } finally {
    preparing.value = false
  }
}

/** 倒计时到点：先排空当前语音 → 同会话收尾总评 → 断开并自动生成报告。 */
function autoFinishByTimer(): void {
  if (ended.value || ending.value) return
  autoFinished.value = true
  void endSessionWithReview()
}

/** 收尾总评进行中（结束面板/按钮给出状态文案）。 */
const reviewingEnd = ref(false)

/**
 * 同会话收尾总评：不另开离线窗口，而是经 useOmniRealtime.askText() 把收尾
 * 指令注入同一个实时 WebSocket——模型基于本场已听到的语音/看到的画面直接
 * 口头总评（转写进入会话与报告），再提交整场评分。失败静默（离线报告兜底）。
 * 触发条件：技能 reviewOnEnd、连接存活、用户说过话、末句不是口头收尾语。
 */
async function maybeClosingReview(): Promise<void> {
  const skill = activeSkill.value
  if (ended.value || !skill.reviewOnEnd) return
  if (phase.value !== 'ready' && phase.value !== 'listening' && phase.value !== 'speaking') return
  if (!omni.turns.value.some(turn => turn.role === 'user')) return
  const lastUser = [...omni.turns.value].reverse().find(turn => turn.role === 'user')
  if (lastUser && isClosingUtteranceLike(lastUser.text)) return
  reviewingEnd.value = true
  try {
    await omni.askText(buildPracticeClosingReviewPrompt(skill), { timeoutMs: 90_000 })
  } catch {
    // 收尾总评失败/超时不阻塞离线报告生成
  } finally {
    reviewingEnd.value = false
  }
}

/**
 * 结束会话公共流程：停止推流并等当前句子放完 →（按技能）同会话收尾总评 →
 * finalizeSession()（断开并自动生成报告）。
 */
async function endSessionWithReview(): Promise<void> {
  if (ended.value || ending.value) return
  ending.value = true
  stopCountdown()
  timeLeftMs.value = 0
  try {
    await omni.drainOutput(6000)
    await maybeClosingReview()
  } finally {
    ending.value = false
  }
  finalizeSession()
}

/** 立即结束（手动点「结束对练」）：连接存活时先做同会话收尾总评再断开。 */
function endSession(): void {
  if (ended.value || ending.value) return
  if (phase.value === 'idle' || phase.value === 'closed' || phase.value === 'error') {
    finalizeSession()
    return
  }
  void endSessionWithReview()
}

/** 结束会话的公共收尾：标记 ended、停计时/取帧/摄像头、断开并持久化，
 *  然后自动进入「生成报告 → 渲染 md 看板 → 落盘 → 聊天会话出现下载按钮」。 */
function finalizeSession(): void {
  if (ended.value) return
  ended.value = true
  sessionEndedAt.value = Date.now()
  stopCountdown()
  timeLeftMs.value = 0
  stopFrameCapture()
  stopCamera()
  omni.disconnect()
  flushPendingPersistence()
  void runEndReportFlow()
}

function handleClose(): void {
  if (isActive.value || ending.value) {
    // 返回键在会话中 = 结束对练（优雅收尾进行中时直接截断离开）。
    finalizeSession()
    return
  }
  stopEverything()
  emit('close')
}

function stopEverything(): void {
  stopCountdown()
  stopFrameCapture()
  stopCamera()
  flushPendingPersistence()
  omni.disconnect()
}

function toggleMute(): void {
  omni.setMicStreaming(!omni.isPushing.value)
}
const isMuted = computed(() => !omni.isPushing.value && isActive.value)

// 摄像头预览流绑定到 <video>（flush post：等 v-if 挂载完成）。
// bindCameraPreview 会再兜底一次，覆盖「流先到、元素后挂载」的时序。
watch(cameraStream, async (stream) => {
  if (stream) {
    cameraWasOn.value = true
    await bindCameraPreview()
  } else {
    const el = videoRef.value
    if (el) el.srcObject = null
  }
}, { flush: 'post' })

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') handleClose()
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
  // 恢复历史会话时按 skillRef 解析练习技能（失败自动回退通用教练）
  void ensurePracticeSkill()
})

onBeforeUnmount(() => {
  // 先置位再停：还在 await 的 getUserMedia / connect 靠这个标志自行放弃
  stageDisposed = true
  window.removeEventListener('keydown', handleKeydown)
  stopEverything()
})

// --- 逐轮 / 工具调用持久化到当前 chat 会话（与 OmniRealtimeStage 同款） ---

function turnToMessage(turn: { role: 'user' | 'assistant'; text: string; timestamp: number }): Message {
  return {
    id: uid(),
    role: turn.role === 'user' ? 'user' : 'assistant',
    content: turn.text,
    timestamp: turn.timestamp,
  }
}

function toolCallToMessage(call: OmniDialogToolCall): Message {
  const startedAt = call.startedAt
  const finishedAt = call.finishedAt || Date.now()
  const durationMs = Math.max(0, finishedAt - startedAt)
  let preview = ''
  try {
    const parsed = JSON.parse(call.argsJson || '{}') as Record<string, unknown>
    preview = JSON.stringify(parsed).slice(0, 220)
  } catch {
    preview = (call.argsJson || '').slice(0, 220)
  }
  const resultSnippet = (call.output || '').slice(0, 280)
  return {
    id: uid(),
    role: 'tool',
    content: '',
    timestamp: startedAt,
    toolName: call.name,
    toolCallId: call.callId,
    toolArgs: safeParseJson(call.argsJson),
    toolResult: resultSnippet,
    toolPreview: preview,
    toolStatus: call.status,
    toolDuration: Math.round((durationMs / 1000) * 10) / 10,
  }
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function persistMessage(message: Message): void {
  const sessionId = chatStore.activeSessionId
  if (!sessionId) return
  const session = chatStore.sessions.find(s => s.id === sessionId)
  if (!session) return
  if (session.messages.some(existing => existing.id === message.id)) return
  chatStore.addMessage(sessionId, message)
  session.updatedAt = Date.now()
}

function touchSession(): void {
  const sessionId = chatStore.activeSessionId
  if (!sessionId) return
  const session = chatStore.sessions.find(s => s.id === sessionId)
  if (session) session.updatedAt = Date.now()
}

const writtenTurnIds = new Set<string>()
const writtenToolCallIds = new Set<string>()

watch(() => omni.turns.value, (turns) => {
  if (!chatStore.activeSessionId) return
  for (const turn of turns) {
    const key = `${turn.role}:${turn.timestamp}:${turn.text}`
    if (writtenTurnIds.has(key)) continue
    writtenTurnIds.add(key)
    persistMessage(turnToMessage(turn))
  }
}, { deep: true })

watch(() => omni.toolCalls.value, (calls) => {
  if (!chatStore.activeSessionId) return
  for (const call of calls) {
    if (call.status === 'running') {
      if (writtenToolCallIds.has(call.callId)) continue
      writtenToolCallIds.add(call.callId)
      persistMessage(toolCallToMessage(call))
    } else if (!writtenToolCallIds.has(call.callId + ':done')) {
      writtenToolCallIds.add(call.callId + ':done')
      persistMessage(toolCallToMessage(call))
    } else {
      touchSession()
    }
  }
}, { deep: true })

function flushPendingPersistence(): void {
  if (!chatStore.activeSessionId) return
  for (const turn of omni.turns.value) {
    const key = `${turn.role}:${turn.timestamp}:${turn.text}`
    if (writtenTurnIds.has(key)) continue
    writtenTurnIds.add(key)
    persistMessage(turnToMessage(turn))
  }
  for (const call of omni.toolCalls.value) {
    const flag = call.status === 'running' ? '' : ':done'
    if (writtenToolCallIds.has(call.callId + flag)) continue
    writtenToolCallIds.add(call.callId + flag)
    persistMessage(toolCallToMessage(call))
  }
}

// --- 评分维度（live 评分卡 / 报告共用；技能可自定义维度与量表） ------------

/** 通用教练的五个细分维度（不含 overall）。 */
const detailDimKeys = ['fluency', 'pronunciation', 'grammar', 'vocabulary', 'content'] as const

/** 评分卡逐条展示的维度：默认五维；下载技能按技能 evaluation.dimensions。 */
const displayDimKeys = computed<string[]>(() =>
  activeSkill.value.kind === 'skill' && activeSkill.value.evaluation.dims.length > 0
    ? activeSkill.value.evaluation.dims.map(dim => dim.id)
    : [...detailDimKeys],
)
const scoreScaleMax = computed(() => activeSkill.value.evaluation.scale.max)

/** 维度显示名：技能 labels 覆盖优先，否则 i18n 默认名。 */
function dimLabel(key: string): string {
  const skill = activeSkill.value
  if (skill.kind === 'skill' && skill.labels[key]) return skill.labels[key]!
  return dimensionLabel(key)
}

function dimensionLabel(key: string): string {
  const map: Record<string, string> = {
    overall: t('speechPractice.score.overall'),
    fluency: t('speechPractice.score.fluency'),
    pronunciation: t('speechPractice.score.pronunciation'),
    grammar: t('speechPractice.score.grammar'),
    vocabulary: t('speechPractice.score.vocabulary'),
    content: t('speechPractice.score.content'),
    bodyLanguage: t('speechPractice.score.bodyLanguage'),
  }
  return map[key] || key
}

/** 从反馈记录里读取某维度分数（顶层按维度 id 存放，兼容技能自定义 id）。 */
function feedbackDimValue(record: PracticeFeedbackRecord | null, key: string): number | null {
  if (!record) return null
  const value = (record as unknown as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function scoreTone(score: number | null | undefined, scaleMax = 10): string {
  if (score == null || score <= 0) return 'none'
  const max = scaleMax > 0 ? scaleMax : 10
  if (score >= max * 0.8) return 'good'
  if (score >= max * 0.6) return 'ok'
  return 'weak'
}

function fmtScore(value: number | null | undefined): string {
  return value && value > 0 ? String(value) : '—'
}

// 对话轮次数（用于统计展示）
const dialogueTurns = computed(() => {
  const userCount = omni.turns.value.filter(t => t.role === 'user').length
  const assistantCount = omni.turns.value.filter(t => t.role === 'assistant').length
  return { userCount, assistantCount }
})

// --- 报告：生成 / 保存 / 复制 ----------------------------------------------

/** 确定性基础报告（逐轮评分 + 转写 + 技能/素材证据）。 */
const reportMarkdown = computed(() =>
  buildPracticeReportMarkdown({
    config: props.config,
    startedAt: sessionStartedAt.value || Date.now(),
    endedAt: sessionEndedAt.value || Date.now(),
    turns: omni.turns.value as PracticeTurnRecord[],
    feedback: feedbacks.value,
    skill: activeSkill.value,
    media: {
      audioSegments: audioSegments.value.length,
      frames: pickPracticeReportFrames(reportFrames.value).length,
      cameraOn: cameraWasOn.value,
    },
  }),
)

// AI 全模态深度分析：结束后先用 Qwen3.5-Omni 听录音 / 看画面流式生成一段
// Markdown，实时渲染到结束面板的 “md 看板”；素材缺失或调用失败时回落纯
// 基础报告。文本-only（不申请音频、省 token）。
type AnalysisState = 'idle' | 'running' | 'ok' | 'failed' | 'skipped' | 'inSession'
const analysisState = ref<AnalysisState>('idle')
/** 流式累积中的 AI 段（增量逐段追加，看板实时重渲染）。 */
const aiSection = ref('')
/**
 * 同会话收尾总评产出的整场书面总评（submit_practice_feedback 的
 * reportMarkdown 字段）。拿到它就不再跑离线 Omni 深度分析：同一个模型、
 * 同一份录音/画面已经在会话里评过一次，再发一次纯属重复计费；而且保存
 * 失败重试时也不该二次收费，所以这里独立于 aiSection 常驻，直到下一场开始。
 */
const closingReviewMarkdown = ref('')
/** SSE meta 首帧（服务端校验后实际入请求的素材清单）；未到达时回退本地统计。 */
const analysisMediaMeta = ref<OmniAnalysisMediaMeta | null>(null)

const analysisStatusText = computed(() => {
  switch (analysisState.value) {
    case 'running': {
      const meta = analysisMediaMeta.value
      const local = collectedMediaInfo()
      const audio = meta ? meta.audioSegments : local.audioSegments
      const frames = meta ? meta.frames : local.frames
      return t('speechPractice.reportAnalyzingMedia', { audio, frames })
    }
    case 'ok': return t('speechPractice.reportAnalyzed')
    case 'failed': return t('speechPractice.aiAnalysisFailed')
    case 'skipped': return t('speechPractice.reportSkippedNoMedia')
    case 'inSession': return t('speechPractice.reportInSessionReview')
    default: return ''
  }
})

/**
 * 最终报告 = 基础报告 + 深度分析段。
 * 优先用同会话收尾总评（已在会话里基于真实语音/画面评过），没有才用离线段。
 */
const finalReportMarkdown = computed(() =>
  composePracticeReportWithOmniAnalysis(
    reportMarkdown.value,
    closingReviewMarkdown.value || aiSection.value,
  ),
)

// --- 结束面板「md 看板」滚动：AI 流式生成时自动贴底，用户上翻则跟随 ------

const reportBoardRef = ref<HTMLElement | null>(null)
let stickReportBottom = true

function handleReportBoardScroll(): void {
  const el = reportBoardRef.value
  if (!el) return
  stickReportBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
}

watch(
  () => finalReportMarkdown.value.length,
  () => {
    if (!reportBoardRef.value) return
    if (!stickReportBottom && analysisState.value !== 'running') return
    void nextTick(() => {
      const el = reportBoardRef.value
      if (el) el.scrollTop = el.scrollHeight
    })
  },
)

function practiceApiKey(): string {
  return realtimeModelStore.config.apiKey || meetingStore.asrConfig.dashscopeApiKey || ''
}

/** 素材清单（录音段数 / 画面帧数 / 是否开过摄像头）——报告与聊天消息的证据行。 */
function collectedMediaInfo(): { audioSegments: number; frames: number; cameraOn: boolean } {
  return {
    audioSegments: audioSegments.value.length,
    frames: pickPracticeReportFrames(reportFrames.value).length,
    cameraOn: cameraWasOn.value,
  }
}

/** 素材证据行文本（写入 md 报告头部 & 聊天下载消息）。 */
function mediaEvidenceText(): string {
  const media = collectedMediaInfo()
  if (media.audioSegments > 0 || media.frames > 0) {
    const parts = [
      media.audioSegments > 0 ? `录音 ${media.audioSegments} 段` : '',
      media.frames > 0 ? `画面 ${media.frames} 帧` : '',
    ].filter(Boolean).join(' + ')
    return `练习素材：${parts}（${media.cameraOn ? '已开启摄像头' : '未开启摄像头'}，仅存于本机内存）`
  }
  return '本次未采集到录音/画面，报告基于对话文字与逐轮评分生成'
}

/** 组装 Omni 分析请求；没有素材（录音与画面都为空）时返回 null。 */
function buildOmniAnalysisPayload(): OmniAnalysisPayload | null {
  const frames = pickPracticeReportFrames(reportFrames.value)
  const segments = audioSegments.value
  if (frames.length === 0 && segments.length === 0) return null
  // 总音频预算（base64 字符数）：超出丢最旧的段，给服务端上限留余量。
  const TOTAL_AUDIO_BUDGET_CHARS = 10_000_000
  const kept: typeof segments = []
  let totalChars = 0
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const seg = segments[i]!
    if (totalChars + seg.wavBase64.length > TOTAL_AUDIO_BUDGET_CHARS) break
    totalChars += seg.wavBase64.length
    kept.unshift(seg)
  }
  const skill = activeSkill.value
  return {
    config: {
      language: props.config.language,
      direction: props.config.direction || '',
      difficulty: props.config.difficulty,
      durationMinutes: props.config.durationMinutes,
      // 技能上下文：服务端把技能评分标准/专属指令注入深度分析提示词
      skill: skill.kind === 'skill' ? {
        name: skill.name,
        displayName: skill.displayName,
        description: skill.description,
        criteria: buildSkillCriteriaMarkdown(skill) || undefined,
        instructions: skill.omniInstructions || undefined,
        background: skill.background || undefined,
      } : undefined,
    },
    turns: omni.turns.value.map(t => ({ role: t.role, text: t.text })),
    feedback: feedbacks.value as unknown as Array<Record<string, unknown>>,
    audioSegments: kept.map(seg => ({
      index: seg.index,
      text: seg.text,
      wavBase64: seg.wavBase64,
    })),
    frames,
  }
}

/**
 * 结束后的完整报告流程（finalizeSession 触发；保存失败时按钮可重试）：
 *  0. 同会话收尾总评已给出整场书面总评 → 直接用它，跳过离线分析（不重复计费）；
 *  1. 否则有素材 → 流式调用 Qwen3.5-Omni，增量实时刷进 aiSection（md 看板）；
 *  2. 拼最终 Markdown 落盘（复用 /report）；
 *  3. 成功后往该对练会话插入一条带「下载」附件的消息（聊天页可下载）。
 */
const reportRunning = ref(false)
const saveError = ref('')
const savedReport = ref<{ fileName: string; path: string; url: string } | null>(null)
const copied = ref(false)
/** 本次会话是否已把报告下载入口写进聊天会话（防重复）。 */
let reportChatInserted = false

async function runEndReportFlow(): Promise<void> {
  if (reportRunning.value || !ended.value) return
  reportRunning.value = true
  saveError.value = ''
  savedReport.value = null
  reportChatInserted = false
  try {
    // 1) 深度分析段：同会话收尾总评优先；否则有素材才跑离线 Omni 分析
    let aiOk = true
    if (closingReviewMarkdown.value) {
      analysisState.value = 'inSession'
      aiSection.value = ''
      analysisMediaMeta.value = null
    } else {
      analysisState.value = 'idle'
      aiSection.value = ''
      analysisMediaMeta.value = null
      const payload = buildOmniAnalysisPayload()
      if (payload) {
        analysisState.value = 'running'
        const aiResult = await streamOmniPracticeAnalysis(payload, practiceApiKey() || undefined, {
          onMeta: (meta) => { analysisMediaMeta.value = meta },
          onDelta: (text) => { aiSection.value += text },
        })
        aiOk = !!(aiResult.ok && aiResult.markdown)
        analysisState.value = aiOk ? 'ok' : 'failed'
      } else {
        analysisState.value = 'skipped'
      }
    }
    // 2) 落盘最终报告：AI 成功/跳过 → 基础 + 分析段；AI 失败 → 只存基础报告
    //   （看板仍展示流式生成到的部分，文件保持完整可读）。
    const finalMarkdown = aiOk ? finalReportMarkdown.value : reportMarkdown.value
    const suggestedName = practiceReportFileStem(props.config, Date.now())
    const result = await savePracticeReport(finalMarkdown, suggestedName)
    if (!result.ok || !result.path || !result.fileName) {
      saveError.value = result.error || t('speechPractice.saveFailed')
      return
    }
    const url = getDownloadUrl(result.path, result.fileName)
    savedReport.value = { fileName: result.fileName, path: result.path, url }
    // 3) 聊天会话里出现可下载的报告入口
    persistReportChatMessage(result.fileName, url, finalMarkdown.length)
  } catch (cause) {
    saveError.value = cause instanceof Error ? cause.message : String(cause)
    if (analysisState.value === 'running') analysisState.value = 'failed'
  } finally {
    reportRunning.value = false
  }
}

function persistReportChatMessage(fileName: string, url: string, contentLength: number): void {
  const sessionId = chatStore.activeSessionId
  if (!sessionId || reportChatInserted) return
  const session = chatStore.sessions.find(s => s.id === sessionId)
  if (!session) return
  reportChatInserted = true
  const skill = activeSkill.value
  const skillLine = skill.kind === 'skill' ? `练习技能：${skill.displayName}` : ''
  const message: Message = {
    id: uid(),
    role: 'assistant',
    content: [
      `本次口语对练的评价报告已生成，点击下方文件即可下载。`,
      skillLine,
      mediaEvidenceText(),
    ].filter(Boolean).join('\n'),
    timestamp: Date.now(),
    attachments: [{
      id: uid(),
      name: fileName,
      type: 'text/markdown',
      size: Math.max(1, Math.round(contentLength * 2)),
      url,
    }],
  }
  chatStore.addMessage(sessionId, message)
  session.updatedAt = Date.now()
}

function handleSaveReport(): Promise<void> {
  // 保存失败 / 想重新生成时的重试入口（自动流程已在结束时跑过一次）。
  return runEndReportFlow()
}

async function handleCopyMarkdown(): Promise<void> {
  copied.value = false
  try {
    await navigator.clipboard.writeText(finalReportMarkdown.value)
    copied.value = true
    window.setTimeout(() => { copied.value = false }, 2000)
  } catch {
    // 剪贴板不可用（非安全上下文）时忽略
  }
}
</script>

<template>
  <section
    class="practice-stage"
    :class="[`practice-stage--${orbPhase}`, { 'practice-stage--ended': ended }]"
    role="dialog"
    aria-modal="true"
    :aria-label="t('speechPractice.title')"
    data-testid="speech-practice-stage"
  >
    <div class="practice-stage__wash practice-stage__wash--top" aria-hidden="true" />
    <div class="practice-stage__wash practice-stage__wash--bottom" aria-hidden="true" />

    <header class="practice-stage__header">
      <button class="practice-stage__back" type="button" :aria-label="t('speechPractice.back')" @click="handleClose">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
      </button>
      <div class="practice-stage__identity">
        <strong>{{ sessionTitle }}</strong>
        <span data-testid="speech-practice-subtitle">
          {{ languageLabel }} · {{ difficultyLabel }}
          <template v-if="(config.direction || '').trim()">· {{ config.direction.trim() }}</template>
        </span>
      </div>
      <div class="practice-stage__header-right">
        <span
          v-if="countdownActive"
          class="practice-stage__timer"
          :class="{ 'practice-stage__timer--warning': countdownWarning }"
          :aria-label="`${t('speechPractice.timeRemaining')} ${countdownText}`"
          data-testid="speech-practice-timer"
        >⏱ {{ countdownText }}</span>
        <span v-if="!ended" class="practice-stage__phase" data-testid="speech-practice-phase">{{ statusLabel }}</span>
      </div>
    </header>

    <main class="practice-stage__main">
      <!-- 摄像头预览：放在 <main> 顶层（设置卡 / 进行中两个视图都存在）。
           此前放在 live 区块内，getUserMedia 成功时 video 尚未挂载，
           watch(cameraStream) 拿不到 videoRef → srcObject 丢失 → 黑屏、
           取帧读到空画面、AI 收不到帧。 -->
      <div
        v-if="cameraStream"
        class="practice-stage__camera"
        data-testid="speech-practice-camera-preview"
      >
        <video ref="videoRef" autoplay playsinline muted />
      </div>
      <!-- 设置卡 -->
      <section v-if="!isActive && !ended" class="practice-stage__setup" data-testid="speech-practice-setup">
        <NAlert v-if="!hasDashscopeKey" type="warning" :show-icon="false" class="practice-stage__alert">
          {{ t('meeting.realtime.needApiKey') }}
        </NAlert>
        <NAlert v-if="backendError" type="error" :show-icon="false" class="practice-stage__alert" data-testid="speech-practice-backend-error">
          {{ backendError }}
        </NAlert>
        <NAlert
          v-if="nearContextLimit && contextLimitTotal"
          type="warning"
          :show-icon="false"
          class="practice-stage__alert"
        >
          {{ t('omniRealtime.contextNearLimit', { used: usedUserTurns, total: contextLimitTotal }) }}
        </NAlert>
        <div class="practice-stage__card">
          <h2>{{ t('speechPractice.title') }}</h2>
          <p class="practice-stage__card-sub">{{ t('speechPractice.subtitle') }}</p>
          <p class="practice-stage__card-meta" data-testid="speech-practice-config">
            <span class="practice-stage__chip">{{ languageLabel }}</span>
            <span class="practice-stage__chip">{{ difficultyLabel }}</span>
            <span
              v-if="durationTotalMs > 0"
              class="practice-stage__chip practice-stage__chip--duration"
              data-testid="speech-practice-duration-chip"
            >⏱ {{ t('speechPractice.timedMinutes', { minutes: config.durationMinutes }) }}</span>
            <span v-if="(config.direction || '').trim()" class="practice-stage__chip practice-stage__chip--direction">
              {{ config.direction.trim() }}
            </span>
          </p>
          <p class="practice-stage__card-hint">{{ t('speechPractice.setupHint') }}</p>
          <div class="practice-stage__field">
            <label>{{ t('meeting.realtime.voice') }}</label>
            <NSelect
              v-model:value="selectedVoice"
              :options="voiceOptions"
              size="small"
              @update:value="userVoicePicked = true"
            />
          </div>
          <div class="practice-stage__field practice-stage__field--row">
            <label>{{ t('omniRealtime.camera') }}</label>
            <NSwitch
              v-model:value="cameraEnabled"
              size="small"
              :disabled="!canStart"
              data-testid="speech-practice-camera"
            />
          </div>
          <p v-if="cameraEnabled" class="practice-stage__card-hint" data-testid="speech-practice-camera-hint">
            {{ t('speechPractice.cameraHint') }}
          </p>
          <p v-else-if="cameraNotice" class="practice-stage__card-hint practice-stage__card-hint--error">{{ cameraNotice }}</p>
          <NButton
            type="primary"
            block
            :disabled="!canStart"
            :loading="preparing"
            data-testid="speech-practice-start"
            @click="startSession"
          >
            {{ preparing ? t('meeting.realtime.phase.connecting') : t('speechPractice.startSession') }}
          </NButton>
        </div>
      </section>

      <!-- 结束面板：完整报告 md 看板（评分汇总 + 逐轮点评 + AI 全模态分析） -->
      <section v-else-if="ended" class="practice-stage__ended" data-testid="speech-practice-ended">
        <div class="practice-stage__ended-card practice-stage__ended-card--report">
          <header class="practice-stage__ended-head">
            <div class="practice-stage__ended-title">
              <h2>{{ t('speechPractice.endedTitle') }}</h2>
              <p class="practice-stage__card-sub" data-testid="speech-practice-ended-summary">
                {{ languageLabel }} · {{ difficultyLabel }}
                <template v-if="(config.direction || '').trim()"> · {{ config.direction.trim() }}</template>
                <template v-if="skillNotice"> · {{ skillNotice }}</template>
                · {{ t('speechPractice.endedSummary', { user: dialogueTurns.userCount, assistant: dialogueTurns.assistantCount, scored: feedbacks.length }) }}
              </p>
            </div>
            <span
              v-if="analysisStatusText"
              class="practice-stage__ai-pill"
              :class="`practice-stage__ai-pill--${analysisState}`"
              data-testid="speech-practice-ai-status"
              aria-live="polite"
            >{{ analysisStatusText }}</span>
          </header>

          <NAlert
            v-if="autoFinished"
            type="info"
            :show-icon="false"
            class="practice-stage__alert practice-stage__alert--timeup"
            data-testid="speech-practice-timeup-notice"
          >
            {{ t('speechPractice.timeUpNotice') }}
          </NAlert>
          <NAlert v-if="saveError" type="error" :show-icon="false" class="practice-stage__alert">
            {{ saveError }}
          </NAlert>

          <!-- 报告看板：确定性部分 + AI 深度分析实时渲染 -->
          <div
            ref="reportBoardRef"
            class="practice-stage__report-board"
            data-testid="speech-practice-report-board"
            @scroll.passive="handleReportBoardScroll"
          >
            <MarkdownRenderer :content="finalReportMarkdown" heading-id-prefix="sp-report" />
          </div>

          <div v-if="savedReport" class="practice-stage__saved" data-testid="speech-practice-saved">
            <strong>{{ t('speechPractice.reportSaved') }}</strong>
            <span class="practice-stage__saved-name">{{ savedReport.fileName }}</span>
            <a
              class="practice-stage__download-link"
              :href="savedReport.url"
              :download="savedReport.fileName"
              data-testid="speech-practice-download"
            >{{ t('speechPractice.download') }}</a>
          </div>

          <div class="practice-stage__actions">
            <NButton
              v-if="saveError || !savedReport"
              type="primary"
              :loading="reportRunning"
              :disabled="reportRunning"
              data-testid="speech-practice-save-report"
              @click="handleSaveReport"
            >
              {{ reportRunning && analysisState === 'running' ? analysisStatusText : t('speechPractice.saveReport') }}
            </NButton>
            <NButton :disabled="finalReportMarkdown.length === 0 || reportRunning" @click="handleCopyMarkdown">
              {{ copied ? t('speechPractice.copied') : t('speechPractice.copyMarkdown') }}
            </NButton>
            <NButton quaternary @click="emit('close')">
              {{ t('speechPractice.close') }}
            </NButton>
          </div>
        </div>
      </section>

      <!-- 进行中：舞台 + 右侧评分卡 -->
      <section v-else class="practice-stage__live" data-testid="speech-practice-live">
        <div class="practice-stage__body">
          <div
            ref="stageScrollRef"
            class="practice-stage__stage"
            data-testid="speech-practice-stage-scroll"
            @scroll.passive="handleStageScroll"
          >
            <NAlert
              v-if="nearContextLimit && contextLimitTotal"
              type="warning"
              :show-icon="false"
              class="practice-stage__alert practice-stage__alert--live"
            >
              {{ t('omniRealtime.contextNearLimit', { used: usedUserTurns, total: contextLimitTotal }) }}
            </NAlert>

            <div class="practice-stage__visualizer-zone">
              <OmniVisualizer
                :phase="orbPhase"
                :input-level="omni.inputLevel.value"
                :output-level="omni.outputLevel.value"
                class="practice-stage__visualizer"
              />
            </div>

            <div
              ref="bubbleListRef"
              class="practice-stage__bubbles"
              aria-live="polite"
              data-testid="speech-practice-bubbles"
            >
              <TransitionGroup name="practice-bubble" tag="div" class="practice-stage__bubbles-inner">
              <div
                v-for="b in bubbles"
                :key="b.key"
                class="practice-stage__bubble"
                :class="[`practice-stage__bubble--${b.role}`, { 'practice-stage__bubble--live': b.live }]"
              >{{ b.text }}</div>
              </TransitionGroup>
            </div>

            <p
              class="practice-stage__caption"
              aria-live="polite"
              aria-atomic="true"
              data-testid="speech-practice-caption"
            >{{ caption }}</p>

            <div
              v-if="latestToolCall"
              class="practice-stage__tool-inline"
              aria-live="polite"
              data-testid="speech-practice-tool-calls"
            >
              <span
                class="practice-stage__tool-indicator"
                :class="`practice-stage__tool-indicator--${latestToolCall.status}`"
                aria-hidden="true"
              >
                <span
                  v-if="latestToolCall.status === 'running'"
                  class="practice-stage__tool-spinner"
                />
                <svg v-else-if="latestToolCall.status === 'error'" viewBox="0 0 20 20">
                  <path d="m6.5 6.5 7 7m0-7-7 7" />
                </svg>
                <svg v-else viewBox="0 0 20 20">
                  <path d="m5.5 10.2 2.8 2.8 6.2-6.2" />
                </svg>
              </span>
              <span class="practice-stage__tool-inline-copy">{{ toolPillText }}</span>
            </div>

            <NButton
              v-if="phase === 'error'"
              type="primary"
              size="small"
              :loading="preparing"
              data-testid="speech-practice-resume"
              @click="resumeSession"
            >
              {{ t('speechPractice.resume') }}
            </NButton>

            <div class="practice-stage__controls">
              <button
                class="practice-stage__control"
                type="button"
                :class="{ 'practice-stage__control--muted': isMuted }"
                :aria-pressed="isMuted"
                :aria-label="isMuted ? t('omniRealtime.unmute') : t('omniRealtime.mute')"
                data-testid="speech-practice-mute"
                @click="toggleMute"
              >
                <svg v-if="!isMuted" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z" />
                  <path d="M17 11a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" />
                </svg>
                <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z" />
                  <path d="M17 11a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" />
                  <path d="m4 4 16 16" />
                </svg>
              </button>

              <button
                class="practice-stage__control practice-stage__control--interrupt"
                type="button"
                :disabled="phase !== 'speaking'"
                :aria-label="t('meeting.realtime.bargeIn')"
                data-testid="speech-practice-interrupt"
                @click="omni.interrupt()"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </button>

              <button
                class="practice-stage__control practice-stage__control--end"
                type="button"
                :aria-label="t('speechPractice.endSession')"
                data-testid="speech-practice-end"
                @click="endSession"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
                  <rect x="2" y="13" width="6" height="8" rx="2" />
                  <rect x="16" y="13" width="6" height="8" rx="2" />
                </svg>
              </button>
            </div>
          </div>

          <!-- 右侧逐轮评分卡 -->
          <aside class="practice-stage__scores" data-testid="speech-practice-scores">
            <header class="practice-stage__scores-header">
              <strong>{{ t('speechPractice.scoreBoard') }}</strong>
              <span v-if="feedbacks.length > 0" class="practice-stage__scores-count">{{ feedbacks.length }}</span>
            </header>

            <div v-if="!latestFeedback" class="practice-stage__scores-empty">
              {{ t('speechPractice.scoresEmpty') }}
            </div>

            <template v-else>
              <div class="practice-stage__feedback-card" data-testid="speech-practice-latest-feedback">
                <div class="practice-stage__feedback-round">
                  {{ latestFeedback.round > 0 ? t('speechPractice.roundLabel', { n: latestFeedback.round }) : t('speechPractice.unattachedRound') }}
                </div>
                <div class="practice-stage__feedback-score-row">
                  <span class="practice-stage__feedback-overall" :data-tone="scoreTone(latestFeedback.overall, scoreScaleMax)">
                    {{ fmtScore(latestFeedback.overall) }}/{{ scoreScaleMax }}
                  </span>
                  <span class="practice-stage__feedback-overall-label">{{ t('speechPractice.score.overall') }}</span>
                </div>
                <div class="practice-stage__feedback-dims">
                  <span
                    v-for="key in displayDimKeys"
                    :key="key"
                    class="practice-stage__dim"
                    :data-tone="scoreTone(feedbackDimValue(latestFeedback, key), scoreScaleMax)"
                  >
                    <i>{{ dimLabel(key) }}</i>
                    <b>{{ fmtScore(feedbackDimValue(latestFeedback, key)) }}</b>
                  </span>
                  <span
                    v-if="latestFeedback.bodyLanguage != null"
                    class="practice-stage__dim"
                    :data-tone="scoreTone(latestFeedback.bodyLanguage, scoreScaleMax)"
                    data-testid="speech-practice-bodylanguage-chip"
                  >
                    <i>{{ dimLabel('bodyLanguage') }}</i>
                    <b>{{ fmtScore(latestFeedback.bodyLanguage) }}</b>
                  </span>
                </div>
                <p v-if="latestFeedback.comment" class="practice-stage__feedback-comment">{{ latestFeedback.comment }}</p>
                <p v-if="latestFeedback.strengths" class="practice-stage__feedback-line">
                  <em>✨ {{ t('speechPractice.strengths') }}</em> {{ latestFeedback.strengths }}
                </p>
                <p v-if="latestFeedback.improvements" class="practice-stage__feedback-line">
                  <em>💡 {{ t('speechPractice.improvements') }}</em> {{ latestFeedback.improvements }}
                </p>
                <p v-if="latestFeedback.example" class="practice-stage__feedback-line practice-stage__feedback-line--example">
                  <em>✍️ {{ t('speechPractice.example') }}</em> {{ latestFeedback.example }}
                </p>
              </div>

              <div v-if="feedbacks.length > 1" class="practice-stage__history">
                <template v-for="(item, index) in feedbacks.slice(0, -1).slice(-20).reverse()" :key="`${item.at}-${index}`">
                  <div class="practice-stage__history-row">
                    <span class="practice-stage__history-round">
                      {{ item.round > 0 ? t('speechPractice.roundLabel', { n: item.round }) : t('speechPractice.unattachedRound') }}
                    </span>
                    <span class="practice-stage__history-score" :data-tone="scoreTone(item.overall, scoreScaleMax)">
                      {{ fmtScore(item.overall) }}/{{ scoreScaleMax }}
                    </span>
                    <span class="practice-stage__history-comment">{{ item.comment || '—' }}</span>
                  </div>
                </template>
              </div>
            </template>
          </aside>
        </div>
      </section>
    </main>
  </section>
</template>

<style scoped>
/* 口语对练舞台——沿用 Omni 实时对话的设计语言：
 * 不透明 var(--bg-primary) 底 + accent 紫蓝低透明渐变氛围 + 玻璃拟态
 * 面板（--glass-realtime-* 令牌），全部颜色跟随 light/dark 主题。
 * 评分语义色（good/ok/weak）保留，但改用 --success/--warning/--error
 * 主题令牌，两种主题下都做柔化处理。 */
.practice-stage {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  isolation: isolate;
  overflow: hidden;
  color: var(--text-primary);
  background: var(--theme-card-bg, var(--bg-card));
}

.practice-stage__wash {
  position: absolute;
  inset-inline: 0;
  height: 26vh;
  z-index: -1;
  pointer-events: none;
}

.practice-stage__wash--top { background: linear-gradient(rgba(var(--accent-primary-rgb), 0.07), transparent); }
.practice-stage__wash--bottom { background: linear-gradient(transparent, rgba(var(--accent-primary-rgb), 0.05)); }

.practice-stage__header {
  z-index: 3;
  height: 72px;
  padding: env(safe-area-inset-top, 0) clamp(16px, 4vw, 48px) 0;
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  border-bottom: 1px solid var(--glass-realtime-border);
  background: var(--theme-card-bg, var(--bg-card));
  -webkit-backdrop-filter: var(--glass-realtime-blur);
  backdrop-filter: var(--glass-realtime-blur);
}

.practice-stage__back {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border: 1px solid var(--glass-realtime-border);
  border-radius: 12px;
  background: var(--theme-card-bg, var(--bg-card));
  color: inherit;
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease;
}

.practice-stage__back:hover { background: var(--theme-card-bg, var(--bg-card)); border-color: rgba(var(--text-primary-rgb), 0.4); }
.practice-stage__back svg { width: 20px; fill: none; stroke: currentColor; stroke-width: 1.7; }

.practice-stage__identity { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.practice-stage__identity strong {
  overflow: hidden;
  font-size: 14px;
  font-weight: 560;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.practice-stage__identity span {
  overflow: hidden;
  color: rgba(var(--text-primary-rgb), 0.58);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.practice-stage__phase {
  padding: 5px 12px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.34);
  border-radius: 999px;
  color: var(--text-primary);
  background: rgba(var(--accent-primary-rgb), 0.14);
  font-size: 11px;
  letter-spacing: 0.04em;
}

.practice-stage__header-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  min-width: 0;
}

.practice-stage__timer {
  padding: 5px 12px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.34);
  border-radius: 999px;
  color: var(--text-primary);
  background: rgba(var(--accent-primary-rgb), 0.14);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.03em;
  white-space: nowrap;
}

.practice-stage__timer--warning {
  border-color: rgba(var(--warning-rgb), 0.55);
  color: rgb(var(--warning-rgb));
  background: rgba(var(--warning-rgb), 0.12);
  animation: practice-pulse 1.1s ease-in-out infinite;
}

@keyframes practice-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

.practice-stage__chip--duration {
  background: rgba(var(--accent-primary-rgb), 0.2);
  border-color: rgba(var(--accent-primary-rgb), 0.4);
}

.practice-stage__alert--timeup { width: 100%; }

.practice-stage__main {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: center;
  padding: 20px;
}

.practice-stage__setup {
  width: min(460px, calc(100% - 32px));
  margin: 0 auto;
}

.practice-stage__alert { margin-bottom: 14px; }
.practice-stage__alert--live { max-width: 720px; margin: 0 auto 14px; }

.practice-stage__card {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 14px;
  padding: 26px 24px;
  border: 1px solid var(--glass-realtime-border);
  border-radius: 20px;
  background: var(--theme-card-bg, var(--bg-card));
  -webkit-backdrop-filter: var(--glass-realtime-blur-strong);
  backdrop-filter: var(--glass-realtime-blur-strong);
  box-shadow: var(--glass-realtime-shadow);
}

.practice-stage__card h2 { margin: 0; font-size: 18px; font-weight: 620; }
.practice-stage__card-sub { margin: -8px 0 0; color: rgba(var(--text-primary-rgb), 0.62); font-size: 12px; text-align: center; }

.practice-stage__card-meta {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin: 0;
}

.practice-stage__chip {
  padding: 4px 12px;
  border-radius: 999px;
  background: rgba(var(--accent-primary-rgb), 0.12);
  border: 1px solid rgba(var(--accent-primary-rgb), 0.26);
  color: var(--text-primary);
  font-size: 12px;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.practice-stage__chip--direction { background: rgba(var(--accent-primary-rgb), 0.2); border-color: rgba(var(--accent-primary-rgb), 0.4); }

.practice-stage__card-hint { margin: -6px 0 0; color: rgba(var(--text-primary-rgb), 0.52); font-size: 12px; }

.practice-stage__field {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 100%;
}
.practice-stage__field--row { flex-direction: row; align-items: center; justify-content: center; gap: 12px; }
.practice-stage__field label { color: rgba(var(--text-primary-rgb), 0.72); font-size: 12px; }
.practice-stage__field :deep(.n-select) { width: 100%; max-width: 320px; }
.practice-stage__card-hint--error { color: rgba(var(--error-rgb), 0.9); }

.practice-stage__live { flex: 1; min-height: 0; display: flex; }
.practice-stage__body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 340px);
  /* 单行高度固定为容器可用高度：左栏内容超高时由左栏自己滚动，
     而不是把 grid 撑高把下方内容顶出可滚动范围。 */
  grid-template-rows: minmax(0, 1fr);
  gap: 18px;
  align-items: stretch;
}

/* 左栏舞台：内容超高时纵向可滚（Linux 小屏/矮窗下气泡 + 控件不再被裁）。
 * justify-content 先给 center，再被支持 safe 的浏览器用 safe center 覆盖：
 * 空间不足时回落 flex-start，保证滚动时顶部/底部内容都能滚到。 */
.practice-stage__stage {
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  justify-content: safe center;
  position: relative;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

.practice-stage__visualizer-zone {
  position: relative;
  /* 方形容器：用 min() 同时限制宽高（vw 管宽度、vh 管矮屏高度），
     矮屏下给气泡/控件让出空间，避免整栏溢出。 */
  width: min(46vw, 420px, 42vh);
  aspect-ratio: 1;
  margin: 6px 0 0;
  flex-shrink: 1;
}
.practice-stage__visualizer { position: absolute; inset: 0; }

.practice-stage__camera {
  position: absolute;
  top: 14px;
  right: 14px;
  width: min(210px, 28vw);
  aspect-ratio: 16 / 10;
  border: 1px solid var(--glass-realtime-border-strong);
  border-radius: 14px;
  overflow: hidden;
  box-shadow: var(--glass-realtime-shadow);
  z-index: 4;
}

.practice-stage__camera video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scaleX(-1);
}

/* 气泡滚动层：内容（长文本 / 很多轮）超高时可上下滚动；新内容贴底见
 * scrollLiveToLatest。inner 才是真正的 flex 列（TransitionGroup 的渲染体）。 */
.practice-stage__bubbles {
  width: min(560px, 92%);
  margin-top: 6px;
  min-height: 0;
  max-height: min(36vh, 320px);
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

.practice-stage__bubbles-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 100%;
  justify-content: flex-end;
}

.practice-stage__bubble {
  max-width: 100%;
  padding: 10px 16px;
  border-radius: 16px;
  font-size: 14px;
  line-height: 1.55;
  background: var(--theme-card-bg, var(--bg-card));
  border: 1px solid var(--glass-realtime-border);
  -webkit-backdrop-filter: blur(16px) saturate(160%);
  backdrop-filter: blur(16px) saturate(160%);
  color: var(--text-primary);
  word-break: break-word;
}

/* 用户气泡：与 Omni 舞台一致的单一 accent 渐变胶囊。 */
.practice-stage__bubble--user {
  align-self: flex-end;
  background: linear-gradient(135deg,
    rgba(var(--accent-primary-rgb), 0.22),
    rgba(var(--accent-primary-rgb), 0.10));
  border-color: rgba(var(--accent-primary-rgb), 0.34);
}
.practice-stage__bubble--assistant {
  align-self: flex-start;
  background: var(--theme-card-bg, var(--bg-card));
  border-color: var(--glass-realtime-border-strong);
}
.practice-stage__bubble--live {
  border-style: dashed;
  animation: practice-live-pulse 2.2s ease-in-out infinite;
}

@keyframes practice-live-pulse {
  0%, 100% { border-color: var(--glass-realtime-border); }
  50% { border-color: var(--glass-realtime-border-strong); }
}

.practice-bubble-enter-active, .practice-bubble-leave-active { transition: all 0.32s ease; }
.practice-bubble-enter-from { opacity: 0; transform: translateY(10px) scale(0.98); }
.practice-bubble-leave-to { opacity: 0; transform: translateY(-8px) scale(0.98); }

.practice-stage__caption {
  margin: 8px 0 0;
  min-height: 18px;
  color: rgba(var(--text-primary-rgb), 0.62);
  font-size: 12px;
  text-align: center;
}

.practice-stage__tool-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 5px 12px;
  border-radius: 999px;
  background: var(--theme-card-bg, var(--bg-card));
  border: 1px solid var(--glass-realtime-border);
  -webkit-backdrop-filter: var(--glass-realtime-blur);
  backdrop-filter: var(--glass-realtime-blur);
  font-size: 12px;
  color: rgba(var(--text-primary-rgb), 0.85);
}

.practice-stage__tool-indicator { width: 14px; height: 14px; display: grid; place-items: center; }
.practice-stage__tool-indicator svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 2; }
/* 与 Omni 舞台一致：running 用 accent 紫蓝，done/error 用 ink 灰——不再红/绿。 */
.practice-stage__tool-indicator--running { color: rgb(var(--accent-primary-rgb)); }
.practice-stage__tool-indicator--done { color: rgba(var(--text-primary-rgb), 0.55); }
.practice-stage__tool-indicator--error { color: rgba(var(--text-primary-rgb), 0.4); }
.practice-stage__tool-spinner {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid rgba(var(--accent-primary-rgb), 0.3);
  border-top-color: rgb(var(--accent-primary-rgb));
  animation: practice-spin 0.8s linear infinite;
}
@keyframes practice-spin { to { transform: rotate(360deg); } }

.practice-stage__controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 18px;
  margin-top: 16px;
}

.practice-stage__control {
  width: 52px;
  height: 52px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1px solid var(--glass-realtime-border-strong);
  background: var(--theme-card-bg, var(--bg-card));
  -webkit-backdrop-filter: var(--glass-realtime-blur);
  backdrop-filter: var(--glass-realtime-blur);
  color: inherit;
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease;
  box-shadow: var(--glass-realtime-shadow);
}
.practice-stage__control svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.7; }
.practice-stage__control:hover { background: var(--theme-card-bg, var(--bg-card)); border-color: rgba(var(--text-primary-rgb), 0.4); }
/* 静音 = ink 灰表达"非激活"；挂断 = accent 紫蓝强调（同 Omni 舞台）。 */
.practice-stage__control--muted {
  border-color: rgba(var(--text-primary-rgb), 0.55);
  background: rgba(var(--text-primary-rgb), 0.10);
  color: rgba(var(--text-primary-rgb), 0.6);
}
.practice-stage__control--end {
  border-color: rgba(var(--accent-primary-rgb), 0.5);
  background: rgba(var(--accent-primary-rgb), 0.18);
}
.practice-stage__control--end:hover { background: rgba(var(--accent-primary-rgb), 0.3); }
.practice-stage__control:disabled { opacity: 0.35; cursor: not-allowed; }

/* 右侧评分卡 */
.practice-stage__scores {
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--glass-realtime-border);
  border-radius: 18px;
  background: var(--theme-card-bg, var(--bg-card));
  -webkit-backdrop-filter: var(--glass-realtime-blur-strong);
  backdrop-filter: var(--glass-realtime-blur-strong);
  box-shadow: var(--glass-realtime-shadow);
}

.practice-stage__scores-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px 10px;
  font-size: 13px;
  border-bottom: 1px solid var(--glass-realtime-border);
}

.practice-stage__scores-count {
  min-width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  background: rgba(var(--accent-primary-rgb), 0.18);
  font-size: 11px;
}

.practice-stage__scores-empty {
  padding: 26px 18px;
  text-align: center;
  color: rgba(var(--text-primary-rgb), 0.5);
  font-size: 12px;
  line-height: 1.7;
}

.practice-stage__feedback-card {
  overflow-y: auto;
  padding: 14px 16px;
}

.practice-stage__feedback-round {
  font-size: 11px;
  color: rgba(var(--text-primary-rgb), 0.62);
}

.practice-stage__feedback-score-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 6px 0 10px;
}

.practice-stage__feedback-overall { font-size: 30px; font-weight: 700; line-height: 1; }
.practice-stage__feedback-overall-label { font-size: 12px; color: rgba(var(--text-primary-rgb), 0.68); }

/* 评分语义色：good/ok/weak 保留红绿黄的"反馈可读性"，但改用主题令牌
 * 并降低饱和——水墨底上不刺眼，light/dark 都可读。 */
[data-tone='good'] { color: rgb(var(--success-rgb)); }
[data-tone='ok'] { color: rgb(var(--warning-rgb)); }
[data-tone='weak'] { color: rgb(var(--error-rgb)); }
[data-tone='none'] { color: rgba(var(--text-primary-rgb), 0.55); }

.practice-stage__feedback-dims {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}

.practice-stage__dim {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  padding: 3px 9px;
  border-radius: 8px;
  background: rgba(var(--text-primary-rgb), 0.06);
  font-size: 11px;
}
.practice-stage__dim i { font-style: normal; color: rgba(var(--text-primary-rgb), 0.72); }
.practice-stage__dim b { font-weight: 650; }

.practice-stage__feedback-comment {
  margin: 4px 0 8px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);
}

.practice-stage__feedback-line {
  margin: 4px 0;
  font-size: 12px;
  line-height: 1.6;
  color: rgba(var(--text-primary-rgb), 0.82);
}
.practice-stage__feedback-line em { font-style: normal; color: rgb(var(--success-rgb)); }
.practice-stage__feedback-line--example em { color: rgb(var(--warning-rgb)); }

.practice-stage__history {
  border-top: 1px solid var(--glass-realtime-border);
  overflow-y: auto;
  padding: 6px 16px 14px;
}

.practice-stage__history-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 7px 0;
  font-size: 12px;
  border-bottom: 1px dashed var(--glass-realtime-border);
}

.practice-stage__history-round { color: rgba(var(--text-primary-rgb), 0.6); white-space: nowrap; }
.practice-stage__history-score { font-weight: 650; white-space: nowrap; }
.practice-stage__history-comment {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgba(var(--text-primary-rgb), 0.8);
}

/* 结束面板：完整报告 md 看板 */
.practice-stage__ended {
  width: min(880px, calc(100% - 32px));
  margin: 0 auto;
  overflow-y: auto;
}

.practice-stage__ended-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 22px 24px 24px;
  border: 1px solid var(--glass-realtime-border);
  border-radius: 20px;
  background: var(--theme-card-bg, var(--bg-card));
  -webkit-backdrop-filter: var(--glass-realtime-blur-strong);
  backdrop-filter: var(--glass-realtime-blur-strong);
  box-shadow: var(--glass-realtime-shadow);
}

.practice-stage__ended-card--report { text-align: left; }

.practice-stage__ended-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.practice-stage__ended-title { min-width: 0; }
.practice-stage__ended-title h2 { margin: 0; font-size: 18px; font-weight: 620; }
.practice-stage__ended-title .practice-stage__card-sub {
  margin: 4px 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* AI 分析状态胶囊 */
.practice-stage__ai-pill {
  flex-shrink: 0;
  padding: 5px 12px;
  border-radius: 999px;
  border: 1px solid var(--glass-realtime-border);
  background: var(--theme-card-bg, var(--bg-card));
  font-size: 12px;
  color: rgba(var(--text-primary-rgb), 0.75);
  white-space: nowrap;
}
.practice-stage__ai-pill--running {
  color: rgb(var(--accent-primary-rgb));
  border-color: rgba(var(--accent-primary-rgb), 0.4);
  animation: practice-pulse 1.3s ease-in-out infinite;
}
.practice-stage__ai-pill--failed { color: rgba(var(--warning-rgb), 0.95); }
.practice-stage__ai-pill--ok { color: rgba(var(--success-rgb), 0.9); }

/* 报告看板：渲染后的 Markdown，超高内部滚动（矮屏也能看到全文） */
.practice-stage__report-board {
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  max-height: min(58vh, 560px);
  padding: 14px 16px;
  border: 1px solid var(--glass-realtime-border);
  border-radius: 14px;
  background: var(--theme-card-bg, var(--bg-card));
  color: var(--text-primary);
  font-size: 13.5px;
  line-height: 1.7;
  text-align: left;
}
.practice-stage__report-board :deep(h1) { font-size: 20px; }
.practice-stage__report-board :deep(h2) { font-size: 16px; margin-top: 18px; }
.practice-stage__report-board :deep(h3) { font-size: 14.5px; margin-top: 14px; }
.practice-stage__report-board :deep(p), .practice-stage__report-board :deep(ul), .practice-stage__report-board :deep(ol) { margin: 6px 0; }
.practice-stage__report-board :deep(table) { border-collapse: collapse; margin: 8px 0; width: 100%; }
.practice-stage__report-board :deep(th), .practice-stage__report-board :deep(td) {
  padding: 5px 9px;
  border: 1px solid var(--glass-realtime-border);
}
.practice-stage__report-board :deep(blockquote) {
  margin: 6px 0;
  padding: 4px 10px;
  border-inline-start: 3px solid rgba(var(--accent-primary-rgb), 0.5);
  color: rgba(var(--text-primary-rgb), 0.75);
}
.practice-stage__report-board :deep(code) {
  padding: 1px 5px;
  border-radius: 6px;
  background: rgba(var(--text-primary-rgb), 0.07);
  font-size: 0.92em;
}
.practice-stage__report-board :deep(a) { color: rgb(var(--accent-primary-rgb)); }

.practice-stage__saved {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 12px;
  border-radius: 12px;
  background: rgba(var(--accent-primary-rgb), 0.1);
  border: 1px solid rgba(var(--accent-primary-rgb), 0.3);
  font-size: 13px;
}

.practice-stage__saved-name { color: rgba(var(--text-primary-rgb), 0.72); font-size: 12px; word-break: break-all; }

.practice-stage__download-link {
  padding: 6px 16px;
  border-radius: 999px;
  background: rgba(var(--accent-primary-rgb), 0.16);
  border: 1px solid rgba(var(--accent-primary-rgb), 0.42);
  color: rgb(var(--accent-primary-rgb));
  font-size: 13px;
  text-decoration: none;
}

.practice-stage__download-link:hover { background: rgba(var(--accent-primary-rgb), 0.28); }

.practice-stage__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
  margin-top: 6px;
}

/* light 主题（日间）补充：与 Omni 舞台一致——控件实底白 + 深描边 +
 * 投影保证白底对比度；AI 气泡玻璃增强描边。 */
html:not(.dark) .practice-stage__control {
  background: rgba(var(--text-primary-rgb), 0.9);
  border-color: rgba(var(--text-primary-rgb), 0.16);
  box-shadow: 0 2px 14px rgba(var(--text-primary-rgb), 0.1);
}

html:not(.dark) .practice-stage__control:hover {
  background: var(--theme-card-bg, var(--theme-card-bg, var(--bg-card)));
  border-color: rgba(var(--text-primary-rgb), 0.42);
}

html:not(.dark) .practice-stage__control--muted {
  border-color: rgba(var(--text-primary-rgb), 0.44);
  background: rgba(var(--text-primary-rgb), 0.08);
}

html:not(.dark) .practice-stage__bubble--assistant {
  background: rgba(var(--text-primary-rgb), 0.92);
  border-color: rgba(var(--text-primary-rgb), 0.14);
  box-shadow: 0 2px 16px rgba(var(--text-primary-rgb), 0.08);
}

@media (max-width: 960px) {
  .practice-stage__body {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(0, 1fr) auto;
    overflow-y: auto;
  }

  .practice-stage__stage { min-height: 480px; }

  .practice-stage__scores {
    max-height: 320px;
    border-radius: 16px;
  }
}
</style>
