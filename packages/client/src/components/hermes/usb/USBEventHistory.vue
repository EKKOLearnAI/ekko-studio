<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NEmpty, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { USBEventRecord } from '@/api/studio/usb-socket'

const props = defineProps<{
  events: USBEventRecord[]
}>()

const emit = defineEmits<{
  pickDevice: [uuid: string]
}>()

const { t } = useI18n()

const recentEvents = computed(() => props.events.slice(0, 20))

function eventTitle(event: USBEventRecord): string {
  if (event.status === 'mount_failed') return t('usb.page.history.mountFailed')
  return event.action === 'remove'
    ? t('usb.page.history.removed')
    : t('usb.page.history.mounted')
}

function eventToneClass(event: USBEventRecord): string {
  if (event.status === 'mount_failed') return 'is-error'
  return event.action === 'remove' ? 'is-warning' : 'is-success'
}

function eventLabel(event: USBEventRecord): string {
  return event.label?.trim() || t('usb.notifications.unknownDevice')
}

function formatTime(ts: number): string {
  const date = new Date(ts)
  return Number.isNaN(date.getTime()) ? String(ts) : date.toLocaleString()
}
</script>

<template>
  <section class="usb-history">
    <div class="history-head">
      <span class="history-kicker">Activity</span>
      <h3>{{ t('usb.page.history.title') }}</h3>
      <span class="history-meta">{{ t('usb.page.history.count', { count: recentEvents.length }) }}</span>
    </div>

    <div v-if="recentEvents.length === 0" class="empty-wrap">
      <NEmpty :description="t('usb.page.history.empty')" size="small" />
    </div>

    <div v-else class="history-list">
      <article
        v-for="event in recentEvents"
        :key="event.id"
        class="history-item"
        :class="eventToneClass(event)"
      >
        <div class="history-main">
          <div class="history-top">
            <NTag size="small" :type="eventToneClass(event) === 'is-error' ? 'error' : eventToneClass(event) === 'is-warning' ? 'warning' : 'success'">
              {{ eventTitle(event) }}
            </NTag>
            <span class="history-time">{{ formatTime(event.ts) }}</span>
          </div>

          <div class="history-label">{{ eventLabel(event) }}</div>
          <div class="history-path">{{ event.mountPoint || event.deviceNode }}</div>
          <div v-if="event.error" class="history-error">{{ event.error }}</div>
        </div>

        <NButton quaternary size="tiny" class="history-action" @click="emit('pickDevice', event.uuid)">
          {{ t('usb.page.history.openDevice') }}
        </NButton>
      </article>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.usb-history {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.history-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.history-kicker {
  font-size: 10.5px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: $text-muted;
}

.history-head h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: $text-primary;
}

.history-meta {
  font-size: 11px;
  color: $text-muted;
  font-variant-numeric: tabular-nums;
}

.empty-wrap {
  padding: 16px 0;
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.history-item {
  --usb-event-line: #{$text-muted};
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px 10px 14px;
  background: var(--theme-card-bg, var(--bg-card));
  border: 1px solid $border-light;
  border-left: 2px solid var(--usb-event-line);
  border-radius: $radius-sm;

  &.is-success { --usb-event-line: #{$success}; }
  &.is-warning { --usb-event-line: #{$warning}; }
  &.is-error { --usb-event-line: #{$error}; }
}

.history-main {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.history-top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.history-time {
  color: $text-muted;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

.history-path {
  color: $text-muted;
  font-size: 11.5px;
  word-break: break-all;
  font-family: $font-code;
}

.history-label {
  font-weight: 600;
  color: $text-primary;
  font-size: 13px;
}

.history-error {
  color: $error;
  font-size: 12px;
  word-break: break-word;
}

.history-action {
  flex: 0 0 auto;
  align-self: center;
}

@media (max-width: $breakpoint-mobile) {
  .history-item {
    flex-direction: column;
  }
}
</style>
