<script setup lang="ts">
// 法律沟通场景 · 专属右栏面板：风险雷达 / 各方立场 / 法条依据 / 报告。
// 注册于 scene-ui-registry（legal 场景）。极简设计令牌与全局一致：
// 无卡片盒、发丝分隔线、无 emoji 图标。
import { computed, watch, onUnmounted, defineAsyncComponent } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NSpin } from 'naive-ui'
import { useMeetingStore } from '@/stores/hermes/meeting'
import { useMeetingAssist } from '@/composables/useMeetingAssist'
import { useLegalAggregation } from '@/composables/useLegalAggregation'
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

// ---------- 风险/立场/法条聚合 ----------
const { riskItems, positions, lawRefs } = useLegalAggregation({ rounds })

// 轮次持久化到 store（状态条等场景级组件从 store 派生，不开第二连接）
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
          sceneTemplate: 'legal',
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
  getSceneTemplate: () => 'legal',
  resolveProfile: () => session.value?.hermesProfile || undefined,
  onReportGenerated: (markdown) => emit('report-generated', markdown),
})

function buildTranscript(): string {
  const s = session.value
  const lines = (s?.sentences || []).map(x => `${x.speaker ? `[${x.speaker}] ` : ''}${x.text}`)
  const riskLines = riskItems.value.map(r => `- [${r.level === 'high' ? '高' : r.level === 'medium' ? '中' : '低'}] ${r.text}${r.lawHint ? `（${r.lawHint}）` : ''}`)
  const positionLines = positions.value.map(p => `- ${p.party}：${p.stance}`)
  const lawLines = lawRefs.value.map(l => `- ${l.name}${l.article ? ` ${l.article}` : ''}${l.note ? `（${l.note}）` : ''}（${l.verified ? '已核实' : '需人工核实'}）`)
  const evalBlock = [
    '【法律沟通评估数据】',
    '## 风险清单（实时累积）',
    ...(riskLines.length ? riskLines : ['（无）']),
    '## 各方立场',
    ...(positionLines.length ? positionLines : ['（无）']),
    '## 法条引用线索',
    ...(lawLines.length ? lawLines : ['（无）']),
  ]
  return [...lines, '', ...evalBlock].join('\n')
}

