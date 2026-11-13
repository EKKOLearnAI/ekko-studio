<script setup lang="ts">
import { ref, computed, watch, nextTick, defineAsyncComponent, onUnmounted, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NSpin, NTag } from 'naive-ui'
import { useMeetingAssist } from '@/composables/useMeetingAssist'
import { useReportStream } from '@/composables/useReportStream'
import { request } from '@/api/client'
import { useMeetingStore } from '@/stores/hermes/meeting'
import MeetingExportDropdown from './MeetingExportDropdown.vue'

const MarkdownRenderer = defineAsyncComponent(async () => (await import('@/components/hermes/chat/MarkdownRenderer.vue')).default)

const props = withDefaults(defineProps<{
  sessionId: string
  sceneTemplate?: string
  isRecording?: boolean
  // meeting 分支兼容：触发一次分析（当前 assist 架构下为占位，供后续接线）
  startTrigger?: number
}>(), {
  sceneTemplate: 'general',
  isRecording: false,
  startTrigger: 0,
})

const emit = defineEmits<{
  (e: 'report-generated', markdown: string): void
  (e: 'request-report'): void
  // meeting 分支兼容事件（assist 架构下暂不触发，保留契约供视图侧处理器）
  (e: 'update:analysisResult', result: any): void
  (e: 'update:reportHtml', html: string): void
  (e: 'completed'): void
  (e: 'corrected', sentences: any[]): void
}>()

const { t } = useI18n()

// Realtime assist composable
const {
  rounds,
  isConnected,
  isAnalyzing,
  error,
  connect,
  disconnect,
  clear,
} = useMeetingAssist(props.sessionId)

const meetingStore = useMeetingStore()

// 当前会议信息
const currentSession = computed(() => meetingStore.sessions.find(s => s.id === props.sessionId))

// 场景标签映射
const sceneLabelMap: Record<string, string> = {
  general: t('meeting.scene.general'),
  legal: t('meeting.scene.legal'),
  business: t('meeting.scene.business'),
  medical: t('meeting.scene.medical'),
  interview: t('meeting.scene.interview'),
  speech: t('meeting.scene.speech'),
}

// 分析模式标签
const analysisModeLabel = computed(() => {
  const session = currentSession.value
  if (!session) return ''
  return session.analysisMode === 'hermes' ? 'Hermes Agent' : t('meeting.customModel')
})

// Agent 类型标签
const agentTypeLabel = computed(() => {
  const session = currentSession.value
  if (!session?.agentConfig) return 'Hermes Agent'
  const typeMap: Record<string, string> = {
    'hermes': 'Hermes Agent',
    'claude-code': 'Claude Code',
    'codex': 'Codex',
  }
  return typeMap[session.agentConfig.agentType] || 'Hermes Agent'
})

// 句子数量
const sentenceCount = computed(() => currentSession.value?.sentences.length || 0)

// 加载已持久化的历史分析记录
onMounted(() => {
  const session = meetingStore.sessions.find(s => s.id === props.sessionId)
  if (session?.analysisRounds?.length) {
    rounds.value = [...session.analysisRounds]
  }
})

// 解析本会议使用的 Hermes profile（供服务端加载该 profile 下的分析技能）
function resolveProfile(): string | undefined {
  const session = meetingStore.sessions.find(s => s.id === props.sessionId)
  return session?.hermesProfile || undefined
}

// 新分析到达时同步持久化到 store
watch(rounds, (newRounds) => {
  meetingStore.updateSession(props.sessionId, { analysisRounds: [...newRounds] })
}, { deep: true })

// Report state（拆分至 useReportStream，行为保持不变）
const {
  reportMarkdown,
  isGeneratingReport,
  reportError,
  lastTranscript,
  generateReport,
  retryReport,
} = useReportStream({
  getSessionId: () => props.sessionId,
  getSceneTemplate: () => props.sceneTemplate,
  resolveProfile,
  onReportGenerated: (markdown) => emit('report-generated', markdown),
})

// Rounds container ref for auto-scroll
const roundsContainer = ref<HTMLElement | null>(null)

// Scene label
const sceneLabel = computed(() => {
  const map: Record<string, string> = {
    general: t('meeting.scene.general'),
    legal: t('meeting.scene.legal'),
    business: t('meeting.scene.business'),
    medical: t('meeting.scene.medical'),
    interview: t('meeting.scene.interview'),
    speech: t('meeting.scene.speech'),
  }
  return map[props.sceneTemplate] || map.general
})

