<script setup lang="ts">
// 演讲评分场景 · 转写区顶部计时状态条（自 MeetingView 搬出，经 scene-ui-registry 渲染）。
// 走表状态来自 useSpeechTimer 模块级单例；句数读自会议 store。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSpeechTimer } from '@/composables/useSpeechTimer'
import { useMeetingStore } from '@/stores/hermes/meeting'

const { t } = useI18n()
const meetingStore = useMeetingStore()

const {
  timerRunning,
  phase,
} = useSpeechTimer()

const sentenceCount = computed(() => meetingStore.activeSession?.sentences.length ?? 0)
</script>

<template>
  <div class="speech-transcript-strip" :class="`phase-${phase}`">
    <div class="strip-left">
      <span class="strip-dot" :class="{ running: timerRunning }" />
      <span class="strip-label">{{ timerRunning ? t('meeting.recording') : t('meeting.idle') }}</span>
    </div>
    <div class="strip-right">
      <span class="strip-count">{{ sentenceCount }} {{ t('meeting.sentences') }}</span>
      <span class="strip-hint">{{ t('meeting.speechEval.practiceHint') }}</span>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.speech-transcript-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 16px;
  font-size: 11px;
}

.strip-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.strip-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(var(--text-primary-rgb), 0.2);

  &.running { background: var(--success); animation: strip-pulse 1.6s infinite; }
}

.strip-label {
  font-weight: 600;
  color: $text-secondary;
}

.strip-right {
  display: flex;
  align-items: center;
  gap: 12px;
  color: $text-secondary;
}

.strip-count { font-variant-numeric: tabular-nums; }
.strip-hint { opacity: 0.55; }
</style>
