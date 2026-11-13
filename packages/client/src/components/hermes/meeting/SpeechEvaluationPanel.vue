<script setup lang="ts">
import { ref, computed, toRef, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NInput, NSpin, NTag, NTabPane, NTabs, NTooltip } from 'naive-ui'
import { useMeetingStore } from '@/stores/hermes/meeting'
import type { SpeechEvalState } from '@/stores/hermes/meeting'
import { useMeetingAssist } from '@/composables/useMeetingAssist'
import { useSpeechAiAggregation } from '@/composables/useSpeechAiAggregation'
import { useSpeechTimerInjectOrCreate } from './speech/speechTimerContext'
import { useSpeechFillerCounter } from '@/composables/useSpeechFillerCounter'
import { request } from '@/api/client'
import { useSpeechEvalReport } from '@/composables/useSpeechEvalReport'
import { buildSpeakerTimeline } from '@/utils/speech-segments'
const activeTab = ref('review')
import LiveScoreCard from './speech/right-panel/LiveScoreCard.vue'
import SpeechEvalBlocks from './speech/right-panel/SpeechEvalBlocks.vue'
import SpeechTimerCard from './speech/right-panel/SpeechTimerCard.vue'
import SpeechTimerSettingsDialog from './speech/right-panel/SpeechTimerSettingsDialog.vue'
import SpeechEvalReportSection from './speech/right-panel/SpeechEvalReportSection.vue'

const props = withDefaults(defineProps<{
  sessionId: string
  isRecording?: boolean
}>(), {
  isRecording: false,
})

const emit = defineEmits<{
  (e: 'report-generated', markdown: string): void
}>()

const { t } = useI18n()
const meetingStore = useMeetingStore()

// ---------- 实时 AI 分析（Socket.IO） ----------

const {
  rounds,
  isConnected,
  isAnalyzing,
  error: assistError,
  connect,
  disconnect,
  clear,
} = useMeetingAssist(props.sessionId)

// ---------- 状态读写（持久化到 session.speechEval） ----------

const session = computed(() => meetingStore.sessions.find(s => s.id === props.sessionId))

const DEFAULT_EVAL: SpeechEvalState = {
  timerDurationSec: 180,
  yellowAtSec: 30,
  redAtSec: 10,
  timerRecords: [],
  // 赘语词表不再预置：由 AI 实时分析检测并汇总（手动 +1 仅作补充修正）
  fillerWords: {},
  wordOfTheDay: '',
  wotdUsedCount: 0,
  goodPhrases: [],
  grammarNotes: [],
  // 肢体语言与台风：AI 看不到画面，由人工观察记录，报告据此点评
  bodyNotes: [],
  // 计时声音提醒（黄牌/红牌/时间到 语音播报），默认开启
  voiceAlert: true,
}

// 合并默认值：旧会话持久化数据缺少新增字段时也能拿到默认值
const evalState = computed<SpeechEvalState>(() => ({
  ...DEFAULT_EVAL,
  ...(session.value?.speechEval || {}),
}))

function persist(patch: Partial<SpeechEvalState>) {
  meetingStore.updateSession(props.sessionId, { speechEval: { ...evalState.value, ...patch } })
}

// ---------- 计时员 (Timer) ----------
// 共享计时器（单例）：与左侧波形/转写区同步显示；面板层（环节/串场记录、
// 设置、语音提醒）经 deps 启用——timerMode/串场/TTS 已收编进 composable。
// 共享计时器唯一实例（reactive 化供子组件经上下文注入；面板自身经 timer.* 访问）
const timer = useSpeechTimerInjectOrCreate({ evalState, persist })

// 阈值变更时同步共享计时器（时长/黄牌/红牌剩余秒数）
watch(() => ({
  durationSec: evalState.value.timerDurationSec,
  yellowAtSec: evalState.value.yellowAtSec,
  redAtSec: evalState.value.redAtSec,
}), (v) => {
  timer.setThresholds({ durationSec: v.durationSec, yellowAtSec: v.yellowAtSec, redAtSec: v.redAtSec })
}, { immediate: true })

// ---------- 演讲上下文（注入 AI 提示词：计时/每日一词） ----------

function buildSpeechContext() {
  // 把"已记录环节 + 当前走表中的标签"展开为 speakerTimeline，注入服务端 AI 提示词。
  // 服务端会按时间戳把每条转写句子按真实姓名归属，让 LLM 直接按 [姓名] 标签点评。
  const speakerTimeline = buildSpeakerTimeline(
    evalState.value.timerRecords || [],
    {
      timerLabel: timer.timerLabel,
      // 仅在走表期间把当前标签展开为 open 段，避免停止后还把句子错归到当前标签
      timerRunning: timer.timerRunning,
    },
  )
  return {
    wordOfTheDay: evalState.value.wordOfTheDay || undefined,
    timerDurationSec: evalState.value.timerDurationSec,
    yellowAtSec: evalState.value.yellowAtSec,
    redAtSec: evalState.value.redAtSec,
    timerRecords: evalState.value.timerRecords || [],
    // 倒计时状态始终上报（含暂停/超时），让 AI 的评分以实际时间情况为依据
    currentRemainingSec: Math.max(0, timer.timerRemainingMs / 1000),
    currentPhase: timer.phase,
    // 手动记录（语法官/肢体语言）：AI 实时点评结合这些人工观察做专项点评
    manualNotes: {
      goodPhrases: evalState.value.goodPhrases || [],
      grammarNotes: evalState.value.grammarNotes || [],
      bodyNotes: evalState.value.bodyNotes || [],
    },
    // 环节-演讲者时间线：覆盖原声纹 speaker（"说话人1"），让 LLM 拿真实姓名
    speakerTimeline: speakerTimeline.length > 0 ? speakerTimeline : undefined,
  }
}

