<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  runId: string
  tools: { toolName?: string; toolStatus?: 'running' | 'done' | 'error' | 'interrupted' }[]
  active?: boolean
}>()

const { t } = useI18n()
const expandedOverride = ref<boolean | null>(null)
const expanded = computed(() => expandedOverride.value ?? !!props.active)
watch(() => props.active, () => { expandedOverride.value = null })

const toolNames = computed(() => {
  const names = [...new Set(props.tools.map(tool => tool.toolName).filter(Boolean) as string[])]
  const visible = names.slice(0, 3).join(' · ')
  return names.length > 3 ? `${visible} · +${names.length - 3}` : visible
})

const hasError = computed(() => props.tools.some(tool => tool.toolStatus === 'error'))
const hasInterrupted = computed(() => props.tools.some(tool => tool.toolStatus === 'interrupted'))
</script>

<template>
  <section class="tool-run-card" :data-run-id="runId">
    <button
      type="button"
      class="tool-run-header"
      :aria-expanded="expanded"
      @click="expandedOverride = !expanded"
    >
      <svg
        class="tool-run-chevron"
        :class="{ expanded }"
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        aria-hidden="true"
      >
        <polyline points="9 18 15 12 9 6" />
      </svg>
      <svg
        class="tool-run-icon"
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        aria-hidden="true"
      >
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      </svg>
      <span class="tool-run-count">{{ t('subagent.tools', { count: tools.length }) }}</span>
      <span v-if="toolNames" class="tool-run-names">{{ toolNames }}</span>
      <span v-if="hasError" class="tool-run-error">{{ t('chat.error') }}</span>
      <span v-else-if="hasInterrupted" class="tool-run-error">{{ t('chat.toolResultUnavailable') }}</span>
      <span v-else-if="active" class="tool-run-active" aria-busy="true">•••</span>
      <svg
        v-else
        class="tool-run-success"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        aria-hidden="true"
      >
        <path d="m7 12 3 3 7-7" />
      </svg>
    </button>

    <Transition name="tool-run-expand">
      <div v-if="expanded" class="tool-run-expand">
        <div class="tool-run-expand-inner">
          <slot />
        </div>
      </div>
    </Transition>
  </section>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.tool-run-card {
  width: 520px;
  max-width: 100%;
  min-width: 0;
}

.tool-run-header {
  display: flex;
  align-items: center;
  gap: calc(7px * var(--spacing-scale, 1));
  width: 100%;
  min-width: 0;
  min-height: 30px;
  padding: calc(4px * var(--spacing-scale, 1)) calc(8px * var(--spacing-scale, 1));
  border: var(--border-width, 1px) solid rgba(var(--text-primary-rgb), 0.09);
  border-radius: var(--radius-component, 8px);
  background: rgba(var(--bg-main-surface-rgb), 0.28);
  color: $text-secondary;
  font: inherit;
  font-size: calc(var(--font-size-base, 14px) * 11 / 14);
  text-align: start;
  cursor: pointer;

  &:hover,
  &:focus-visible {
    outline: none;
    border-color: rgba(var(--accent-primary-rgb), 0.24);
    background: rgba(var(--accent-primary-rgb), 0.055);
  }
}

.tool-run-chevron {
  flex: 0 0 auto;
  color: $text-muted;
  transition: transform 0.15s ease;

  &.expanded {
    transform: rotate(90deg);
  }
}

.tool-run-icon {
  flex: 0 0 auto;
  color: rgba(var(--accent-primary-rgb), 0.82);
}

.tool-run-count {
  flex: 0 0 auto;
  color: $text-secondary;
  font-weight: 500;
}

.tool-run-names {
  min-width: 0;
  overflow: hidden;
  color: $text-muted;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.tool-run-error {
  flex: 0 0 auto;
  margin-inline-start: auto;
  color: $error;
}

.tool-run-active,
.tool-run-success {
  flex: 0 0 auto;
  margin-inline-start: auto;
  color: rgba(var(--accent-primary-rgb), 0.78);
}

.tool-run-expand {
  display: grid;
  grid-template-rows: 1fr;
  opacity: 1;
  transform: translateY(0);
}

.tool-run-expand-inner {
  min-height: 0;
  overflow: hidden;
}

.tool-run-expand-enter-active,
.tool-run-expand-leave-active {
  transition:
    grid-template-rows 220ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 150ms ease,
    transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}

.tool-run-expand-enter-from,
.tool-run-expand-leave-to {
  grid-template-rows: 0fr;
  opacity: 0;
  transform: translateY(-4px);
}

@media (prefers-reduced-motion: reduce) {
  .tool-run-chevron,
  .tool-run-expand-enter-active,
  .tool-run-expand-leave-active {
    transition: none;
  }
}
</style>
