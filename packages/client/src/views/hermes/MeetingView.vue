<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NSpin, NTag, NTooltip, NInput, NPopconfirm, NModal, NSelect, NRadio, NRadioGroup, NTabs, NTabPane } from 'naive-ui'
import MeetingAgentPanel from '@/components/hermes/meeting/MeetingAgentPanel.vue'
import SceneTemplatePicker from '@/components/hermes/meeting/SceneTemplatePicker.vue'
import WaveformCanvas from '@/components/hermes/meeting/WaveformCanvas.vue'
import MeetingSidebar, { type SidebarSession } from '@/components/hermes/meeting/MeetingSidebar.vue'
import CreateMeetingDialog from '@/components/hermes/meeting/CreateMeetingDialog.vue'
import AsrConfigWizardDialog from '@/components/hermes/meeting/AsrConfigWizardDialog.vue'
import DirectTranscribeForm from '@/components/hermes/meeting/DirectTranscribeForm.vue'
import DiarizeWholeFileDialog, { type DiarizeEngine, type DiarizeOssConfig } from '@/components/hermes/meeting/DiarizeWholeFileDialog.vue'
import { SCENE_UI } from '@/components/hermes/meeting/scene-ui-registry'
import { normalizeSceneId } from '@/components/hermes/meeting/scene-templates'
import MeetingTopBar from '@/components/hermes/meeting/MeetingTopBar.vue'
import MeetingRightPanel from '@/components/hermes/meeting/MeetingRightPanel.vue'
import TranscriptList from '@/components/hermes/meeting/TranscriptList.vue'
import type { SceneId } from '@/components/hermes/meeting/scene-templates'
import { useMeetingStore } from '@/stores/hermes/meeting'
import type { MeetingSession, TranscriptSentence, AgentConfig, SpeechEvalState } from '@/stores/hermes/meeting'
import { useModelsStore } from '@/stores/hermes/models'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { DEFAULT_EVAL, provideSpeechTimer } from '@/components/hermes/meeting/speech/speechTimerContext'
import { useRealtimeModelStore } from '@/stores/hermes/realtime-model'
import { meetingASRApi } from '@/utils/meeting-asr-api'
import { getApiKey } from '@/api/client'
import { useMessage } from '@/composables/useAppMessage'
import { meetingStorageApi } from '@/utils/meeting-storage-api'
import { extractMeetingTitleFromReport, requestAiMeetingTitle, formatTranscriptForTitle, canAutoRenameMeeting } from '@/utils/meeting-title'
import { getProfileDisplayName } from '@/utils/hermes/profile-display'
import { useMeetingAudio } from '@/composables/useMeetingAudio'
import { useDraggableWidth } from '@/composables/useDraggableWidth'
import { useDiarizeMerge } from '@/composables/useDiarizeMerge'
import { useMeetingDownloads } from '@/composables/useMeetingDownloads'
import { useFileTranscription } from '@/composables/useFileTranscription'
import { buildSegmentRanges, resolveActiveSegmentSpeaker } from '@/utils/speech-segments'

const { t } = useI18n()
const message = useMessage()
const meetingStore = useMeetingStore()
const modelsStore = useModelsStore()
const profilesStore = useProfilesStore()
const realtimeModelStore = useRealtimeModelStore()

// --- 侧边栏状态 ---
const showSidebar = ref(true)

// 把 store 数据压扁成 MeetingSidebar 期望的最小结构（避免组件依赖 store 内部类型）
const sidebarSessions = computed<SidebarSession[]>(() =>
  meetingStore.sortedSessions.map((s) => ({
    id: s.id,
    title: s.title,
    updatedAt: s.updatedAt,
    sentencesCount: s.sentences.length,
    hasAnalysis: s.analysisResult !== null && s.analysisResult !== undefined,
  })),
)

// --- 创建会议对话框 ---
const showCreateModal = ref(false)
const newMeetingTitle = ref('')
const newMeetingAnalysisMode = ref<'hermes' | 'custom'>('hermes')
const newMeetingHermesProfile = ref('')
const newMeetingCustomProvider = ref('')
const newMeetingCustomModel = ref('')
const newMeetingSceneTemplate = ref<SceneId>('general')

// --- Agent 配置 ---
const newMeetingAgentType = ref<'hermes' | 'claude-code' | 'codex'>('hermes')
const newMeetingCodingAgentMode = ref<'scoped' | 'global'>('scoped')

// Agent 类型选项
const agentTypeOptions = computed(() => [
  { label: 'Hermes Agent', value: 'hermes', description: t('meeting.agentTypeHermesDesc') },
  { label: 'Claude Code', value: 'claude-code', description: t('meeting.agentTypeClaudeCodeDesc') },
  { label: 'Codex', value: 'codex', description: t('meeting.agentTypeCodexDesc') },
])

// Coding Agent 模式选项
const codingAgentModeOptions = computed(() => [
  { label: t('meeting.codingAgentModeScoped'), value: 'scoped', description: t('meeting.codingAgentModeScopedDesc') },
  { label: t('meeting.codingAgentModeGlobal'), value: 'global', description: t('meeting.codingAgentModeGlobalDesc') },
])

// --- ASR 配置 ---
// DashScope Key 由父级持有（"创建"按钮禁用条件需要响应式依赖它）；
// 其余向导字段（LLM/OSS/步骤/ASR 模型/ASR provider）由 AsrConfigWizardDialog
// 自持，通过 collectConfig() 取值、reset() 重播种。
// 未单独配置时默认回落 Realtime 模型面板里统一管理的千问 API Key。
const asrApiKey = ref(meetingStore.asrConfig.dashscopeApiKey || realtimeModelStore.config.apiKey)
const newMeetingAsrProvider = ref<'dashscope' | 'minimax'>(
  realtimeModelStore.config.asrProvider || meetingStore.asrConfig.asrProvider || 'dashscope',
)
const newMeetingMinimaxApiKey = ref(
  meetingStore.asrConfig.minimaxApiKey || realtimeModelStore.config.minimaxApiKey,
)
const asrWizardRef = ref<InstanceType<typeof AsrConfigWizardDialog> | null>(null)

// --- 当前会议状态 ---
const isLoading = ref(false)
const partialText = ref('')
const finalSentences = ref<TranscriptSentence[]>([])
const speakerMap = ref<Record<string, string>>({})
/** 隐藏说话人分离功能（产品需求：会议只显示 agent 对话，不展示说话人分离）。
 *  置 true 时：工具栏不显示 diarize 开关/节省模式/说话人数选择，且强制关闭
 *  说话人分离（转写不再带说话人标签）。改回 false 可恢复。 */
const HIDE_SPEAKER_DIARIZATION = true
/** 转写列表里的说话人标签始终显示：「拆分人声」/「直接音频转录」得到的结果
 *  必须可见、可点击重命名。实时工具栏的说话人分离控件仍由
 *  HIDE_SPEAKER_DIARIZATION 关闭——两者是独立的关注点。 */
const HIDE_TRANSCRIPT_SPEAKERS = false
const useDiarize = ref(false)
const saveMode = ref(true)  // 节省模式：只走说话人分离，不走实时ASR
const speakerCount = ref(0) // 0 = auto

const sentences = computed(() => finalSentences.value)

// --- 说话人数选项 ---
const speakerCountOptions = computed(() => [
  { label: t('meeting.speakerCountAuto'), value: 0 },
  { label: '2', value: 2 },
  { label: '3', value: 3 },
  { label: '4', value: 4 },
  { label: '5', value: 5 },
  { label: '6', value: 6 },
  { label: '7', value: 7 },
  { label: '8', value: 8 },
])

// --- 说话人重命名 ---

// --- ASR 服务状态 ---
const asrServiceStatus = ref({
  isRunning: false,
  asrPort: null as number | null,
  diarizePort: null as number | null,
  pid: null as number | null,
  uptime: null as number | null,
  error: null as string | null,
})
const isStartingASR = ref(false)
const asrServiceError = ref('')

// --- 分析相关 ---
const analysisResult = ref<any>(null)
const htmlContent = ref('')
const isAnalyzing = ref(false)
const analysisInterval = ref(30)
const analysisTriggerMode = ref<'sentences' | 'time' | 'both'>('sentences')
const analysisIntervalSentences = ref(10)
const agentStartAnalysisTrigger = ref(0)
const showReport = ref(false)
const showAnalysisConfig = ref(false)

// --- Agent 分析相关 ---
const showAgentPanel = ref(false)
const assistPanelRef = ref<InstanceType<typeof MeetingAgentPanel> | null>(null)

// --- 新建会议：采集方式选项卡（实时语音 / 直接音频转录） ---
// 「直接音频转录」不上麦克风，创建后把选中的整段音频交给 ASR 一次性识别。
const newMeetingCaptureMode = ref<'realtime' | 'file'>('realtime')
const directEngine = ref<'minimax' | 'qwen'>('minimax')
const directDiarize = ref(true)
const directSpeakerCount = ref(0)
const directFile = ref<File | null>(null)

// 「拆分人声」对话框（选择识别模型 / 说话人数 / Qwen 所需 OSS）
const showDiarizeDialog = ref(false)

// --- 音频录制/播放（拆分至 useMeetingAudio，行为保持不变） ---
const {
  isRecording,
  isConnecting,
  statusText,
  errorMessage,
  analyser,
  audioBlob,
  audioUrl,
  startRecording,
  stopRecording,
  isPlaying,
  playbackTime,
  playbackDuration,
  progressPercent,
  highlightedSentenceIndex,
  togglePlayPause,
  seekToSentence,
  seekToPosition,
  startProgressDrag,
  stopAudio,
} = useMeetingAudio({
  useDiarize,
  saveMode,
  speakerCount,
  asrServiceStatus,
  asrServiceError,
  openCreateModal,
  startASRService,
  handleWsMessage,
  saveCurrentMeeting,
  assistPanelRef,
  sentences: finalSentences,
})

// --- 说话人分离结果合并（拆分至 useDiarizeMerge，行为保持不变） ---
const { addDiarizeResultDirectly, matchAndMergeDiarizeResult, applyFileTranscriptionResult } = useDiarizeMerge({
  finalSentences,
  speakerMap,
  pushSentenceToAssist,
})

// --- 产物下载（拆分至 useMeetingDownloads，行为保持不变） ---
const { downloadAudio, downloadTranscript, downloadTranscriptMarkdown, downloadJson, downloadReport, formatDuration } = useMeetingDownloads({
  audioBlob,
  htmlContent,
})

// --- 整段音频转录（「拆分人声」按钮 / 直接音频转录 tab） ---
// 两个入口共用一个上传 + 轮询 + 合并流程：录音完成后按发言人重新标注，
// 或把上传的整段音频直接识别成会议转写。
const lastTranscribeWasDiarize = ref(true)
const { isTranscribing, progress: transcribeProgress, transcribe } = useFileTranscription({
  onComplete: async (result, options) => {
    const changed = applyFileTranscriptionResult(result.sentences, { diarize: !!options.diarize })
    const sessionId = meetingStore.activeSessionId
    if (sessionId) {
      meetingStore.updateSession(sessionId, {
        sentences: [...finalSentences.value],
        speakerMap: { ...speakerMap.value },
      })
    }
    await saveCurrentMeeting()
    if (changed > 0) {
      message.success(t(options.diarize ? 'meeting.diarizeDone' : 'meeting.directTranscribeDone'))
    } else {
      message.warning(t('meeting.diarizeNoNewSentences'))
    }
  },
  onError: (msg, status) => {
    const title = lastTranscribeWasDiarize.value
      ? t('meeting.diarizeFailed')
      : t('meeting.directTranscribeFailed')
    // 后端 502/503/任务丢失都来自「服务在识别过程中被重启」，给出可操作提示
    // 而不是甩一个裸 HTTP 码；原始细节留在控制台便于排查（含服务端 error/phase）。
    if (status === 503 || status === 502) {
      console.error('[meeting] transcribe backend unavailable:', msg)
      message.error(`${title}：${t('meeting.transcribeBackendUnavailable')}`)
      return
    }
    if (status === 404) {
      console.error('[meeting] transcribe job lost:', msg)
      message.error(`${title}：${t('meeting.transcribeJobLost')}`)
      return
    }
    message.error(`${title}：${msg}`)
  },
})