async function generateReport() {
  if (isGeneratingReport.value) return
  const transcript = buildTranscript()
  if (!transcript.trim()) return
  await streamReport(transcript)
}

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
  <div class="legal-review-panel">
    <!-- 顶部：连接状态 + 开始分析 -->
    <div class="eval-topbar">
      <div class="eval-status">
        <span class="status-dot" :class="{ connected: isConnected, analyzing: isAnalyzing }" />
        <span v-if="isAnalyzing">{{ t('meeting.legal.analyzing') }}</span>
        <span v-else-if="isConnected">{{ t('meeting.legal.connected') }}</span>
        <span v-else>{{ t('meeting.legal.notConnected') }}</span>
      </div>
      <NButton size="small" type="primary" :loading="isAnalyzing" :disabled="!props.isRecording" @click="analyzeNow">
        {{ t('meeting.legal.analyzeNow') }}
      </NButton>
    </div>

    <!-- 风险雷达 -->
    <section class="eval-section">
      <div class="section-title">
        <span class="section-name">{{ t('meeting.legal.riskRadar') }}</span>
      </div>
      <p class="section-desc">{{ t('meeting.legal.riskRadarDesc') }}</p>

      <div v-if="riskItems.length === 0" class="empty-hint">{{ t('meeting.legal.emptyRisks') }}</div>
      <TransitionGroup name="round-fade">
        <div v-for="r in riskItems" :key="r.text" class="risk-item" :class="`level-${r.level}`">
          <div class="risk-head">
            <span class="risk-level" :class="`level-${r.level}`">
              {{ t(`meeting.legal.level_${r.level}`) }}
            </span>
            <span class="risk-time">{{ new Date(r.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</span>
          </div>
          <div class="risk-text">{{ r.text }}</div>
          <div v-if="r.quote" class="risk-quote">「{{ r.quote }}」</div>
          <div v-if="r.lawHint" class="risk-law">{{ t('meeting.legal.lawHint') }}{{ r.lawHint }}</div>
        </div>
      </TransitionGroup>
    </section>

    <!-- 各方立场 -->
    <section class="eval-section">
      <div class="section-title">
        <span class="section-name">{{ t('meeting.legal.positions') }}</span>
      </div>
      <div v-if="positions.length === 0" class="empty-hint">{{ t('meeting.legal.emptyPositions') }}</div>
      <div v-for="p in positions" :key="`${p.party}-${p.stance}`" class="position-item">
        <span class="position-party">{{ p.party }}</span>
        <span class="position-stance">{{ p.stance }}</span>
      </div>
    </section>

    <!-- 法条依据 -->
    <section class="eval-section">
      <div class="section-title">
        <span class="section-name">{{ t('meeting.legal.lawRefs') }}</span>
      </div>
      <div v-if="lawRefs.length === 0" class="empty-hint">{{ t('meeting.legal.emptyLawRefs') }}</div>
      <div v-for="l in lawRefs" :key="`${l.name}-${l.article}`" class="law-item">
        <span class="law-name">{{ l.name }}<template v-if="l.article"> {{ l.article }}</template></span>
        <span class="law-verify" :class="{ verified: l.verified }">
          {{ l.verified ? t('meeting.legal.verified') : t('meeting.legal.needsVerify') }}
        </span>
        <div v-if="l.note" class="law-note">{{ l.note }}</div>
      </div>
      <p class="section-desc">{{ t('meeting.legal.verifyNote') }}</p>
    </section>

    <!-- 评估报告 -->
    <section class="eval-section report-section">
      <div class="section-title">
        <span class="section-name">{{ t('meeting.legal.reportTitle') }}</span>
      </div>
      <div class="report-generate-row">
        <NButton type="primary" size="small" :loading="isGeneratingReport" :disabled="!canGenerate" @click="generateReport">
          {{ t('meeting.legal.generateReport') }}
        </NButton>
      </div>
      <div v-if="reportError" class="report-error">{{ reportError }}</div>
      <div v-if="isGeneratingReport && !reportMarkdown" class="report-loading">
        <NSpin size="small" />
        <span>{{ t('meeting.speechEval.generating') }}</span>
      </div>
      <div v-if="reportMarkdown" class="report-content">
        <div class="report-actions">
          <MeetingExportDropdown :markdown="reportMarkdown" :title="exportTitle" scope="legalReview" />
        </div>
        <MarkdownRenderer :content="reportMarkdown" />
      </div>
    </section>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.legal-review-panel {
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

.eval-section {
  padding: 12px 2px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
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

/* 风险雷达*/
.risk-item {
  border-left: 3px solid rgba(var(--text-primary-rgb), 0.3);
  padding: 6px 8px;
  border-radius: 0 8px 8px 0;
  background: rgba(var(--text-primary-rgb), 0.03);
  display: flex;
  flex-direction: column;
  gap: 4px;

  &.level-high { border-left-color: var(--error); }
  &.level-medium { border-left-color: var(--warning); }
  &.level-low { border-left-color: var(--success); }
}

.risk-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.risk-level {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 6px;

  &.level-high { background: rgba(var(--error-rgb), 0.15); color: var(--warning); }
  &.level-medium { background: rgba(var(--warning-rgb), 0.15); color: var(--warning); }
  &.level-low { background: rgba(var(--success-rgb), 0.15); color: var(--success); }
}

.risk-time { font-size: 10px; color: var(--n-text-color3, var(--text-primary)); font-variant-numeric: tabular-nums; }
.risk-text { font-size: 12px; color: var(--text-primary); line-height: 1.5; }
.risk-quote { font-size: 11px; color: var(--accent-info); padding-left: 6px; border-left: 2px solid rgba(var(--accent-info-rgb), 0.4); }
.risk-law { font-size: 11px; color: var(--n-text-color3, var(--text-primary)); }

/* 各方立场*/
.position-item {
  display: flex;
  gap: 8px;
  font-size: 12px;
  padding: 4px 0;
}

.position-party {
  flex-shrink: 0;
  font-weight: 600;
  color: var(--accent-info);
  min-width: 48px;
}

.position-stance { color: var(--text-primary); line-height: 1.5; }

/* 法条依据*/
.law-item {
  font-size: 12px;
  padding: 4px 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.law-name { color: var(--text-primary); font-weight: 500; }

.law-verify {
  font-size: 10px;
  padding: 0 6px;
  border-radius: 8px;
  background: rgba(var(--warning-rgb), 0.12);
  color: var(--warning);

  &.verified { background: rgba(var(--success-rgb), 0.12); color: var(--success); }
}

.law-note { width: 100%; font-size: 11px; color: var(--n-text-color3, var(--text-primary)); }

/* 报告（与全局报告区一致）*/
.report-generate-row { display: flex; gap: 8px; }
.report-generate-row .n-button { flex: 1; }
.report-error { font-size: 12px; color: var(--error); padding: 6px 8px; background: rgba(var(--error-rgb), 0.08); border-radius: 6px; }
.report-loading { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--n-text-color3, var(--text-primary)); }
.report-actions { display: flex; justify-content: flex-end; margin-bottom: 8px; }
.report-content { font-size: 13px; line-height: 1.6; }
</style>
