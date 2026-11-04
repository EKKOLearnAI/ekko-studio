<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PersonAgentPreset, PersonTask } from '@/api/person'
import { personTaskIdentity } from '@/utils/person-task-identity'
import PersonPanelIcon from './PersonPanelIcon.vue'
const props = defineProps<{ task: PersonTask; agents?: PersonAgentPreset[] }>()
const { t } = useI18n()
const identity = computed(() => personTaskIdentity(props.task, props.agents))
</script>

<template>
  <span class="person-task-identity">
    <img v-if="identity.avatar" class="task-identity-logo" :src="identity.avatar.src" :alt="identity.avatar.label" width="40" height="40" />
    <PersonPanelIcon v-else class="task-identity-logo" name="agents" :size="40" />
    <span class="task-identity-text">
      <span class="task-identity-name" :title="identity.name || t('person.agentRuntime')">{{ identity.name || t('person.agentRuntime') }}</span>
      <span class="task-identity-title" :title="task.title">{{ task.title }}</span>
    </span>
  </span>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use '@/styles/agent-avatar' as *;
.person-task-identity { display: flex; align-items: center; gap: 10px; min-width: 0; text-align: start; }
.task-identity-logo { @include agent-avatar(40px); }
.task-identity-text { display: flex; flex-direction: column; flex: 1; min-width: 0; line-height: 20px; }
.task-identity-name, .task-identity-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-identity-name { font-size: 13px; font-weight: 600; }
.task-identity-title { font-size: 12px; color: $text-secondary; }
</style>
