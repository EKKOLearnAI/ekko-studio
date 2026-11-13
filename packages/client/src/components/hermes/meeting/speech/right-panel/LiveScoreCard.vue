<script setup lang="ts">
// 演讲评分 · 实时评分卡（更新式展示，不弹出新卡）。
// 纯展示组件：评分数据由 SpeechEvaluationPanel 经 useSpeechAiAggregation 提供。
// 多演讲者场景：传入 speakerScores（每位演讲者的最新评分）时按人分块渲染。
import { useI18n } from 'vue-i18n'
import { SCORE_LABEL_MAP } from '@/composables/useSpeechAiAggregation'

const props = defineProps<{
  liveScore: Record<string, number> | undefined
  scoreUpdatedAt: number | undefined
  /** 每位演讲者的最新评分；多于一位时按人分块展示（替代单一 liveScore 视图） */
  speakerScores?: Array<{ speaker: string; score: Record<string, number>; updatedAt: number }>
}>()

const { t } = useI18n()
</script>

<template>
  <!-- 多演讲者：每位演讲者一块独立记分牌 -->
  <div v-if="props.speakerScores && props.speakerScores.length > 1" class="live-score-multi">
    <div v-for="s in props.speakerScores" :key="s.speaker" class="live-score">
      <div class="live-score-header">
        <span class="live-score-title">🎤 {{ s.speaker }}</span>
        <span class="live-score-time">
          {{ t('meeting.speechEval.updatedAt') }} {{ new Date(s.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }}
        </span>
      </div>
      <div class="live-score-grid">
        <div v-for="(labelKey, key) in SCORE_LABEL_MAP" :key="key" class="live-score-item" :class="{ overall: key === 'overall' }">
          <span class="live-score-label">{{ t(labelKey) }}</span>
          <span class="live-score-value">{{ s.score[key] ?? '—' }}</span>
        </div>
      </div>
    </div>
  </div>

  <!-- 单演讲者/无归属：保持原单一视图 -->
  <div v-else-if="props.liveScore" class="live-score" :key="props.scoreUpdatedAt">
    <div class="live-score-header">
      <span class="live-score-title">📊 {{ t('meeting.speechEval.liveScore') }}</span>
      <span v-if="props.scoreUpdatedAt" class="live-score-time">
        {{ t('meeting.speechEval.updatedAt') }} {{ new Date(props.scoreUpdatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }}
      </span>
    </div>
    <div class="live-score-grid">
      <div v-for="(labelKey, key) in SCORE_LABEL_MAP" :key="key" class="live-score-item" :class="{ overall: key === 'overall' }">
        <span class="live-score-label">{{ t(labelKey) }}</span>
        <span class="live-score-value">{{ props.liveScore[key] ?? '—' }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
/* --- 实时评分（更新式面板，自 SpeechEvaluationPanel 原样搬出） ---*/
.live-score-multi {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

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
  padding: 6px 4px;
  border-radius: 8px;
  background: rgba(var(--text-primary-rgb), 0.03);

  &.overall {
    background: rgba(var(--success-rgb), 0.08);
  }
}

.live-score-label { font-size: 10px; color: var(--n-text-color3, var(--text-primary)); text-align: center; }
.live-score-value { font-size: 18px; font-weight: 700; color: var(--accent-info); font-variant-numeric: tabular-nums; }
.live-score-item.overall .live-score-value { color: var(--success); }
</style>
