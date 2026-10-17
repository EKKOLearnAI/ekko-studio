<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useUsageStore } from '@/stores/hermes/usage'
import { formatUsageCost, formatUsageCurrency, usageCostState, type UsageCostCoverage } from '@/utils/usage-cost'
import { formatUsageTokens, formatUsagePercent, USAGE_TOKEN_COLORS } from '@/utils/usage-display'
import { buildUsageTrend } from '@/utils/usage-trend'

const { t, locale } = useI18n()
const usageStore = useUsageStore()
function formatTokens(value: number) { return formatUsageTokens(value, locale?.value) }

const metric = ref<'tokens' | 'cache' | 'cost'>('tokens')
const metrics = ['tokens', 'cache', 'cost'] as const
const costStatus = computed(() => usageCostState(usageStore.estimatedCost, usageStore.stats?.cost_coverage, usageStore.hasData))
const trend = computed(() => buildUsageTrend(usageStore.dailyUsage, usageStore.stats?.period_days))
const chartTitle = computed(() => t(trend.value.granularity === 'day' ? 'usage.dailyTrend' : `usage.dashboard.${trend.value.granularity}Trend`))
function dateRange(d: { date: string; endDate: string }) { return d.date === d.endDate ? d.date : `${d.date} – ${d.endDate}` }
function value(d: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cost: number }) {
  if (metric.value === 'cache') return d.cache_read_tokens
  if (metric.value === 'cost') return d.cost
  return d.input_tokens + d.output_tokens
}

function formatCost(day: { cost: number; cost_coverage?: UsageCostCoverage; sessions: number }): string {
  const amount = formatUsageCost(day.cost, day.cost_coverage, day.sessions > 0, locale?.value)
  if (amount === null) return t('usage.costStates.unknown')
  const state = usageCostState(day.cost, day.cost_coverage, day.sessions > 0)
  return state ? `${amount} · ${t(`usage.costStates.${state}`)}` : amount
}

function cacheHitRate(d: { input_tokens: number; cache_read_tokens: number }): string {
  const total = d.input_tokens + d.cache_read_tokens
  if (total === 0) return '--'
  return formatUsagePercent(d.cache_read_tokens / total * 100, locale?.value)
}

const maxTokens = computed(() =>
  Math.max(...trend.value.buckets.map(value), 0.000001),
)
const axisTicks = computed(() => [1, 2 / 3, 1 / 3, 0].map(fraction => ({
  top: (1 - fraction) * 100,
  label: metric.value === 'cost' ? formatUsageCurrency(maxTokens.value * fraction, locale?.value) : formatTokens(Math.round(maxTokens.value * fraction)),
})))
const dateTicks = computed(() => {
  const buckets = trend.value.buckets
  const count = Math.min(trend.value.granularity === 'month' ? 3 : 6, buckets.length)
  return Array.from({ length: count }, (_, index) => {
    const date = buckets[Math.round(index * (buckets.length - 1) / Math.max(1, count - 1))]!.date
    return trend.value.granularity === 'month' ? date.slice(0, 7) : date.slice(5)
  })
})
</script>

