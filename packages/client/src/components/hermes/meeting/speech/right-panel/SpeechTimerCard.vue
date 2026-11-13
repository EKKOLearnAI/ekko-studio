<script setup lang="ts">
// 演讲评分 · 计时员卡：环节/串场记录、发言人用时、声音提醒。
// 走表控制与倒计时展示以舞台浮层（SpeechTimerOverlay）为唯一操作面，
// 本卡片不再重复渲染计时器（用户反馈：两个计时功能太多余）。
import { useI18n } from 'vue-i18n'
import { injectSpeechTimer } from '../speechTimerContext'
import { fmtSec } from '@/composables/useSpeechTimer'

defineProps<{
  /** 发言人用时（由转写时间戳估算，面板经 useSpeechAiAggregation 提供） */
  speakerDurations: Array<{ speaker: string; durationSec: number }>
}>()

const { t } = useI18n()
const timer = injectSpeechTimer()
</script>

<template>
  <div class="time-records">
    <div class="records-title">{{ t('meeting.speechEval.timeRecords') }}</div>
    <div v-if="timer.timerRecords.length === 0" class="empty-hint">{{ t('meeting.speechEval.emptyRecords') }}</div>
    <div v-for="(r, i) in timer.timerRecords" :key="i" class="record-item">
      <span class="record-label">{{ r.label }}</span>
      <span class="record-duration">{{ fmtSec(r.durationSec) }}<span v-if="r.overtimeSec > 0" class="record-overtime"> (+{{ fmtSec(r.overtimeSec) }})</span></span>
      <button class="record-remove" @click="timer.removeRecord(i)">×</button>
    </div>
  </div>

  <!-- 发言人用时（由转写时间戳估算，供时间把控/串场分析） -->
  <div class="time-records">
    <div class="records-title">👥 {{ t('meeting.speechEval.speakerDuration') }}</div>
    <div v-if="speakerDurations.length === 0" class="empty-hint">{{ t('meeting.speechEval.emptySpeakerDurations') }}</div>
    <div v-for="d in speakerDurations" :key="d.speaker" class="record-item">
      <span class="record-label">{{ d.speaker }}</span>
      <span class="record-duration">{{ fmtSec(d.durationSec) }}</span>
    </div>
  </div>
</template>

<style scoped lang="scss">
/* --- 计时员卡（去重后：仅保留浮层没有的记录与管理功能） ---*/


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

.record-remove {
  background: none;
  border: none;
  color: var(--text-primary);
  cursor: pointer;
  font-size: 14px;
  padding: 0 2px;
  line-height: 1;

  &:hover { color: var(--error); }
}
</style>
