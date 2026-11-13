<script setup lang="ts">
// 法律沟通场景 · 风险状态条（经 scene-ui-registry 渲染）。
// 风险数据从会议 store 的 analysisRounds 派生（面板负责持久化），
// 不自建 Socket 连接。有高风险时左缘与计数变红。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMeetingStore } from '@/stores/hermes/meeting'
import { summarizeLegalRisks } from '@/composables/useLegalAggregation'

const { t } = useI18n()
const meetingStore = useMeetingStore()

const summary = computed(() => summarizeLegalRisks(meetingStore.activeSession?.analysisRounds || []))
</script>

<template>
  <div class="legal-risk-strip" :class="{ alert: summary.highRiskCount > 0 }">
    <div class="strip-left">
      <span class="strip-dot" :class="{ alert: summary.highRiskCount > 0 }" />
      <span class="strip-label">{{ t('meeting.legal.sceneLabel') }}</span>
      <span v-if="summary.highRiskCount > 0" class="strip-risk">
        {{ t('meeting.legal.highRiskCount', { n: summary.highRiskCount }) }}
      </span>
    </div>
    <div class="strip-right">
      <span class="strip-count">{{ t('meeting.legal.riskTotal', { n: summary.riskTotal }) }}</span>
      <span class="strip-hint">{{ t('meeting.legal.stripHint') }}</span>
    </div>
  </div>
</template>

<style scoped lang="scss">
.legal-risk-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 16px;
  font-size: 11px;

  &.alert { background: rgba(var(--error-rgb), 0.06); }

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
  }

  .strip-label {
    font-weight: 600;
    color: var(--text-secondary, var(--text-primary));
  }

  .strip-risk {
    color: var(--error);
    font-weight: 700;
  }

  .strip-right {
    display: flex;
    align-items: center;
    gap: 12px;
    color: var(--text-secondary, var(--text-primary));
  }

  .strip-hint { opacity: 0.55; }
}
</style>
