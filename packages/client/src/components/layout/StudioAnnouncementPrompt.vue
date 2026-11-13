<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, NCard, NModal } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchStudioAnnouncements, type StudioAnnouncement } from '@/api/studio/announcements'
import { openUrlInDesktopBrowser } from '@/utils/desktop-browser'

const STORAGE_KEY = 'hermes-studio:seen-announcements:v1'
const { t, locale } = useI18n()
const announcement = ref<StudioAnnouncement | null>(null)
const seen = new Map<number, number>()
let mounted = false
let checking = false

const actionUrl = computed(() => {
  try {
    const url = new URL(announcement.value?.actionUrl || '')
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
})

function restoreSeen() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    if (stored.version !== 1 || !stored.entries || typeof stored.entries !== 'object') return
    for (const [id, time] of Object.entries(stored.entries)) {
      if (Number.isSafeInteger(Number(id)) && Number(id) > 0
        && Number.isSafeInteger(Number(time)) && Number(time) > 0) {
        seen.set(Number(id), Math.max(seen.get(Number(id)) || 0, Number(time)))
      }
    }
  } catch {
    // Keep in-memory deduplication when storage is unavailable.
  }
}

function isPageVisible() {
  return document.visibilityState !== 'hidden'
}

async function checkAnnouncements() {
  if (!mounted || checking || announcement.value || !isPageVisible()) return
  checking = true
  try {
    const response = await fetchStudioAnnouncements(locale.value)
    if (!mounted || !isPageVisible() || response.ok !== true || response.platform !== 'desktop') return
    // Select the latest before checking read state: never drain older notices.
    const latest = Array.isArray(response.list) ? response.list[0] : null
    if (!latest || !Number.isSafeInteger(latest.id) || latest.id <= 0
      || !Number.isSafeInteger(latest.updateTime) || latest.updateTime <= 0
      || typeof latest.title !== 'string' || !latest.title.trim()
      || typeof latest.content !== 'string' || !latest.content.trim()) return
    restoreSeen()
    if ((seen.get(latest.id) || 0) >= latest.updateTime) return
    announcement.value = latest
  } catch {
    // Announcements are optional; network failures must not interrupt Studio.
  } finally {
    checking = false
  }
}

function dismiss() {
  const current = announcement.value
  if (!current) return
  restoreSeen()
  seen.set(current.id, current.updateTime)
  try {
    const entries = Object.fromEntries([...seen].sort((a, b) => b[1] - a[1]).slice(0, 200))
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, entries }))
  } catch {
    // The in-memory marker still prevents repeated prompts in this page.
  }
  announcement.value = null
}

function confirm() {
  const url = actionUrl.value
  if (url) {
    void openUrlInDesktopBrowser(url).then(opened => {
      if (!opened) window.open(url, '_blank', 'noopener,noreferrer')
    }).catch(() => undefined)
  }
  dismiss()
}

onMounted(() => {
  mounted = true
  void checkAnnouncements()
  window.addEventListener('focus', checkAnnouncements)
  document.addEventListener('visibilitychange', checkAnnouncements)
})

onBeforeUnmount(() => {
  mounted = false
  window.removeEventListener('focus', checkAnnouncements)
  document.removeEventListener('visibilitychange', checkAnnouncements)
})
</script>

<template>
  <NModal v-if="announcement" :show="true" :mask-closable="false" :close-on-esc="false">
    <NCard
      data-testid="studio-announcement"
      role="dialog"
      aria-modal="true"
      :aria-label="announcement.title"
      :title="announcement.title"
      :bordered="false"
      style="width: min(520px, calc(100vw - 32px))"
    >
      <div class="announcement-content">{{ announcement.content }}</div>
      <template #footer>
        <div class="actions">
          <NButton v-if="actionUrl && announcement.dismissible" @click="dismiss">
            {{ t('announcements.later') }}
          </NButton>
          <NButton type="primary" @click="confirm">
            {{ t(actionUrl ? 'announcements.details' : 'announcements.gotIt') }}
          </NButton>
        </div>
      </template>
    </NCard>
  </NModal>
</template>

<style scoped lang="scss">
.announcement-content {
  max-height: min(50vh, 480px);
  overflow-y: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: var(--line-height, 1.7);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: calc(10px * var(--spacing-scale, 1));
}
</style>