// Whether there has been any content (rounds or recording happened)
const hasContent = computed(() => rounds.value.length > 0 || reportMarkdown.value.length > 0)

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// Auto-scroll to bottom when new rounds arrive
function scrollToBottom() {
  nextTick(() => {
    if (roundsContainer.value) {
      roundsContainer.value.scrollTop = roundsContainer.value.scrollHeight
    }
  })
}

watch(rounds, scrollToBottom, { deep: true })

// Start/stop assist based on recording state
watch(() => props.isRecording, async (recording) => {
  if (recording) {
    // 保留同一会议的历史分析记录，仅重置报告状态
    reportMarkdown.value = ''
    reportError.value = null
    connect()
    // Notify server to start assist session
    try {
      await request('/api/studio/meeting-asr/assist/start', {
        method: 'POST',
        body: JSON.stringify({ sessionId: props.sessionId, sceneTemplate: props.sceneTemplate, profile: resolveProfile() }),
      })
    } catch { /* best effort */ }
  } else {
    // Stop assist
    try {
      await request('/api/studio/meeting-asr/assist/stop', {
        method: 'POST',
        body: JSON.stringify({ sessionId: props.sessionId }),
      })
    } catch { /* best effort */ }
    disconnect()
  }
}, { immediate: true })

// 导出报告：拆分按钮 + 下拉菜单，默认 Word（极致样式），可切 HTML / Markdown。
const exportTitle = computed(() => meetingStore.activeSession?.title || t('meeting.reportPanel.title'))

// Expose generateReport for parent component
defineExpose({ generateReport })

onUnmounted(() => {
  disconnect()
})
</script>

<template>
  <div class="assist-panel">
    <!-- Header -->
    <div class="assist-header">
      <div class="assist-header-left">
        <span class="scene-badge">{{ sceneLabel }}</span>
        <span class="status-indicator" :class="{ active: isConnected && isRecording, analyzing: isAnalyzing }">
          <span class="status-dot" />
          <span class="status-text">
            <template v-if="isAnalyzing">{{ t('meeting.assist.analyzing') }}</template>
            <template v-else-if="isConnected && isRecording">{{ t('meeting.assist.listening') }}</template>
            <template v-else>{{ t('meeting.assist.idle') }}</template>
          </span>
        </span>
      </div>
      <NButton v-if="rounds.length > 0" size="tiny" quaternary @click="clear()">
        {{ t('meeting.assist.clearHints') }}
      </NButton>
    </div>

    <!-- Analysis rounds stream -->
    <div ref="roundsContainer" class="assist-rounds-area">
      <!-- Session info & empty state -->
      <div v-if="rounds.length === 0 && !isGeneratingReport && !reportMarkdown" class="assist-empty">
        <div class="session-info-panel">
          <!-- 会议配置标签 -->
          <div class="session-tags">
            <NTag size="small" type="info" :bordered="false">
              {{ sceneLabelMap[sceneTemplate] || sceneLabelMap.general }}
            </NTag>
            <NTag size="small" type="success" :bordered="false">
              {{ agentTypeLabel }}
            </NTag>
            <NTag v-if="currentSession?.analysisMode" size="small" type="warning" :bordered="false">
              {{ analysisModeLabel }}
            </NTag>
          </div>

          <!-- 会议统计 -->
          <div class="session-stats">
            <div class="stat-item">
              <span class="stat-value">{{ sentenceCount }}</span>
              <span class="stat-label">{{ t('meeting.sentences') }}</span>
            </div>
            <div class="stat-item">
              <span class="stat-value">{{ rounds.length }}</span>
              <span class="stat-label">{{ t('meeting.assist.hints') }}</span>
            </div>
          </div>

          <!-- 状态提示 -->
          <div class="session-status">
            <template v-if="isRecording">
              <div class="status-icon recording">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
                  <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
                </svg>
              </div>
              <span class="status-text-active">{{ t('meeting.assist.listening') }}</span>
            </template>
            <template v-else-if="isAnalyzing">
              <div class="status-icon analyzing">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"/>
                  <path d="M12 6v6l4 2"/>
                </svg>
              </div>
              <span class="status-text-active">{{ t('meeting.assist.analyzing') }}</span>
            </template>
            <template v-else>
              <div class="status-icon idle">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/>
                  <path d="M8 12l3 3 5-5"/>
                </svg>
              </div>
              <span class="status-text-idle">{{ t('meeting.assist.notRecording') }}</span>
            </template>
          </div>

          <!-- 使用提示 -->
          <div class="usage-hint">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" opacity="0.5">
              <circle cx="12" cy="12" r="10"/>
              <path d="M12 16v-4"/>
              <path d="M12 8h.01"/>
            </svg>
            <span>{{ t('meeting.assist.usageHint') }}</span>
          </div>
        </div>
      </div>

      <!-- Analysis round cards -->
      <TransitionGroup name="round-fade">
        <div
          v-for="round in rounds"
          :key="round.id"
          class="round-card" data-theme-surface="card"
          :class="`priority-${round.priority}`"
        >
          <!-- Time + priority badge -->
          <div class="round-meta">
            <span class="round-time">{{ formatTime(round.timestamp) }}</span>
            <span v-if="round.priority === 'urgent'" class="priority-badge urgent">紧急</span>
            <span v-else-if="round.priority === 'attention'" class="priority-badge attention">注意</span>
          </div>

          <!-- Key point (highlighted, prominent) -->
          <div v-if="round.keyPoint" class="round-keypoint" :class="`priority-${round.priority}`">
            {{ round.keyPoint }}
          </div>

          <!-- Context quote (original text) -->
          <div v-if="round.context" class="round-context">
            <span class="context-quote">「{{ round.context }}」</span>
          </div>

          <!-- Analysis body (secondary detail) -->
          <div v-if="round.analysis" class="round-analysis">{{ round.analysis }}</div>
        </div>
      </TransitionGroup>

      <!-- Analyzing indicator -->
      <div v-if="isAnalyzing" class="analyzing-indicator">
        <NSpin size="small" />
        <span>{{ t('meeting.assist.thinking') }}</span>
      </div>
    </div>

    <!-- Report action bar (shown when recording stopped and no report yet) -->
    <div v-if="!isRecording && !reportMarkdown && !isGeneratingReport" class="report-action-bar">
      <NButton type="primary" size="small" :disabled="!hasContent" @click="emit('request-report')">
        {{ t('meeting.reportPanel.generate') }}
      </NButton>
    </div>

    <!-- Report section (shown after recording stops) -->
    <div v-if="!isRecording && (reportMarkdown || isGeneratingReport || reportError)" class="assist-report-section">
      <div class="report-header">
        <span class="report-title">{{ t('meeting.reportPanel.title') }}</span>
        <div class="report-actions">
          <MeetingExportDropdown
            v-if="reportMarkdown && !isGeneratingReport"
            :markdown="reportMarkdown"
            :title="exportTitle"
            scope="reportPanel"
          />
        </div>
      </div>

      <div v-if="reportError" class="report-error">
        <span>{{ reportError }}</span>
        <NButton
          v-if="lastTranscript && !isGeneratingReport"
          size="tiny"
          class="report-retry"
          @click="retryReport"
        >
          {{ t('meeting.reportPanel.retry') }}
        </NButton>
      </div>

      <div v-if="isGeneratingReport && !reportMarkdown" class="report-loading">
        <NSpin size="small" />
        <span>{{ t('meeting.reportPanel.generating') }}</span>
      </div>

      <div v-if="reportMarkdown" class="report-content">
        <MarkdownRenderer :content="reportMarkdown" />
      </div>
    </div>

    <!-- Error -->
    <div v-if="error" class="assist-error">{{ error }}</div>
  </div>