// 上下文变更（计时记录/每日一词/当前标签）时同步给服务端，后续自动分析会带上最新数据。
// 依赖 timerLabel / timerRunning 是关键：用户在 SpeechTimerOverlay 输入名字后 400ms 内就推到服务端。
let contextPushTimer: number | null = null
watch(() => JSON.stringify({
  wordOfTheDay: evalState.value.wordOfTheDay,
  timerRecords: evalState.value.timerRecords,
  timerDurationSec: evalState.value.timerDurationSec,
  yellowAtSec: evalState.value.yellowAtSec,
  redAtSec: evalState.value.redAtSec,
  timerLabel: timer.timerLabel,
  timerRunning: timer.timerRunning,
}), () => {
  if (!props.isRecording) return
  if (contextPushTimer) { clearTimeout(contextPushTimer); contextPushTimer = null }
  contextPushTimer = window.setTimeout(() => {
    request('/api/studio/meeting-asr/assist/context', {
      method: 'POST',
      body: JSON.stringify({ sessionId: props.sessionId, speechContext: buildSpeechContext() }),
    }).catch(() => {})
  }, 400)
})

// ---------- 按需提示：演讲者姓名未填写时的 UI 引导 ----------
// 仅在录音中提示，避免未开始会议时显示干扰。
// 规则：
//   - 从未记录 + 当前标签空 → info 提示"请在计时器上方填写"
//   - 已记录 + 全部记录的 speaker 都为空 → warning 提示"历史记录中没有姓名"
const speakerHint = computed<{ type: 'info' | 'warning'; key: string } | null>(() => {
  if (!props.isRecording) return null
  const records = evalState.value.timerRecords || []
  if (records.length === 0 && !timer.timerLabel.trim()) {
    return { type: 'info', key: 'speakerHint' }
  }
  if (records.length > 0) {
    const anySpeaker = records.some(r => /[／/]/.test(r.label || '') && r.label.split(/[／/]/).pop()!.trim())
    if (!anySpeaker && !timer.timerLabel.trim()) {
      return { type: 'warning', key: 'speakerHintHistory' }
    }
  }
  return null
})

const speakerKpiZero = computed(() =>
  speakerDurations.value.length === 0 && (evalState.value.timerRecords || []).length > 0,
)

// 录音开始/停止：连接 assist 会话（与其他模式一致）
watch(() => props.isRecording, async (recording) => {
  if (recording) {
    connect()
    try {
      await request('/api/studio/meeting-asr/assist/start', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: props.sessionId,
          sceneTemplate: 'speech',
          profile: session.value?.hermesProfile || undefined,
          speechContext: buildSpeechContext(),
        }),
      })
    } catch { /* best effort */ }
  } else {
    try {
      await request('/api/studio/meeting-asr/assist/stop', {
        method: 'POST',
        body: JSON.stringify({ sessionId: props.sessionId }),
      })
    } catch { /* best effort */ }
    disconnect()
  }
}, { immediate: true })

// 录音开始时自动开始倒计时（仅当计时器尚未启动/处于满时长状态时）
watch(() => props.isRecording, (recording) => {
  if (recording && !timer.timerRunning && timer.timerRemainingMs === evalState.value.timerDurationSec * 1000) {
    timer.toggle()
  }
})

// 立即分析：先把当前所有已转写句子推到服务端（演讲场景在计时器停止期间不推送，
// 服务端缓冲区可能为空），再把最新上下文发给服务端并触发一次分析。
async function analyzeNow() {
  if (isAnalyzing.value) return
  const sentences = session.value?.sentences || []
  if (sentences.length) {
    await Promise.all(sentences.map(s =>
      request('/api/studio/meeting-asr/assist/sentence', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: props.sessionId,
          speaker: s.speaker,
          text: s.text,
          timestamp: s.timestamp,
        }),
      }).catch(() => {})
    ))
  }
  request('/api/studio/meeting-asr/assist/analyze', {
    method: 'POST',
    body: JSON.stringify({ sessionId: props.sessionId, speechContext: buildSpeechContext() }),
  }).catch(() => {})
}

// ---------- AI 实时点评聚合 ----------

// 赘语（拆分至 useSpeechFillerCounter，行为保持不变）
const {
  aiFillerTotals,
  fillerWords,
  fillerTotal,
  incrementFiller,
  removeFiller,
  newFiller,
  addFiller,
} = useSpeechFillerCounter({ evalState, persist, rounds })