/** 当前会议用哪个 ASR 引擎（会话优先，其次全局配置）。 */
function activeTranscribeEngine(): 'minimax' | 'qwen' {
  const provider = meetingStore.activeSession?.asrProvider
    || meetingStore.asrConfig.asrProvider
    || 'dashscope'
  return provider === 'minimax' ? 'minimax' : 'qwen'
}

/**
 * 整段转录的后端能力版本（与 python-backend/app/main.py 的
 * `TRANSCRIBE_CAPABILITY` 保持一致）。改 `/api/transcribe` 契约时两边一起 +1。
 */
const TRANSCRIBE_CAPABILITY = '2'

/**
 * 确保整段转录的后端是「当前代码」。
 *
 * uvicorn 子进程在 spawn 时 import 一次模块，之后重建 dist / 刷新页面都不会
 * 让它重新加载 python-backend —— 这正是「已修复的 bug 仍然复现」的原因。
 * 这里探测 /healthz 的能力标记与代码 hash：
 *  - 都能对上 → 直接用；
 *  - 对不上（或探测失败）→ 主动 stop 一次，强制下次 start 重新 spawn。
 */
async function ensureTranscribeBackend(): Promise<boolean> {
  const status = await checkASRServiceStatus()
  if (!status?.isRunning) return startASRService()

  let stale = false
  try {
    const health = await meetingASRApi.healthCheck()
    if (String(health.transcribe || '') !== TRANSCRIBE_CAPABILITY) {
      stale = true
    } else if (status.codeHash && health.code_hash !== status.codeHash) {
      stale = true
    }
  } catch (err) {
    console.warn('[meeting] ASR capability probe failed; restarting service', err)
    stale = true
  }

  if (stale) {
    console.warn('[meeting] ASR backend is running stale code; restarting to reload python-backend')
    message.info(t('meeting.asrRestarting'))
    try {
      await meetingASRApi.stop()
      await checkASRServiceStatus()
    } catch (err) {
      console.warn('[meeting] failed to stop stale ASR service:', err)
    }
  }
  return startASRService()
}

/**
 * 把当前 ASR 凭据热推给已在运行的后端（不重启服务）。
 *
 * `startASRService()` 在「服务已运行且没有 OSS」时会直接返回、不下发配置；
 * 而整段转录允许临时切换引擎（会话 provider 与实际使用的 engine 可以不同），
 * 所以这里显式补一次凭据推送，避免后端缺少 MiniMax/DashScope key。
 */
async function pushTranscribeCredentials() {
  try {
    await meetingASRApi.updateConfig({
      dashscopeApiKey: meetingStore.asrConfig.dashscopeApiKey
        || asrApiKey.value
        || realtimeModelStore.config.apiKey,
      minimaxApiKey: meetingStore.asrConfig.minimaxApiKey
        || realtimeModelStore.config.minimaxApiKey,
      minimaxAsrModel: meetingStore.asrConfig.minimaxAsrModel
        || realtimeModelStore.config.minimaxAsrModel,
      minimaxBaseUrl: meetingStore.asrConfig.minimaxBaseUrl
        || realtimeModelStore.config.minimaxBaseUrl,
    })
  } catch (err) {
    console.warn('[meeting] failed to push transcribe credentials:', err)
  }
}

/**
 * 「拆分人声」：先让用户选识别模型（MiniMax / Qwen）与说话人数，
 * 再执行整段人声分离。Qwen 需要在对话框里补齐 OSS（公网音频 URL）。
 */
function openDiarizeDialog() {
  if (!audioBlob.value || !meetingStore.activeSessionId) {
    message.warning(t('meeting.diarizeNoAudio'))
    return
  }
  showDiarizeDialog.value = true
}

/** 对话框确认后：落库 OSS（若有改动）→ 确保 ASR 服务按新配置启动 → 开始整段分离。 */
async function onDiarizeStart(payload: { engine: DiarizeEngine; speakerCount: number; oss: DiarizeOssConfig }) {
  showDiarizeDialog.value = false
  const sessionId = meetingStore.activeSessionId
  if (!audioBlob.value || !sessionId) return

  if (payload.engine === 'qwen') {
    meetingStore.updateASRConfig({
      ossBucket: payload.oss.bucket,
      ossAccessKeyId: payload.oss.accessKeyId,
      ossAccessKeySecret: payload.oss.accessKeySecret,
      ossEndpoint: payload.oss.endpoint,
      ossPathPrefix: payload.oss.pathPrefix,
    })
  }

  // 文件转录走 Node → Python ASR 后端，服务必须先起来；带 OSS 配置启动会
  // 触发后端重启以读取新的 OSS 凭据，代码版本不一致时也会自动重启。
  if (!(await ensureTranscribeBackend())) return
  await pushTranscribeCredentials()
  lastTranscribeWasDiarize.value = true
  await transcribe(audioBlob.value, {
    engine: payload.engine,
    diarize: true,
    speakerCount: payload.speakerCount || 0,
    sessionId,
  })
}

/**
 * 「直接音频转录」：新建会议时选中的整段音频立即开始识别，并把音频落库，
 * 让后续的播放 / 下载音频按钮对这类会议同样可用。
 */
async function runDirectTranscription(sessionId: string, file: File) {
  if (!(await ensureTranscribeBackend())) return
  await pushTranscribeCredentials()
  meetingStorageApi.uploadAudio(sessionId, file).catch((err) => {
    console.warn('[meeting] failed to persist uploaded audio:', err)
  })
  audioBlob.value = file
  audioUrl.value = URL.createObjectURL(file)
  lastTranscribeWasDiarize.value = false
  await transcribe(file, {
    engine: directEngine.value,
    diarize: directDiarize.value,
    speakerCount: directSpeakerCount.value || 0,
    sessionId,
  })
}

/** 创建按钮禁用条件：实时语音看 ASR Key，直接音频转录看引擎 Key + 是否选了文件。 */
const createMeetingDisabled = computed(() => {
  if (!newMeetingTitle.value.trim()) return true
  if (newMeetingCaptureMode.value === 'realtime') {
    return newMeetingAsrProvider.value === 'dashscope'
      ? (!asrApiKey.value.trim() && !meetingStore.hasASRConfig && !realtimeModelStore.hasApiKey)
      : (!newMeetingMinimaxApiKey.value.trim() && !realtimeModelStore.config.minimaxApiKey)
  }
  if (!directFile.value) return true
  if (directEngine.value === 'minimax') {
    return !(
      newMeetingMinimaxApiKey.value.trim()
      || meetingStore.asrConfig.minimaxApiKey
      || realtimeModelStore.config.minimaxApiKey
    )
  }
  return !asrApiKey.value.trim() && !meetingStore.hasASRConfig && !realtimeModelStore.hasApiKey
})

/**
 * 顶栏「导出会议文字」：把当前会议的 ASR 逐字稿导出为排版美观的 Markdown
 * （会议信息 / 说话人 / 带时间戳逐字稿 / 全文 / AI 分析 / 实时分析记录）。
 */
function exportMeetingTranscript() {
  if (!downloadTranscriptMarkdown()) {
    message.warning(t('meeting.noTranscript'))
  }
}

// 当前活动会议
const activeSession = computed(() => meetingStore.activeSession)

// 演讲评分场景：右侧面板切换为专用评估面板（计时员/赘语记录员/语法官）
const isSpeechScene = computed(() => activeSession.value?.sceneTemplate === 'speech')
const isLegalScene = computed(() => activeSession.value?.sceneTemplate === 'legal')
const isInterviewScene = computed(() => activeSession.value?.sceneTemplate === 'interview')

// 场景 UI 注册表：舞台浮层/状态条按 sceneTemplate 声明式渲染（演讲场景的
// 计时器浮层与状态条已组件化至 scene-ui-registry）
const sceneUI = computed(() => SCENE_UI[normalizeSceneId(activeSession.value?.sceneTemplate)])

// 共享计时器（与右侧演讲评估面板/场景组件同步——单例状态）。
// 视图侧只保留生命周期职责：阈值同步、切会话重置、页面卸载停表；
// 展示（浮层/状态条）由注册表组件自行从单例读取。
const activeSpeechEval = computed<SpeechEvalState>(() => ({
  ...DEFAULT_EVAL,
  ...(activeSession.value?.speechEval || {}),
}))

function persistSpeechEval(patch: Partial<SpeechEvalState>) {
  const id = activeSession.value?.id
  if (id) meetingStore.updateSession(id, { speechEval: { ...activeSpeechEval.value, ...patch } })
}

// 计时器唯一实例由 MeetingView 创建并向下 provide：
// 舞台浮层（唯一操控面）与右栏记录面板共享同一份状态与副作用。
// 注意：provideSpeechTimer 返回 reactive 包装，不能解构 timerRunning（会丢失响应性）；
// 必须保留对象引用，通过 speechTimer.timerRunning 访问。
const speechTimer = provideSpeechTimer({
  evalState: activeSpeechEval,
  persist: persistSpeechEval,
  // 计时器启动前必须先确认录音已就绪（录音启动需要数秒：麦克风检测、ASR 服务、WebSocket 握手）
  // 返回 false 则中止计时器启动；录音失败时用户会看到 errorMessage
  onBeforeStart: async () => {
    if (isRecording.value) return true // 已在录音，直接放行
    if (isConnecting.value) return false // 正在连接中，等待用户手动重试
    await startRecording()
    return isRecording.value
  },
})
const speechPhase = computed(() => speechTimer.phase)
const setSpeechTimerThresholds = speechTimer.setThresholds
const resetSpeechTimer = speechTimer.reset
const stopSpeechTimer = speechTimer.stop

const speechEval = activeSpeechEval

// 演讲会话的计时阈值变更时同步共享计时器
watch(speechEval, (st) => {
  if (st) {
    setSpeechTimerThresholds({
      durationSec: st.timerDurationSec,
      yellowAtSec: st.yellowAtSec,
      redAtSec: st.redAtSec,
    })
  }
}, { deep: true, immediate: true })

// 切换到演讲会话时重置计时器（与右侧面板一致）
watch(() => activeSession.value?.id, (id) => {
  if (id) resetSpeechTimer()
})

// --- AI 自动命名会议标题 ---
// 触发两次：1) 录音中首个实时分析轮次到达（先用当前转写取个初步标题）；
// 2) 最终 AI 分析/报告生成完成（用报告开头 AI 输出的一级标题定稿）。
// 只覆盖“会议 + 时间”这类占位标题；用户手动命名的会议一律不被覆盖。
const aiAutoNamedSessions = new Set<string>()

function persistAiMeetingTitle(sessionId: string, title: string) {
  const session = meetingStore.sessions.find(s => s.id === sessionId)
  if (!session || !title) return
  meetingStore.updateSession(sessionId, { title, titleAutoNamed: true })
  // 同步到服务端（仅当该会议已在服务端落库，避免为纯本地会议创建空壳）
  meetingStorageApi.updateMeetingTitle(sessionId, title).catch(() => {})
}

async function autoNameOnFirstAnalysis(sessionId: string) {
  const session = meetingStore.sessions.find(s => s.id === sessionId)
  if (!session) return
  if (!canAutoRenameMeeting(session)) return
  if (!session.sentences.length) return
  const title = await requestAiMeetingTitle(formatTranscriptForTitle(session.sentences))
  if (!title) return
  // 等待网络期间用户可能切走/删除了该会议，回来时再校验一次
  const cur = meetingStore.sessions.find(s => s.id === sessionId)
  if (!cur || !canAutoRenameMeeting(cur)) return
  persistAiMeetingTitle(sessionId, title)
}

// 首个实时分析轮次（analysisRounds 0 → >0）到达即触发初步命名；每个会议至多触发一次。
// 用数组作为 watch 源，只在 sessionId 或轮次数变化时回调，避免对每句转写都触发。
watch(
  () => [meetingStore.activeSessionId, meetingStore.activeSession?.analysisRounds?.length ?? 0] as [string | null, number],
  ([id, rounds], [prevId, prevRounds]) => {
    if (!id || prevId !== id) return // 会话切换/首次挂载：只建立基线，不触发
    if (rounds > 0 && (prevRounds ?? 0) === 0 && !aiAutoNamedSessions.has(id)) {
      aiAutoNamedSessions.add(id)
      void autoNameOnFirstAnalysis(id)
    }
  },
)

