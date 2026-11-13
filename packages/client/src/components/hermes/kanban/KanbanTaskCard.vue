<script setup lang="ts">
import { computed } from 'vue'
import { NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import ProfileAvatar from '@/components/hermes/profiles/ProfileAvatar.vue'
import type { KanbanTask } from '@/api/hermes/kanban'
import type { ProfileAvatar as ProfileAvatarData } from '@/api/hermes/profiles'

const props = defineProps<{
  task: KanbanTask
  assigneeAvatar?: ProfileAvatarData | null
}>()

const emit = defineEmits<{
  click: [taskId: string]
}>()

const { t } = useI18n()

const timeAgo = computed(() => {
  const diff = Date.now() / 1000 - props.task.created_at
  if (diff < 60) return t('kanban.card.timeAgo.justNow')
  if (diff < 3600) return t('kanban.card.timeAgo.minutes', { count: Math.floor(diff / 60) })
  if (diff < 86400) return t('kanban.card.timeAgo.hours', { count: Math.floor(diff / 3600) })
  return t('kanban.card.timeAgo.days', { count: Math.floor(diff / 86400) })
})

const priorityLabel = computed(() => {
  if (props.task.priority >= 3) return 'high'
  if (props.task.priority === 2) return 'medium'
  return 'low'
})

const priorityText = computed(() => {
  return t(`kanban.card.priority.${priorityLabel.value}`)
})
</script>

<template>
  <button
    type="button"
    class="kanban-task-card"
    :class="`status-${task.status}`"
    :aria-label="task.title"
    @click="emit('click', task.id)"
  >
    <div class="card-heading">
      <span class="status-marker" aria-hidden="true" />
      <span class="task-id">{{ task.id }}</span>
      <span v-if="task.priority >= 2" class="priority" :class="priorityLabel">
        <span class="priority-dot" aria-hidden="true" />
        {{ priorityText }}
      </span>
    </div>
    <div class="card-title" dir="auto">{{ task.title }}</div>
    <div class="card-footer">
      <NTooltip v-if="task.assignee" trigger="hover">
        <template #trigger>
          <span class="assignee">
            <ProfileAvatar
              class="assignee-profile-avatar"
              :name="task.assignee"
              :avatar="assigneeAvatar"
              :size="18"
              aria-hidden="true"
            />
            <span class="assignee-name">{{ task.assignee }}</span>
          </span>
        </template>
        {{ t('kanban.card.assigneeTooltip') }}
      </NTooltip>
      <span class="card-time">{{ timeAgo }}</span>
    </div>
  </button>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.kanban-task-card {
  --kanban-card-status-color: #7f858d;
  appearance: none;
  width: 100%;
  display: block;
  background-color: var(--theme-card-bg, $bg-card);
  border: var(--border-width, 1px) solid $border-color;
  border-radius: $radius-md;
  padding: calc(12px * var(--spacing-scale, 1)) calc(13px * var(--spacing-scale, 1));
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.035);
  transition:
    background-color $transition-fast,
    border-color $transition-fast,
    box-shadow $transition-fast,
    transform $transition-fast;

  &.status-triage { --kanban-card-status-color: #8b8f95; }
  &.status-todo { --kanban-card-status-color: #6f7782; }
  &.status-scheduled { --kanban-card-status-color: #667681; }
  &.status-ready { --kanban-card-status-color: #a66d23; }
  &.status-running { --kanban-card-status-color: var(--accent-info); }
  &.status-blocked { --kanban-card-status-color: var(--error); }
  &.status-review { --kanban-card-status-color: #7b6f8b; }
  &.status-done { --kanban-card-status-color: var(--success); }
  &.status-archived { --kanban-card-status-color: #777b81; }

  &:hover {
    background-color: var(--theme-card-bg, $bg-card-hover);
    border-color: color-mix(in srgb, var(--kanban-card-status-color) 52%, $border-color);
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.07);
    transform: translateY(-1px);
  }

  &:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--kanban-card-status-color) 72%, transparent);
    outline-offset: 2px;
  }
}

.card-heading {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: calc(7px * var(--spacing-scale, 1));
  min-height: 16px;
}

.status-marker {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: var(--kanban-card-status-color);
}

.task-id {
  min-width: 0;
  overflow: hidden;
  color: $text-muted;
  font-family: var(--font-code, $font-code);
  font-size: calc(var(--font-size-base, 14px) * 10.5 / 14);
  line-height: var(--line-height, 1);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-title {
  margin-top: 8px;
  font-size: calc(var(--font-size-base, 14px) * 14 / 14);
  font-weight: 600;
  color: $text-primary;
  line-height: var(--line-height, 1.45);
  word-break: break-word;
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.priority {
  display: inline-flex;
  align-items: center;
  gap: calc(5px * var(--spacing-scale, 1));
  margin-inline-start: auto;
  color: $text-secondary;
  font-size: calc(var(--font-size-base, 14px) * 10.5 / 14);
  font-weight: 500;
  line-height: var(--line-height, 1);
  white-space: nowrap;

  &.high .priority-dot {
    background: $error;
  }

  &.medium .priority-dot {
    background: $warning;
  }
}

.priority-dot {
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: $text-muted;
}

.card-footer {
  display: flex;
  align-items: center;
  gap: calc(8px * var(--spacing-scale, 1));
  min-width: 0;
  min-height: 20px;
  margin-top: 12px;
}

.assignee {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: calc(100% - 64px);
  gap: calc(6px * var(--spacing-scale, 1));
  color: $text-secondary;
  font-size: calc(var(--font-size-base, 14px) * 11 / 14);
  line-height: var(--line-height, 1);
}

.assignee-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.assignee-profile-avatar {
  flex: 0 0 auto;
  box-shadow: 0 0 0 1px $border-light;
}

.card-time {
  flex: 0 0 auto;
  font-size: calc(var(--font-size-base, 14px) * 11 / 14);
  color: $text-muted;
  margin-inline-start: auto;
  white-space: nowrap;
}
</style>