// ---------- AI 实时点评聚合（抽至 useSpeechAiAggregation：评分/增量评价/金句/发言人用时） ----------
const {
  aiFillerBySpeaker,
  aiGoldenQuotes,
  aiGrammarIssues,
  aiWotdUsedCount,
  newPointRounds,
  liveScore,
  scoreUpdatedAt,
  highlights,
  improvements,
  topics,
  speakerScores,
  speakerSections,
  speakerDurations,
} = useSpeechAiAggregation({
  rounds,
  session,
  // 传 timerLabel/timerRunning 让 speakerDurations 在 sentence.speaker 缺失时
  // 仍能按"当前标签 / 已记录时间线"反查归属（修复 KPI 卡一直显示 0 的问题）
  timerLabel: toRef(timer, 'timerLabel'),
  timerRunning: toRef(timer, 'timerRunning'),
})



// ---------- 语法官 (Grammarian) ----------

const wotdInput = ref('')
const goodInput = ref('')
const grammarInput = ref('')

const goodPhrases = computed(() => evalState.value.goodPhrases || [])
const grammarNotes = computed(() => evalState.value.grammarNotes || [])

function saveWotd() {
  persist({ wordOfTheDay: wotdInput.value.trim() })
}

function wotdUsed() {
  persist({ wotdUsedCount: (evalState.value.wotdUsedCount || 0) + 1 })
}

function addGood() {
  const text = goodInput.value.trim()
  if (!text) return
  persist({ goodPhrases: [...goodPhrases.value, text] })
  goodInput.value = ''
}

function addGrammar() {
  const text = grammarInput.value.trim()
  if (!text) return
  persist({ grammarNotes: [...grammarNotes.value, text] })
  grammarInput.value = ''
}

function removeGood(index: number) {
  const next = [...goodPhrases.value]
  next.splice(index, 1)
  persist({ goodPhrases: next })
}

function removeGrammar(index: number) {
  const next = [...grammarNotes.value]
  next.splice(index, 1)
  persist({ grammarNotes: next })
}

// ---------- 肢体语言与台风（手动观察记录） ----------
// AI 只能听到音频、看不到画面，表情/动作/肢体语言由人工观察记录，
// 报告生成时随「演讲评估数据」交给 AI 结合点评。

const bodyInput = ref('')
const bodyNotes = computed(() => evalState.value.bodyNotes || [])

function addBodyNote() {
  const text = bodyInput.value.trim()
  if (!text) return
  persist({ bodyNotes: [...bodyNotes.value, text] })
  bodyInput.value = ''
}

function removeBodyNote(index: number) {
  const next = [...bodyNotes.value]
  next.splice(index, 1)
  persist({ bodyNotes: next })
}


// 导出报告：拆分按钮 + 下拉菜单，默认 Word（极致样式），可切 HTML / Markdown。
const exportTitle = computed(() => session.value?.title || t('meeting.reportPanel.title'))

// ---------- 评估报告（抽至 useSpeechEvalReport；S4 行为改进：走 useReportStream） ----------
const {
  reportMarkdown,
  isGeneratingReport,
  reportError,
  downloadVerbatim,
  getVerbatimSpeakers,
  downloadVerbatimBySpeaker,
  generateReport,
} = useSpeechEvalReport({
  getSessionId: () => props.sessionId,
  getSession: () => session.value,
  evalState: () => evalState.value,
  transcriptData: {
    fillerWords: () => fillerWords.value,
    aiFillerBySpeaker: () => aiFillerBySpeaker.value,
    aiGoldenQuotes: () => aiGoldenQuotes.value,
    aiGrammarIssues: () => aiGrammarIssues.value,
    aiWotdUsedCount: () => aiWotdUsedCount.value,
    highlights: () => highlights.value,
    improvements: () => improvements.value,
    topics: () => topics.value,
    liveScore: () => liveScore.value,
    speakerDurations: () => speakerDurations.value,
    transitionRecords: () => timer.transitionRecords,
    transitionTotalSec: () => timer.transitionTotalSec,
    fmtSec: timer.fmtSec,
  },
  onReportGenerated: (markdown) => emit('report-generated', markdown),
})

// 逐字稿按演讲者分组（报告 Tab 的「按演讲者导出」下拉选项）。
// 句子缺 speaker 时由 groupSentencesBySpeaker 按已记录环节时间线兜底归属。
const verbatimSpeakers = computed(() => getVerbatimSpeakers())

// 切换会话时不持久化空 rounds（clear() 会触发 rounds watch）
let suppressRoundPersist = false

// 新分析到达时同步持久化到 store（与其他面板 MeetingAgentPanel / InterviewPanel 行为一致）
watch(rounds, (newRounds) => {
  if (suppressRoundPersist) return
  if (newRounds.length) {
    meetingStore.updateSession(props.sessionId, { analysisRounds: [...newRounds] })
  }
}, { deep: true })

onMounted(() => {
  // 计时器由共享模块持有且已在阈值 watch 中同步，这里不重置，避免打断左侧覆盖层正在走的表。
  wotdInput.value = evalState.value.wordOfTheDay || ''
  // 恢复已持久化的 AI 点评记录（切换会议/刷新页面后保留）
  const s = session.value
  if (s?.analysisRounds?.length) {
    rounds.value = [...s.analysisRounds]
  }
})

