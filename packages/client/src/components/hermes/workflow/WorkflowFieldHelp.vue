<script setup lang="ts">
import { NTooltip } from 'naive-ui'

defineProps<{
  text: string
  secondaryText?: string
  testId?: string
}>()
</script>

<template>
  <NTooltip trigger="hover">
    <template #trigger>
      <button
        class="workflow-field-help-button"
        type="button"
        :aria-label="text"
        :data-testid="testId"
        @click.stop.prevent
        @pointerdown.stop
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5" />
          <path d="M12 8h.01" />
        </svg>
      </button>
    </template>
    <div class="workflow-field-help-tooltip">
      <span>{{ text }}</span>
      <span v-if="secondaryText">{{ secondaryText }}</span>
    </div>
  </NTooltip>
</template>

<style scoped lang="scss">
.workflow-field-help-button {
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--text-muted);
  cursor: help;
  transition: color 0.15s ease, background-color 0.15s ease;

  &:hover,
  &:focus-visible {
    color: var(--accent-info);
    background: rgba(var(--accent-info-rgb), 0.1);
    outline: none;
  }
}

.workflow-field-help-tooltip {
  display: flex;
  max-width: 360px;
  flex-direction: column;
  gap: calc(4px * var(--spacing-scale, 1));
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  line-height: var(--line-height, 1.5);
}
</style>
