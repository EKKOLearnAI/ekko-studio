<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NInput, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import BrowserDownloadRow from './BrowserDownloadRow.vue'
import { desktopBridge, type DesktopBrowserDownload, type DesktopBrowserState } from '@/utils/desktop-bridge'
const props = defineProps<{ items: DesktopBrowserDownload[] }>()
const emit = defineEmits<{ state: [value: DesktopBrowserState] }>()
const { t, locale } = useI18n()
const message = useMessage()
const search = ref('')
const clearing = ref(false)
const bridge = desktopBridge()?.browser
const removable = computed(() => props.items.filter(item => item.state !== 'progressing'))
const groups = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  const dates = new Map<string, DesktopBrowserDownload[]>()
  const items = props.items.filter(item => !query || `${item.fileName} ${item.sourceUrl}`.toLocaleLowerCase().includes(query))
    .slice().sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
  for (const item of items) {
    const date = new Date(item.startedAt)
    const key = Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
    const group = dates.get(key) || []; group.push(item); dates.set(key, group)
  }
  return [...dates].map(([key, items]) => ({ key, items, title: dateLabel(items[0].startedAt) }))
})
function dateLabel(value: string) {
  const date = new Date(value), today = new Date(), yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  if (Number.isNaN(date.getTime())) return t('browser.downloads')
  if (date.toDateString() === today.toDateString()) return t('browser.downloadToday')
  if (date.toDateString() === yesterday.toDateString()) return t('browser.downloadYesterday')
  return new Intl.DateTimeFormat(locale.value, { year: 'numeric', month: 'long', day: 'numeric' }).format(date)
}
async function clearHistory() {
  if (clearing.value || !bridge?.downloadAction) return
  clearing.value = true
  // Only this profile's settled records, independent of search. Never cancel transfers or delete files.
  const ids = removable.value.map(item => item.id)
  try {
    for (const id of ids) emit('state', await bridge.downloadAction(id, 'remove'))
  } catch { message.error(t('browser.downloadActionFailed')) }
  finally { clearing.value = false }
}
</script>
<template>
  <section class="download-history" data-testid="download-history">
    <header class="history-toolbar">
      <NInput v-model:value="search" clearable :placeholder="t('browser.searchDownloads')" :aria-label="t('browser.searchDownloads')" />
      <NButton round :disabled="clearing || !removable.length || !bridge?.downloadAction" :loading="clearing" :title="t('browser.clearDownloadsHint')" @click="clearHistory">{{ t('browser.clearDownloads') }}</NButton>
    </header>
    <p class="history-hint">{{ t('browser.clearDownloadsHint') }}</p>
    <div class="history-groups">
      <p v-if="!groups.length" class="history-empty">{{ search ? t('browser.noMatchingDownloads') : t('common.noData') }}</p>
      <section v-for="group in groups" :key="group.key" class="download-date-group">
        <h3>{{ group.title }}</h3>
        <div v-for="item in group.items" :key="item.id" class="download-history-card" data-theme-surface="card">
          <BrowserDownloadRow :item="item" @state="emit('state', $event)" />
        </div>
      </section>
    </div>
  </section>
</template>
<style scoped lang="scss">
.download-history { width: 100%; min-width: 0; }
.history-toolbar { display: flex; align-items: center; gap: 16px; max-width: 820px; margin: 0 auto; }
.history-toolbar .n-input { flex: 1; min-width: 0; }
.history-hint { max-width: 820px; margin: 10px auto 26px; color: var(--text-secondary); font-size: 12px; }
.history-groups { max-width: 820px; margin: 0 auto; }
.download-date-group { margin-bottom: 30px; }
.download-date-group h3 { margin: 0 0 14px; font-size: var(--font-size-base, 14px); font-weight: 500; color: var(--text-secondary); }
.download-history-card { margin-bottom: 10px; background: var(--bg-card); border: var(--border-width, 1px) solid var(--border-color); border-radius: var(--radius-component, 10px); }
.history-empty { text-align: center; padding: 48px 0; color: var(--text-secondary); }
@media (max-width: 500px) { .history-toolbar { gap: 8px; flex-wrap: wrap; } }
</style>
