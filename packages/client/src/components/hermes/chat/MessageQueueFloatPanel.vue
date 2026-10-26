<script setup lang="ts">
import { useI18n } from 'vue-i18n'

export interface MessageQueueFloatItem {
  id: string
  text: string
  secondary?: string
  position?: number
}

const props = withDefaults(defineProps<{
  items: MessageQueueFloatItem[]
  testId?: string
  canInsert?: boolean
  activeInsertId?: string | null
  insertTitle?: (item: MessageQueueFloatItem) => string
  removeTitle?: string | ((item: MessageQueueFloatItem) => string)
}>(), {
  testId: undefined,
  canInsert: false,
  activeInsertId: null,
  insertTitle: undefined,
  removeTitle: undefined,
})

const emit = defineEmits<{
  insert: [id: string]
  remove: [id: string]
}>()
const { t } = useI18n()

function resolvedInsertTitle(item: MessageQueueFloatItem): string {
  return props.insertTitle?.(item) || t('chat.insertQueuedMessage')
}

function resolvedRemoveTitle(item: MessageQueueFloatItem): string {
  if (typeof props.removeTitle === 'function') return props.removeTitle(item)
  return props.removeTitle || t('chat.removeQueuedMessage')
}
</script>

<template>
  <div
    v-if="items.length > 0"
    class="queue-float-panel"
    :data-testid="testId"
    aria-live="polite"
  >
    <div class="queue-float-header">
      <span class="queue-orbit" aria-hidden="true"><span></span></span>
      <span>{{ t('chat.messageQueue') }}</span>
      <strong>{{ items.length }}</strong>
    </div>
    <div class="queue-float-list">
      <div
        v-for="(item, index) in items"
        :key="item.id"
        class="queue-float-item"
        :data-queue-id="item.id"
      >
        <span class="queue-index">{{ item.position || index + 1 }}</span>
        <span v-if="item.secondary" class="queue-agent">{{ item.secondary }}</span>
        <span class="queue-text">{{ item.text }}</span>
        <button
          v-if="canInsert"
          type="button"
          class="queue-insert"
          :class="{ 'queue-insert--active': activeInsertId === item.id }"
          :disabled="!!activeInsertId"
          :title="resolvedInsertTitle(item)"
          :aria-label="resolvedInsertTitle(item)"
          @click="emit('insert', item.id)"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 19V5" />
            <path d="m5 12 7-7 7 7" />
          </svg>
        </button>
        <button
          type="button"
          class="queue-remove"
          :title="resolvedRemoveTitle(item)"
          :aria-label="resolvedRemoveTitle(item)"
          @click="emit('remove', item.id)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.queue-float-panel {
  pointer-events: auto;
  align-self: flex-end;
  width: min(380px, 100%);
  padding: calc(10px * var(--spacing-scale, 1));
  border: var(--border-width, 1px) solid rgba(var(--accent-info-rgb), 0.22);
  border-radius: var(--radius-component, 16px);
  background: #ffffff;
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.14);
  backdrop-filter: blur(14px);

  .dark & {
    background: #262626;
  }
}

.queue-float-header {
  display: flex;
  align-items: center;
  gap: calc(8px * var(--spacing-scale, 1));
  padding: calc(2px * var(--spacing-scale, 1)) calc(4px * var(--spacing-scale, 1)) calc(8px * var(--spacing-scale, 1));
  color: $text-secondary;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  font-weight: 600;

  strong {
    margin-inline-start: auto;
    min-width: 20px;
    height: 20px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    background: rgba(var(--accent-info-rgb), 0.16);
    color: var(--accent-info);
  }
}

.queue-orbit {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: var(--border-width, 1px) solid rgba(var(--accent-info-rgb), 0.28);
  position: relative;
  animation: queue-spin 1.6s linear infinite;

  span {
    position: absolute;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    right: -2px;
    top: 5px;
    background: var(--accent-info);
    box-shadow: 0 0 12px rgba(var(--accent-info-rgb), 0.65);
  }
}

.queue-float-list {
  display: flex;
  flex-direction: column;
  gap: calc(6px * var(--spacing-scale, 1));
  max-height: 172px;
  overflow-y: auto;
}

.queue-float-item {
  display: flex;
  align-items: center;
  gap: calc(8px * var(--spacing-scale, 1));
  min-height: 34px;
  padding: calc(7px * var(--spacing-scale, 1)) calc(8px * var(--spacing-scale, 1));
  border-radius: var(--radius-component, 11px);
  background: rgba(255, 255, 255, 0.68);
  color: $text-primary;

  .dark & {
    background: rgba(255, 255, 255, 0.08);
  }
}

.queue-index {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-component, 7px);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: calc(var(--font-size-base, 14px) * 11 / 14);
  color: var(--accent-info);
  background: rgba(var(--accent-info-rgb), 0.12);
}

.queue-agent {
  flex: 0 0 auto;
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(var(--font-size-base, 14px) * 11 / 14);
  font-weight: 600;
  color: $text-secondary;
}

.queue-text {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
}

.queue-insert,
.queue-remove {
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--radius-component, 8px);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: $text-muted;
  background: transparent;
  cursor: pointer;
  transition: all $transition-fast;
}

.queue-insert {
  color: var(--accent-info);

  &:hover:not(:disabled) {
    color: var(--accent-primary);
    background: rgba(var(--accent-primary-rgb), 0.12);
    transform: translateY(-1px);
  }

  &:disabled {
    cursor: default;
    opacity: 0.34;
  }

  &.queue-insert--active {
    opacity: 1;
    color: var(--accent-primary);
    background: rgba(var(--accent-primary-rgb), 0.12);

    svg {
      animation: queue-insert-pulse 0.9s ease-in-out infinite alternate;
    }
  }
}

.queue-remove:hover {
  color: $error;
  background: rgba($error, 0.1);
}

@media (max-width: 640px) {
  .queue-float-panel {
    padding: calc(7px * var(--spacing-scale, 1));
    border-radius: var(--radius-component, 14px);
  }

  .queue-float-header {
    padding: 0 calc(2px * var(--spacing-scale, 1));
    font-size: calc(var(--font-size-base, 14px) * 11 / 14);

    span:nth-child(2) {
      display: none;
    }
  }

  .queue-orbit {
    width: 16px;
    height: 16px;

    span {
      width: 5px;
      height: 5px;
      top: 5px;
    }
  }

  .queue-float-list {
    margin-top: 6px;
    max-height: min(220px, 34dvh);
  }

  .queue-float-item {
    min-height: 30px;
    padding: calc(5px * var(--spacing-scale, 1)) calc(6px * var(--spacing-scale, 1));
  }

  .queue-index {
    width: 18px;
    height: 18px;
    border-radius: var(--radius-component, 6px);
    font-size: calc(var(--font-size-base, 14px) * 10 / 14);
  }

  .queue-text {
    font-size: calc(var(--font-size-base, 14px) * 11 / 14);
  }

  .queue-insert,
  .queue-remove {
    width: 22px;
    height: 22px;
  }
}

@keyframes queue-spin {
  to { transform: rotate(360deg); }
}

@keyframes queue-insert-pulse {
  from { transform: translateY(1px); }
  to { transform: translateY(-2px); }
}
</style>
