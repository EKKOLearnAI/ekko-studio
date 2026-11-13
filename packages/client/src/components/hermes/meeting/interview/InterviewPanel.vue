<script setup lang="ts">
// 客户访谈场景 · 专属右栏面板：洞察流 / 关键引语 / 追问建议 / 报告。
// 注册于 scene-ui-registry（interview 场景）。极简设计令牌与全局一致：
// 无卡片盒、发丝分隔线、无 emoji 图标。
import { computed, watch, onUnmounted, defineAsyncComponent } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NSpin } from 'naive-ui'
import { useMeetingStore } from '@/stores/hermes/meeting'
import { useMeetingAssist } from '@/composables/useMeetingAssist'
import { useInterviewAggregation, type InsightType } from '@/composables/useInterviewAggregation'
import { useReportStream } from '@/composables/useReportStream'
import { request } from '@/api/client'
import MeetingExportDropdown from '../MeetingExportDropdown.vue'

const MarkdownRenderer = defineAsyncComponent(async () => (await import('@/components/hermes/chat/MarkdownRenderer.vue')).default)

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

const session = computed(() => meetingStore.sessions.find(s => s.id === props.sessionId))

// ---------- 实时 AI 分析（Socket.IO） ----------
const {
  rounds,
  isConnected,
  isAnalyzing,
  connect,
  disconnect,
  clear,
} = useMeetingAssist(props.sessionId)

// ---------- 洞察/引语/追问/参与度聚合 ----------
const {
  insights,
  keyQuotes,
  latestFollowUps,
  engagement,
  summary,
} = useInterviewAggregation({ rounds })

// 轮次持久化到 store（状态条从 store 派生，不开第二连接）
watch(rounds, (newRounds) => {
  meetingStore.updateSession(props.sessionId, { analysisRounds: [...newRounds] })
}, { deep: true })

