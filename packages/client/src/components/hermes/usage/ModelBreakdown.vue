<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUsageStore } from '@/stores/hermes/usage'

const { t } = useI18n()
const usageStore = useUsageStore()
const maxModelTokens = computed(() => Math.max(...usageStore.modelUsage.map(m => m.visualTokens), 1))

function formatTokens(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return String(n)
}

function cacheHitRate(m: { inputTokens: number; cacheTokens: number }): string {
  const total = m.inputTokens + m.cacheTokens
  if (total === 0) return '--'
  return ((m.cacheTokens / total) * 100).toFixed(1) + '%'
}
</script>

<template>
  <div class="model-breakdown">
    <h3 class="section-title">{{ t('usage.modelBreakdown') }}</h3>

    <div class="model-legend" aria-label="Token type legend">
      <div class="legend-item"><span class="legend-swatch input" />{{ t('usage.inputTokens') }}</div>
      <div class="legend-item"><span class="legend-swatch output" />{{ t('usage.outputTokens') }}</div>
      <div class="legend-item"><span class="legend-swatch cache" />{{ t('usage.cacheRead') }}</div>
    </div>

    <div class="model-list">
      <div v-for="m in usageStore.modelUsage" :key="m.model" class="model-row">
        <span class="model-swatch" :style="{ background: m.color }" />
        <span class="model-name" :title="m.model">{{ m.model }}</span>
        <div class="model-bar-wrap">
          <div
            class="model-bar"
            :style="{ width: (m.visualTokens / maxModelTokens * 100) + '%' }"
          >
            <div
              v-if="m.inputTokens > 0"
              class="model-bar-segment input"
              :style="{ width: m.inputPercent + '%' }"
            />
            <div
              v-if="m.outputTokens > 0"
              class="model-bar-segment output"
              :style="{ width: m.outputPercent + '%' }"
            />
            <div
              v-if="m.cacheTokens > 0"
              class="model-bar-segment cache"
              :style="{ width: m.cachePercent + '%' }"
            />
          </div>
        </div>
        <span class="model-tokens" :title="`${t('usage.inputTokens')}: ${formatTokens(m.inputTokens)} · ${t('usage.outputTokens')}: ${formatTokens(m.outputTokens)} · ${t('usage.cacheRead')}: ${formatTokens(m.cacheTokens)} · ${t('usage.cacheHitRate')}: ${cacheHitRate(m)}`">
          {{ formatTokens(m.totalTokens) }}
          <small v-if="m.cacheTokens > 0">+{{ formatTokens(m.cacheTokens) }}</small>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.model-breakdown {
  background: var(--theme-card-bg, $bg-card);
  border: var(--border-width, 1px) solid $border-color;
  border-radius: $radius-md;
  padding: calc(16px * var(--spacing-scale, 1));
  margin-bottom: 20px;
}

.section-title {
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  font-weight: 600;
  color: $text-secondary;
  margin: 0 0 12px;
}

.model-legend {
  display: flex;
  flex-wrap: wrap;
  gap: calc(8px * var(--spacing-scale, 1)) calc(14px * var(--spacing-scale, 1));
  margin: 0 0 12px;
  color: $text-muted;
  font-size: calc(var(--font-size-base, 14px) * 11 / 14);
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: calc(5px * var(--spacing-scale, 1));
}

.legend-swatch,
.model-swatch {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-component, 2px);
  flex-shrink: 0;
}

.legend-swatch.input,
.model-bar-segment.input {
  background: #5c6bc0;
}

.legend-swatch.output,
.model-bar-segment.output {
  background: #26a69a;
}

.legend-swatch.cache,
.model-bar-segment.cache {
  background: #f6ad55;
}

.model-list {
  display: flex;
  flex-direction: column;
  gap: calc(8px * var(--spacing-scale, 1));
}

.model-row {
  display: flex;
  align-items: center;
  gap: calc(10px * var(--spacing-scale, 1));
}

.model-name {
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  font-family: var(--font-code, $font-code);
  color: $text-secondary;
  width: 140px;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-bar-wrap {
  flex: 1;
  height: 16px;
  background: $bg-secondary;
  border-radius: var(--radius-component, 3px);
  overflow: hidden;
}

.model-bar {
  height: 100%;
  border-radius: var(--radius-component, 3px);
  min-width: 2px;
  transition: width 0.3s ease;
  display: flex;
  overflow: hidden;
}

.model-bar-segment {
  height: 100%;
  min-width: 0;
}

.model-tokens {
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  color: $text-muted;
  width: 86px;
  text-align: end;
  flex-shrink: 0;

  small {
    color: #f6ad55;
    margin-inline-start: 4px;
    font-size: calc(var(--font-size-base, 14px) * 10 / 14);
  }
}
</style>
