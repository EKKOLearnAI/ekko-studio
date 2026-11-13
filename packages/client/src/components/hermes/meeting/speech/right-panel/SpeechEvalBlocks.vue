<script setup lang="ts">
// 演讲评分 · AI 实时点评累积区：亮点/可提升点/主题 + 仅新评价点弹出的点评卡。
// 纯展示组件：数据由 SpeechEvaluationPanel 经 useSpeechAiAggregation 提供。
// 多演讲者场景：按演讲者渲染可折叠子模块（SpeechSpeakerCard，含评分/评价/轮次/导出）；
// 单演讲者或无归属：保持原平铺视图。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NTag } from 'naive-ui'
import type { AnalysisRound } from '@/composables/useMeetingAssist'
import type { SpeechSpeakerSection } from '@/composables/useSpeechAiAggregation'
import {
  buildAllSpeakersFeedbackMarkdown,
  downloadTextFile,
} from '@/utils/speech-export'
import SpeechRoundCard from './SpeechRoundCard.vue'
import SpeechSpeakerCard from './SpeechSpeakerCard.vue'

const props = defineProps<{
  highlights: string[]
  improvements: string[]
  topics: string[]
  newPointRounds: AnalysisRound[]
  /** 按演讲者分组累积的评价；出现 ≥2 个有内容的分组（含未标注桶）时按人折叠渲染 */
  speakerSections?: SpeechSpeakerSection[]
  /** 每位演讲者的最新评分（折叠模块头部徽标 + 导出用） */
  speakerScores?: Array<{ speaker: string; score: Record<string, number>; updatedAt: number }>
}>()

const { t } = useI18n()

/** 未标注桶的显示名 */
const unknownLabel = computed(() => t('meeting.speechEval.unknownSpeaker'))

function roundsFor(speaker: string): AnalysisRound[] {
  return props.newPointRounds.filter(r => (r.speaker?.trim() || '') === speaker)
}

function hasContent(section: SpeechSpeakerSection): boolean {
  return section.highlights.length > 0 || section.improvements.length > 0 ||
    section.topics.length > 0 || roundsFor(section.speaker).length > 0
}

/** 是否按演讲者分区：至少两个有内容的分组（含未标注桶） */
const contentfulSections = computed<SpeechSpeakerSection[]>(() =>
  (props.speakerSections || []).filter(hasContent),
)

const grouped = computed(() => contentfulSections.value.length > 1)

const scoreMap = computed(() => {
  const map = new Map<string, { score: Record<string, number>; updatedAt: number }>()
  for (const s of props.speakerScores || []) {
    map.set(s.speaker, { score: s.score, updatedAt: s.updatedAt })
  }
  return map
})

function sectionInput(section: SpeechSpeakerSection) {
  const scoreEntry = scoreMap.value.get(section.speaker)
  return {
    speaker: section.speaker || unknownLabel.value,
    score: scoreEntry?.score,
    scoreUpdatedAt: scoreEntry?.updatedAt,
    highlights: section.highlights,
    improvements: section.improvements,
    topics: section.topics,
    rounds: roundsFor(section.speaker),
  }
}

function exportAllSections() {
  const md = buildAllSpeakersFeedbackMarkdown(contentfulSections.value.map(sectionInput))
  downloadTextFile('演讲点评汇总.md', md)
}
</script>

<template>
  <!-- 按演讲者折叠分区（多演讲者场景） -->
  <template v-if="grouped">
    <div class="speaker-modules-actions">
      <NButton size="tiny" quaternary @click="exportAllSections">
        ⬇ {{ t('meeting.speechEval.exportAllSpeakerFeedback') }}
      </NButton>
    </div>
    <SpeechSpeakerCard
      v-for="section in contentfulSections"
      :key="section.speaker || 'unknown'"
      :speaker="section.speaker || unknownLabel"
      :score="scoreMap.get(section.speaker)?.score"
      :score-updated-at="scoreMap.get(section.speaker)?.updatedAt"
      :highlights="section.highlights"
      :improvements="section.improvements"
      :topics="section.topics"
      :rounds="roundsFor(section.speaker)"
    />
  </template>

  <!-- 平铺（单演讲者/无归属：保持原视图） -->
  <template v-else>
    <!-- 累积亮点 -->
    <div v-if="props.highlights.length" class="eval-block">
      <div class="eval-block-title">✨ {{ t('meeting.speechEval.highlights') }}</div>
      <div class="eval-tags">
        <NTag v-for="(h, i) in props.highlights" :key="i" size="small" type="success" :bordered="false">✓ {{ h }}</NTag>
      </div>
    </div>

    <!-- 累积可提升的点（3+1：只给最重要的一个可落地提升点） -->
    <div v-if="props.improvements.length" class="eval-block">
      <div class="eval-block-title">💡 {{ t('meeting.speechEval.topImprovement') }}</div>
      <div class="eval-tags">
        <NTag v-for="(imp, i) in props.improvements" :key="i" size="small" type="warning" :bordered="false">↗ {{ imp }}</NTag>
      </div>
    </div>

    <!-- 累积主题 -->
    <div v-if="props.topics.length" class="eval-block">
      <div class="eval-block-title">🏷️ {{ t('meeting.speechEval.topics') }}</div>
      <div class="eval-tags">
        <NTag v-for="(tp, i) in props.topics" :key="i" size="small" type="info" :bordered="false">{{ tp }}</NTag>
      </div>
    </div>

    <!-- 仅 AI 判断出现新的评价点时才弹出的点评卡 -->
    <div v-if="props.newPointRounds.length" class="eval-block">
      <div class="eval-block-title">🆕 {{ t('meeting.speechEval.newPoints') }}</div>
      <TransitionGroup name="round-fade">
        <SpeechRoundCard v-for="round in props.newPointRounds" :key="round.id" :round="round" />
      </TransitionGroup>
    </div>
  </template>
</template>

<style scoped lang="scss">
/* --- 累积评价块 + 点评卡（自 SpeechEvaluationPanel 原样搬出） ---*/
.eval-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(var(--text-primary-rgb), 0.03);
  min-width: 0;
  max-width: 100%;
}

.eval-block-title { font-size: 12px; font-weight: 600; color: var(--n-text-color3, var(--text-primary)); }

.speaker-modules-actions {
  display: flex;
  justify-content: flex-end;
}

/* NTag 默认 white-space: nowrap——长英文高亮/提升点会把右栏整条撑出横向溢出*/
/* （KPI/Tab 全部跟着超宽）。允许标签内换行并钳制宽度。*/
.eval-tags {
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

/* round-card 样式已拆至 SpeechRoundCard.vue（平铺/折叠两视图共用）*/
</style>
