<script setup lang="ts">
// 演讲评分 · 单演讲者折叠子模块：评分 → 亮点/提升点/主题 → 点评轮次，
// 整体可收起；头部带该演讲者总分徽标与「导出该演讲者点评」按钮。
// 多演讲者场景由 SpeechEvalBlocks 按人渲染一份；单人场景不使用（保持原平铺视图）。
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NTag } from 'naive-ui'
import { SCORE_LABEL_MAP } from '@/composables/useSpeechAiAggregation'
import type { AnalysisRound } from '@/composables/useMeetingAssist'
import { buildSpeakerFeedbackMarkdown, downloadTextFile } from '@/utils/speech-export'
import SpeechRoundCard from './SpeechRoundCard.vue'

const props = defineProps<{
  /** 演讲者名（空串由父组件转为「未标注」显示名） */
  speaker: string
  score?: Record<string, number>
  scoreUpdatedAt?: number
  highlights: string[]
  improvements: string[]
  topics: string[]
  rounds: AnalysisRound[]
}>()

const { t } = useI18n()

const collapsed = ref(false)

const hasBody = computed(() =>
  props.highlights.length > 0 || props.improvements.length > 0 ||
  props.topics.length > 0 || props.rounds.length > 0 ||
  (props.score && Object.keys(props.score).length > 0),
)

function toggleCollapsed() {
  collapsed.value = !collapsed.value
}

function exportFeedback() {
  const md = buildSpeakerFeedbackMarkdown({
    speaker: props.speaker,
    score: props.score,
    scoreUpdatedAt: props.scoreUpdatedAt,
    highlights: props.highlights,
    improvements: props.improvements,
    topics: props.topics,
    rounds: props.rounds,
  })
  downloadTextFile(`演讲点评_${props.speaker || t('meeting.speechEval.unknownSpeaker')}.md`, md)
}
</script>

<template>
  <div class="speaker-card" :class="{ collapsed }">
    <button type="button" class="speaker-header" @click="toggleCollapsed">
      <span class="chevron">{{ collapsed ? '▶' : '▼' }}</span>
      <span class="speaker-name">🎤 {{ props.speaker }}</span>
      <span v-if="props.score?.overall != null" class="speaker-score">{{ props.score.overall }}</span>
      <span class="header-spacer" />
      <NButton
        size="tiny"
        quaternary
        class="export-btn"
        :title="t('meeting.speechEval.exportSpeakerFeedback')"
        @click.stop="exportFeedback"
      >
        ⬇ {{ t('meeting.speechEval.exportSpeakerFeedback') }}
      </NButton>
    </button>

    <div v-if="!collapsed && hasBody" class="speaker-body">
      <div v-if="props.score && Object.keys(props.score).length" class="score-grid">
        <div v-for="(labelKey, key) in SCORE_LABEL_MAP" :key="key" class="score-item" :class="{ overall: key === 'overall' }">
          <span class="score-label">{{ t(labelKey) }}</span>
          <span class="score-value">{{ props.score![key] ?? '—' }}</span>
        </div>
      </div>

      <div v-if="props.highlights.length" class="tag-group">
        <div class="tag-title">✨ {{ t('meeting.speechEval.highlights') }}</div>
        <div class="tag-tags">
          <NTag v-for="(h, i) in props.highlights" :key="`h-${i}`" size="small" type="success" :bordered="false">✓ {{ h }}</NTag>
        </div>
      </div>

      <div v-if="props.improvements.length" class="tag-group">
        <div class="tag-title">💡 {{ t('meeting.speechEval.topImprovement') }}</div>
        <div class="tag-tags">
          <NTag v-for="(imp, i) in props.improvements" :key="`i-${i}`" size="small" type="warning" :bordered="false">↗ {{ imp }}</NTag>
        </div>
      </div>

      <div v-if="props.topics.length" class="tag-group">
        <div class="tag-title">🏷️ {{ t('meeting.speechEval.topics') }}</div>
        <div class="tag-tags">
          <NTag v-for="(tp, i) in props.topics" :key="`t-${i}`" size="small" type="info" :bordered="false">{{ tp }}</NTag>
        </div>
      </div>

      <div v-if="props.rounds.length" class="round-list">
        <SpeechRoundCard v-for="r in props.rounds" :key="r.id" :round="r" />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.speaker-card {
  border-radius: 10px;
  border: 1px solid rgba(var(--accent-info-rgb), 0.22);
  background: rgba(var(--accent-info-rgb), 0.05);
  overflow: hidden;
  min-width: 0;
  max-width: 100%;
}

.speaker-header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  background: rgba(var(--accent-info-rgb), 0.1);
  cursor: pointer;
  text-align: left;
  color: inherit;
  min-width: 0;

  &:hover { background: rgba(var(--accent-info-rgb), 0.16); }
}

.chevron { font-size: 10px; color: var(--n-text-color3, var(--text-primary)); flex-shrink: 0; }

.speaker-name {
  font-size: 13px;
  font-weight: 700;
  color: var(--accent-info);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.speaker-score {
  font-size: 13px;
  font-weight: 700;
  color: var(--success);
  padding: 0 8px;
  border-radius: 8px;
  background: rgba(var(--success-rgb), 0.12);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.header-spacer { flex: 1; }

.export-btn { flex-shrink: 0; }

.speaker-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px;
  min-width: 0;
}

.score-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 6px;
}

.score-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 5px 4px;
  border-radius: 8px;
  background: rgba(var(--text-primary-rgb), 0.03);

  &.overall { background: rgba(var(--success-rgb), 0.08); }
}

.score-label { font-size: 10px; color: var(--n-text-color3, var(--text-primary)); text-align: center; }
.score-value { font-size: 16px; font-weight: 700; color: var(--accent-info); font-variant-numeric: tabular-nums; }
.score-item.overall .score-value { color: var(--success); }

.tag-group { display: flex; flex-direction: column; gap: 4px; }
.tag-title { font-size: 11px; color: var(--n-text-color3, var(--text-primary)); }

.tag-tags {
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
    line-height: 1.5;
    padding-top: 2px;
    padding-bottom: 2px;
  }
}

.round-list { display: flex; flex-direction: column; gap: 6px; }
</style>