// 切换会话时重置
watch(() => props.sessionId, () => {
  suppressRoundPersist = true
  if (contextPushTimer) { clearTimeout(contextPushTimer); contextPushTimer = null }
  disconnect()
  clear()
  timer.resetVoiceFlags()
  timer.cancelAnnouncement()
  timer.reset()
  wotdInput.value = evalState.value.wordOfTheDay || ''
  reportMarkdown.value = ''
  reportError.value = null
  // 加载新会话的历史 AI 点评
  const s = session.value
  if (s?.analysisRounds?.length) {
    rounds.value = [...s.analysisRounds]
  }
  suppressRoundPersist = false
})

onUnmounted(() => {
  // 计时器由共享模块持有：面板卸载时不停表（左侧波形/转写区覆盖层继续走表），
  // 由 MeetingView 在页面卸载/切换会话时统一 reset/stop。
  if (contextPushTimer) { clearTimeout(contextPushTimer); contextPushTimer = null }
  timer.resetVoiceFlags()
  timer.cancelAnnouncement()
  disconnect()
})
</script>

<template>
  <div class="speech-eval-panel">
    <!-- 顶部：连接状态 + 开始分析 -->
    <div class="eval-topbar">
      <div class="eval-status">
        <span class="status-dot" :class="{ connected: isConnected, analyzing: isAnalyzing }" />
        <span v-if="isAnalyzing">{{ t('meeting.speechEval.analyzing') }}</span>
        <span v-else-if="isConnected">{{ t('meeting.speechEval.connected') }}</span>
        <span v-else>{{ t('meeting.speechEval.notConnected') }}</span>
      </div>
      <NButton size="small" type="primary" :loading="isAnalyzing" :disabled="!props.isRecording" @click="analyzeNow">
        {{ t('meeting.speechEval.analyzeNow') }}
      </NButton>
    </div>

    <!-- 常驻仪表头（sticky）：总分/相位/时间/赘语 四个 KPI 一眼可见 -->
    <div class="kpi-bar" data-theme-surface="card">
      <div class="kpi-cell kpi-score">
        <span class="kpi-value">{{ liveScore?.overall ?? '—' }}</span>
        <span class="kpi-label">{{ t('meeting.speechEval.kpiOverall') }}</span>
      </div>
      <div class="kpi-cell">
        <span class="kpi-value">{{ fillerTotal }}</span>
        <span class="kpi-label">{{ t('meeting.speechEval.kpiFillers') }}</span>
      </div>
      <div class="kpi-cell">
        <NTooltip v-if="speakerKpiZero" trigger="hover">
          <template #trigger>
            <span class="kpi-value kpi-value-warn">{{ speakerDurations.length }}</span>
          </template>
          {{ t('meeting.speechEval.kpiSpeakersZeroHint') }}
        </NTooltip>
        <span v-else class="kpi-value">{{ speakerDurations.length }}</span>
        <span class="kpi-label">{{ t('meeting.speechEval.kpiSpeakers') }}</span>
      </div>
    </div>

    <!-- 按需提示：未填写演讲者姓名时引导用户 -->
    <NAlert
      v-if="speakerHint"
      :type="speakerHint.type"
      :show-icon="true"
      :bordered="false"
      class="speaker-hint"
      size="small"
    >
      {{ t(`meeting.speechEval.${speakerHint.key}`) }}
    </NAlert>

    <!-- 四 Tab 分区：Tab 栏即功能目录 -->
    <NTabs v-model:value="activeTab" type="line" size="small" class="eval-tabs">
    <NTabPane name="review" :tab="t('meeting.speechEval.tabReview')">
    <!-- AI 实时点评与评分 -->
    <section class="eval-section">
      <div class="section-title">
        <span class="section-name">{{ t('meeting.speechEval.aiRounds') }}</span>
      </div>
      <p class="section-desc">{{ t('meeting.speechEval.aiRoundsDesc') }}</p>

      <LiveScoreCard :live-score="liveScore" :score-updated-at="scoreUpdatedAt" :speaker-scores="speakerScores" />

      <SpeechEvalBlocks
        :highlights="highlights"
        :improvements="improvements"
        :topics="topics"
        :new-point-rounds="newPointRounds"
        :speaker-sections="speakerSections"
        :speaker-scores="speakerScores"
      />

      <div v-if="rounds.length === 0" class="empty-hint">{{ t('meeting.speechEval.emptyRounds') }}</div>

      <div v-if="isAnalyzing" class="analyzing-indicator">
        <NSpin size="small" />
        <span>{{ t('meeting.speechEval.thinking') }}</span>
      </div>
      <div v-if="assistError" class="assist-error">{{ assistError }}</div>
    </section>
    </NTabPane>

    <NTabPane name="timer" :tab="t('meeting.speechEval.tabTimer')">
    <!-- 计时员 -->
    <section class="eval-section">
      <div class="section-title">
        <span class="section-name">{{ t('meeting.speechEval.timer') }}</span>
        <NButton size="tiny" quaternary class="settings-btn" @click="timer.openSettings">
          ⚙️ {{ t('meeting.speechEval.settings') }}
        </NButton>
      </div>
      <p class="section-desc">{{ t('meeting.speechEval.timerDesc') }}</p>

      <SpeechTimerCard :speaker-durations="speakerDurations" />
    </section>
    </NTabPane>

    <NTabPane name="notes" :tab="t('meeting.speechEval.tabNotes')">
    <!-- 赘语记录员（AI 检测） -->
    <section class="eval-section">
      <div class="section-title">
        <span class="section-name">{{ t('meeting.speechEval.ahCounter') }}</span>
      </div>
      <p class="section-desc">{{ t('meeting.speechEval.ahCounterDesc') }}</p>
      <p class="section-desc">{{ t('meeting.speechEval.fillerThresholdNote') }}</p>

      <div v-if="Object.keys(fillerWords).length === 0" class="empty-hint">{{ t('meeting.speechEval.emptyFillers') }}</div>

      <div class="filler-grid">
        <div v-for="(count, word) in fillerWords" :key="word" class="filler-item">
          <span class="filler-word">{{ word }}</span>
          <span class="filler-count">{{ count }}</span>
          <NButton size="tiny" quaternary class="filler-plus" @click="incrementFiller(word)">+</NButton>
          <button v-if="!(word in aiFillerTotals)" class="filler-remove" @click="removeFiller(word)">×</button>
        </div>
      </div>
      <div class="filler-total">{{ t('meeting.speechEval.fillerTotal') }}：{{ fillerTotal }} <span class="filler-unit">{{ t('meeting.speechEval.times') }}</span></div>

      <!-- 赘语按发言人区分 -->
      <div v-if="aiFillerBySpeaker.length" class="filler-speakers">
        <div class="records-title">{{ t('meeting.speechEval.fillerBySpeaker') }}</div>
        <div v-for="entry in aiFillerBySpeaker" :key="entry.speaker" class="speaker-filler-item">
          <span class="speaker-filler-name">{{ entry.speaker }}</span>
          <span class="speaker-filler-tags">
            <NTag v-for="(c, w) in entry.totals" :key="w" size="tiny" type="warning" :bordered="false">{{ w }} ×{{ c }}</NTag>
          </span>
          <span class="speaker-filler-total">{{ t('meeting.speechEval.fillerTotal') }} {{ entry.total }}</span>
        </div>
      </div>

      <div class="add-row">
        <NInput v-model:value="newFiller" size="small" :placeholder="t('meeting.speechEval.addFiller')" @keyup.enter="addFiller" />
        <NButton size="small" @click="addFiller">{{ t('meeting.speechEval.add') }}</NButton>
      </div>
    </section>

    <!-- 语法官（AI 检测 + 手动补充） -->
    <section class="eval-section">
      <div class="section-title">
        <span class="section-name">{{ t('meeting.speechEval.grammarian') }}</span>
      </div>
      <p class="section-desc">{{ t('meeting.speechEval.grammarianDesc') }}</p>

      <div class="wotd-row">
        <NInput v-model:value="wotdInput" size="small" :placeholder="t('meeting.speechEval.wordOfTheDay')" @blur="saveWotd" @keyup.enter="saveWotd" />
        <NButton size="small" @click="wotdUsed">
          {{ t('meeting.speechEval.used') }} +1 ({{ (evalState.wotdUsedCount || 0) + aiWotdUsedCount }})
        </NButton>
      </div>

      <!-- AI 检测的金句（按发言人） -->
      <div v-if="aiGoldenQuotes.length" class="note-group">
        <div class="note-title">✨ {{ t('meeting.speechEval.aiGoldenQuotes') }}</div>
        <div class="quote-def">{{ t('meeting.speechEval.goldenQuotesDesc') }}</div>
        <div v-for="(q, i) in aiGoldenQuotes" :key="`ai-${i}`" class="note-item note-item--quote">
          <span>「{{ q.quote }}」<template v-if="q.speaker"><span class="quote-speaker">—— {{ q.speaker }}</span></template></span>
          <div v-if="q.reason" class="quote-reason">{{ q.reason }}</div>
        </div>
      </div>

      <!-- AI 检测的语法问题 -->
      <div v-if="aiGrammarIssues.length" class="note-group">
        <div class="note-title">⚠️ {{ t('meeting.speechEval.aiGrammarIssues') }}</div>
        <div v-for="(g, i) in aiGrammarIssues" :key="`ai-${i}`" class="note-item">
          <span>「{{ g.quote }}」— {{ g.issue }}<template v-if="g.speaker"><span class="quote-speaker">（{{ g.speaker }}）</span></template></span>
        </div>
      </div>

      <div class="note-group">
        <div class="note-title">{{ t('meeting.speechEval.goodPhrases') }}</div>
        <div class="add-row">
          <NInput v-model:value="goodInput" size="small" :placeholder="t('meeting.speechEval.addNotePlaceholder')" @keyup.enter="addGood" />
          <NButton size="small" @click="addGood">{{ t('meeting.speechEval.add') }}</NButton>
        </div>
        <div v-for="(p, i) in goodPhrases" :key="i" class="note-item">
          <span>{{ p }}</span>
          <button class="note-remove" @click="removeGood(i)">×</button>
        </div>
      </div>

      <div class="note-group">
        <div class="note-title">{{ t('meeting.speechEval.grammarNotes') }}</div>
        <div class="add-row">
          <NInput v-model:value="grammarInput" size="small" :placeholder="t('meeting.speechEval.addNotePlaceholder')" @keyup.enter="addGrammar" />
          <NButton size="small" @click="addGrammar">{{ t('meeting.speechEval.add') }}</NButton>
        </div>
        <div v-for="(n, i) in grammarNotes" :key="i" class="note-item">
          <span>{{ n }}</span>
          <button class="note-remove" @click="removeGrammar(i)">×</button>
        </div>
      </div>
    </section>

    <!-- 肢体语言与台风（手动观察，AI 结合点评） -->
    <section class="eval-section">
      <div class="section-title">
        <span class="section-name">{{ t('meeting.speechEval.bodyLanguage') }}</span>
      </div>
      <p class="section-desc">{{ t('meeting.speechEval.bodyLanguageDesc') }}</p>

      <div class="add-row">
        <NInput v-model:value="bodyInput" size="small" :placeholder="t('meeting.speechEval.bodyNotesPlaceholder')" @keyup.enter="addBodyNote" />
        <NButton size="small" @click="addBodyNote">{{ t('meeting.speechEval.addBodyNote') }}</NButton>
      </div>

      <div v-if="bodyNotes.length === 0" class="empty-hint">{{ t('meeting.speechEval.emptyBodyNotes') }}</div>
      <div v-for="(n, i) in bodyNotes" :key="i" class="note-item">
        <span>{{ n }}</span>
        <button class="note-remove" @click="removeBodyNote(i)">×</button>
      </div>
    </section>
    </NTabPane>

    <NTabPane name="report" :tab="t('meeting.speechEval.tabReport')">
    <!-- 评估报告 -->
    <section class="eval-section report-section">
      <div class="section-title">
        <span class="section-name">{{ t('meeting.speechEval.reportTitle') }}</span>
      </div>
      <SpeechEvalReportSection
        :report-markdown="reportMarkdown"
        :report-error="reportError"
        :is-generating-report="isGeneratingReport"
        :can-generate="!!session?.sentences?.length"
        :export-title="exportTitle"
        :verbatim-speakers="verbatimSpeakers"
        @generate="generateReport"
        @download-verbatim="downloadVerbatim"
        @download-verbatim-speaker="downloadVerbatimBySpeaker"
      />
    </section>
    </NTabPane>
    </NTabs>

    <SpeechTimerSettingsDialog />
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.speech-eval-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
  /* 横向一律不出滚动条：长英文标签等超宽内容直接裁掉，*/
  /* 防止把右栏 flex item 撑宽越界盖住左侧转写区*/
  overflow-x: hidden;
  min-width: 0;
  max-width: 100%;
  padding: 12px 14px;
  gap: 12px;
}