</template>

<style scoped>
.assist-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.assist-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--n-border-color, rgba(var(--text-primary-rgb), 0.08));
  flex-shrink: 0;
}

.assist-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.scene-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(var(--success-rgb), 0.15);
  color: var(--success);
  font-weight: 600;
  letter-spacing: 0.5px;
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 5px;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--theme-card-bg, var(--theme-card-bg, var(--bg-card)));
  transition: background 0.3s;
}

.status-indicator.active .status-dot {
  background: var(--success);
  animation: pulse 2s infinite;
}

.status-indicator.analyzing .status-dot {
  background: var(--warning);
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.status-text {
  font-size: 12px;
  color: var(--n-text-color3, var(--text-primary));
}

.assist-rounds-area {
  flex: 1;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.assist-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 14px;
}

.session-info-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  width: 100%;
  max-width: 280px;
  text-align: center;
}

.session-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: center;
}

.session-stats {
  display: flex;
  gap: 24px;
  padding: 12px 16px;
  background: rgba(var(--text-primary-rgb), 0.03);
  border-radius: 8px;
  border: 1px solid rgba(var(--text-primary-rgb), 0.06);
  width: 100%;
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 1;
}

.stat-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--n-text-color, var(--text-primary));
  line-height: 1.2;
}

.stat-label {
  font-size: 11px;
  color: var(--n-text-color3, var(--text-primary));
  margin-top: 2px;
}

.session-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  background: rgba(var(--text-primary-rgb), 0.03);
  border: 1px solid rgba(var(--text-primary-rgb), 0.06);
  width: 100%;
}

.status-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
}

.status-icon.recording {
  background: rgba(var(--error-rgb), 0.15);
  color: var(--error);
  animation: pulse 2s infinite;
}

