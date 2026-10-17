<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useUsageStore } from '@/stores/hermes/usage'
import { computed } from 'vue'
import { formatUsageCost, usageCostState } from '@/utils/usage-cost'
import { formatUsageTokens, formatUsagePercent } from '@/utils/usage-display'

const { t, locale } = useI18n()
const usageStore = useUsageStore()
const costState = computed(() => usageCostState(usageStore.estimatedCost, usageStore.stats?.cost_coverage, usageStore.hasData))
const displayCost = computed(() => formatUsageCost(usageStore.estimatedCost, usageStore.stats?.cost_coverage, usageStore.hasData, locale?.value))
function formatTokens(value: number) { return formatUsageTokens(value, locale?.value) }

</script>

<template>
  <div class="stat-cards">
    <div class="stat-card stat-hero">
      <div class="stat-label">{{ t('usage.dashboard.inputOutput') }}</div>
      <div class="stat-main"><div class="stat-value">{{ formatTokens(usageStore.totalTokens) }}</div><span class="stat-unit">{{ t('usage.tokens') }}</span></div>
      <div class="stat-sub token-split">
        <span>{{ formatTokens(usageStore.totalInputTokens) }} {{ t('usage.inputTokens') }}</span><span aria-hidden="true">/</span>
        <span>{{ formatTokens(usageStore.totalOutputTokens) }} {{ t('usage.outputTokens') }}</span>
      </div>
      <div class="stat-sub">{{ t('usage.dashboard.excludesCacheReads') }}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">{{ t('usage.cost') }} (USD)</div>
      <div class="stat-value stat-currency-value" :class="{ 'stat-text-value': displayCost === null }">{{ displayCost ?? t('usage.costStates.unknown') }}</div>
      <div v-if="costState && costState !== 'unknown'" class="stat-sub">{{ t(`usage.costStates.${costState}`) }}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">{{ t('usage.totalSessions') }}</div>
      <div class="stat-value">{{ usageStore.totalSessions.toLocaleString(locale) }}</div>
      <div class="stat-sub">{{ (usageStore.stats?.total_api_calls ?? 0).toLocaleString(locale) }} {{ t('usage.dashboard.apiCalls') }}</div>
      <div class="stat-sub">{{ t('usage.dashboard.uniqueSessions') }}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">{{ t('usage.cacheHitRate') }}</div>
      <div class="stat-value">{{ usageStore.cacheHitRate !== null ? formatUsagePercent(usageStore.cacheHitRate, locale) : '--' }}</div>
      <div class="stat-sub" v-if="usageStore.cacheHitRate !== null">
        {{ formatTokens(usageStore.totalCacheTokens) }} {{ t('usage.cacheRead') }} {{ t('usage.tokens') }}
      </div>
      <div class="stat-sub">{{ t('usage.dashboard.cacheDefinition') }}</div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.stat-cards {
  display: grid;
  grid-template-columns: 1.5fr repeat(3, 1fr);
  gap: 0;
  margin-bottom: 24px;
  background: var(--theme-card-bg, $bg-card);
  border: var(--border-width, 1px) solid $border-color;
  border-radius: var(--radius-component, 12px);
  padding: calc(28px * var(--spacing-scale, 1)) 0;
}

.stat-card {
  min-width: 0;
  padding: 0 calc(24px * var(--spacing-scale, 1));
  border-inline-start: var(--border-width, 1px) solid $border-light;
  &:first-child { border: 0; }
}

.stat-label {
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  color: $text-secondary;
  margin-bottom: 18px;
}

.stat-value {
  font-size: calc(var(--font-size-base, 14px) * 30 / 14);
  font-weight: 550;
  color: $text-primary;
  line-height: var(--line-height, 1.2);
  letter-spacing: -1px;
  font-variant-numeric: tabular-nums;
  margin-bottom: 18px;
}

.stat-main { display: flex; align-items: baseline; gap: calc(6px * var(--spacing-scale, 1)); flex-wrap: nowrap; }
.stat-unit { font-size: calc(var(--font-size-base, 14px) * 12 / 14); color: $text-secondary; white-space: nowrap; }
.stat-hero .stat-value { font-size: clamp(36px, 4vw, 48px); letter-spacing: -2px; margin-bottom: 12px; }
.stat-text-value { font-size: calc(var(--font-size-base, 14px) * 20 / 14); letter-spacing: 0; }
.token-split { display: flex; flex-wrap: wrap; gap: 0 calc(4px * var(--spacing-scale, 1)); span { white-space: nowrap; } }

.stat-sub {
  font-size: calc(var(--font-size-base, 14px) * 10 / 14);
  color: $text-secondary;
  margin-top: 3px;
  line-height: var(--line-height, 1.7);
  overflow-wrap: anywhere;
}

@media (max-width: 760px) {
  .stat-cards {
    grid-template-columns: repeat(2, 1fr);
    padding: 0;
  }
  .stat-card { padding: calc(22px * var(--spacing-scale, 1)); border: 0; }
  .stat-card:nth-child(even) { border-inline-start: var(--border-width, 1px) solid $border-light; }
  .stat-card:nth-child(n + 3) { border-top: var(--border-width, 1px) solid $border-light; }
  .stat-hero .stat-value { font-size: calc(var(--font-size-base, 14px) * 32 / 14); letter-spacing: -1px; }
}

@media (max-width: 480px) {
  .stat-card { padding: calc(18px * var(--spacing-scale, 1)) calc(12px * var(--spacing-scale, 1)); }
  .stat-label { font-size: calc(var(--font-size-base, 14px) * 11 / 14); margin-bottom: 12px; }
  .stat-value { font-size: clamp(24px, 6.5vw, 28px); letter-spacing: -.7px; margin-bottom: 12px; white-space: nowrap; }
  .stat-hero .stat-value { font-size: clamp(24px, 7vw, 28px); letter-spacing: -1px; }
  .stat-currency-value:not(.stat-text-value) { font-size: clamp(16px, 5vw, 22px); }
  .stat-text-value { font-size: calc(var(--font-size-base, 14px) * 16 / 14); letter-spacing: 0; white-space: normal; }
  .stat-main { gap: calc(4px * var(--spacing-scale, 1)); }
  .stat-unit { font-size: calc(var(--font-size-base, 14px) * 10 / 14); }
  .token-split { gap: 0 calc(3px * var(--spacing-scale, 1)); }
}
</style>
