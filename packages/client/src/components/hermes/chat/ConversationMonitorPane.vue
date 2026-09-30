<script setup lang="ts">
import { NSpin } from 'naive-ui'
import { fetchConversationDetail, fetchConversationSummaries, type ConversationDetail, type ConversationSummary } from '@/api/studio/conversations'
import { formatTimestampSeconds, getSourceLabel } from '@/shared/session-display'
import { useAppStore } from '@/stores/hermes/app'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ humanOnly: boolean }>()
const { t } = useI18n()
const appStore = useAppStore()

const POLL_INTERVAL_MS = 15000

const sessions = ref<ConversationSummary[]>([])
const selectedSessionId = ref<string | null>(null)
const detail = ref<ConversationDetail | null>(null)
const sessionsLoading = ref(false)
const detailLoading = ref(false)
const error = ref('')
let refreshTimer: ReturnType<typeof setInterval> | null = null
let sessionsRequestId = 0
let detailRequestId = 0

const selectedSession = computed(() => sessions.value.find(session => session.id === selectedSessionId.value) || null)
const selectedSessionModelName = computed(() =>
  selectedSession.value?.model
    ? appStore.displayModelName(selectedSession.value.model, selectedSession.value.provider)
    : '',
)

function roleLabel(role: string): string {
  return role === 'user' ? t('chat.monitorRoleUser') : t('chat.monitorRoleAssistant')
}

function linkedSessionsLabel(count: number): string {
  return t('chat.linkedSessions', { count })
}

function invalidateRequests() {
  sessionsRequestId += 1
  detailRequestId += 1
}

async function loadSessions(silent = false) {
  const requestId = ++sessionsRequestId
  if (!silent) {
    sessionsLoading.value = true
    error.value = ''
  }

  try {
    const loaded = await fetchConversationSummaries({ humanOnly: props.humanOnly })
    if (requestId !== sessionsRequestId) return

    sessions.value = loaded
    if (!loaded.length) {
      selectedSessionId.value = null
      detail.value = null
      return
    }

    if (!selectedSessionId.value || !loaded.some(session => session.id === selectedSessionId.value)) {
      selectedSessionId.value = loaded[0].id
    }
  } catch (err: any) {
    if (requestId !== sessionsRequestId || silent) return
    error.value = err?.message || String(err)
    sessions.value = []
    selectedSessionId.value = null
    detail.value = null
  } finally {
    if (!silent && requestId === sessionsRequestId) sessionsLoading.value = false
  }
}

async function loadDetail(sessionId: string | null, silent = false) {
  const requestId = ++detailRequestId
  if (!sessionId) {
    detail.value = null
    return
  }

  const requestedHumanOnly = props.humanOnly
  if (!silent) {
    detailLoading.value = true
    error.value = ''
  }

  try {
    const loaded = await fetchConversationDetail(sessionId, { humanOnly: requestedHumanOnly })
    if (
      requestId !== detailRequestId
      || sessionId !== selectedSessionId.value
      || requestedHumanOnly !== props.humanOnly
    ) {
      return
    }
    detail.value = loaded
  } catch (err: any) {
    if (requestId !== detailRequestId || silent) return
    error.value = err?.message || String(err)
    detail.value = null
  } finally {
    if (!silent && requestId === detailRequestId) detailLoading.value = false
  }
}

watch(selectedSessionId, async sessionId => {
  await loadDetail(sessionId, false)
})

watch(() => props.humanOnly, async () => {
  invalidateRequests()
  selectedSessionId.value = null
  detail.value = null
  await loadSessions(false)
})

onMounted(async () => {
  await loadSessions(false)
  refreshTimer = setInterval(async () => {
    await loadSessions(true)
    if (selectedSessionId.value) {
      await loadDetail(selectedSessionId.value, true)
    }
  }, POLL_INTERVAL_MS)
})

onUnmounted(() => {
  invalidateRequests()
  if (refreshTimer) clearInterval(refreshTimer)
})
</script>