// 录音开始/停止：连接 assist 会话
watch(() => props.isRecording, async (recording) => {
  if (recording) {
    connect()
    try {
      await request('/api/studio/meeting-asr/assist/start', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: props.sessionId,
          sceneTemplate: 'interview',
          profile: session.value?.hermesProfile || undefined,
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

// 立即分析：触发一次服务端分析
function analyzeNow() {
  if (isAnalyzing.value) return
  request('/api/studio/meeting-asr/assist/analyze', {
    method: 'POST',
    body: JSON.stringify({ sessionId: props.sessionId }),
  }).catch(() => {})
}

// ---------- 评估报告（走 useReportStream：fallback 帧/错误分类/重试与全局一致） ----------
const {
  reportMarkdown,
  isGeneratingReport,
  reportError,
  generateReport: streamReport,
} = useReportStream({
  getSessionId: () => props.sessionId,
  getSceneTemplate: () => 'interview',
  resolveProfile: () => session.value?.hermesProfile || undefined,
  onReportGenerated: (markdown) => emit('report-generated', markdown),
})

function buildTranscript(): string {
  const s = session.value
  const lines = (s?.sentences || []).map(x => `${x.speaker ? `[${x.speaker}] ` : ''}${x.text}`)
  const typeLabel: Record<InsightType, string> = {
    need: t('meeting.interview.typeNeed'),
    pain: t('meeting.interview.typePain'),
    opportunity: t('meeting.interview.typeOpportunity'),
    competitor: t('meeting.interview.typeCompetitor'),
  }
  const insightLines = insights.value.map(i => `- [${typeLabel[i.type]}] ${i.text}${i.quote ? `（原话：${i.quote}）` : ''}`)
  const quoteLines = keyQuotes.value.map(q => `- 「${q.quote}」${q.speaker ? `—— ${q.speaker}` : ''}`)
  const followUpLines = latestFollowUps.value.map(f => `- ${f}`)
  const evalBlock = [
    '【客户访谈洞察数据】',
    '## 洞察清单（实时累积）',
    ...(insightLines.length ? insightLines : ['（无）']),
    '## 客户关键引语',
    ...(quoteLines.length ? quoteLines : ['（无）']),
    '## 待追问事项',
    ...(followUpLines.length ? followUpLines : ['（无）']),
    ...(engagement.value ? [`## 参与度（最新）：${engagement.value}`] : []),
  ]
  return [...lines, '', ...evalBlock].join('\n')
}

async function generateReport() {
  if (isGeneratingReport.value) return
  const transcript = buildTranscript()
  if (!transcript.trim()) return
  await streamReport(transcript)
}

const engagementLabel = computed(() => {
  const map: Record<string, string> = {
    engaged: t('meeting.interview.engaged'),
    neutral: t('meeting.interview.neutral'),
    distracted: t('meeting.interview.distracted'),
    at_risk: t('meeting.interview.atRisk'),
  }
  return engagement.value ? map[engagement.value] : undefined
})

const canGenerate = computed(() => (session.value?.sentences?.length ?? 0) > 0)

// 导出报告
const exportTitle = computed(() => session.value?.title || t('meeting.reportPanel.title'))

// 切换会话时重置
watch(() => props.sessionId, () => {
  disconnect()
  clear()
})

onUnmounted(() => {
  disconnect()
})
</script>

<template>
  <div class="interview-panel">
    <!-- 顶部：连接状态 + 开始分析 -->
    <div class="eval-topbar">
      <div class="eval-status">
        <span class="status-dot" :class="{ connected: isConnected, analyzing: isAnalyzing }" />
        <span v-if="isAnalyzing">{{ t('meeting.interview.analyzing') }}</span>
        <span v-else-if="isConnected">{{ t('meeting.interview.connected') }}</span>
        <span v-else>{{ t('meeting.interview.notConnected') }}</span>
      </div>
      <NButton size="small" type="primary" :loading="isAnalyzing" :disabled="!props.isRecording" @click="analyzeNow">
        {{ t('meeting.interview.analyzeNow') }}
      </NButton>
    </div>

    <!-- 常驻 KPI 头（sticky）：需求/痛点/跟进/参与度 -->
    <div class="kpi-bar" data-theme-surface="card">
      <div class="kpi-cell">
        <span class="kpi-value">{{ summary.needCount }}</span>
        <span class="kpi-label">{{ t('meeting.interview.kpiNeeds') }}</span>
      </div>
      <div class="kpi-cell">
        <span class="kpi-value">{{ summary.painCount }}</span>
        <span class="kpi-label">{{ t('meeting.interview.kpiPains') }}</span>
      </div>
      <div class="kpi-cell">
        <span class="kpi-value">{{ summary.followUpCount }}</span>
        <span class="kpi-label">{{ t('meeting.interview.kpiFollowUps') }}</span>
      </div>
      <div class="kpi-cell">
        <span class="kpi-value" :class="{ warn: engagement === 'at_risk' }">
          {{ engagementLabel ?? '—' }}
        </span>
        <span class="kpi-label">{{ t('meeting.interview.kpiEngagement') }}</span>
      </div>
    </div>

    <!-- 洞察流 -->
    <section class="eval-section">
      <div class="section-title">
        <span class="section-name">{{ t('meeting.interview.insights') }}</span>
      </div>
      <p class="section-desc">{{ t('meeting.interview.insightsDesc') }}</p>

      <div v-if="insights.length === 0" class="empty-hint">{{ t('meeting.interview.emptyInsights') }}</div>

      <div v-for="(i, idx) in insights" :key="idx" class="insight-item" :class="`type-${i.type}`">
        <span class="insight-type">{{ t(`meeting.interview.type${i.type[0].toUpperCase()}${i.type.slice(1)}`) }}</span>
        <span class="insight-text">{{ i.text }}</span>
        <span v-if="i.quote" class="insight-quote">「{{ i.quote }}」</span>
      </div>
    </section>

    <!-- 关键引语 -->
    <section class="eval-section">
      <div class="section-title">
        <span class="section-name">{{ t('meeting.interview.quotes') }}</span>
      </div>
      <p class="section-desc">{{ t('meeting.interview.quotesDesc') }}</p>

      <div v-if="keyQuotes.length === 0" class="empty-hint">{{ t('meeting.interview.emptyQuotes') }}</div>

      <div v-for="(q, idx) in keyQuotes" :key="idx" class="quote-card">
        <span class="quote-text">「{{ q.quote }}」</span>
        <span v-if="q.speaker" class="quote-speaker">—— {{ q.speaker }}</span>
      </div>
    </section>

    <!-- 追问建议 -->
    <section class="eval-section">
      <div class="section-title">
        <span class="section-name">{{ t('meeting.interview.followUps') }}</span>
      </div>
      <p class="section-desc">{{ t('meeting.interview.followUpsDesc') }}</p>

      <div v-if="latestFollowUps.length === 0" class="empty-hint">{{ t('meeting.interview.emptyFollowUps') }}</div>
      <div v-for="(f, idx) in latestFollowUps" :key="idx" class="followup-item">
        <span class="followup-index">{{ idx + 1 }}</span>
        <span class="followup-text">{{ f }}</span>
      </div>
    </section>

    <!-- 评估报告 -->
    <section class="eval-section report-section">
      <div class="section-title">
        <span class="section-name">{{ t('meeting.interview.reportTitle') }}</span>
      </div>
      <div class="report-generate-row">
        <NButton type="primary" size="small" :loading="isGeneratingReport" :disabled="!canGenerate" @click="generateReport">
          {{ t('meeting.interview.generateReport') }}
        </NButton>
      </div>

      <div v-if="reportError" class="report-error">{{ reportError }}</div>

      <div v-if="isGeneratingReport && !reportMarkdown" class="report-loading">
        <NSpin size="small" />
        <span>{{ t('meeting.interview.generating') }}</span>
      </div>

      <div v-if="reportMarkdown" class="report-content">
        <div class="report-actions">
          <MeetingExportDropdown
            :markdown="reportMarkdown"
            :title="exportTitle"
            scope="interviewReview"
          />
        </div>
        <MarkdownRenderer :content="reportMarkdown" />
      </div>
    </section>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.interview-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
  padding: 12px 14px;
  gap: 12px;
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

/* 常驻 KPI 头：极简扁平（大数字 + 小标签，发丝分隔）*/
.kpi-bar {
  position: sticky;
  top: -12px;
  z-index: 5;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0;
  padding: 10px 4px;
  background: var(--theme-card-bg, var(--bg-card));
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

  &.warn { color: var(--warning); }
}

.kpi-label { font-size: 10px; color: var(--n-text-color3, var(--text-primary)); }

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
  gap: 8px;
}

.section-name { font-size: 13px; font-weight: 600; color: $text-primary; }
.section-desc { font-size: 11px; color: $text-secondary; line-height: 1.5; }
.empty-hint { font-size: 11px; color: var(--n-text-color3, var(--text-primary)); }

/* 洞察流：按类型着色左缘*/
.insight-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(var(--text-primary-rgb), 0.03);
  border-left: 2px solid rgba(var(--text-primary-rgb), 0.1);

  &.type-need { border-left-color: var(--success); }
  &.type-pain { border-left-color: var(--error); }
  &.type-opportunity { border-left-color: var(--accent-info); }
  &.type-competitor { border-left-color: var(--warning); }
}

.insight-type { font-size: 10px; font-weight: 600; color: $text-secondary; }
.insight-text { font-size: 12px; color: var(--text-primary); line-height: 1.5; }
.insight-quote { font-size: 11px; color: var(--accent-info); }

/* 引语卡*/
.quote-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(var(--accent-info-rgb), 0.05);
  border: 1px solid rgba(var(--accent-info-rgb), 0.12);
}

.quote-text { font-size: 12px; color: var(--text-primary); line-height: 1.6; }
.quote-speaker { font-size: 11px; color: var(--accent-info); align-self: flex-end; }

/* 追问建议*/
.followup-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(var(--accent-info-rgb), 0.05);
}

.followup-index {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: rgba(var(--accent-info-rgb), 0.15);
  color: var(--accent-info);
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.followup-text { color: var(--text-primary); line-height: 1.5; }

/* 报告*/
.report-section { gap: 8px; }
.report-generate-row { display: flex; gap: 8px; }
.report-generate-row .n-button { flex: 1; }
.report-error { font-size: 12px; color: var(--error); padding: 6px 8px; background: rgba(var(--error-rgb), 0.08); border-radius: 6px; }
.report-loading { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--n-text-color3, var(--text-primary)); }
.report-actions { display: flex; justify-content: flex-end; margin-bottom: 8px; }
.report-content { font-size: 13px; line-height: 1.6; }
</style>