// 报告生成完成回调
function onReportGenerated(markdown: string) {
  const sessionId = meetingStore.activeSessionId
  if (!sessionId) return
  meetingStore.updateSession(sessionId, { htmlContent: markdown })
  // 最终 AI 分析完成：若标题仍是占位/此前由 AI 命名，则用报告标题定稿
  const session = meetingStore.sessions.find(s => s.id === sessionId)
  if (session && canAutoRenameMeeting(session)) {
    const title = extractMeetingTitleFromReport(markdown)
    if (title) persistAiMeetingTitle(sessionId, title)
  }
}

// 手动请求生成报告
function onRequestReport() {
  const session = meetingStore.activeSession
  console.log('[report] onRequestReport:', {
    hasSession: !!session,
    sentencesCount: session?.sentences.length ?? 0,
    hasPanelRef: !!assistPanelRef.value,
  })
  if (session && session.sentences.length > 0 && assistPanelRef.value) {
    const transcript = session.sentences
      .map(s => `${s.speaker ? `[${s.speaker}] ` : ''}${s.text}`)
      .join('\n')
    console.log('[report] calling generateReport, transcript length:', transcript.length)
    assistPanelRef.value.generateReport(transcript)
  } else {
    console.warn('[report] guard failed, report not generated')
  }
}

// --- 右侧面板 ---
const showRightPanel = ref(true)
// 拖拽调宽逻辑（拆分至 useDraggableWidth，行为保持不变）
const { style: rightPanelStyle, startResize: startRightPanelResize } = useDraggableWidth({
  storageKey: 'hermes.meeting.rightPanelWidth',
  minWidth: 280,
  maxWidth: 600,
  defaultWidth: 360,
})

// --- 模型选择相关 ---
const profileOptions = computed(() => {
  return profilesStore.profiles.map(p => ({
    label: getProfileDisplayName(p),
    value: p.name,
  }))
})

const providerOptions = computed(() => {
  return modelsStore.providers
    .filter(g => g.models.length > 0)
    .map(g => ({
      label: g.label || g.provider,
      value: g.provider,
    }))
})

const modelOptions = computed(() => {
  if (!newMeetingCustomProvider.value) return []
  const group = modelsStore.providers.find(g => g.provider === newMeetingCustomProvider.value)
  if (!group) return []
  return group.models.map(m => ({
    label: m,
    value: m,
  }))
})

// --- 会议管理 ---
function openCreateModal() {
  newMeetingTitle.value = `会议 ${new Date().toLocaleString('zh-CN')}`
  newMeetingAnalysisMode.value = 'hermes'
  newMeetingHermesProfile.value = profilesStore.activeProfileName || 'default'
  newMeetingCustomProvider.value = ''
  newMeetingCustomModel.value = ''
  newMeetingAgentType.value = 'hermes'
  newMeetingCodingAgentMode.value = 'scoped'
  newMeetingSceneTemplate.value = 'general'
  asrApiKey.value = meetingStore.asrConfig.dashscopeApiKey || realtimeModelStore.config.apiKey
  newMeetingAsrProvider.value = realtimeModelStore.config.asrProvider
    || meetingStore.asrConfig.asrProvider
    || 'dashscope'
  newMeetingMinimaxApiKey.value = meetingStore.asrConfig.minimaxApiKey
    || realtimeModelStore.config.minimaxApiKey
  // 采集方式回落到实时语音；直接音频转录的引擎默认跟随当前 ASR provider。
  // Qwen 引擎不支持区分人声，因此开关只对 MiniMax 预置为开。
  newMeetingCaptureMode.value = 'realtime'
  directEngine.value = newMeetingAsrProvider.value === 'minimax' ? 'minimax' : 'qwen'
  directDiarize.value = directEngine.value === 'minimax'
  directSpeakerCount.value = 0
  directFile.value = null
  // LLM/OSS/步骤的重播种已随向导拆入 AsrConfigWizardDialog
  asrWizardRef.value?.reset()
  showCreateModal.value = true
}

function handleCreateMeeting() {
  if (!newMeetingTitle.value.trim()) return
  const captureMode = newMeetingCaptureMode.value
  const wizard = asrWizardRef.value?.collectConfig()
  // 直接音频转录 tab 用自己选的引擎；实时语音 tab 沿用 ASR 向导的 provider。
  const asrProvider: 'dashscope' | 'minimax' = captureMode === 'file'
    ? (directEngine.value === 'minimax' ? 'minimax' : 'dashscope')
    : (wizard?.asrProvider || 'dashscope')
  const minimaxApiKey = (captureMode === 'file'
    ? (newMeetingMinimaxApiKey.value || wizard?.minimaxApiKey || '')
    : (wizard?.minimaxApiKey ?? '')).trim()
  // ASR 准入校验：DashScope 走 DashScope Key（store / realtime 面板回落），
  // MiniMax 走 MiniMax Key；两个 provider 不能混用同一个 key 字段。
  if (asrProvider === 'dashscope'
    && !asrApiKey.value.trim()
    && !meetingStore.hasASRConfig
    && !realtimeModelStore.hasApiKey) return
  if (asrProvider === 'minimax'
    && !minimaxApiKey
    && !(meetingStore.asrConfig.asrProvider === 'minimax' && meetingStore.asrConfig.minimaxApiKey)
    && !realtimeModelStore.config.minimaxApiKey) return

  // 保存 ASR provider 与 DashScope / MiniMax Key
  meetingStore.updateASRConfig({
    asrProvider,
    dashscopeApiKey: asrApiKey.value.trim() || meetingStore.asrConfig.dashscopeApiKey,
    minimaxApiKey: minimaxApiKey || meetingStore.asrConfig.minimaxApiKey,
    minimaxAsrModel: realtimeModelStore.config.minimaxAsrModel,
    minimaxBaseUrl: realtimeModelStore.config.minimaxBaseUrl,
  })

  // 保存 LLM 配置（可选 — 没填也不阻塞创建）
  const wizardLlmApiKey = wizard?.llmApiKey ?? ''
  const wizardLlmBaseUrl = wizard?.llmBaseUrl ?? ''
  const wizardLlmModel = wizard?.llmModel ?? ''
  if (wizardLlmApiKey.trim() || wizardLlmBaseUrl.trim() || wizardLlmModel.trim()) {
    meetingStore.updateASRConfig({
      llmApiKey: wizardLlmApiKey.trim(),
      llmBaseUrl: wizardLlmBaseUrl.trim() || 'https://api.deepseek.com',
      llmModel: wizardLlmModel.trim() || 'deepseek-chat',
    })
  }
  // 保存 OSS 配置（说话人分离用，可选）
  const wizardOssBucket = wizard?.ossBucket ?? ''
  const wizardOssAccessKeyId = wizard?.ossAccessKeyId ?? ''
  const wizardOssAccessKeySecret = wizard?.ossAccessKeySecret ?? ''
  if (wizardOssBucket.trim() || wizardOssAccessKeyId.trim() || wizardOssAccessKeySecret.trim()) {
    meetingStore.updateASRConfig({
      ossBucket: wizardOssBucket.trim(),
      ossAccessKeyId: wizardOssAccessKeyId.trim(),
      ossAccessKeySecret: wizardOssAccessKeySecret.trim(),
      ossEndpoint: (wizard?.ossEndpoint ?? '').trim() || 'oss-cn-beijing.aliyuncs.com',
      ossPathPrefix: (wizard?.ossPathPrefix ?? '').trim() || 'meeting-asr-uploads/',
    })
  }
   
  // 分析模式：默认 Agent（hermes）直接调用 Hermes Agent 的 Agent 功能生成
  // 会议纪要、关键要点、待办事项，无需额外 LLM 配置；自定义模式（custom）
  // 走下方填写的 LLM API Key / Base URL / 模型
  const analysisMode = newMeetingAnalysisMode.value
  // 使用默认 Agent 时固定用 Hermes Agent（默认配置），不受 Agent 类型选择影响
  const effectiveAgentType = analysisMode === 'hermes' ? 'hermes' : newMeetingAgentType.value
   
  // 构建 Agent 配置
  const agentConfig: AgentConfig = {
    agentType: effectiveAgentType,
    codingAgentMode: newMeetingCodingAgentMode.value,
  }
   
  // 根据 Agent 类型设置配置
  if (effectiveAgentType === 'hermes') {
    agentConfig.profile = newMeetingHermesProfile.value || 'default'
  } else {
    // Coding Agent (claude-code, codex)
    if (newMeetingCodingAgentMode.value === 'scoped') {
      agentConfig.provider = newMeetingCustomProvider.value
      agentConfig.model = newMeetingCustomModel.value
    }
  }
   
  meetingStore.createSession({
    title: newMeetingTitle.value.trim(),
    asrModel: asrWizardRef.value?.collectConfig()?.asrModel || 'paraformer-v2',
    asrProvider,
    analysisMode,
    hermesProfile: effectiveAgentType === 'hermes' ? (newMeetingHermesProfile.value || 'default') : undefined,
    customProvider: effectiveAgentType !== 'hermes' && newMeetingCodingAgentMode.value === 'scoped' ? newMeetingCustomProvider.value : undefined,
    customModel: effectiveAgentType !== 'hermes' && newMeetingCodingAgentMode.value === 'scoped' ? newMeetingCustomModel.value : undefined,
    agentConfig,
    sceneTemplate: newMeetingSceneTemplate.value,
  })

  resetMeetingState()
  showCreateModal.value = false

  // 直接音频转录：创建后立刻把选中的整段音频送去识别
  const createdSessionId = meetingStore.activeSessionId
  const pickedFile = captureMode === 'file' ? directFile.value : null
  if (captureMode === 'file' && pickedFile && createdSessionId) {
    void runDirectTranscription(createdSessionId, pickedFile)
  }
}

// MeetingSidebar 只传 sessionId；这里把它查回 store 中的完整 session，再走原 loadMeeting。
function selectMeetingById(sessionId: string) {
  const session = meetingStore.sortedSessions.find((s) => s.id === sessionId)
  if (session) loadMeeting(session)
}

async function loadMeeting(session: MeetingSession) {
  if (isRecording.value) {
    stopRecording()
  }
  meetingStore.setActiveSession(session.id)
  
  // 从服务器加载数据
  try {
    const serverData = await meetingStorageApi.getMeeting(session.id)
    if (serverData) {
      finalSentences.value = serverData.sentences || []
      analysisResult.value = serverData.analysisResult
      htmlContent.value = serverData.htmlContent || ''
      speakerMap.value = serverData.speakerMap || {}
      useDiarize.value = HIDE_SPEAKER_DIARIZATION ? false : (serverData.useDiarize || false)
    } else {
      // 如果服务器没有数据，使用本地数据
      finalSentences.value = [...session.sentences]
      analysisResult.value = session.analysisResult
      htmlContent.value = session.htmlContent
      speakerMap.value = { ...session.speakerMap }
      useDiarize.value = HIDE_SPEAKER_DIARIZATION ? false : session.useDiarize
    }
  } catch (err) {
    console.error('Failed to load meeting from server:', err)
    // 回退到本地数据
    finalSentences.value = [...session.sentences]
    analysisResult.value = session.analysisResult
    htmlContent.value = session.htmlContent
    speakerMap.value = { ...session.speakerMap }
    useDiarize.value = HIDE_SPEAKER_DIARIZATION ? false : session.useDiarize
  }
  
  // 同步句子到 store（供 Agent 面板读取）
  meetingStore.updateSession(session.id, {
    sentences: [...finalSentences.value],
    analysisResult: analysisResult.value,
    htmlContent: htmlContent.value,
    speakerMap: { ...speakerMap.value },
    useDiarize: useDiarize.value,
  })
  
  partialText.value = ''
  errorMessage.value = ''
  highlightedSentenceIndex.value = -1
  stopAudio()
  
  // 加载音频数据
  await loadAudioForSession(session.id)
}

async function loadAudioForSession(sessionId: string) {
  try {
    // 从服务器加载音频
    const blob = await meetingStorageApi.downloadAudio(sessionId)
    if (blob) {
      audioBlob.value = blob
      audioUrl.value = URL.createObjectURL(blob)
      return
    }
  } catch (err) {
    console.error('Failed to load audio from server:', err)
  }
  
  // 回退到 IndexedDB
  const blob = await meetingStore.getAudioBlob(sessionId)
  if (blob) {
    audioBlob.value = blob
    audioUrl.value = URL.createObjectURL(blob)
  } else {
    audioBlob.value = null
    audioUrl.value = ''
  }
}

