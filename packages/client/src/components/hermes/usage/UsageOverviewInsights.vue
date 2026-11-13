<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUsageStore } from '@/stores/hermes/usage'
import { formatUsageTokens, formatUsagePercent, USAGE_TOKEN_COLORS } from '@/utils/usage-display'

const { t, locale } = useI18n()
const store = useUsageStore()
function tokens(value: number) { return formatUsageTokens(value, locale?.value) }
const modelRows = computed(() => store.modelUsage.map(row => ({
  id: row.model, label: row.model === 'unknown' ? t('usage.agents.unknown') : row.model, totalTokens: row.totalTokens, color: row.color,
})).sort((a, b) => b.totalTokens - a.totalTokens || a.id.localeCompare(b.id)))
const topRows = computed(() => modelRows.value.slice(0, 5))
const ring = computed(() => ({ background: `conic-gradient(${USAGE_TOKEN_COLORS.cache} ${store.cacheHitRate ?? 0}%, var(--bg-secondary) 0)` }))
const rate = computed(() => store.cacheHitRate === null ? '—' : formatUsagePercent(store.cacheHitRate, locale?.value))
function share(value: number) { return store.totalTokens > 0 ? value / store.totalTokens * 100 : 0 }
</script>

<template>
  <div class="overview-lower-grid">
    <section class="overview-panel ranking-panel">
      <div class="panel-head">
        <div><h3>{{ t('usage.dashboard.rankTitle') }}</h3><p>{{ t('usage.dashboard.rankCount', { count: modelRows.length }) }}</p></div>
      </div>
      <div class="rank-list">
        <div v-for="(row, index) in topRows" :key="row.id" class="rank-row">
          <div class="rank-title"><span class="rank-number">{{ String(index + 1).padStart(2, '0') }}</span>
            <span class="rank-name">{{ row.label }}</span><strong>{{ tokens(row.totalTokens) }}</strong><span class="rank-share">{{ formatUsagePercent(share(row.totalTokens), locale) }}</span>
          </div>
          <div class="rank-track"><i :style="{ width: share(row.totalTokens) + '%', background: row.color }" /></div>
        </div>
        <p v-if="!topRows.length" class="rank-empty">{{ t('usage.dashboard.noMatches') }}</p>
      </div>
      <p class="rank-note">{{ t('usage.dashboard.rankNote') }}</p>
    </section>
    <section class="overview-panel cache-panel">
      <div class="panel-head"><div><h3>{{ t('usage.dashboard.cacheEfficiency') }}</h3><p>{{ t('usage.dashboard.cacheSubtitle') }}</p></div></div>
      <div class="cache-summary">
        <div class="cache-ring" :style="ring"><div><strong>{{ rate }}</strong><small>{{ t('usage.cacheHitRate') }}</small></div></div>
        <div class="cache-caption"><strong>{{ tokens(store.totalCacheTokens) }}</strong><p>{{ t('usage.cacheRead') }} {{ t('usage.tokens') }}</p></div>
      </div>
      <div class="cache-note"><p>{{ t('usage.dashboard.cacheNote') }}</p>
        <p v-if="modelRows[0]">{{ t('usage.dashboard.topModel', { model: modelRows[0].label }) }}</p>
      </div>
    </section>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.overview-lower-grid { display: grid; grid-template-columns: 1.6fr 1fr; gap: calc(24px * var(--spacing-scale, 1)); }
.overview-panel { min-width: 0; padding: calc(24px * var(--spacing-scale, 1)); border: var(--border-width, 1px) solid $border-color; border-radius: var(--radius-component, 12px); background: var(--theme-card-bg, $bg-card); }
.panel-head { display: flex; justify-content: space-between; align-items: center; gap: calc(16px * var(--spacing-scale, 1)); margin-bottom: 18px; h3 { margin: 0; color: $text-primary; font-size: calc(var(--font-size-base, 14px) * 15 / 14); font-weight: 600; } p { margin: 5px 0 0; color: $text-secondary; font-size: calc(var(--font-size-base, 14px) * 11 / 14); line-height: var(--line-height, 1.6); } }
.rank-row { padding: calc(9px * var(--spacing-scale, 1)) 0; color: $text-primary; }
.rank-title { display: flex; gap: calc(12px * var(--spacing-scale, 1)); align-items: center; font-size: calc(var(--font-size-base, 14px) * 12 / 14); font-variant-numeric: tabular-nums; strong { font-weight: 600; white-space: nowrap; flex-shrink: 0; } }
.rank-number { color: $text-muted; font-size: calc(var(--font-size-base, 14px) * 10 / 14); width: 20px; flex-shrink: 0; }
.rank-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rank-share { width: 44px; text-align: end; font-size: calc(var(--font-size-base, 14px) * 11 / 14); color: $text-secondary; }
.rank-track { height: 4px; margin: 10px 0 0 32px; background: $bg-secondary; border-radius: var(--radius-component, 3px); overflow: hidden;
  i { display: block; height: 100%; border-radius: inherit; }
}
.rank-note, .rank-empty { margin: 16px 0 0 32px; color: $text-secondary; font-size: calc(var(--font-size-base, 14px) * 10 / 14); line-height: var(--line-height, 1.8); }
.cache-summary { display: flex; align-items: center; gap: calc(24px * var(--spacing-scale, 1)); padding: 4px 0 22px; }
.cache-ring { width: 108px; height: 108px; border-radius: 50%; padding: calc(8px * var(--spacing-scale, 1)); flex-shrink: 0;
  > div { height: 100%; background: var(--theme-card-bg, $bg-card); border-radius: 50%; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  strong { font-size: calc(var(--font-size-base, 14px) * 23 / 14); letter-spacing: -.8px; font-weight: 600; }
  small { max-width: 76px; margin-top: 5px; font-size: calc(var(--font-size-base, 14px) * 10 / 14); line-height: var(--line-height, 1.25); text-align: center; color: $text-secondary; }
}
.cache-caption { min-width: 0; strong { font-size: calc(var(--font-size-base, 14px) * 28 / 14); letter-spacing: -1px; font-weight: 600; } p { margin: 5px 0 0; color: $text-secondary; font-size: calc(var(--font-size-base, 14px) * 11 / 14); } }
.cache-note { border-top: var(--border-width, 1px) solid $border-light; padding-top: calc(16px * var(--spacing-scale, 1)); color: $text-secondary; font-size: calc(var(--font-size-base, 14px) * 12 / 14); line-height: var(--line-height, 1.8); p { margin: 0 0 4px; overflow-wrap: anywhere; } }
@media (max-width: 850px) { .overview-lower-grid { grid-template-columns: 1fr; gap: calc(20px * var(--spacing-scale, 1)); } }
@media (max-width: 480px) { .overview-panel { padding: calc(20px * var(--spacing-scale, 1)); } .rank-title { gap: calc(8px * var(--spacing-scale, 1)); } .panel-head { gap: calc(8px * var(--spacing-scale, 1)); } .cache-caption strong { font-size: calc(var(--font-size-base, 14px) * 24 / 14); white-space: nowrap; } }
</style>
