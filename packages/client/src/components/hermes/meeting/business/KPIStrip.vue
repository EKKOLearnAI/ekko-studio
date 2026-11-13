<script setup lang="ts">
// KPI 横向条（Business 场景专属）
//
// 横向卡片组：标签 / 数值 / 环比方向（up/down/flat）。
// 本组件纯展示，preview 时给一组样本数据。

import { useI18n } from 'vue-i18n'

interface KpiItem {
  id: string
  label: string
  value: string
  delta?: { value: string; direction: 'up' | 'down' | 'flat' }
}

const props = withDefaults(defineProps<{
  items?: KpiItem[]
}>(), {
  items: () => [
    { id: 'k1', label: '营收', value: '¥1.2M', delta: { value: '+12%', direction: 'up' } },
    { id: 'k2', label: 'NPS', value: '42', delta: { value: '+3', direction: 'up' } },
    { id: 'k3', label: '留存', value: '78%', delta: { value: '−2pp', direction: 'down' } },
    { id: 'k4', label: '转化', value: '4.5%', delta: { value: '+0.3pp', direction: 'up' } },
  ],
})

const { t } = useI18n()

function deltaIcon(d?: KpiItem['delta']): string {
  if (!d) return ''
  if (d.direction === 'up') return '▲'
  if (d.direction === 'down') return '▼'
  return '–'
}
</script>

<template>
  <section class="kpi-strip">
    <h3 class="kpi-strip__title">{{ t('meeting.sceneBusiness.kpi.title') }}</h3>
    <div class="kpi-strip__grid">
      <article v-for="k in props.items" class="kpi-card" :key="k.id">
        <div class="kpi-card__label">{{ k.label }}</div>
        <div class="kpi-card__value">{{ k.value }}</div>
        <div
          v-if="k.delta"
          class="kpi-card__delta"
          :class="`kpi-card__delta--${k.delta.direction}`"
        >
          {{ deltaIcon(k.delta) }} {{ k.delta.value }}
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.kpi-strip {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.kpi-strip__title {
  margin: 0;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}
.kpi-strip__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
}
.kpi-card {
  background: var(--theme-card-bg, var(--bg-card));
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.kpi-card__label {
  font-size: 11px;
  color: var(--text-muted);
}
.kpi-card__value {
  font-size: 22px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
}
.kpi-card__delta {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.kpi-card__delta--up {
  color: var(--success);
}
.kpi-card__delta--down {
  color: var(--error);
}
.kpi-card__delta--flat {
  color: var(--text-muted);
}
</style>