async function deleteMeeting(id: string) {
  try {
    // 删除服务器端数据
    await meetingStorageApi.deleteMeeting(id)
  } catch (err) {
    console.error('Failed to delete meeting from server:', err)
  }
  
  // 删除本地数据
  meetingStore.deleteSession(id)
  if (meetingStore.activeSessionId === id) {
    resetMeetingState()
  }
}

function resetMeetingState() {
  finalSentences.value = []
  analysisResult.value = null
  htmlContent.value = ''
  speakerMap.value = {}
  partialText.value = ''
  errorMessage.value = ''
  isRecording.value = false
  isConnecting.value = false
  statusText.value = ''
  highlightedSentenceIndex.value = -1
  stopAudio()
}

async function saveCurrentMeeting() {
  if (!meetingStore.activeSessionId) return
  
  const sessionData = {
    sentences: [...finalSentences.value],
    analysisResult: analysisResult.value,
    htmlContent: htmlContent.value,
    speakerMap: { ...speakerMap.value },
    useDiarize: useDiarize.value,
    status: isRecording.value ? 'recording' as const : 'completed' as const,
  }
  
  // 保存到本地 store
  meetingStore.updateSession(meetingStore.activeSessionId, sessionData)
  
  // 保存到服务器
  try {
    const meetingId = meetingStore.activeSessionId
    const meeting = meetingStore.activeSession
    
    if (meeting) {
      await meetingStorageApi.saveMeeting(meetingId, {
        ...meeting,
        ...sessionData,
      })
      
      // 保存转写内容
      if (finalSentences.value.length > 0) {
        await meetingStorageApi.saveTranscript(meetingId, finalSentences.value)
      }
    }
  } catch (err) {
    console.error('Failed to save meeting to server:', err)
    // 本地 store 与 IndexedDB 音频备份仍然有效，但服务端没有这份数据——
    // 用户换设备 / 清浏览器数据后会丢，必须让用户知道而不是静默失败。
    message.error(t('meeting.errorSaveMeetingFailed'))
  }
}

// --- 说话人重命名 ---
// TranscriptList 负责 UI state（弹窗开合/输入框），这里只做持久化。
function onTranscriptRename(speakerId: string, name: string) {
  if (!meetingStore.activeSessionId) return
  meetingStore.renameSpeaker(meetingStore.activeSessionId, speakerId, name)
  const session = meetingStore.activeSession
  if (session) {
    finalSentences.value = [...session.sentences]
    speakerMap.value = { ...session.speakerMap }
  }
  // 必须同步到服务端：loadMeeting 优先读服务端数据，只改 localStorage 的话
  // 刷新页面就会把重命名回滚掉。
  void saveCurrentMeeting()
}

// --- ASR 服务管理 ---
async function checkASRServiceStatus() {
  try {
    const status = await meetingASRApi.getStatus()
    asrServiceStatus.value = status
    return status
  } catch (err) {
    console.error('Failed to check ASR service status:', err)
    return null
  }
}

async function startASRService() {
  // Check both the persisted store AND the current wizard input — when
  // the browser origin changes (different dev port, incognito, etc.)
  // localStorage is empty but the user may have just re-entered OSS config
  // in the wizard. Without checking the wizard we'd skip restart and
  // keep using the already-running (OSS-less) service.
  const wizard = asrWizardRef.value?.collectConfig()
  const hasOSS =
    meetingStore.asrConfig.ossBucket || (wizard?.ossBucket ?? '').trim() ||
    meetingStore.asrConfig.ossAccessKeyId || (wizard?.ossAccessKeyId ?? '').trim() ||
    meetingStore.asrConfig.ossAccessKeySecret || (wizard?.ossAccessKeySecret ?? '').trim()
  if (asrServiceStatus.value.isRunning && !hasOSS) return true

  isStartingASR.value = true
  asrServiceError.value = ''
  // Reflect the most useful startup hint we have before the call returns.
  // The service exposes finer-grained phases (venv / pip_install / starting)
  // via /status, but those update asynchronously after this coroutine yields,
  // so we pick a phase copy that stays accurate for the full call window.
  statusText.value = t('meeting.startup.starting')

  try {
    // Get ASR config from meeting store and current session
    const activeSession = meetingStore.activeSession
    const asrProvider = activeSession?.asrProvider
      || meetingStore.asrConfig.asrProvider
      || 'dashscope'
    const config: Record<string, unknown> = {
      asrProvider,
      asrModel: activeSession?.asrModel || 'paraformer-v2',
    }
    // DashScope provider → 需要 DashScope Key（store / realtime 面板回落）
    if (asrProvider === 'dashscope') {
      config.dashscopeApiKey = meetingStore.asrConfig.dashscopeApiKey
        || asrApiKey.value
        || realtimeModelStore.config.apiKey
    }
    // MiniMax 凭据与会话 provider 解耦：整段「拆分人声」对话框允许临时切到
    // MiniMax（会话本身可能是 DashScope），所以只要手上有 key/模型就一并下发给
    // 后端 —— 后端按每个请求的 engine 路由，多带一份凭据没有副作用。
    const minimaxKey = meetingStore.asrConfig.minimaxApiKey
      || newMeetingMinimaxApiKey.value.trim()
      || realtimeModelStore.config.minimaxApiKey
    if (minimaxKey) config.minimaxApiKey = minimaxKey
    config.minimaxAsrModel = meetingStore.asrConfig.minimaxAsrModel
      || realtimeModelStore.config.minimaxAsrModel
    config.minimaxBaseUrl = meetingStore.asrConfig.minimaxBaseUrl
      || realtimeModelStore.config.minimaxBaseUrl
    // Pass LLM config if user provided it, so backend has it from the start.
    if (meetingStore.asrConfig.llmApiKey || wizard?.llmApiKey) {
      config.llmApiKey = meetingStore.asrConfig.llmApiKey || wizard?.llmApiKey
      config.llmBaseUrl = meetingStore.asrConfig.llmBaseUrl || wizard?.llmBaseUrl
      config.llmModel = meetingStore.asrConfig.llmModel || wizard?.llmModel
    }
    // Pass OSS config if user configured it (speaker diarization chunk flow).
    // Fallback to the current wizard input when the persisted store
    // is empty — without this, edits made in the wizard that haven't yet been
    // flushed via updateASRConfig() would silently get dropped on the wire.
    const store = meetingStore.asrConfig
    const ossBucketValue = store.ossBucket || (wizard?.ossBucket ?? '').trim()
    const ossAccessKeyIdValue = store.ossAccessKeyId || (wizard?.ossAccessKeyId ?? '').trim()
    const ossAccessKeySecretValue = store.ossAccessKeySecret || (wizard?.ossAccessKeySecret ?? '').trim()
    if (ossBucketValue || ossAccessKeyIdValue || ossAccessKeySecretValue) {
      config.ossBucket = ossBucketValue
      config.ossAccessKeyId = ossAccessKeyIdValue
      config.ossAccessKeySecret = ossAccessKeySecretValue
      config.ossEndpoint = store.ossEndpoint || (wizard?.ossEndpoint ?? '').trim() || 'oss-cn-beijing.aliyuncs.com'
      config.ossPathPrefix = store.ossPathPrefix || (wizard?.ossPathPrefix ?? '').trim() || 'meeting-asr-uploads/'
    }

    console.log('[meeting] Calling ASR start API with config:', {
      ...config,
      dashscopeApiKey: config.dashscopeApiKey ? '***' : 'not set',
      minimaxApiKey: config.minimaxApiKey ? '***' : 'not set',
    })
    const result = await meetingASRApi.start(config)
    console.log('[meeting] ASR start result:', result)

    if (result.status === 'started' || result.status === 'already_running') {
      asrServiceStatus.value = {
        isRunning: true,
        asrPort: result.asrPort,
        diarizePort: result.diarizePort,
        pid: result.pid,
        uptime: result.uptime,
        error: null,
      }
      return true
    } else {
      asrServiceError.value = result.error || t('meeting.startup.error')
      console.error('[meeting] ASR service failed to start:', asrServiceError.value)
      message.error(asrServiceError.value)
      return false
    }
  } catch (err: any) {
    // Backend annotates hot-config push failures with a "config push failed:"
    // prefix (see MeetingASRService.start). Detect that distinctly so the user
    // knows their updated key did not take effect — previously this was
    // swallowed and the wrong key kept being used.
    const raw = err?.message || String(err)
    if (raw.includes('config push failed')) {
      asrServiceError.value = t('meeting.errorConfigUpdateFailed')
    } else if (/not running|not ready|timeout/i.test(raw)) {
      asrServiceError.value = t('meeting.errorServiceNotReady')
    } else {
      asrServiceError.value = raw || t('meeting.startup.error')
    }
    console.error('[meeting] ASR service start error:', err)
    message.error(asrServiceError.value)
    return false
  } finally {
    isStartingASR.value = false
  }
}

// --- 生命周期 ---
onMounted(async () => {
  // 加载模型和配置
  await profilesStore.fetchProfiles()
  await modelsStore.fetchProviders()
  
  // 检查 ASR 服务状态
  await checkASRServiceStatus()

  // 同步服务端会议列表 (触摸屏设备端创建的会议, 合并进侧边栏)
  await meetingStore.syncSessionsFromServer()
  
  // 如果有活跃会议，加载它
  if (meetingStore.activeSession) {
    loadMeeting(meetingStore.activeSession)
  }
  // 不再默认打开新建会议弹窗，用户需要点击"新建会议"按钮
})

onUnmounted(() => {
  stopRecording()
  stopSpeechTimer()
  // Note: We don't stop the ASR service on unmount as it should persist across page navigations
})

// 推送句子到实时辅助服务（fire-and-forget）
function pushSentenceToAssist(sessionId: string, sentence: TranscriptSentence) {
  fetch('/api/studio/meeting-asr/assist/sentence', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(getApiKey() ? { Authorization: `Bearer ${getApiKey()}` } : {}),
    },
    body: JSON.stringify({
      sessionId,
      speaker: sentence.speaker,
      text: sentence.text,
      timestamp: sentence.timestamp,
    }),
  }).catch(() => { /* best effort */ })
}

function handleWsMessage(data: any, source: 'asr' | 'diarize' = 'asr') {
  switch (data.type) {
    case 'ready':
      console.log(`[${source}] Session ready:`, data.session_id || data.task_id)
      break
    case 'started':
      if (source === 'asr') {
        statusText.value = t('meeting.recording')
      }
      break
    case 'partial':
      if (source === 'asr') {
        partialText.value = data.text || ''
      }
      break
    case 'final':
      // ASR实时转写结果 - 无说话人标签
      if (source === 'asr' && data.text) {
        const nowMs = Date.now()
        // 演讲场景：按当前 timerLabel / 已记录环节用时反查 speaker；
        // 非演讲场景 / 计时器停止 / 标签空：speaker 留空（保持原行为）
        let activeSpeaker = ''
        if (isSpeechScene.value && speechTimer.timerRunning) {
          const ranges = buildSegmentRanges(activeSpeechEval.value.timerRecords || [])
          activeSpeaker = resolveActiveSegmentSpeaker(
            speechTimer.timerLabel,
            ranges,
            nowMs,
            '',
          )
        }
        const sentence: TranscriptSentence = {
          text: data.text,
          timestamp: nowMs,
          startTime: data.begin_time,
          endTime: data.end_time,
          ...(activeSpeaker ? { speaker: activeSpeaker } : {}),
        }
        finalSentences.value.push(sentence)
        partialText.value = ''
        
        // 保存到 store
        if (meetingStore.activeSessionId) {
          meetingStore.addSentence(meetingStore.activeSessionId, sentence)
        }
        
        // 推送到实时辅助服务
        // 演讲场景：仅在计时器走表时推送（计时器停止 = 演讲者间隙，不做分析）
        // 其他场景：始终推送
        if (meetingStore.activeSessionId) {
          if (!isSpeechScene.value || speechTimer.timerRunning) {
            pushSentenceToAssist(meetingStore.activeSessionId, sentence)
          }
        }
        
        // 自动滚动到底部
        nextTick(() => {
          const container = document.getElementById('transcript-container')
          if (container) container.scrollTop = container.scrollHeight
        })
      }
      break
    case 'transcript':
      // 说话人分离结果
      if (source === 'diarize' && data.sentences) {
        const offsetSec = data.offset_sec || 0
        const isSaveMode = useDiarize.value && saveMode.value
        
        if (isSaveMode) {
          // 节省模式：直接添加结果（带说话人标签）
          addDiarizeResultDirectly(data.sentences, offsetSec)
        } else {
          // 正常模式：匹配回填到已有ASR句子
          matchAndMergeDiarizeResult(data.sentences, offsetSec)
        }
      }
      break
    case 'chunk_queued':
    case 'chunk_submitted':
      // 说话人分离进度提示（可选显示）
      if (source === 'diarize') {
        console.log(`[diarize] Chunk ${data.chunk_index} processing...`)
      }
      break
    case 'error':
      if (source === 'asr') {
        // 后端 ASR 服务目前只 emit 错误文本（realtime-assist.ts:200），所以 data
        // 经常是字符串而不是对象；这里三种形态都兼容：字符串本身、空字符串、
        // { message: '' }。空 message 多半是 ASR 进程崩溃 / 未启动，此时让用户看到
        // 'service not ready' 比 'unknown error' 更可操作。
        const rawMessage =
          typeof data === 'string'
            ? data
            : (data?.message as string | undefined) ?? ''
        const trimmed = rawMessage.trim()
        errorMessage.value = trimmed || t('meeting.errorServiceNotReady')
        stopRecording()
      } else {
        // Diarize错误只记录日志，不中断录音
        console.error('[diarize] Error:', data.message)
      }
      break
    case 'stopped':
      if (source === 'asr') {
        stopRecording()
      }
      break
  }
}