.status-icon.analyzing {
  background: rgba(var(--warning-rgb), 0.15);
  color: var(--warning);
  animation: pulse 1.5s infinite;
}

.status-icon.idle {
  background: rgba(var(--text-primary-rgb), 0.15);
  color: var(--text-primary);
}

.status-text-active {
  font-size: 12px;
  font-weight: 500;
  color: var(--n-text-color, var(--text-primary));
}

.status-text-idle {
  font-size: 12px;
  color: var(--n-text-color3, var(--text-primary));
}

.usage-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--n-text-color3, var(--text-primary));
  line-height: 1.4;
  text-align: left;
}

/* --- Analysis Round Card --- */
.round-card {
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--n-card-color, rgba(var(--text-primary-rgb), 0.04));
  border: 1px solid var(--n-border-color, rgba(var(--text-primary-rgb), 0.06));
  border-left: 3px solid rgba(var(--text-primary-rgb), 0.3);
  transition: all 0.3s ease;
}

.round-card.priority-normal {
  border-left-color: rgba(var(--accent-info-rgb), 0.5);
}

.round-card.priority-attention {
  border-left-color: var(--warning);
  background: rgba(var(--warning-rgb), 0.04);
}

.round-card.priority-urgent {
  border-left-color: var(--error);
  background: rgba(var(--error-rgb), 0.06);
}

.round-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.round-time {
  font-size: 11px;
  color: var(--n-text-color3, var(--text-primary));
  font-variant-numeric: tabular-nums;
}

.priority-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 8px;
  letter-spacing: 0.5px;
}

.priority-badge.attention {
  background: rgba(var(--warning-rgb), 0.15);
  color: var(--warning);
}

.priority-badge.urgent {
  background: rgba(var(--error-rgb), 0.15);
  color: var(--error);
}

/* Key point - prominent, eye-catching highlight */
.round-keypoint {
  font-size: 15px;
  font-weight: 700;
  line-height: 1.5;
  margin-bottom: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  word-break: break-word;
}

.round-keypoint.priority-normal {
  color: var(--success);
  background: rgba(var(--success-rgb), 0.08);
  border-left: 3px solid var(--success);
}

.round-keypoint.priority-attention {
  color: var(--warning);
  background: rgba(var(--warning-rgb), 0.1);
  border-left: 3px solid var(--warning);
}

.round-keypoint.priority-urgent {
  color: var(--error);
  background: rgba(var(--error-rgb), 0.15);
  border-left: 3px solid var(--error);
  font-size: 16px;
}

/* Context quote - references original speech */
.round-context {
  margin-bottom: 8px;
  padding: 6px 10px;
  border-left: 3px solid var(--accent-info);
  background: rgba(var(--accent-info-rgb), 0.08);
  border-radius: 0 6px 6px 0;
}

.context-quote {
  font-size: 12px;
  color: var(--accent-info);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* Secondary analysis text */
.round-analysis {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-primary);
  word-break: break-word;
}

/* --- Analyzing indicator --- */
.analyzing-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  font-size: 12px;
  color: var(--n-text-color3, var(--text-primary));
}

/* --- Report action bar --- */
.report-action-bar {
  display: flex;
  justify-content: center;
  padding: 12px 14px;
  border-top: 1px solid var(--n-border-color, rgba(var(--text-primary-rgb), 0.08));
  flex-shrink: 0;
}

/* --- Report section --- */
.assist-report-section {
  border-top: 1px solid var(--n-border-color, rgba(var(--text-primary-rgb), 0.08));
  max-height: 50%;
  overflow-y: auto;
  padding: 14px;
  flex-shrink: 0;
}

.report-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.report-title {
  font-size: 13px;
  font-weight: 600;
}

.report-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--n-text-color3, var(--text-primary));
}

.report-error {
  font-size: 13px;
  color: var(--error);
  margin-bottom: 8px;
  padding: 8px 12px;
  background: rgba(var(--error-rgb), 0.08);
  border-radius: 6px;
  border: 1px solid rgba(var(--error-rgb), 0.2);
  display: flex;
  align-items: flex-start;
  gap: 8px;

  .report-retry {
    flex-shrink: 0;
  }
}

.report-content {
  font-size: 13px;
  line-height: 1.6;
}

.assist-error {
  padding: 8px 14px;
  font-size: 12px;
  color: var(--error);
  border-top: 1px solid rgba(var(--error-rgb), 0.2);
}

/* --- Transition --- */
.round-fade-enter-active {
  transition: all 0.4s ease;
}

.round-fade-enter-from {
  opacity: 0;
  transform: translateY(12px);
}
</style>
