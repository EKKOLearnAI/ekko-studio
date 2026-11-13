<script setup lang="ts">
// 演讲评分 · 单轮 AI 点评卡（自 SpeechEvalBlocks 拆出：
// 平铺视图与按演讲者折叠模块共用同一渲染，避免样式漂移）。
import { useI18n } from 'vue-i18n'
import { NTag } from 'naive-ui'
import type { AnalysisRound } from '@/composables/useMeetingAssist'

const props = defineProps<{
  round: AnalysisRound
}>()

const { t } = useI18n()
</script>

<template>
  <div class="round-card" data-theme-surface="card" :class="`priority-${props.round.priority}`">
    <div class="round-meta">
      <span class="round-time">{{ new Date(props.round.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }}</span>
      <span v-if="props.round.speaker" class="round-speaker">🎤 {{ props.round.speaker }}</span>
      <span v-if="props.round.priority === 'urgent'" class="priority-badge urgent">{{ t('meeting.assist.urgent') }}</span>
      <span v-else-if="props.round.priority === 'attention'" class="priority-badge attention">{{ t('meeting.assist.attention') }}</span>
    </div>

    <div v-if="props.round.keyPoint" class="round-keypoint" :class="`priority-${props.round.priority}`">{{ props.round.keyPoint }}</div>
    <div v-if="props.round.context" class="round-context">「{{ props.round.context }}」</div>
    <div v-if="props.round.analysis" class="round-analysis">{{ props.round.analysis }}</div>
    <div v-if="props.round.timeNote" class="round-timenote">⏱️ {{ props.round.timeNote }}</div>

    <div v-if="props.round.fillerWords?.length" class="round-chips">
      <NTag v-for="f in props.round.fillerWords" :key="f.word" size="small" type="warning" :bordered="false">
        {{ f.word }} ×{{ f.count }}<template v-if="f.speaker"> · {{ f.speaker }}</template>
      </NTag>
    </div>

    <div v-if="props.round.goldenQuotes?.length" class="round-lists">
      <div class="round-list-title">✨ {{ t('meeting.speechEval.goldenQuotes') }}</div>
      <div v-for="(q, i) in props.round.goldenQuotes" :key="i" class="round-list-item">
        「{{ q.quote }}」<template v-if="q.speaker"><span class="quote-speaker">—— {{ q.speaker }}</span></template>
        <div v-if="q.reason" class="quote-reason">{{ q.reason }}</div>
      </div>
    </div>

    <div v-if="props.round.grammarIssues?.length" class="round-lists">
      <div class="round-list-title">⚠️ {{ t('meeting.speechEval.grammarIssues') }}</div>
      <div v-for="(g, i) in props.round.grammarIssues" :key="i" class="round-list-item">
        「{{ g.quote }}」— {{ g.issue }}<template v-if="g.speaker"><span class="quote-speaker">（{{ g.speaker }}）</span></template>
      </div>
    </div>

    <div v-if="props.round.wotdUsed" class="round-wotd">📖 {{ t('meeting.speechEval.wotdUsedFlag') }}</div>
  </div>
</template>

<style scoped lang="scss">
.round-card {
  border-radius: 10px;
  padding: 10px 12px;
  background: rgba(var(--text-primary-rgb), 0.04);
  border: 1px solid rgba(var(--text-primary-rgb), 0.06);
  border-left: 3px solid rgba(var(--text-primary-rgb), 0.3);
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  max-width: 100%;

  &.priority-attention { border-left-color: var(--warning); }
  &.priority-urgent { border-left-color: var(--error); }
}

.round-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.round-time { font-size: 11px; color: var(--n-text-color3, var(--text-primary)); font-variant-numeric: tabular-nums; }

.round-speaker {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent-info);
  padding: 1px 6px;
  border-radius: 8px;
  background: rgba(var(--accent-info-rgb), 0.12);
}

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

.round-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
  max-width: 100%;

  :deep(.n-tag) {
    max-width: 100%;
    height: auto;
    white-space: normal;
    word-break: break-word;
  }
}

.round-lists { display: flex; flex-direction: column; gap: 3px; }
.round-list-title { font-size: 11px; color: var(--n-text-color3, var(--text-primary)); }
.round-list-item { font-size: 12px; color: var(--text-primary); line-height: 1.5; }

.round-wotd { font-size: 12px; color: var(--success); }

.quote-speaker { color: var(--accent-info); font-size: 11px; }
.quote-reason { font-size: 11px; color: var(--n-text-color3, var(--text-primary)); padding-left: 4px; }
</style>
