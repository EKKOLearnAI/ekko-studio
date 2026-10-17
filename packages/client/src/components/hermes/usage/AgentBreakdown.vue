<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUsageStore } from '@/stores/hermes/usage'

const { t } = useI18n()
const usageStore = useUsageStore()
const maxAgentTokens = computed(() => Math.max(...usageStore.agentUsage.map(agent => agent.visualTokens), 1))

const agentLabels: Record<string, string> = {
  hermes: 'hermes',
  claude_code: 'claudeCode',
  codex: 'codex',
  pi: 'pi',
  grok: 'grok',
  opencode: 'opencode',
  dsh: 'dsh',
  cursor: 'cursor',
  antigravity: 'antigravity',
  ekko_agent: 'ekkoAgent',
}

function agentName(agent: string): string {
  return t(`usage.agents.${agentLabels[agent] || 'unknown'}`)
}

function formatTokens(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return String(n)
}

function cacheHitRate(agent: { inputTokens: number; cacheTokens: number }): string {
  const total = agent.inputTokens + agent.cacheTokens
  if (total === 0) return '--'
  return ((agent.cacheTokens / total) * 100).toFixed(1) + '%'
}
</script>

<template>
  <div class="agent-breakdown">
    <h3 class="section-title">{{ t('usage.agentBreakdown') }}</h3>

    <div class="agent-legend" aria-label="Token type legend">
      <div class="legend-item"><span class="legend-swatch input" />{{ t('usage.inputTokens') }}</div>
      <div class="legend-item"><span class="legend-swatch output" />{{ t('usage.outputTokens') }}</div>
      <div class="legend-item"><span class="legend-swatch cache" />{{ t('usage.cacheRead') }}</div>
    </div>

    <div class="agent-list">
      <div v-for="agent in usageStore.agentUsage" :key="agent.agent" class="agent-row">
        <span class="agent-swatch" :style="{ background: agent.color }" />
        <span class="agent-name" :title="agentName(agent.agent)">{{ agentName(agent.agent) }}</span>
        <div class="agent-bar-wrap">
          <div class="agent-bar" :style="{ width: (agent.visualTokens / maxAgentTokens * 100) + '%' }">
            <div v-if="agent.inputTokens > 0" class="agent-bar-segment input" :style="{ width: agent.inputPercent + '%' }" />
            <div v-if="agent.outputTokens > 0" class="agent-bar-segment output" :style="{ width: agent.outputPercent + '%' }" />
            <div v-if="agent.cacheTokens > 0" class="agent-bar-segment cache" :style="{ width: agent.cachePercent + '%' }" />
          </div>
        </div>
        <span
          class="agent-tokens"
          :title="`${t('usage.inputTokens')}: ${formatTokens(agent.inputTokens)} · ${t('usage.outputTokens')}: ${formatTokens(agent.outputTokens)} · ${t('usage.cacheRead')}: ${formatTokens(agent.cacheTokens)} · ${t('usage.cacheHitRate')}: ${cacheHitRate(agent)}`"
        >
          {{ formatTokens(agent.totalTokens) }}
          <small v-if="agent.cacheTokens > 0">+{{ formatTokens(agent.cacheTokens) }}</small>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.agent-breakdown {
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

.agent-legend {
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
.agent-swatch {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-component, 2px);
  flex-shrink: 0;
}

.legend-swatch.input,
.agent-bar-segment.input { background: #5c6bc0; }
.legend-swatch.output,
.agent-bar-segment.output { background: #26a69a; }
.legend-swatch.cache,
.agent-bar-segment.cache { background: #f6ad55; }

.agent-list {
  display: flex;
  flex-direction: column;
  gap: calc(8px * var(--spacing-scale, 1));
}

.agent-row {
  display: flex;
  align-items: center;
  gap: calc(10px * var(--spacing-scale, 1));
}

.agent-name {
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  color: $text-secondary;
  width: 140px;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-bar-wrap {
  flex: 1;
  height: 16px;
  background: $bg-secondary;
  border-radius: var(--radius-component, 3px);
  overflow: hidden;
}

.agent-bar {
  height: 100%;
  border-radius: var(--radius-component, 3px);
  min-width: 2px;
  transition: width 0.3s ease;
  display: flex;
  overflow: hidden;
}

.agent-bar-segment {
  height: 100%;
  min-width: 0;
}

.agent-tokens {
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
