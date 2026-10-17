<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import HeaderActionOverflow from '@/components/layout/HeaderActionOverflow.vue'
import type { SkillSource } from '@/api/hermes/skills'

type SkillSourceFilter = SkillSource | 'modified'

const props = defineProps<{
  modelValue: SkillSourceFilter | null
  showHub?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: SkillSourceFilter | null]
}>()

const { t } = useI18n()

function toggle(filter: SkillSourceFilter) {
  emit('update:modelValue', props.modelValue === filter ? null : filter)
}
</script>

<template>
  <HeaderActionOverflow :label="t('skills.filterBySource')" :breakpoint="1100" :active="modelValue !== null" placement="bottom-start">
    <div class="source-legend">
      <button class="legend-item" :class="{ active: modelValue === 'builtin' }" @click="toggle('builtin')">
        <span class="legend-dot dot-builtin" />{{ t('skills.source.builtin') }}
      </button>
      <button v-if="showHub !== false" class="legend-item" :class="{ active: modelValue === 'hub' }" @click="toggle('hub')">
        <span class="legend-dot dot-hub" />{{ t('skills.source.hub') }}
      </button>
      <button class="legend-item" :class="{ active: modelValue === 'local' }" @click="toggle('local')">
        <span class="legend-dot dot-local" />{{ t('skills.source.local') }}
      </button>
      <button class="legend-item" :class="{ active: modelValue === 'external' }" @click="toggle('external')">
        <span class="legend-dot dot-external" />{{ t('skills.source.external') }}
      </button>
      <button class="legend-item" :class="{ active: modelValue === 'modified' }" @click="toggle('modified')">
        <span class="modified-icon">✎</span>{{ t('skills.modified') }}
      </button>
    </div>
  </HeaderActionOverflow>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.source-legend {
  display: flex;
  align-items: center;
  gap: calc(4px * var(--spacing-scale, 1));
  flex-wrap: wrap;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: calc(4px * var(--spacing-scale, 1));
  font-size: calc(var(--font-size-base, 14px) * 11 / 14);
  color: $text-muted;
  white-space: nowrap;
  padding: calc(2px * var(--spacing-scale, 1)) calc(6px * var(--spacing-scale, 1));
  border: var(--border-width, 1px) solid transparent;
  border-radius: var(--radius-component, 10px);
  background: none;
  cursor: pointer;
  transition: all $transition-fast;

  &:hover {
    color: $text-secondary;
    background: rgba(var(--accent-primary-rgb), 0.04);
  }

  &.active {
    color: $text-primary;
    border-color: $border-color;
    background: rgba(var(--accent-primary-rgb), 0.08);
  }
}

.legend-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot-builtin { background: #888; }
.dot-hub { background: #4a90d9; }
.dot-local { background: #66bb6a; }
.dot-external { background: #f59e0b; }

.modified-icon {
  font-size: calc(var(--font-size-base, 14px) * 11 / 14);
  color: $warning;
  opacity: 0.7;
}
</style>