function onAgentCompleted() {
  // 分析完成后自动切换到报告视图
  if (htmlContent.value) {
    showAgentPanel.value = false
  }
}

function onAgentCorrected(corrected: any[]) {
  // 更新本地字幕
  finalSentences.value = [...corrected]
}

// --- Agent 面板事件处理（meeting 分支合并） ---
function onAgentAnalysisResult(result: any) {
  analysisResult.value = result
  // 保存到 store
  if (meetingStore.activeSessionId) {
    meetingStore.updateAnalysis(meetingStore.activeSessionId, result)
  }
}

function onAgentReportHtml(html: string) {
  htmlContent.value = html
  // 保存到 store
  if (meetingStore.activeSessionId) {
    meetingStore.updateHtmlContent(meetingStore.activeSessionId, html)
  }
}

// --- Hermes Agent 分析 ---
async function analyzeWithHermesAgent() {
  if (!meetingStore.activeSession) return
  
  const session = meetingStore.activeSession
  
  // 构建带说话人信息的转写内容
  const transcriptLines = session.sentences.map(s => {
    const speaker = s.speaker ? `[${s.speaker}] ` : ''
    return `${speaker}${s.text}`
  })
  const transcript = transcriptLines.join('\n')
  
  if (!transcript.trim()) {
    errorMessage.value = t('meeting.noTranscript')
    return
  }
  
  // 切换到 Agent 面板并触发报告生成
  showAgentPanel.value = true
  await nextTick()
  if (assistPanelRef.value) {
    assistPanelRef.value.generateReport(transcript)
  }
}

// --- Action item formatters (support both string and object forms) ---
function formatActionItem(item: any): string {
  if (item == null) return ''
  if (typeof item === 'string') return item
  return item.task || item.text || ''
}

function formatActionAssignee(item: any): string {
  if (item && typeof item === 'object') return item.assignee || ''
  return ''
}

function formatActionDeadline(item: any): string {
  if (item && typeof item === 'object') return item.deadline || ''
  return ''
}

// 声浪可视化已迁移到 <WaveformCanvas>，本组件只保留 analyser ref 与录音控制。

// --- 分析功能 ---
async function startAnalysis() {
  const session = meetingStore.activeSession
  if (!session) return
  
  // 检查是否有逐字稿
  if (sentences.value.length === 0) {
    errorMessage.value = t('meeting.noTranscript')
    return
  }
  
  // Hermes Agent 模式下，切换到 Agent 面板并启动分析
  if (session.analysisMode === 'hermes') {
    await analyzeWithHermesAgent()
    return
  }
  
  // 自定义模型模式下，调用后端自动分析
  try {
    isAnalyzing.value = true
    const config = {
      interval_seconds: analysisInterval.value,
      interval_sentences: analysisIntervalSentences.value,
      trigger_mode: analysisTriggerMode.value,
    }
    const result = await meetingASRApi.startAnalysis(config)
    console.log('Analysis started:', result)

    // 开始轮询结果
    pollAnalysisResult()
  } catch (error) {
    console.error('Failed to start analysis:', error)
    errorMessage.value = t('meeting.analysisStartError')
  }
}

async function stopAnalysis() {
  const session = meetingStore.activeSession
  if (!session) return
  
  isAnalyzing.value = false
  
  // 自定义模型模式下，调用后端停止分析
  if (session.analysisMode === 'custom') {
    try {
      await meetingASRApi.stopAnalysis()
    } catch (error) {
      console.error('Failed to stop analysis:', error)
    }
  }
}

async function pollAnalysisResult() {
  try {
    const result = await meetingASRApi.getAnalysisResult()
    if (result) {
      analysisResult.value = result
    }
  } catch (error) {
    console.error('Failed to fetch analysis result:', error)
  }
}

async function triggerAnalysis() {
  await analyzeWithHermesAgent()
}

async function clearTranscript() {
  // Backend transcript endpoint removed in v0.7.6 (audit #17). Local store
  // already holds the canonical transcript; just clear the UI.
  finalSentences.value = []
  partialText.value = ''
  analysisResult.value = null
  htmlContent.value = ''
  showReport.value = false
  highlightedSentenceIndex.value = -1
  stopAudio()
  
  // 清空 store 中的数据
  if (meetingStore.activeSessionId) {
    meetingStore.clearSession(meetingStore.activeSessionId)
  }
}
</script>

