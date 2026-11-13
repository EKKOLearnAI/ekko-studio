<script setup lang="ts">
// 决策项面板（Business 场景专属）
//
// 决策项 pending / decided 两组。
// 本组件可独立预览：你给一个待决 / 已决样本，能直接看到分组与样式。

import { ref } from 'vue'
import { NButton, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'

interface DecisionItem {
  id: string
  title: string
  owner?: string
  dueAt?: string  // ISO
  status: 'pending' | 'decided'
}

const props = withDefaults(defineProps<{
  items?: DecisionItem[]
}>(), {
  items: () => [
    {
      id: 'd1',
      title: '调整 Q4 KPI 阈值（增长 ≥15%）',
      owner: '@alice',
      dueAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      status: 'pending',
    },
    {
      id: 'd2',
      title: '追加渠道投放预算 ¥500K',
      owner: '@bob',
      dueAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      status: 'pending',
    },
    {
      id: 'd3',
      title: '锁定 Q4 OKR 终稿',
      status: 'decided',
    },
  ],
})

const { t } = useI18n()
const local = ref<DecisionItem[]>([...props.items])

function markDecided(item: DecisionItem) {
  item.status = 'decided'
}

function fmtDue(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  const h = Math.round((d.getTime() - Date.now()) / 3600 / 1000)
  if (h <= 0) return '已过期'
  if (h < 24) return `${h}h 内`
  return `${Math.round(h / 24)}d 内`
}

const pendingItems = () => local.value.filter(i => i.status === 'pending')
const decidedItems = () => local.value.filter(i => i.status === 'decided')
</script>

<template>
  <section class="decision-panel">
    <header class="decision-panel__header">
      <h3>{{ t('meeting.sceneBusiness.decisions.title') }}</h3>
      <NTag size="small" type="warning" round>
        {{ pendingItems().length }} {{ t('meeting.sceneBusiness.decisions.pending') }}
      </NTag>
    </header>
    <div class="decision-panel__scroll">
      <h4 class="decision-panel__group">
        {{ t('meeting.sceneBusiness.decisions.pending') }} ({{ pendingItems().length }})
      </h4>
      <ul class="decision-panel__list">
        <li v-for="item in pendingItems()" :key="item.id" class="decision-panel__item">
          <div class="decision-panel__title">{{ item.title }}</div>
          <div class="decision-panel__meta">
            <span v-if="item.owner">{{ item.owner }}</span>
            <span v-if="item.dueAt" class="decision-panel__due">⏰ {{ fmtDue(item.dueAt) }}</span>
          </div>
          <div class="decision-panel__actions">
            <NButton size="tiny" tertiary @click="markDecided(item)">
              {{ t('meeting.sceneBusiness.decisions.markDecided') }}
            </NButton>
          </div>
        </li>
      </ul>
      <h4 class="decision-panel__group">
        {{ t('meeting.sceneBusiness.decisions.decided') }} ({{ decidedItems().length }})
      </h4>
      <ul class="decision-panel__list">
        <li v-for="item in decidedItems()" :key="item.id" class="decision-panel__item decision-panel__item--done">
          <span class="decision-panel__check">✓</span>
          <span class="decision-panel__title">{{ item.title }}</span>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.decision-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  min-height: 0;
}
.decision-panel__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.decision-panel__header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-secondary);
}
.decision-panel__scroll {
  flex: 1 1 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.decision-panel__group {
  margin: 0;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}
.decision-panel__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.decision-panel__item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--theme-card-bg, var(--bg-card));
  border: 1px solid var(--border-color);
}
.decision-panel__item--done {
  background: rgba(var(--success-rgb), 0.08);
  border-color: rgba(var(--success-rgb), 0.28);
}
.decision-panel__check {
  color: var(--success);
  font-weight: 600;
}
.decision-panel__item--done .decision-panel__title {
  color: var(--text-muted);
  text-decoration: line-through;
}
.decision-panel__title {
  font-size: 13px;
  line-height: 1.4;
}
.decision-panel__meta {
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: var(--text-muted);
}
.decision-panel__due {
  color: var(--warning);
}
.decision-panel__actions {
  margin-top: 2px;
}
</style>