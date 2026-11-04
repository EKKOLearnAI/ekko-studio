<script setup lang="ts">
import { computed, inject } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PersonTaskReturn } from '@/api/person'
import SessionTaskIcon from '@/components/common/SessionTaskIcon.vue'
import { personTaskNavigation } from './task-navigation'
import { chatSessionAgentAvatar } from '@/utils/chat-agent-avatar'

const props = defineProps<{ result: PersonTaskReturn }>()
const { t } = useI18n()
const openTask = inject(personTaskNavigation, undefined)
const avatar = computed(() => chatSessionAgentAvatar({ agent: props.result.agent }))
</script>

<template>
  <section v-if="openTask" class="person-task-return-card" data-theme-surface="card" :aria-label="result.title">
    <img class="task-return-logo" :src="avatar.src" :alt="avatar.label" :title="avatar.label" />
    <div class="task-return-content">
      <div class="task-return-header">
        <button type="button" class="task-return-title" :aria-label="t('sessionTasks.openTask', { title: result.title })" @click="openTask(result.taskId, result.executionId)">{{ result.title }}</button>
        <span class="task-status" :class="{ 'task-status--completed': result.state === 'finished' }" role="status">
          <SessionTaskIcon :name="result.state === 'finished' ? 'completed' : 'circle'" :size="13" />
          {{ t(`person.states.${result.state}`) }}
        </span>
      </div>
      <details v-if="result.summary" class="task-return-details">
        <summary :aria-label="t('person.details')"><span class="task-return-description">{{ result.summary }}</span><SessionTaskIcon name="chevron-down" :size="13" /></summary>
      </details>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use '../tasks/task-status' as task-status;
.person-task-return-card {
  box-sizing: border-box;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  width: 100%;
  margin-top: 12px;
  padding: 12px 14px;
  background: $bg-card;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 10px);
  color: $text-primary;
  font: inherit;
  text-align: start;
}
.task-return-logo { width: 56px; height: 56px; object-fit: contain; border-radius: 22%; flex-shrink: 0; }
.task-return-content { min-width: 0; flex: 1; }
.task-return-header { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; }
.task-return-title { flex: 1; min-width: 0; padding: 0; border: 0; background: transparent; font: inherit; color: $text-primary; text-align: start; font-weight: 550; line-height: 1.6; overflow-wrap: anywhere; cursor: pointer; }
.task-return-title:hover { text-decoration: underline; text-underline-offset: 4px; }
.task-return-title:focus-visible, summary:focus-visible { outline: 2px solid $accent-primary; outline-offset: 4px; border-radius: var(--radius-component, 4px); }
.task-status { @include task-status.badge; }
.task-status--completed { @include task-status.completed; }
.task-return-details { margin-top: 5px; color: $text-secondary; font-size: calc(var(--font-size-base, 14px) * 13 / 14); line-height: 1.65; }
summary { display: flex; align-items: flex-start; gap: 8px; min-width: 0; list-style: none; cursor: pointer; }
summary::-webkit-details-marker { display: none; }
summary svg { flex-shrink: 0; margin-top: 5px; color: $text-muted; transition: transform 160ms ease; }
.task-return-description { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
details[open] .task-return-description { white-space: pre-wrap; overflow-wrap: anywhere; }
details[open] summary svg { transform: rotate(180deg); }
@media (max-width: 768px) {
  .person-task-return-card { gap: 10px; }
  .task-status { @include task-status.mobile; }
  .task-return-details { font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
}
@media (prefers-reduced-motion: reduce) { summary svg { transition: none; } }
</style>
