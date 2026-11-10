<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NDrawer, NDrawerContent } from 'naive-ui'
import type { PersonTask } from '@/api/person'
import SessionTaskIcon from '@/components/common/SessionTaskIcon.vue'
import SessionTasksPanel from './SessionTasksPanel.vue'
import { useTaskDrawerLayout } from './useTaskDrawerLayout'

const props = defineProps<{ show: boolean; person?: boolean; personSessionId?: string }>()
const emit = defineEmits<{ 'update:show': [show: boolean]; 'open-person-task': [task: PersonTask] }>()
const { t } = useI18n()
const { drawerWidth } = useTaskDrawerLayout()
const total = ref(0)
</script>

<template>
  <NDrawer :show="show" :width="drawerWidth" placement="right" display-directive="show" class="session-tasks-drawer" :aria-label="t('sessionTasks.title')" @update:show="emit('update:show', $event)">
    <NDrawerContent closable :native-scrollbar="true" :body-content-style="{ padding: '0', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }">
      <template #header><div class="drawer-title"><SessionTaskIcon :size="18" /><span>{{ t('sessionTasks.title') }}</span><span class="task-count">{{ total }}</span></div></template>
      <SessionTasksPanel :active="props.show" :person="person" :person-session-id="personSessionId" @update:total="total = $event" @open-person-task="emit('open-person-task', $event)" />
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.drawer-title { display: flex; align-items: center; gap: 10px; color: $text-primary; font-size: calc(var(--font-size-base, 14px) * 16 / 14); font-weight: 600; }
.drawer-title svg { color: $text-secondary; }
.task-count { font-variant-numeric: tabular-nums; }
</style>