<template>
  <div class="meeting-view">
    <!-- 左侧边栏（拆分自 MeetingView 主体） -->
    <MeetingSidebar
      v-model:expanded="showSidebar"
      :sessions="sidebarSessions"
      :active-id="meetingStore.activeSessionId"
      @create="openCreateModal"
      @select="selectMeetingById"
    >
      <template #item-actions="{ session }">
        <NPopconfirm @positive-click.stop="deleteMeeting(session.id)">
          <template #trigger>
            <button
              class="meeting-item-delete"
              @click.stop
              :title="t('common.delete')"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </template>
          {{ t('meeting.deleteConfirm') }}
        </NPopconfirm>
      </template>
    </MeetingSidebar>

    <!-- 主内容区 -->
    <div class="meeting-main">
      <!-- 顶部标题栏 -->
      <!-- 顶部控制条（拆分自 MeetingView 主体） -->
      <MeetingTopBar
        :sidebar-expanded="showSidebar"
        :show-agent-panel="showAgentPanel"
        :use-diarize="useDiarize"
        :save-mode="saveMode"
        :speaker-count="speakerCount"
        :speaker-count-options="speakerCountOptions"
        :is-recording="isRecording"
        :has-sentences="sentences.length > 0"
        :hide-speaker-diarization="HIDE_SPEAKER_DIARIZATION"
        @toggle-sidebar="showSidebar = !showSidebar"
        @toggle-agent-panel="showAgentPanel = !showAgentPanel"
        @export-transcript="exportMeetingTranscript"
        @toggle-diarize="useDiarize = !useDiarize"
        @toggle-save-mode="saveMode = !saveMode"
        @update:speaker-count="speakerCount = $event"
        @clear-transcript="clearTranscript"
      />

      <!-- 主内容区 -->
      <div class="meeting-content">
      <!-- 左侧：转写区域 -->
      <div class="transcript-panel" :class="{ 'speech-scene': isSpeechScene, 'legal-scene': isLegalScene, 'interview-scene': isInterviewScene }">
        <!-- 可视化区域（场景浮层经 scene-ui-registry 声明式渲染） -->
        <div class="waveform-stage" :class="`phase-${speechPhase}`">
          <WaveformCanvas :analyser="analyser" :connecting="isConnecting" />
          <component v-if="sceneUI.stageOverlay" :is="sceneUI.stageOverlay" />
        </div>

        <component v-if="sceneUI.transcriptStrip" :is="sceneUI.transcriptStrip" />

        <!-- 状态栏（演讲场景：状态由上方状态条承载，这里只留面板开关与错误） -->
        <div class="status-bar">
          <div v-if="!sceneUI.transcriptStrip" class="status-indicator" :class="{ active: isRecording }">
            <span class="status-dot"></span>
            <span>{{ statusText || t('meeting.idle') }}</span>
          </div>
          <div v-if="errorMessage" class="error-message">
            {{ errorMessage }}
          </div>
          <div class="status-actions">
            <NTooltip trigger="hover">
              <template #trigger>
                <button
                  class="panel-toggle-btn"
                  :class="{ active: showRightPanel }"
                  @click="showRightPanel = !showRightPanel"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                    <line x1="15" y1="3" x2="15" y2="21"/>
                  </svg>
                </button>
              </template>
              {{ showRightPanel ? t('meeting.hidePanel') : t('meeting.showPanel') }}
            </NTooltip>
          </div>
        </div>

        <!-- 整段音频转录进度（「拆分人声」/ 直接音频转录共用） -->
        <div v-if="isTranscribing" class="transcribe-progress">
          <div class="transcribe-progress-label">
            {{ t('meeting.directTranscribing') }} · {{ Math.round(transcribeProgress * 100) }}%
          </div>
          <div class="transcribe-progress-track">
            <div class="transcribe-progress-fill" :style="{ width: `${Math.round(transcribeProgress * 100)}%` }" />
          </div>
        </div>

        <!-- 转写内容（拆分自 MeetingView 主体） -->
        <TranscriptList
          :sentences="sentences"
          :partial-text="partialText"
          :highlighted-index="highlightedSentenceIndex"
          :is-recording="isRecording"
          :hide-speaker-diarization="HIDE_TRANSCRIPT_SPEAKERS"
          @seek="seekToSentence"
          @rename="onTranscriptRename"
        />

        <!-- 录音按钮 -->
        <div class="record-button-container">
          <button
            class="record-button"
            :class="{ recording: isRecording, connecting: isConnecting }"
            :aria-label="isRecording ? t('meeting.stop') : (isConnecting ? t('meeting.connecting') : t('meeting.start'))"
            @click="isRecording ? stopRecording() : startRecording()"
            :disabled="isConnecting"
          >
            <svg v-if="!isRecording && !isConnecting" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
            </svg>
            <svg v-else-if="isRecording" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2"/>
            </svg>
            <NSpin v-else size="small" />
          </button>
          <span class="record-label">
            {{ isRecording ? t('meeting.stop') : (isConnecting ? t('meeting.connecting') : t('meeting.start')) }}
          </span>
        </div>
      </div>

      <!-- 右侧：分析面板（壳已拆出 MeetingRightPanel） -->
      <MeetingRightPanel
        :visible="showRightPanel"
        :is-speech-scene="isSpeechScene"
        :is-legal-scene="isLegalScene"
        :is-interview-scene="isInterviewScene"
        :show-agent-panel="showAgentPanel"
        :can-download-audio="!isRecording && !!audioUrl"
        :can-diarize="!isRecording && !!audioBlob"
        :is-diarizing="isTranscribing"
        :resize-style="rightPanelStyle"
        @close="showRightPanel = false"
        @download-audio="downloadAudio"
        @diarize="openDiarizeDialog"
        @resize-start="startRightPanelResize"
      >
        <template #toolbar>
          <div class="toolbar-actions">
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  size="tiny"
                  type="primary"
                  :loading="isLoading && !isAnalyzing"
                  :disabled="sentences.length === 0"
                  @click="triggerAnalysis"
                >
                  <template #icon>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                  </template>
                  {{ t('meeting.triggerAnalysis') }}
                </NButton>
              </template>
              {{ sentences.length === 0 ? t('meeting.noTranscript') : '' }}
            </NTooltip>

            <NButton
              size="tiny"
              type="primary"
              @click="triggerAnalysis"
              :loading="isLoading"
              :disabled="sentences.length === 0"
            >
              {{ t('meeting.generateReport') }}
            </NButton>

            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  size="tiny"
                  :type="isAnalyzing ? 'warning' : 'default'"
                  :disabled="sentences.length === 0"
                  @click="isAnalyzing ? stopAnalysis() : startAnalysis()"
                >
                  <template #icon>
                    <svg v-if="!isAnalyzing" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="12" cy="12" r="10"/>
                      <polyline points="12 6 12 12 16 14"/>
                    </svg>
                    <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="6" y="4" width="4" height="16"/>
                      <rect x="14" y="4" width="4" height="16"/>
                    </svg>
                  </template>
                  {{ isAnalyzing ? t('meeting.stopAnalysis') : t('meeting.startAnalysis') }}
                </NButton>
              </template>
            </NTooltip>

            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  size="tiny"
                  quaternary
                  @click="showAnalysisConfig = true"
                >
                  <template #icon>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="12" cy="12" r="3"/>
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                    </svg>
                  </template>
                </NButton>
              </template>
              {{ t('meeting.analysisTriggerConfig') }}
            </NTooltip>

            <!-- Agent 切换：靠右 -->
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  size="tiny"
                  :type="showAgentPanel ? 'primary' : 'default'"
                  @click="showAgentPanel = !showAgentPanel"
                >
                  <template #icon>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M12 2a4 4 0 0 1 4 4v2a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z"/>
                      <path d="M16 14H8a4 4 0 0 0-4 4v2h16v-2a4 4 0 0 0-4-4z"/>
                    </svg>
                  </template>
                </NButton>
              </template>
              {{ showAgentPanel ? t('meeting.showAnalysis') : t('meeting.showAgentChat') }}
            </NTooltip>
          </div>
        </template>

        <template #interview>
          <component
            v-if="sceneUI.rightPanel && meetingStore.activeSessionId"
            :is="sceneUI.rightPanel"
            :key="meetingStore.activeSessionId"
            :session-id="meetingStore.activeSessionId"
            :is-recording="isRecording"
            @report-generated="onReportGenerated"
          />
        </template>

        <template #legal>
          <component
            v-if="sceneUI.rightPanel && meetingStore.activeSessionId"
            :is="sceneUI.rightPanel"
            :key="meetingStore.activeSessionId"
            :session-id="meetingStore.activeSessionId"
            :is-recording="isRecording"
            @report-generated="onReportGenerated"
          />
        </template>

        <template #speech>
          <component
            v-if="sceneUI.rightPanel && meetingStore.activeSessionId"
            :is="sceneUI.rightPanel"
            :key="meetingStore.activeSessionId"
            :session-id="meetingStore.activeSessionId"
            :is-recording="isRecording"
            @report-generated="onReportGenerated"
          />
        </template>

        <template #agent>
          <MeetingAgentPanel
            v-if="meetingStore.activeSessionId"
            ref="assistPanelRef"
            :session-id="meetingStore.activeSessionId"
            :scene-template="activeSession?.sceneTemplate || 'general'"
            :is-recording="isRecording"
            @report-generated="onReportGenerated"
            @request-report="onRequestReport"
            :start-trigger="agentStartAnalysisTrigger"
            @update:analysis-result="onAgentAnalysisResult"
            @update:report-html="onAgentReportHtml"
            @completed="onAgentCompleted"
            @corrected="onAgentCorrected"
          />
        </template>

        <template #analysis>
          <div class="right-panel-content">
            <!-- 下载区域 - 始终显示 -->
            <div class="download-section">
              <h3>{{ t('meeting.downloads') }}</h3>
              <!-- 音频播放器 -->
              <div v-if="audioUrl" class="audio-section">
                <div class="audio-player">
                  <button class="audio-play-btn" @click="togglePlayPause()">
                    <svg v-if="!isPlaying" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M8 5v14l11-7z"/>
                    </svg>
                    <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="6" y="4" width="4" height="16"/>
                      <rect x="14" y="4" width="4" height="16"/>
                    </svg>
                  </button>
                  <div class="audio-info">
                    <span class="audio-time">{{ formatDuration(playbackTime) }}</span>
                    <div class="progress-track" @click="seekToPosition" @mousedown="startProgressDrag">
                      <div class="progress-fill" :style="{ width: progressPercent + '%' }"></div>
                      <div class="progress-thumb" :style="{ left: progressPercent + '%' }"></div>
                    </div>
                    <span class="audio-time">{{ formatDuration(playbackDuration) }}</span>
                  </div>
                </div>
              </div>
              <!-- 下载按钮 -->
              <div class="download-actions">
                <NButton size="small" @click="downloadAudio" :disabled="isRecording || !audioUrl">
                  <template #icon>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                      <polyline points="7 10 12 15 17 10"/>
                      <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                  </template>
                  {{ t('meeting.downloadAudio') }}
                </NButton>
                <NButton size="small" @click="downloadTranscript" :disabled="isRecording || sentences.length === 0">
                  <template #icon>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                      <line x1="16" y1="13" x2="8" y2="13"/>
                      <line x1="16" y1="17" x2="8" y2="17"/>
                    </svg>
                  </template>
                  {{ t('meeting.downloadTranscript') }}
                </NButton>
                <NButton size="small" @click="downloadJson" :disabled="isRecording || sentences.length === 0">
                  <template #icon>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                      <line x1="16" y1="13" x2="8" y2="13"/>
                      <line x1="16" y1="17" x2="8" y2="17"/>
                      <polyline points="10 9 9 9 8 9"/>
                    </svg>
                  </template>
                  {{ t('meeting.downloadJson') }}
                </NButton>
                <NButton v-if="htmlContent" size="small" @click="downloadReport" :disabled="isRecording">
                  <template #icon>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                      <line x1="16" y1="13" x2="8" y2="13"/>
                      <line x1="16" y1="17" x2="8" y2="17"/>
                    </svg>
                  </template>
                  {{ t('meeting.downloadReport') }}
                </NButton>
              </div>
            </div>

            <!-- 分析结果区域 - 只在有分析结果时显示 -->
            <template v-if="analysisResult">
              <div v-if="analysisResult.summary" class="result-section">
                <h3>{{ t('meeting.summary') }}</h3>
                <p>{{ analysisResult.summary }}</p>
              </div>

              <div v-if="analysisResult.key_points?.length" class="result-section">
                <h3>{{ t('meeting.keyPoints') }}</h3>
                <ul>
                  <li v-for="(point, i) in analysisResult.key_points" :key="i">{{ point }}</li>
                </ul>
              </div>

              <div v-if="analysisResult.action_items?.length" class="result-section">
                <h3>{{ t('meeting.actionItems') }}</h3>
                <ul class="action-list">
                  <li v-for="(item, i) in analysisResult.action_items" :key="i">
                    <input type="checkbox" />
                    <div class="action-body">
                      <span class="action-text">{{ formatActionItem(item) }}</span>
                      <span v-if="formatActionAssignee(item)" class="action-assignee">
                        👤 {{ formatActionAssignee(item) }}
                      </span>
                      <span v-if="formatActionDeadline(item)" class="action-deadline">
                        📅 {{ formatActionDeadline(item) }}
                      </span>
                    </div>
                  </li>
                </ul>
              </div>

              <div v-if="analysisResult.decisions?.length" class="result-section">
                <h3>{{ t('meeting.decisions') }}</h3>
                <ol class="decision-list">
                  <li v-for="(d, i) in analysisResult.decisions" :key="i">{{ d }}</li>
                </ol>
              </div>

              <div v-if="analysisResult.risks?.length" class="result-section">
                <h3>{{ t('meeting.risks') }}</h3>
                <ul>
                  <li v-for="(r, i) in analysisResult.risks" :key="i">{{ r }}</li>
                </ul>
              </div>

              <div v-if="analysisResult.learnings?.length" class="result-section">
                <h3>{{ t('meeting.learnings') }}</h3>
                <ul>
                  <li v-for="(l, i) in analysisResult.learnings" :key="i">{{ l }}</li>
                </ul>
              </div>

              <div v-if="analysisResult.feedback?.positive?.length || analysisResult.feedback?.negative?.length" class="result-section">
                <h3>{{ t('meeting.feedback') }}</h3>
                <div class="feedback-grid">
                  <div v-if="analysisResult.feedback.positive?.length" class="feedback-positive">
                    <h4>{{ t('meeting.feedbackPositive') }}</h4>
                    <ul>
                      <li v-for="(f, i) in analysisResult.feedback.positive" :key="i">{{ f }}</li>
                    </ul>
                  </div>
                  <div v-if="analysisResult.feedback.negative?.length" class="feedback-negative">
                    <h4>{{ t('meeting.feedbackNegative') }}</h4>
                    <ul>
                      <li v-for="(f, i) in analysisResult.feedback.negative" :key="i">{{ f }}</li>
                    </ul>
                  </div>
                </div>
              </div>

              <div v-if="analysisResult.people_mentioned?.length" class="result-section">
                <h3>{{ t('meeting.peopleMentioned') }}</h3>
                <div class="people-container">
                  <NTag v-for="(p, i) in analysisResult.people_mentioned" :key="i" type="info" size="small">
                    {{ p }}
                  </NTag>
                </div>
              </div>

              <div v-if="analysisResult.relationships?.length" class="result-section">
                <h3>{{ t('meeting.relationships') }}</h3>
                <div class="relationship-list">
                  <div v-for="(r, i) in analysisResult.relationships" :key="i" class="relationship-item">
                    <span class="rel-source">{{ r.source }}</span>
                    <span class="rel-arrow">→</span>
                    <span class="rel-target">{{ r.target }}</span>
                    <span class="rel-desc">{{ r.relation }}</span>
                  </div>
                </div>
              </div>

              <div v-if="analysisResult.meeting_type" class="result-section meeting-type">
                <NTag type="primary" size="small">{{ analysisResult.meeting_type }}</NTag>
              </div>

              <div v-if="analysisResult.topics?.length" class="result-section">
                <h3>{{ t('meeting.topics') }}</h3>
                <div class="topic-tags">
                  <NTag v-for="(topic, i) in analysisResult.topics" :key="i" type="info" size="small">
                    {{ topic }}
                  </NTag>
                </div>
              </div>

              <div class="result-section result-actions">
                <NButton type="primary" @click="showReport = true" block size="small" :disabled="!htmlContent">
                  {{ t('meeting.viewReport') }}
                </NButton>
                <NButton v-if="htmlContent" @click="downloadReport" block size="small">
                  {{ t('meeting.downloadReport') }}
                </NButton>
              </div>
            </template>

            <!-- 提示区域 - 当有转写内容但没有分析结果时显示 -->
            <div v-if="!analysisResult && sentences.length > 0" class="analysis-hint">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 16v-4"/>
                <path d="M12 8h.01"/>
              </svg>
              <p>{{ t('meeting.analysisHint') }}</p>
              <NButton
                type="primary"
                size="small"
                :loading="isLoading && !isAnalyzing"
                :disabled="sentences.length === 0"
                @click="triggerAnalysis"
              >
                <template #icon>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="5 3 19 12 5 21 5 3"/>
                  </svg>
                </template>
                {{ t('meeting.triggerAnalysis') }}
              </NButton>
            </div>

            <!-- 报告预览：有 htmlContent 时直接渲染，HTML 内容始终可见 -->
            <div v-if="htmlContent" class="report-preview-section" data-theme-surface="card">
              <div class="report-preview-header">
                <h3>{{ t('meeting.reportPreview') }}</h3>
                <div class="report-preview-actions">
                  <NButton size="tiny" @click="showReport = true">
                    {{ t('meeting.openReport') }}
                  </NButton>
                  <NButton size="tiny" @click="downloadReport" :disabled="isRecording">
                    {{ t('meeting.downloadReport') }}
                  </NButton>
                </div>
              </div>
              <iframe :srcdoc="htmlContent" class="report-preview-iframe"></iframe>
            </div>

            <!-- 空状态 -->
            <div v-if="sentences.length === 0" class="right-panel-empty">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
                <polyline points="10 9 9 9 8 9"/>
              </svg>
              <p>{{ t('meeting.emptyState') }}</p>
            </div>
          </div>
        </template>
      </MeetingRightPanel>
      </div>
    </div>