/* 常驻仪表头：录音时不用滚动即可看到 4 个关键数字 */
.kpi-bar {
  position: sticky;
  top: -12px; /* 抵消面板 padding，贴住滚动容器顶部 */
  z-index: 5;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--theme-card-bg, var(--bg-card));
  border: 1px solid rgba(var(--text-primary-rgb), 0.08);
  flex-shrink: 0;
}

.kpi-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 2px 0;

  & + & { border-left: 1px solid rgba(var(--text-primary-rgb), 0.05); }
}

.kpi-value {
  font-size: 18px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--n-text-color, var(--text-primary));
  line-height: 1.1;
}

.kpi-value-warn {
  color: var(--error); /* 红色：标识"已有记录但 speaker 全部为空"*/
  text-decoration: underline dotted;
  text-underline-offset: 3px;
}

.kpi-label { font-size: 10px; color: var(--n-text-color3, var(--text-primary)); }

.speaker-hint {
  margin: 0 0 12px;
}

/* 指示条在右栏宽度动画/隐藏挂载时会测宽失败（渲染成超宽），隐藏规避*/
.eval-tabs :deep(.n-tabs-bar) {
  display: none !important;
}

/* Tab 距面板边缘留出呼吸空间（naive 的 nav 自身 padding 会盖外层）*/
.eval-tabs :deep(.n-tabs-nav-scroll-content) {
  padding: 0 8px;
}

