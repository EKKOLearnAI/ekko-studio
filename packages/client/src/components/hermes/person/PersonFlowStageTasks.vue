<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { PersonFlow } from '@/api/person'
import SessionTaskIcon from '@/components/common/SessionTaskIcon.vue'
import { chatSessionAgentAvatar } from '@/utils/chat-agent-avatar'
defineProps<{tasks:PersonFlow['stages'][number]['tasks']}>()
const emit = defineEmits<{openTask:[taskId:string]}>()
const {t} = useI18n()
</script>

<template>
  <details v-if="tasks.length" class="flow-worker-details">
    <summary><SessionTaskIcon :size="14" /><span>{{ t('person.flowWorkerTasks',{ count:tasks.length }) }}</span><SessionTaskIcon name="chevron-down" :size="12" /></summary>
    <ul><li v-for="task in tasks" :key="task.id">
      <button type="button" class="flow-worker" @click="emit('openTask',task.id)">
        <img :src="chatSessionAgentAvatar({ agent:task.agent || 'ekko-agent' }).src" alt="" width="22" height="22" />
        <span>{{ task.title }}<small>{{ t(`person.states.${task.execution_state || task.status}`) }}</small></span><SessionTaskIcon name="open" :size="12" />
      </button>
    </li></ul>
  </details>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.flow-worker-details { margin-top: auto; padding-top: 10px; border-top: 1px solid $border-light; }
summary { display: flex; align-items: center; gap: 7px; list-style: none; font-size: 11px; line-height: 1.7; color: $text-muted; cursor: pointer; }
summary::-webkit-details-marker { display: none; }
summary span { flex: 1; }
details[open] summary > svg:last-child { transform: rotate(180deg); }
.flow-worker-details ul { padding: 0; margin: 10px 0 0; list-style: none; }
.flow-worker { display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 0; border: 0; background: transparent; font: inherit; color: $text-secondary; text-align: start; cursor: pointer; }
.flow-worker > img, .flow-worker > svg { flex-shrink: 0; object-fit: contain; }
.flow-worker > span { flex: 1; min-width: 0; font-size: 11px; overflow-wrap: anywhere; }
.flow-worker small { display: block; margin-top: 3px; font-size: 10px; color: $text-muted; }
.flow-worker:focus-visible, summary:focus-visible { outline: 2px solid $accent-primary; outline-offset: 4px; border-radius: var(--radius-component, 4px); }
</style>