<!-- 创建会议对话框（外壳已拆出 CreateMeetingDialog） -->
    <CreateMeetingDialog
      v-model:visible="showCreateModal"
      :create-disabled="createMeetingDisabled"
      @create="handleCreateMeeting"
    >
      <div class="create-meeting-form">
        <div class="form-item">
          <label class="form-label">{{ t('meeting.meetingName') }}</label>
          <NInput
            v-model:value="newMeetingTitle"
            :placeholder="t('meeting.meetingNamePlaceholder')"
            maxlength="50"
          />
        </div>

        <div class="form-item">
          <label class="form-label">{{ t('meeting.scene.label') }}</label>
          <SceneTemplatePicker v-model="newMeetingSceneTemplate" />
          <div class="form-hint">{{ t('meeting.scene.hint') }}</div>
        </div>

        <!-- 采集方式：实时语音（麦克风） / 直接音频转录（上传整段音频） -->
        <NTabs v-model:value="newMeetingCaptureMode" type="line" animated>
          <NTabPane name="realtime" :tab="t('meeting.createTabRealtime')" display-directive="show">
            <!-- ASR 配置向导（拆分至 AsrConfigWizardDialog，行为保持不变） -->
            <AsrConfigWizardDialog
              ref="asrWizardRef"
              v-model:asr-api-key="asrApiKey"
              v-model:analysis-mode="newMeetingAnalysisMode"
              v-model:asr-provider="newMeetingAsrProvider"
              v-model:minimax-api-key="newMeetingMinimaxApiKey"
            />
          </NTabPane>
          <NTabPane name="file" :tab="t('meeting.createTabFile')" display-directive="show">
            <DirectTranscribeForm
              v-model:engine="directEngine"
              v-model:diarize="directDiarize"
              v-model:speaker-count="directSpeakerCount"
              v-model:file="directFile"
            />
          </NTabPane>
        </NTabs>

        <div class="form-section">
          <div class="form-section-title">{{ t('meeting.agentConfig') }}</div>
          <!-- 默认 Agent 模式：固定使用 Hermes Agent，仅需选择 Agent 配置（profile） -->
          <template v-if="newMeetingAnalysisMode === 'hermes'">
            <div class="form-item">
              <label class="form-label">{{ t('meeting.selectProfile') }}</label>
              <NSelect
                v-model:value="newMeetingHermesProfile"
                :options="profileOptions"
                :placeholder="t('meeting.selectProfilePlaceholder')"
              />
            </div>
          </template>

          <!-- 自定义 LLM 模式：可选择 Hermes Agent 或 Coding Agent -->
          <template v-else>
            <div class="form-item">
              <label class="form-label">{{ t('meeting.agentType') }}</label>
              <NSelect
                v-model:value="newMeetingAgentType"
                :options="agentTypeOptions"
                :placeholder="t('meeting.selectAgentType')"
              />
            </div>

            <!-- Hermes Agent 配置 -->
            <template v-if="newMeetingAgentType === 'hermes'">
              <div class="form-item">
                <label class="form-label">{{ t('meeting.selectProfile') }}</label>
                <NSelect
                  v-model:value="newMeetingHermesProfile"
                  :options="profileOptions"
                  :placeholder="t('meeting.selectProfilePlaceholder')"
                />
              </div>
            </template>

            <!-- Coding Agent 配置 -->
            <template v-if="newMeetingAgentType === 'claude-code' || newMeetingAgentType === 'codex'">
              <div class="form-item">
                <label class="form-label">{{ t('meeting.codingAgentMode') }}</label>
                <NRadioGroup v-model:value="newMeetingCodingAgentMode">
                  <NRadio v-for="option in codingAgentModeOptions" :key="option.value" :value="option.value">
                    <div class="radio-content">
                      <span class="radio-title">{{ option.label }}</span>
                      <span class="radio-desc">{{ option.description }}</span>
                    </div>
                  </NRadio>
                </NRadioGroup>
              </div>
              <template v-if="newMeetingCodingAgentMode === 'scoped'">
                <div class="form-item">
                  <label class="form-label">{{ t('meeting.selectProvider') }}</label>
                  <NSelect
                    v-model:value="newMeetingCustomProvider"
                    :options="providerOptions"
                    :placeholder="t('meeting.selectProviderPlaceholder')"
                    @update:value="newMeetingCustomModel = ''"
                  />
                </div>
                <div v-if="newMeetingCustomProvider" class="form-item">
                  <label class="form-label">{{ t('meeting.selectModel') }}</label>
                  <NSelect
                    v-model:value="newMeetingCustomModel"
                    :options="modelOptions"
                    :placeholder="t('meeting.selectModelPlaceholder')"
                  />
                </div>
              </template>
            </template>
          </template>
        </div>
      </div>
    </CreateMeetingDialog>

    <!-- 拆分人声对话框（选择识别模型 + Qwen 所需 OSS） -->
    <DiarizeWholeFileDialog
      v-model:visible="showDiarizeDialog"
      :default-engine="activeTranscribeEngine()"
      :default-speaker-count="speakerCount || 0"
      :minimax-key-available="!!(meetingStore.asrConfig.minimaxApiKey || realtimeModelStore.config.minimaxApiKey)"
      :dashscope-key-available="!!(meetingStore.asrConfig.dashscopeApiKey || realtimeModelStore.hasApiKey)"
      :oss="{
        bucket: meetingStore.asrConfig.ossBucket,
        accessKeyId: meetingStore.asrConfig.ossAccessKeyId,
        accessKeySecret: meetingStore.asrConfig.ossAccessKeySecret,
        endpoint: meetingStore.asrConfig.ossEndpoint,
        pathPrefix: meetingStore.asrConfig.ossPathPrefix,
      }"
      :busy="isTranscribing"
      @start="onDiarizeStart"
    />

    <!-- 分析触发配置弹窗 -->
    <NModal
      v-model:show="showAnalysisConfig"
      :title="t('meeting.analysisTriggerConfig')"
      preset="dialog"
      :positive-text="t('common.confirm')"
      :negative-text="t('common.cancel')"
      @positive-click="showAnalysisConfig = false"
    >
      <div class="analysis-config-form">
        <div class="config-field">
          <label>{{ t('meeting.triggerMode') }}</label>
          <select v-model="analysisTriggerMode" class="config-select">
            <option value="sentences">{{ t('meeting.triggerModeSentences') }}</option>
            <option value="time">{{ t('meeting.triggerModeTime') }}</option>
            <option value="both">{{ t('meeting.triggerModeBoth') }}</option>
          </select>
        </div>
        
        <div class="config-field" v-if="analysisTriggerMode !== 'time'">
          <label>{{ t('meeting.intervalSentences') }}</label>
          <div class="config-input-group">
            <input 
              type="number" 
              v-model="analysisIntervalSentences" 
              :min="1" 
              :max="100"
              class="config-input"
            />
            <span class="config-unit">{{ t('meeting.sentencesUnit') }}</span>
          </div>
          <span class="config-hint">{{ t('meeting.intervalSentencesHint') }}</span>
        </div>
        
        <div class="config-field" v-if="analysisTriggerMode !== 'sentences'">
          <label>{{ t('meeting.intervalSeconds') }}</label>
          <div class="config-input-group">
            <input 
              type="number" 
              v-model="analysisInterval" 
              :min="10" 
              :max="600"
              class="config-input"
            />
            <span class="config-unit">{{ t('meeting.secondsUnit') }}</span>
          </div>
          <span class="config-hint">{{ t('meeting.intervalSecondsHint') }}</span>
        </div>
      </div>
    </NModal>

    <!-- HTML 报告弹窗 -->
    <div v-if="showReport" class="report-modal" @click.self="showReport = false">
      <div class="report-container">
        <div class="report-header">
          <h2>{{ t('meeting.report') }}</h2>
          <button class="close-button" @click="showReport = false">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <iframe :srcdoc="htmlContent" class="report-iframe"></iframe>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.meeting-view {
  display: flex;
  height: calc(100 * var(--vh));
  background: var(--theme-card-bg, var(--bg-card));
  color: $text-primary;
  overflow: hidden;
}

/* 左侧边栏布局（容器+删除按钮样式由父级提供；列表项内层样式已迁入 MeetingSidebar）*/
:deep(.sidebar-backdrop) {
  display: none;

  @media (max-width: 768px) {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(var(--text-primary-rgb), 0.4);
    z-index: 99;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease;

    &.active {
      opacity: 1;
      pointer-events: auto;
    }
  }
}

:deep(.meeting-sidebar) {
  width: 260px;
  min-width: 260px;
  height: 100%;
  display: flex;
  flex-direction: column;
  border-right: 1px solid $border-color;
  background: var(--theme-card-bg, var(--bg-card));
  overflow: hidden;
  transition: width 0.2s ease, min-width 0.2s ease;

  &.collapsed {
    width: 0;
    min-width: 0;
    border-right: none;
  }

  @media (max-width: 768px) {
    position: fixed;
    left: 0;
    top: 0;
    bottom: 0;
    z-index: 100;
    transform: translateX(-100%);
    transition: transform 0.2s ease;

    &:not(.collapsed) {
      transform: translateX(0);
    }

    &.collapsed {
      width: 260px;
      min-width: 260px;
    }
  }
}

:deep(.page-sidebar-top) {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 12px;
  gap: 8px;
}

:deep(.meeting-list) {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

:deep(.meeting-list-item) {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border: none;
  border-radius: $radius-sm;
  background: transparent;
  cursor: pointer;
  transition: background-color 0.2s ease;
  text-align: left;
  width: 100%;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.06);
  }

  &.active {
    background: rgba(var(--accent-primary-rgb), 0.1);
  }
}

:deep(.meeting-item-icon) {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: $radius-sm;
  background: rgba(var(--accent-primary-rgb), 0.1);
  color: $accent-primary;
}

:deep(.meeting-item-content) {
  flex: 1;
  min-width: 0;
}

/* 删除按钮由父级 slot 渲染（包 NPopconfirm），故其样式留在父级*/
:deep(.meeting-item-delete) {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: $text-secondary;
  cursor: pointer;
  opacity: 0;
  transition: all 0.2s ease;

  &:hover {
    background: rgba(var(--error-rgb), 0.1);
    color: var(--error);
  }
}

/* 让 hover 父级（列表项）时显示删除按钮——拆成独立规则，因为 SCSS 嵌套 + :deep + & 不能正确编译。*/
:deep(.meeting-list-item:hover) .meeting-item-delete {
  opacity: 1;
}

.meeting-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

:deep(.header-avatar-toggle) {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: all 0.2s ease;
  overflow: hidden;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.1);
    transform: scale(1.05);
  }

  &:active {
    transform: scale(0.95);
  }
}

:deep(.header-logo) {
  width: 24px;
  height: 24px;
  object-fit: contain;
}

/* 顶部控制条样式（MeetingTopBar 子组件内部 DOM，scoped 需用 :deep 穿透）*/
:deep(.meeting-header) {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid $border-color;
  background: var(--theme-card-bg, var(--bg-card));
  flex-shrink: 0;
}

:deep(.meeting-title) {
  display: flex;
  align-items: center;
  gap: 8px;

  h1 {
    font-size: 16px;
    font-weight: 600;
    margin: 0;
  }

  svg {
    color: $accent-primary;
  }
}

:deep(.meeting-controls) {
  display: flex;
  gap: 8px;
}

.meeting-content {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.transcript-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  border-right: 1px solid $border-color;
  min-width: 0;
}

/* .waveform-container / .connecting-overlay 已迁入 WaveformCanvas 组件。*/
/* 演讲评分：波形区外层舞台。圆角悬浮卡对齐主设计——*/
/* 方角深蓝底（WaveformCanvas 容器）随 overflow:hidden 被圆角裁切。*/
.waveform-stage {
  position: relative;
  overflow: hidden;
  margin: 12px 12px 0;
  border-radius: 12px;
}

.status-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 16px;
  border-bottom: 1px solid $border-color;
  background: var(--theme-card-bg, var(--bg-card));
}

.status-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.transcribe-progress {
  padding: 8px 16px;
  border-bottom: 1px solid $border-color;
  background: rgba(var(--accent-primary-rgb), 0.06);
}

.transcribe-progress-label {
  font-size: 12px;
  color: $text-secondary;
  margin-bottom: 6px;
}

.transcribe-progress-track {
  height: 4px;
  border-radius: 2px;
  background: rgba(var(--accent-primary-rgb), 0.15);
  overflow: hidden;
}