.eval-tabs {
  flex: 1;
  min-height: 0;
  padding: 0 4px;

  :deep(.n-tabs-nav) { position: sticky; top: 52px; z-index: 4; background: var(--theme-card-bg, var(--bg-card)); }
  :deep(.n-tab-pane) { padding: 4px 0 0; }
}

.eval-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-shrink: 0;
}

.eval-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--n-text-color3, var(--text-primary));
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--theme-card-bg, var(--theme-card-bg, var(--bg-card)));

  &.connected { background: var(--success); }
  &.analyzing { background: var(--warning); animation: pulse 1s infinite; }
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.eval-section {
  padding: 14px 2px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-bottom: 1px solid rgba(var(--text-primary-rgb), 0.04);
}

.section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
}

.section-name { flex: 1; }
.settings-btn { flex-shrink: 0; }

.section-desc {
  font-size: 11px;
  color: var(--n-text-color3, var(--text-primary));
  line-height: 1.5;
  margin: 0;
}

.empty-hint {
  font-size: 11px;
  color: var(--n-text-color3, var(--text-primary));
}

/* --- AI 点评轮次 ---*/
.round-card {
  border-radius: 10px;
  padding: 10px 12px;
  background: rgba(var(--text-primary-rgb), 0.04);
  border: 1px solid rgba(var(--text-primary-rgb), 0.06);
  border-left: 3px solid rgba(var(--text-primary-rgb), 0.3);
  display: flex;
  flex-direction: column;
  gap: 6px;

  &.priority-attention { border-left-color: var(--warning); }
  &.priority-urgent { border-left-color: var(--error); }
}

