<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { NCollapse, NCollapseItem } from 'naive-ui'
import KanbanTaskCard from './KanbanTaskCard.vue'
import type { KanbanTask, KanbanTaskStatus } from '@/api/hermes/kanban'

const props = defineProps<{
  status: KanbanTaskStatus
  tasks: KanbanTask[]
}>()

const emit = defineEmits<{
  taskClick: [taskId: string]
}>()

const { t } = useI18n()

const statusLabel = computed(() => t(`kanban.columns.${props.status}`, props.status))
const statusCount = computed(() => props.tasks.length)

const statusIcon = computed(() => {
  switch (props.status) {
    case 'todo': return '○'
    case 'ready': return '◎'
    case 'running': return '●'
    case 'blocked': return '⊘'
    case 'done': return '✓'
    default: return '○'
  }
})

const headerTitle = computed(() => `${statusIcon.value}  ${statusLabel.value}  (${statusCount.value})`)
</script>

<template>
  <div class="kanban-column">
    <NCollapse :default-expanded-names="[status]" display-directive="show">
      <NCollapseItem :title="headerTitle" :name="status">
        <KanbanTaskCard
          v-for="task in tasks"
          :key="task.id"
          :task="task"
          @click="emit('taskClick', task.id)"
        />
        <div v-if="tasks.length === 0" class="column-empty">
          {{ t('kanban.noTasks') }}
        </div>
      </NCollapseItem>
    </NCollapse>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.kanban-column {
  flex: 1 1 calc(20% - 12px);
  min-width: 200px;
  background-color: rgba(var(--accent-primary-rgb), 0.02);
  border-radius: $radius-md;
  border: var(--border-width, 1px) solid $border-light;

  :deep(.n-collapse) {
    --n-title-font-size: calc(var(--font-size-base, 14px) * 13 / 14);
    --n-title-font-weight: 600;
  }

  :deep(.n-collapse-item__header-main) {
    color: $text-primary;
  }

  :deep(.n-collapse-item__content-wrapper) {
    padding: 0 calc(10px * var(--spacing-scale, 1)) calc(10px * var(--spacing-scale, 1));
  }

  :deep(.n-collapse-item) {
    display: flex;
    flex-direction: column;
  }
}

.column-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 60px;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  color: $text-muted;
}
</style>