.transcribe-progress-fill {
  height: 100%;
  background: var(--accent-primary);
  transition: width 0.3s ease;
}

.panel-toggle-btn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: $text-secondary;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;

  &:hover {
    background: rgba($accent-primary, 0.1);
    color: $accent-primary;
  }

  &.active {
    color: $accent-primary;
  }
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: $text-secondary;

  &.active {
    color: $accent-primary;

    .status-dot {
      background: var(--error);
      animation: pulse 1.5s infinite;
    }
  }
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: $text-secondary;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.error-message {
  color: var(--error);
  font-size: 12px;
}

/* 转写内容样式（.transcript-content/.empty-state/.sentence-item/.sentence-speaker/*/
/* .partial-text 等）已迁入 TranscriptList.vue scoped 样式。*/

.record-button-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 16px;
  gap: 8px;
}

.record-button {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  border: none;
  background: $accent-primary;
  color: var(--text-primary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  box-shadow: 0 4px 12px rgba($accent-primary, 0.3);

  &:hover:not(:disabled) {
    transform: scale(1.05);
    box-shadow: 0 6px 16px rgba($accent-primary, 0.4);
  }

  &:active:not(:disabled) {
    transform: scale(0.95);
  }

  &.recording {
    background: var(--error);
    box-shadow: 0 4px 12px rgba(var(--error-rgb), 0.3);
    animation: pulse-button 1.5s infinite;
  }

  &.connecting {
    opacity: 0.7;
    cursor: not-allowed;
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

@keyframes pulse-button {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.05); }
}

.record-label {
  font-size: 12px;
  color: $text-secondary;
}

/* 右侧面板：chrome 已迁入 MeetingRightPanel.vue*/
/* 父组件只保留分析内容区域的样式（result-section / download-section / ...）*/

.result-section {
  margin-bottom: 20px;

  h3 {
    font-size: 13px;
    font-weight: 600;
    color: $text-secondary;
    margin: 0 0 8px 0;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  p {
    font-size: 14px;
    line-height: 1.6;
    margin: 0;
  }

  ul {
    margin: 0;
    padding-left: 20px;

    li {
      font-size: 14px;
      line-height: 1.6;
      margin-bottom: 4px;
    }
  }
}

.action-list {
  list-style: none;
  padding: 0;

  li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px;
    background: rgba(var(--warning-rgb), 0.1);
    border-radius: 6px;
    margin-bottom: 8px;
    border-left: 3px solid var(--warning);

    input[type="checkbox"] {
      width: 16px;
      height: 16px;
      cursor: pointer;
    }
  }
}

.topic-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* 新增分析结果样式*/
.decision-list {
  margin: 0;
  padding-left: 24px;

  li {
    font-size: 14px;
    line-height: 1.7;
    margin-bottom: 6px;
    color: var(--success);
  }
}

.feedback-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;

  @media (max-width: 600px) {
    grid-template-columns: 1fr;
  }
}

.feedback-positive,
.feedback-negative {
  padding: 12px;
  border-radius: 8px;

  h4 {
    font-size: 13px;
    font-weight: 600;
    margin: 0 0 8px 0;
  }

  ul {
    margin: 0;
    padding-left: 20px;

    li {
      font-size: 13px;
      line-height: 1.6;
      margin-bottom: 4px;
    }
  }
}

.feedback-positive {
  background: rgba(var(--success-rgb), 0.1);
  border-left: 3px solid var(--success);

  h4 { color: var(--success); }
  li { color: var(--success); }
}

.feedback-negative {
  background: rgba(var(--error-rgb), 0.1);
  border-left: 3px solid var(--error);

  h4 { color: var(--error); }
  li { color: var(--error); }
}

.people-container {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.relationship-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.relationship-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: rgba(var(--accent-info-rgb), 0.05);
  border-radius: 8px;
  flex-wrap: wrap;
}

.rel-source,
.rel-target {
  font-weight: 600;
  color: var(--accent-info);
  font-size: 13px;
}

.rel-arrow {
  color: var(--accent-info);
}

.rel-desc {
  color: $text-secondary;
  font-size: 12px;
  flex: 1;
  min-width: 100px;
}

.action-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.action-assignee,
.action-deadline {
  font-size: 11px;
  color: var(--warning);
}

.meeting-type {
  display: flex;
  justify-content: flex-start;
}

/* 音频播放器样式*/
.audio-section {
  padding: 12px;
  background: rgba(var(--accent-primary-rgb), 0.03);
  border-radius: 8px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.1);
  margin-bottom: 16px;
}

.audio-player {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.audio-play-btn {
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 50%;
  background: $accent-primary;
  color: var(--text-primary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  flex-shrink: 0;

  &:hover {
    transform: scale(1.05);
    opacity: 0.9;
  }
}

.audio-info {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.audio-time {
  font-size: 12px;
  color: $text-secondary;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.progress-track {
  flex: 1;
  height: 6px;
  background: rgba($border-color, 0.8);
  border-radius: 3px;
  position: relative;
  cursor: pointer;
  transition: height 0.15s ease;

  &:hover {
    height: 8px;

    .progress-thumb {
      opacity: 1;
      transform: translate(-50%, -50%) scale(1);
    }
  }
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, $accent-primary, rgba($accent-primary, 0.8));
  border-radius: 3px;
  transition: width 0.1s linear;
}

.progress-thumb {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%) scale(0.8);
  width: 14px;
  height: 14px;
  background: $accent-primary;
  border: 2px solid var(--border-color);
  border-radius: 50%;
  box-shadow: 0 1px 4px rgba(var(--text-primary-rgb), 0.2);
  opacity: 0;
  transition: opacity 0.15s ease, transform 0.15s ease;
  pointer-events: none;
}

.audio-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.download-section {
  padding: 12px;
  background: rgba(var(--accent-primary-rgb), 0.03);
  border-radius: 8px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.1);
  margin-bottom: 16px;
  
  h3 {
    font-size: 13px;
    font-weight: 600;
    color: $text-secondary;
    margin: 0 0 12px 0;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
}

.download-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.analysis-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  gap: 12px;
  color: $text-secondary;

  p {
    font-size: 13px;
    text-align: center;
    line-height: 1.5;
    margin: 0;
  }
}

/* 报告预览：直接内嵌 iframe 渲染已生成的 HTML*/
.report-preview-section {
  display: flex;
  flex-direction: column;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.2);
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 16px;
  background: var(--theme-card-bg, var(--bg-card));
}

.report-preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(var(--accent-primary-rgb), 0.04);
  border-bottom: 1px solid $border-color;
  flex-shrink: 0;

  h3 {
    font-size: 12px;
    font-weight: 600;
    color: $text-secondary;
    margin: 0;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
}

.report-preview-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.report-preview-iframe {
  width: 100%;
  height: 480px;
  border: none;

  /* theme-exception: preview -- Fixed contrast keeps camera and paper preview controls visible. */
  background: white;
  display: block;
}

.result-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.report-modal {
  position: fixed;
  inset: 0;
  background: rgba(var(--text-primary-rgb), 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
}

.report-container {
  width: 100%;
  height: 100%;
  max-width: 1200px;
  max-height: 90vh;
  background: var(--theme-card-bg, var(--theme-card-bg, var(--bg-card)));
  border-radius: 12px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(var(--text-primary-rgb), 0.3);
}

.report-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);

  h2 {
    font-size: 16px;
    font-weight: 600;
    margin: 0;
    color: var(--text-primary);
  }
}

.close-button {
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  color: var(--text-primary);

  &:hover {
    background: var(--theme-card-bg, var(--theme-card-bg, var(--bg-card)));
  }
}

.report-iframe {
  flex: 1;
  border: none;
  width: 100%;
  height: 100%;
}

/* 创建会议对话框样式*/
.create-meeting-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.form-section {
  padding: 12px;
  background: rgba(var(--accent-primary-rgb), 0.03);
  border-radius: 8px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.1);
}

.form-section-title {
  font-size: 14px;
  font-weight: 600;
  color: $text-primary;
  margin-bottom: 12px;
}

.form-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-label {
  font-size: 13px;
  font-weight: 500;
  color: $text-primary;
  display: flex;
  align-items: center;
  gap: 8px;
}

.form-label-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(var(--success-rgb), 0.1);
  color: var(--success);
  font-size: 11px;
  font-weight: 600;
}

.form-tutorial-link {
  font-size: 12px;
  font-weight: 400;
  color: var(--color-primary, var(--accent-info));
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
  opacity: 0.75;
  transition: opacity 0.2s;
}

.form-tutorial-link:hover {
  opacity: 1;
}

.form-hint {
  font-size: 12px;
  color: $text-secondary;
  line-height: 1.4;
}

.oss-config-details {
  margin-top: 12px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.15);
  border-radius: $radius-sm;
  overflow: hidden;
}

.oss-config-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  font-size: 13px;
  font-weight: 500;
  color: $text-primary;
  cursor: pointer;
  user-select: none;
  background: rgba(var(--accent-primary-rgb), 0.03);
  transition: background 0.2s;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.07);
  }

  svg {
    flex-shrink: 0;
    color: $accent-primary;
  }

  &::-webkit-details-marker {
    display: none;
  }
}

.oss-config-body {
  padding: 10px;
  border-top: 1px solid rgba(var(--accent-primary-rgb), 0.1);
}

.radio-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.radio-title {
  font-size: 14px;
  font-weight: 500;
  color: $text-primary;
}

.radio-desc {
  font-size: 12px;
  color: $text-secondary;
}

/* Agent 分析相关样式*/
.agent-analysis-section {
  border-bottom: 1px solid $border-color;
  background: rgba($accent-primary, 0.02);
}

.agent-analysis-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  color: $text-primary;
  transition: background 0.2s ease;

  &:hover {
    background: rgba($accent-primary, 0.05);
  }

  svg {
    transition: transform 0.2s ease;
    color: $accent-primary;
  }
}

.agent-status {
  margin-left: auto;
  font-size: 12px;
  color: $accent-primary;
  font-weight: normal;
}

.agent-messages-container {
  max-height: 300px;
  overflow-y: auto;
  padding: 0 16px 12px;
}

.agent-message {
  margin-bottom: 8px;
  
  &.role-tool {
    padding: 6px 10px;
    background: rgba(var(--text-primary-rgb), 0.03);
    border-radius: 6px;
    border-left: 3px solid $accent-primary;
  }
}

.agent-thinking {
  margin-bottom: 8px;
  padding: 8px 10px;
  background: rgba($accent-primary, 0.05);
  border-radius: 6px;
  border-left: 3px solid $accent-primary;
}

.thinking-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: $accent-primary;
  margin-bottom: 4px;
}

.thinking-content {
  font-size: 12px;
  color: $text-secondary;
  white-space: pre-wrap;
  line-height: 1.5;
}

.agent-tool {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tool-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.tool-spinner {
  animation: spin 1s linear infinite;
  color: $accent-primary;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.tool-done {
  color: var(--success);
}

.tool-error {
  color: var(--error);
}

.tool-name {
  font-weight: 600;
  color: $text-primary;
}

.tool-error-text {
  color: var(--error);
  font-size: 11px;
}

.agent-content {
  font-size: 13px;
  line-height: 1.6;
  color: $text-primary;
  white-space: pre-wrap;
}

/* 分析配置弹窗表单样式*/
.analysis-config-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 8px 0;
}

.config-field {
  display: flex;
  flex-direction: column;
  gap: 6px;

  label {
    font-size: 13px;
    font-weight: 500;
    color: $text-primary;
  }
}

.config-select {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid $border-color;
  border-radius: 6px;
  font-size: 14px;
  background: var(--theme-card-bg, var(--bg-card));
  color: $text-primary;
  cursor: pointer;

  &:focus {
    outline: none;
    border-color: $accent-primary;
  }
}

.config-input-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.config-input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid $border-color;
  border-radius: 6px;
  font-size: 14px;
  background: var(--theme-card-bg, var(--bg-card));
  color: $text-primary;

  &:focus {
    outline: none;
    border-color: $accent-primary;
  }
}

.config-unit {
  font-size: 14px;
  color: $text-secondary;
  white-space: nowrap;
}

.config-hint {
  font-size: 12px;
  color: $text-secondary;
  opacity: 0.8;
}
</style>