.round-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.round-time { font-size: 11px; color: var(--n-text-color3, var(--text-primary)); font-variant-numeric: tabular-nums; }

.priority-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 8px;

  &.attention { background: rgba(var(--warning-rgb), 0.15); color: var(--warning); }
  &.urgent { background: rgba(var(--error-rgb), 0.15); color: var(--error); }
}

.round-keypoint {
  font-size: 14px;
  font-weight: 700;
  line-height: 1.4;
  padding: 4px 8px;
  border-radius: 6px;

  &.priority-normal { color: var(--success); background: rgba(var(--success-rgb), 0.08); }
  &.priority-attention { color: var(--warning); background: rgba(var(--warning-rgb), 0.1); }
  &.priority-urgent { color: var(--error); background: rgba(var(--error-rgb), 0.15); }
}

.round-context {
  font-size: 12px;
  color: var(--accent-info);
  padding-left: 8px;
  border-left: 2px solid var(--accent-info);
}

.round-analysis { font-size: 12px; color: var(--text-primary); line-height: 1.6; }
.round-timenote { font-size: 12px; color: var(--warning); }

/* --- 实时评分（更新式面板） ---*/
.live-score {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(var(--accent-info-rgb), 0.06);
  border: 1px solid rgba(var(--accent-info-rgb), 0.2);
  animation: score-flash 0.6s ease;
}

@keyframes score-flash {
  0% { background: rgba(var(--accent-info-rgb), 0.2); }
  100% { background: rgba(var(--accent-info-rgb), 0.06); }
}

.live-score-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.live-score-title { font-size: 13px; font-weight: 700; color: var(--accent-info); }
.live-score-time { font-size: 11px; color: var(--n-text-color3, var(--text-primary)); font-variant-numeric: tabular-nums; }

.live-score-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 6px;
}

.live-score-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 2px;
  border-radius: 8px;
  background: rgba(var(--text-primary-rgb), 0.04);
  border: 1px solid rgba(var(--text-primary-rgb), 0.06);

  &.overall {
    background: rgba(var(--success-rgb), 0.08);
    border-color: rgba(var(--success-rgb), 0.3);
  }
}

.live-score-label { font-size: 10px; color: var(--n-text-color3, var(--text-primary)); text-align: center; }
.live-score-value { font-size: 18px; font-weight: 700; color: var(--accent-info); font-variant-numeric: tabular-nums; }
.live-score-item.overall .live-score-value { color: var(--success); }

/* --- 累积评价块（亮点/改进点/主题） ---*/
.eval-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(var(--text-primary-rgb), 0.03);
  border: 1px solid rgba(var(--text-primary-rgb), 0.05);
}

.eval-block-title { font-size: 12px; font-weight: 600; color: var(--n-text-color3, var(--text-primary)); }

.eval-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.round-chips { display: flex; flex-wrap: wrap; gap: 4px; }

.round-lists { display: flex; flex-direction: column; gap: 3px; }
.round-list-title { font-size: 11px; color: var(--n-text-color3, var(--text-primary)); }
.round-list-item { font-size: 12px; color: var(--text-primary); line-height: 1.5; }

.round-wotd { font-size: 12px; color: var(--success); }

.analyzing-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--n-text-color3, var(--text-primary));
}

.assist-error {
  font-size: 12px;
  color: var(--error);
  padding: 6px 8px;
  background: rgba(var(--error-rgb), 0.08);
  border-radius: 6px;
}

/* --- 计时器 ---*/
.timer-display {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 14px;
  border-radius: 10px;
  border: 1px solid rgba(var(--text-primary-rgb), 0.08);
  background: rgba(var(--text-primary-rgb), 0.2);
  transition: all 0.3s ease;

  &.phase-green { border-color: rgba(var(--success-rgb), 0.6); }
  &.phase-yellow { border-color: rgba(var(--warning-rgb), 0.7); background: rgba(var(--warning-rgb), 0.06); }
  &.phase-red { border-color: rgba(var(--error-rgb), 0.8); background: rgba(var(--error-rgb), 0.08); }
}

