<script setup lang="ts">
// 客户访谈场景 · 状态条（经 scene-ui-registry 渲染）。
// 参与度/洞察数据从会议 store 的 analysisRounds 派生（面板负责持久化），
// 不自建 Socket 连接。at_risk/distracted 时变琥珀。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMeetingStore } from '@/stores/hermes/meeting'
import { summarizeInterviewRounds } from '@/composables/useInterviewAggregation'

const { t } = useI18n()
const meetingStore = useMeetingStore()

const summary = computed(() => summarizeInterviewRounds(meetingStore.activeSession?.analysisRounds || []))

const engagementLabel = computed(() => {
  const map: Record<string, string> = {
    engaged: t('meeting.interview.engaged'),
    neutral: t('meeting.interview.neutral'),
    distracted: t('meeting.interview.distracted'),
    at_risk: t('meeting.interview.atRisk'),
  }
  return summary.value.engagement ? map[summary.value.engagement] : undefined
})
</script>

<template>
  <div class="interview-strip" :class="{ warn: summary.engagement === 'at_risk' || summary.engagement === 'distracted' }">
    <div class="strip-left">
      <span class="strip-label">{{ t('meeting.interview.sceneLabel') }}</span>
      <span v-if="engagementLabel" class="strip-engagement" :class="summary.engagement">{{ engagementLabel }}</span>
    </div>
    <div class="strip-right">
      <span class="strip-count">{{ t('meeting.interview.insightCount', { n: summary.needCount + summary.painCount + summary.opportunityCount }) }}</span>
      <span class="strip-hint">{{ t('meeting.interview.stripHint') }}</span>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.interview-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 16px;
  font-size: 11px;

  &.warn { background: rgba(var(--warning-rgb), 0.06); }

  .strip-left {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .strip-label {
    font-weight: 600;
    color: $text-secondary;
  }

  .strip-engagement {
    color: $text-secondary;

    &.engaged { color: var(--success); }
    &.distracted, &.at_risk { color: var(--warning); }
    &.at_risk { font-weight: 700; }
  }

  .strip-right {
    display: flex;
    align-items: center;
    gap: 12px;
    color: $text-secondary;
  }

  .strip-count { font-variant-numeric: tabular-nums; }
  .strip-hint { opacity: 0.55; }
}
</style>