<template>
  <div class="daily-trend" :data-granularity="trend.granularity" :class="{ 'single-day': trend.buckets.length === 1, 'cost-chart': metric === 'cost' }">
    <div class="trend-heading">
      <div><h3 class="section-title">{{ chartTitle }}</h3><p class="chart-caption"><span v-if="trend.granularity !== 'day'">{{ t(`usage.dashboard.${trend.granularity}Summary`) }} · </span>{{ t(metric === 'tokens' ? 'usage.dashboard.tokenDefinition' : metric === 'cache' ? 'usage.cacheRead' : 'usage.dashboard.recordedCost') }}</p></div>
      <div class="metric-selector" role="group" :aria-label="t('usage.dashboard.trendMetric')">
        <NButton v-for="option in metrics" :key="option" size="small" :data-metric="option"
          :type="metric === option ? 'primary' : 'default'" :secondary="metric === option" :quaternary="metric !== option"
          :aria-pressed="metric === option" @click="metric = option">{{ t(`usage.${option}`) }}</NButton>
      </div>
    </div>

    <div class="chart-frame">
      <div class="chart-grid" aria-hidden="true"><div v-for="tick in axisTicks" :key="tick.top" :style="{ top: tick.top + '%' }"><span>{{ tick.label }}</span></div></div>
      <div class="bar-chart">
      <div
        v-for="d in trend.buckets"
        :key="d.date"
        class="bar-col"
        tabindex="0"
        :aria-label="`${dateRange(d)}: ${metric === 'cost' ? formatCost(d) : formatTokens(value(d))}`"
      >
        <div class="bar-track">
          <div
            class="bar-stack"
            :style="{ height: (value(d) / maxTokens * 100) + '%' }"
          >
            <div
              v-if="metric === 'tokens' && d.output_tokens > 0"
              class="bar-segment output"
              :style="{ height: (d.output_tokens / value(d) * 100) + '%' }"
            />
            <div
              v-if="metric === 'tokens' && d.input_tokens > 0"
              class="bar-segment input"
              :style="{ height: (d.input_tokens / value(d) * 100) + '%' }"
            />
            <div
              v-if="metric === 'cache' && d.cache_read_tokens > 0"
              class="bar-segment cache"
              style="height: 100%"
            />
            <div v-if="metric === 'cost' && d.cost > 0" class="bar-segment cost" style="height: 100%" />
          </div>
        </div>
        <div class="bar-tooltip">
          <div class="tooltip-date">{{ dateRange(d) }}</div>
          <div class="tooltip-row">{{ t('usage.inputTokens') }}: {{ formatTokens(d.input_tokens) }}</div>
          <div class="tooltip-row">{{ t('usage.outputTokens') }}: {{ formatTokens(d.output_tokens) }}</div>
          <div class="tooltip-row">{{ t('usage.cacheRead') }}: {{ formatTokens(d.cache_read_tokens) }}</div>
          <div class="tooltip-row">{{ t('usage.cacheWrite') }}: {{ formatTokens(d.cache_write_tokens) }}</div>
          <div class="tooltip-row">{{ t('usage.cacheHitRate') }}: {{ cacheHitRate(d) }}</div>
          <div v-if="trend.granularity === 'day'" class="tooltip-row">{{ t('usage.sessions') }}: {{ d.sessions.toLocaleString(locale) }}</div>
          <div class="tooltip-row">{{ t('usage.cost') }}: {{ formatCost(d) }}</div>
        </div>
      </div>
      </div>
    </div>
    <div class="bar-dates">
      <span v-for="(date, index) in dateTicks" :key="index">{{ date }}</span>
    </div>

    <div class="chart-legend">
      <template v-if="metric === 'tokens'">
        <div class="legend-item"><span class="legend-swatch input" />{{ t('usage.inputTokens') }}</div>
        <div class="legend-item"><span class="legend-swatch output" />{{ t('usage.outputTokens') }}</div>
      </template>
      <div v-else class="legend-item"><span class="legend-swatch" :class="metric" />{{ t(metric === 'cache' ? 'usage.cacheRead' : 'usage.dashboard.recordedCost') }}</div>
      <span v-if="metric === 'cost' && costStatus">{{ t(`usage.costStates.${costStatus}`) }}</span>
    </div>

    <details class="daily-details">
      <summary>{{ t('usage.dashboard.dailyDetails') }}</summary>
      <div class="trend-table">
      <table>
        <thead>
          <tr>
            <th>{{ t('usage.date') }}</th>
            <th>{{ t('usage.inputTokens') }}</th>
            <th>{{ t('usage.outputTokens') }}</th>
            <th>{{ t('usage.cacheRead') }}</th>
            <th>{{ t('usage.cacheWrite') }}</th>
            <th>{{ t('usage.cacheHitRate') }}</th>
            <th>{{ t('usage.sessions') }}</th>
            <th>{{ t('usage.cost') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in [...usageStore.dailyUsage].reverse()" :key="d.date">
            <td>{{ d.date }}</td>
            <td>{{ formatTokens(d.input_tokens) }}</td>
            <td>{{ formatTokens(d.output_tokens) }}</td>
            <td>{{ formatTokens(d.cache_read_tokens) }}</td>
            <td>{{ formatTokens(d.cache_write_tokens) }}</td>
            <td>{{ cacheHitRate(d) }}</td>
            <td>{{ d.sessions.toLocaleString(locale) }}</td>
            <td>{{ formatCost(d) }}</td>
          </tr>
        </tbody>
      </table>
      </div>
    </details>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.daily-trend {
  background: var(--theme-card-bg, $bg-card);
  border: var(--border-width, 1px) solid $border-color;
  border-radius: var(--radius-component, 12px);
  padding: calc(24px * var(--spacing-scale, 1)) calc(24px * var(--spacing-scale, 1)) calc(16px * var(--spacing-scale, 1));
}

.section-title {
  font-size: calc(var(--font-size-base, 14px) * 15 / 14);
  font-weight: 600;
  color: $text-primary;
  margin: 0;
}

.trend-heading { display: flex; justify-content: space-between; align-items: center; gap: calc(12px * var(--spacing-scale, 1)); margin-bottom: 30px; }
.chart-caption { margin: 6px 0 0; font-size: calc(var(--font-size-base, 14px) * 11 / 14); color: $text-secondary; }
.metric-selector { display: flex; align-items: center; gap: calc(4px * var(--spacing-scale, 1)); flex-shrink: 0; }
.daily-details { margin-top: 16px; summary { cursor: pointer; color: $text-secondary; font-size: calc(var(--font-size-base, 14px) * 12 / 14); padding: calc(8px * var(--spacing-scale, 1)) 0; } }
.bar-segment.cost, .legend-swatch.cost { background: $accent-primary; }
.chart-frame { position: relative; padding-inline-start: calc(48px * var(--spacing-scale, 1)); margin-bottom: 16px; }
.chart-grid { position: absolute; inset: 0; inset-inline-start: 48px; pointer-events: none;
  > div { position: absolute; width: 100%; border-top: var(--border-width, 1px) dashed $border-light; span { position: absolute; inset-inline-end: calc(100% + 10px); transform: translateY(-50%); font-size: calc(var(--font-size-base, 14px) * 10 / 14); white-space: nowrap; color: $text-secondary; } }
}
.cost-chart {
  .chart-frame, .bar-dates { padding-inline-start: 72px; }
  .chart-grid { inset-inline-start: 72px; }
}

.bar-chart {
  display: flex;
  gap: clamp(2px, .6vw, 8px);
  margin-bottom: 0;
}

.bar-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  position: relative;
}

.bar-track {
  width: 100%;
  height: 140px;
  background: transparent;
  border-radius: 2px 2px 0 0;
  display: flex;
  align-items: flex-end;
  overflow: hidden;
  position: relative;
}

.bar-stack {
  width: 100%;
  display: flex;
  flex-direction: column-reverse;
  justify-content: flex-start;
  overflow: hidden;
  transition: height 0.3s ease;
}

.bar-segment {
  width: 100%;
  min-height: 0;
  transition: height 0.3s ease;
}

.bar-segment.output,
.legend-swatch.output {
  background: v-bind('USAGE_TOKEN_COLORS.output');
}

.bar-segment.input,
.legend-swatch.input {
  background: v-bind('USAGE_TOKEN_COLORS.input');
}

.bar-segment.cache,
.legend-swatch.cache {
  background: v-bind('USAGE_TOKEN_COLORS.cache');
}

.bar-tooltip {
  display: none;
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  background: $text-primary;
  color: var(--text-on-accent);
  padding: calc(6px * var(--spacing-scale, 1)) calc(10px * var(--spacing-scale, 1));
  border-radius: $radius-sm;
  font-size: calc(var(--font-size-base, 14px) * 11 / 14);
  white-space: nowrap;
  z-index: 10;
  pointer-events: none;

  &::after {
    content: '';
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    border: 5px solid transparent;
    border-top-color: $text-primary;
  }
}

.bar-col:hover .bar-tooltip,
.bar-col:focus .bar-tooltip {
  display: block;
}

.tooltip-date {
  font-weight: 600;
  margin-bottom: 4px;
}

.tooltip-row {
  line-height: var(--line-height, 1.5);
}

.bar-dates {
  display: flex;
  justify-content: space-between;
  font-size: calc(var(--font-size-base, 14px) * 10 / 14);
  color: $text-secondary;
  margin-bottom: 12px;
  padding-inline-start: calc(48px * var(--spacing-scale, 1));
}

.single-day {
  .bar-chart { justify-content: center; }
  .bar-col { max-width: 32px; }
  .bar-dates { justify-content: center; }
}

.chart-legend {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: calc(8px * var(--spacing-scale, 1)) calc(14px * var(--spacing-scale, 1));
  margin: 0;
  color: $text-secondary;
  font-size: calc(var(--font-size-base, 14px) * 11 / 14);
}

@media (max-width: 480px) {
  .daily-trend { padding: calc(20px * var(--spacing-scale, 1)) calc(16px * var(--spacing-scale, 1)) calc(12px * var(--spacing-scale, 1)); }
  .trend-heading { gap: calc(8px * var(--spacing-scale, 1)); align-items: flex-start; flex-wrap: wrap; }
  .section-title { font-size: calc(var(--font-size-base, 14px) * 14 / 14); }
  .metric-selector { gap: calc(2px * var(--spacing-scale, 1)); :deep(.n-button) { font-size: calc(var(--font-size-base, 14px) * 11 / 14); padding: 0 calc(10px * var(--spacing-scale, 1)); } }
  .bar-col { position: static; }
  .bar-tooltip { left: 0; right: 0; transform: none; white-space: normal; &::after { display: none; } }
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: calc(5px * var(--spacing-scale, 1));
  white-space: nowrap;
}

.legend-swatch {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-component, 2px);
  flex-shrink: 0;
}

.trend-table {
  overflow-x: auto;

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: calc(var(--font-size-base, 14px) * 11 / 14);
  }

  th,
  td {
    text-align: end;
    padding: calc(6px * var(--spacing-scale, 1)) calc(8px * var(--spacing-scale, 1));
    border-bottom: var(--border-width, 1px) solid $border-color;
    white-space: nowrap;
  }

  th:first-child,
  td:first-child {
    text-align: start;
  }

  th {
    color: $text-muted;
    font-weight: 500;
  }

  td {
    color: $text-secondary;
  }
}
</style>