.timer-time {
  font-size: 40px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
  color: var(--n-text-color, var(--text-primary));
}

.phase-green .timer-time { color: var(--success); }
.phase-yellow .timer-time { color: var(--warning); }
.phase-red .timer-time { color: var(--error); }

.timer-phase-label { font-size: 12px; font-weight: 600; letter-spacing: 0.5px; }

.timer-cards { display: flex; gap: 6px; }

.card {
  flex: 1;
  text-align: center;
  font-size: 11px;
  padding: 4px 0;
  border-radius: 6px;
  border: 1px solid rgba(var(--text-primary-rgb), 0.08);
  opacity: 0.45;
  transition: all 0.2s ease;

  &.green.active { opacity: 1; border-color: var(--success); background: rgba(var(--success-rgb), 0.15); }
  &.yellow.active { opacity: 1; border-color: var(--warning); background: rgba(var(--warning-rgb), 0.15); }
  &.red.active { opacity: 1; border-color: var(--error); background: rgba(var(--error-rgb), 0.18); }
}

.timer-controls { display: flex; gap: 8px; flex-wrap: wrap; }
.segment-row { display: flex; gap: 8px; align-items: center; }

.transition-hint {
  font-size: 11px;
  color: var(--accent-info);
  padding: 4px 8px;
  border-radius: 6px;
  background: rgba(var(--accent-info-rgb), 0.08);
  border: 1px solid rgba(var(--accent-info-rgb), 0.15);
}

.time-records { display: flex; flex-direction: column; gap: 4px; }
.records-title { font-size: 11px; color: var(--n-text-color3, var(--text-primary)); }

.record-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 6px;
  background: rgba(var(--text-primary-rgb), 0.03);
}

.record-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.record-duration { font-variant-numeric: tabular-nums; }
.record-overtime { color: var(--error); }

.record-remove,
.note-remove,
.filler-remove {
  background: none;
  border: none;
  color: var(--text-primary);
  cursor: pointer;
  font-size: 14px;
  padding: 0 2px;
  line-height: 1;

  &:hover { color: var(--error); }
}

/* --- 赘语 ---*/
.filler-grid { display: flex; flex-wrap: wrap; gap: 6px; }

.filler-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border-radius: 8px;
  background: rgba(var(--text-primary-rgb), 0.04);
  border: 1px solid rgba(var(--text-primary-rgb), 0.07);
}

.filler-word { font-size: 12px; }
.filler-count { font-size: 12px; font-weight: 700; color: var(--warning); min-width: 14px; text-align: center; }
.filler-plus { font-size: 13px; }

.filler-total { font-size: 12px; color: var(--n-text-color3, var(--text-primary)); }
.filler-unit { color: var(--n-text-color3, var(--text-primary)); }

/* --- 赘语按发言人 ---*/
.filler-speakers { display: flex; flex-direction: column; gap: 4px; }

.speaker-filler-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 6px;
  background: rgba(var(--text-primary-rgb), 0.03);
  flex-wrap: wrap;
}

.speaker-filler-name { font-weight: 600; color: var(--accent-info); min-width: 48px; }
.speaker-filler-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.speaker-filler-total { margin-left: auto; color: var(--n-text-color3, var(--text-primary)); font-variant-numeric: tabular-nums; }

.add-row { display: flex; gap: 8px; align-items: center; }

/* --- 语法官 ---*/
.wotd-row { display: flex; gap: 8px; align-items: center; }

.note-group { display: flex; flex-direction: column; gap: 6px; }
.note-title { font-size: 11px; color: var(--n-text-color3, var(--text-primary)); }

.note-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 6px;
  background: rgba(var(--text-primary-rgb), 0.03);

  > span { flex: 1; }
}

/* 金句条目：引文 + 出处 + 点评（竖排）*/
.note-item--quote {
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;

  > span { flex: none; }
}

/* --- 金句 ---*/
.quote-def { font-size: 11px; color: var(--n-text-color3, var(--text-primary)); }
.quote-speaker { color: var(--accent-info); font-size: 11px; }
.quote-reason { font-size: 11px; color: var(--n-text-color3, var(--text-primary)); padding-left: 4px; }

/* --- 报告 ---*/
.report-section { gap: 8px; }
.report-generate-row { display: flex; gap: 8px; }
.report-generate-row .n-button { flex: 1; }
.report-error { font-size: 12px; color: var(--error); padding: 6px 8px; background: rgba(var(--error-rgb), 0.08); border-radius: 6px; }
.report-loading { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--n-text-color3, var(--text-primary)); }
.report-actions { display: flex; justify-content: flex-end; margin-bottom: 8px; }
.report-content { font-size: 13px; line-height: 1.6; }

/* --- 设置 ---*/
.settings-form { display: flex; flex-direction: column; gap: 12px; }

.setting-field {
  display: flex;
  flex-direction: column;
  gap: 4px;

  label { font-size: 12px; color: var(--n-text-color3, var(--text-primary)); }
}

.preset-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.settings-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }

/* --- Transition ---*/
.round-fade-enter-active { transition: all 0.4s ease; }
.round-fade-enter-from { opacity: 0; transform: translateY(12px); }
</style>
