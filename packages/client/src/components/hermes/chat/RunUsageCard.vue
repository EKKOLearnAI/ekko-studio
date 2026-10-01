<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { formatRunCost, formatRunTokens, formatCacheHitRate, type RunUsageSummary } from '@/utils/run-usage'

defineProps<{ usage: RunUsageSummary }>()
const { t } = useI18n()
</script>

<template>
  <div class="run-usage-card">
    <div class="run-usage-metric">
      <span class="run-usage-label">{{ t('chat.runUsageOutput') }}</span>
      <span class="run-usage-value" :title="String(usage.outputTokens ?? '')">{{ usage.isEstimated && usage.outputTokens != null ? '≈ ' : '' }}{{ formatRunTokens(usage.outputTokens) }}</span>
    </div>
    <div class="run-usage-metric">
      <span class="run-usage-label">{{ t('chat.runUsageInput') }}</span>
      <span class="run-usage-value" :title="String(usage.inputTokens ?? '')">{{ usage.isEstimated && usage.inputTokens != null ? '≈ ' : '' }}{{ formatRunTokens(usage.inputTokens) }}</span>
    </div>
    <div class="run-usage-metric">
      <span class="run-usage-label">{{ t('chat.runUsageCache') }}</span>
      <span class="run-usage-value" :title="String(usage.cacheReadTokens ?? '')">{{ formatRunTokens(usage.cacheReadTokens) }}</span>
    </div>
    <div class="run-usage-metric" :title="t('chat.runUsageCacheRateHint')">
      <span class="run-usage-label">{{ t('chat.runUsageCacheRate') }}</span>
      <span class="run-usage-value run-usage-cache-rate">{{ formatCacheHitRate(usage.cacheHitRate) }}</span>
    </div>
    <div class="run-usage-metric">
      <span class="run-usage-label">{{ t('chat.runUsageCost') }}</span>
      <span class="run-usage-value">{{ formatRunCost(usage.costUsd) }}</span>
    </div>
    <div class="run-usage-metric" :title="t(usage.speedSource === 'estimated' ? 'chat.runUsageEstimatedSpeedHint' : usage.speedSource === 'run' ? 'chat.runUsageAverageSpeedHint' : 'chat.runUsageSpeedHint')">
      <span class="run-usage-label">{{ t(usage.speedSource === 'estimated' ? 'chat.runUsageEstimatedSpeed' : usage.speedSource === 'run' ? 'chat.runUsageAverageSpeed' : 'chat.runUsageSpeed') }}</span>
      <span class="run-usage-value">{{ usage.tokensPerSecond == null ? '—' : `${usage.speedSource === 'run' || usage.speedSource === 'estimated' ? '≈ ' : ''}${usage.tokensPerSecond.toFixed(1)} tok/s` }}</span>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.run-usage-card {
  box-sizing: border-box;
  width: 100%;
  margin-top: 12px;
  padding: 12px 14px;
  display: grid;
  container-type: inline-size;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 12px;
  background: $bg-secondary;
  border: 1px solid $border-light;
  border-radius: 10px;
  color: $text-primary;
  :global(.dark) & { background: #1f1f1f; border-color: rgba(255, 255, 255, 0.14); color: #f2f2f2; }
}
.run-usage-metric { display: flex; min-width: 0; grid-column: span 3; flex-direction: column; gap: 5px; }
.run-usage-label { color: $text-muted; font-size: 11px; line-height: 16px; overflow-wrap: anywhere; }
.run-usage-value { font-family: $font-code; font-size: 13px; line-height: 18px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
@container (min-width: 360px) {
  .run-usage-metric { grid-column: span 2; }
}
@container (min-width: 732px) {
  .run-usage-metric { grid-column: span 1; }
}
</style>
