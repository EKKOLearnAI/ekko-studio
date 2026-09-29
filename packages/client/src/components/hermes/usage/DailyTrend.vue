<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUsageStore } from '@/stores/hermes/usage'
import { formatUsageCost, usageCostState, type UsageCostCoverage } from '@/utils/usage-cost'

const { t } = useI18n()
const usageStore = useUsageStore()

function formatTokens(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return String(n)
}

function formatCost(day: { cost: number; cost_coverage?: UsageCostCoverage; sessions: number }): string {
  const amount = formatUsageCost(day.cost, day.cost_coverage, day.sessions > 0)
  if (amount === null) return t('usage.costStates.unknown')
  const state = usageCostState(day.cost, day.cost_coverage, day.sessions > 0)
  return state ? `${amount} · ${t(`usage.costStates.${state}`)}` : amount
}

function cacheHitRate(d: { input_tokens: number; cache_read_tokens: number }): string {
  const total = d.input_tokens + d.cache_read_tokens
  if (total === 0) return '--'
  return ((d.cache_read_tokens / total) * 100).toFixed(1) + '%'
}

const maxTokens = computed(() =>
  Math.max(...usageStore.dailyUsage.map(d => d.visualTokens), 1),
)
</script>

<template>
  <div class="daily-trend">
    <h3 class="section-title">{{ t('usage.dailyTrend') }}</h3>

    <div class="bar-chart">
      <div
        v-for="d in usageStore.dailyUsage"
        :key="d.date"
        class="bar-col"
      >
        <div class="bar-track">
          <div
            class="bar-stack"
            :style="{ height: (d.visualTokens / maxTokens * 100) + '%' }"
          >
            <div
              v-if="d.output_tokens > 0"
              class="bar-segment output"
              :style="{ height: d.outputPercent + '%' }"
            />
            <div
              v-if="d.input_tokens > 0"
              class="bar-segment input"
              :style="{ height: d.inputPercent + '%' }"
            />
            <div
              v-if="d.cache_read_tokens > 0"
              class="bar-segment cache"
              :style="{ height: d.cachePercent + '%' }"
            />
          </div>
        </div>
        <div class="bar-tooltip">
          <div class="tooltip-date">{{ d.date }}</div>
          <div class="tooltip-row">{{ t('usage.inputTokens') }}: {{ formatTokens(d.input_tokens) }}</div>
          <div class="tooltip-row">{{ t('usage.outputTokens') }}: {{ formatTokens(d.output_tokens) }}</div>
          <div class="tooltip-row">{{ t('usage.cacheRead') }}: {{ formatTokens(d.cache_read_tokens) }}</div>
          <div class="tooltip-row">{{ t('usage.cacheWrite') }}: {{ formatTokens(d.cache_write_tokens) }}</div>
          <div class="tooltip-row">{{ t('usage.cacheHitRate') }}: {{ cacheHitRate(d) }}</div>
          <div class="tooltip-row">{{ t('usage.sessions') }}: {{ d.sessions }}</div>
          <div class="tooltip-row">{{ t('usage.cost') }}: {{ formatCost(d) }}</div>
        </div>
      </div>
    </div>
    <div class="bar-dates">
      <span>{{ usageStore.dailyUsage[0]?.date.slice(5) }}</span>
      <span>{{ usageStore.dailyUsage[usageStore.dailyUsage.length - 1]?.date.slice(5) }}</span>
    </div>

    <div class="chart-legend" aria-label="Token type legend">
      <div class="legend-item"><span class="legend-swatch input" />{{ t('usage.inputTokens') }}</div>
      <div class="legend-item"><span class="legend-swatch output" />{{ t('usage.outputTokens') }}</div>
      <div class="legend-item"><span class="legend-swatch cache" />{{ t('usage.cacheRead') }}</div>
    </div>

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
            <td>{{ d.sessions }}</td>
            <td>{{ formatCost(d) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.daily-trend {
  background: $bg-card;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  padding: 16px;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
  color: $text-secondary;
  margin: 0 0 12px;
}

.bar-chart {
  display: flex;
  gap: 2px;
  margin-bottom: 16px;
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
  background: $bg-secondary;
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
  background: #26a69a;
}

.bar-segment.input,
.legend-swatch.input {
  background: #5c6bc0;
}

.bar-segment.cache,
.legend-swatch.cache {
  background: #f6ad55;
}

.bar-tooltip {
  display: none;
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  background: $text-primary;
  color: var(--text-on-accent);
  padding: 6px 10px;
  border-radius: $radius-sm;
  font-size: 11px;
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

.bar-col:hover .bar-tooltip {
  display: block;
}

.tooltip-date {
  font-weight: 600;
  margin-bottom: 4px;
}

.tooltip-row {
  line-height: 1.5;
}

.bar-dates {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: $text-muted;
  margin-bottom: 12px;
}

.chart-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  margin: 0 0 16px;
  color: $text-muted;
  font-size: 11px;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.legend-swatch {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex-shrink: 0;
}

.trend-table {
  overflow-x: auto;

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
  }

  th,
  td {
    text-align: end;
    padding: 6px 8px;
    border-bottom: 1px solid $border-color;
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