<template>
  <div class="conversation-monitor">
    <aside class="conversation-monitor__sidebar">
      <div v-if="sessionsLoading && sessions.length === 0" class="conversation-monitor__empty"><NSpin :description="t('common.loading')" /></div>
      <div v-else-if="sessions.length === 0" class="conversation-monitor__empty">{{ t('chat.noSessions') }}</div>
      <button
        v-for="session in sessions"
        :key="session.id"
        class="conversation-monitor__session"
        :class="{ active: session.id === selectedSessionId }"
        :aria-pressed="session.id === selectedSessionId"
        @click="selectedSessionId = session.id"
      >
        <div class="conversation-monitor__session-title-row">
          <span class="conversation-monitor__session-title">{{ session.title || session.preview || session.id }}</span>
          <span v-if="session.is_active" class="conversation-monitor__session-live">{{ t('chat.recentBadge') }}</span>
        </div>
        <div class="conversation-monitor__session-meta">{{ getSourceLabel(session.source) }} · {{ formatTimestampSeconds(session.last_active) }}</div>
        <div v-if="session.preview" class="conversation-monitor__session-preview">{{ session.preview }}</div>
      </button>
    </aside>

    <section class="conversation-monitor__detail">
      <header v-if="selectedSession" class="conversation-monitor__detail-header">
        <div class="conversation-monitor__detail-title">{{ selectedSession.title || selectedSession.preview || selectedSession.id }}</div>
        <div class="conversation-monitor__detail-meta">
          <span>{{ getSourceLabel(selectedSession.source) }}</span>
          <span>·</span>
          <span :title="selectedSession.model">{{ selectedSessionModelName }}</span>
          <span>·</span>
          <span>{{ linkedSessionsLabel(selectedSession.thread_session_count) }}</span>
        </div>
      </header>

      <div v-if="error" class="conversation-monitor__empty conversation-monitor__empty--error">{{ error }}</div>
      <div v-else-if="detailLoading && !detail" class="conversation-monitor__empty"><NSpin :description="t('common.loading')" /></div>
      <div v-else-if="!detail || detail.messages.length === 0" class="conversation-monitor__empty">{{ t('chat.noVisibleMessages') }}</div>
      <div v-else class="conversation-monitor__messages">
        <article
          v-for="message in detail.messages"
          :key="`${message.session_id}-${message.id}`"
          class="conversation-monitor__message"
          :class="`role-${message.role}`"
        >
          <div class="conversation-monitor__message-meta">{{ roleLabel(message.role) }} · {{ formatTimestampSeconds(message.timestamp) }}</div>
          <div class="conversation-monitor__message-content">{{ message.content }}</div>
        </article>
      </div>
    </section>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.conversation-monitor {
  display: flex;
  min-height: 0;
  flex: 1;
}

.conversation-monitor__sidebar {
  width: 260px;
  border-inline-end: 1px solid $border-color;
  overflow-y: auto;
  flex-shrink: 0;
  scrollbar-gutter: stable;

  &::-webkit-scrollbar {
    width: 4px;
  }

  &::-webkit-scrollbar-thumb {
    background: rgba($text-muted, 0.3);
    border-radius: 4px;
  }

  &::-webkit-scrollbar-thumb:hover {
    background: rgba($text-muted, 0.5);
  }
}

.conversation-monitor__session {
  width: 100%;
  border: 0;
  border-bottom: 1px solid rgba($border-color, 0.6);
  background: transparent;
  color: inherit;
  text-align: start;
  padding: 12px 14px;
  cursor: pointer;

  &.active {
    background: rgba(var(--accent-primary-rgb), 0.12);
    color: $text-primary;
    font-weight: 500;
  }

  &.active .conversation-monitor__session-title {
    color: $accent-primary;
  }
}

.conversation-monitor__session-title-row,
.conversation-monitor__detail-meta,
.conversation-monitor__message-meta {
  display: flex;
  align-items: center;
  gap: 6px;
}

.conversation-monitor__session-title,
.conversation-monitor__detail-title {
  font-weight: 600;
}

.conversation-monitor__session-live {
  font-size: 11px;
  color: $accent-primary;
}

.conversation-monitor__session-meta,
.conversation-monitor__session-preview,
.conversation-monitor__detail-meta,
.conversation-monitor__message-meta {
  font-size: 12px;
  color: $text-muted;
}

.conversation-monitor__session-preview,
.conversation-monitor__message-content {
  margin-top: 6px;
  white-space: pre-wrap;
}

.conversation-monitor__detail {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.conversation-monitor__detail-header {
  padding: 16px 20px;
  border-bottom: 1px solid $border-color;
}

.conversation-monitor__messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.conversation-monitor__message {
  padding: 12px 14px;
  border-radius: 10px;
  background: rgba($bg-secondary, 0.8);

  &.role-user {
    border: 1px solid rgba($accent-primary, 0.18);
  }

  &.role-assistant {
    border: 1px solid rgba($border-color, 0.9);
  }
}

.conversation-monitor__empty {
  padding: 24px;
  color: $text-muted;
}

.conversation-monitor__empty--error {
  color: $error;
}

@media (max-width: $breakpoint-mobile) {
  .conversation-monitor {
    flex-direction: column;
  }

  .conversation-monitor__sidebar {
    width: 100%;
    max-height: 220px;
    border-inline-end: 0;
    border-bottom: 1px solid $border-color;
    flex-shrink: 0;
  }

  .conversation-monitor__detail {
    min-height: 0;
    overflow: hidden;
  }
}
</style>
