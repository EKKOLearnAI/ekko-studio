<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { TaskPlanSnapshot } from '@/utils/task-plan'

const props = defineProps<{ plan: TaskPlanSnapshot }>()
const { t } = useI18n()
const expanded = ref(true)
const completed = computed(() => props.plan.plan.filter(step => step.status === 'completed').length)
const stateLabel = computed(() => completed.value === props.plan.plan.length
  ? t('taskPlan.completed')
  : t(`taskPlan.${props.plan.execution_state}`))
</script>

<template>
  <section class="task-plan-card" data-testid="task-plan-card">
    <button class="plan-header" type="button" :aria-expanded="expanded" @click="expanded = !expanded">
      <span class="plan-title">{{ t('taskPlan.title') }}</span>
      <span class="plan-count" aria-live="polite">{{ t('taskPlan.progress', { completed, total: plan.plan.length }) }}</span>
      <span aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
    </button>
    <div v-if="expanded" class="plan-body">
      <ol>
        <li v-for="step in plan.plan" :key="step.id" :class="step.status">
          <span class="step-icon" aria-hidden="true">{{ step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '◉' : '○' }}</span>
          <span class="step-title" dir="auto">{{ step.step }}</span>
          <span class="step-status">{{ t(`taskPlan.${step.status}`) }}</span>
        </li>
      </ol>
      <p v-if="plan.explanation" class="plan-explanation" dir="auto">{{ plan.explanation }}</p>
      <p class="plan-state">{{ stateLabel }}</p>
    </div>
  </section>
</template>

<style scoped lang="scss">
.task-plan-card { color: var(--text-primary, #1a1a1a); background: var(--msg-assistant-bg, #f5f5f5); width: 100%; max-width: 680px; border: 1px solid var(--border-color, #8884); border-radius: 12px; overflow: hidden; }
.plan-header { display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px 16px; border: 0; color: inherit; background: transparent; cursor: pointer; text-align: start; font: inherit; }
.plan-header:focus-visible { outline: 2px solid var(--accent-primary, #333333); outline-offset: -3px; }
.plan-title { font-weight: 600; }
.plan-count { margin-inline-start: auto; font-size: 12px; opacity: .75; }
.plan-body { padding: 0 16px 12px; }
ol { list-style: none; padding: 0; margin: 0; }
li { display: flex; align-items: baseline; gap: 10px; padding: 6px 0; }
.step-icon { flex: 0 0 16px; }
.step-title { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.step-status { flex-shrink: 0; font-size: 12px; opacity: .7; }
.completed .step-icon { color: var(--success, #2e7d32); }
.in_progress .step-icon { color: var(--accent-primary, #333333); }
.plan-explanation, .plan-state { margin: 8px 0 0; font-size: 12px; opacity: .7; overflow-wrap: anywhere; }
@media (max-width: 480px) { .plan-header { gap: 8px; padding-inline: 12px; } .plan-body { padding-inline: 12px; } }
</style>
