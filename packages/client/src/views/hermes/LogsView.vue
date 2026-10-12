<script setup lang="ts">
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { NSelect, NButton, NPopover, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchLogFiles, fetchLogs, type LogEntry } from '@/api/studio/logs'

const { t } = useI18n()
const message = useMessage()
const logFiles = ref<{ name: string; size: string; modified: string }[]>([])
const selectedLog = ref('agent')
const entries = ref<LogEntry[]>([])
const loading = ref(false)
const initializing = ref(true)
const pageLoading = computed(() => initializing.value || loading.value)
let loadId = 0
let disposed = false
const lineCount = ref(100)
const levelFilter = ref<string>('')
const searchQuery = ref('')

function displayLogName(name: string): string {
  return name.replace(/^ekko-agent(?=\/|$)/, 'Ekko')
}

const logOptions = computed(() =>
  logFiles.value.map(f => ({ label: `${displayLogName(f.name)} (${f.size})`, value: f.name })),
)

const levelOptions = computed(() => [
  { label: t('logs.all'), value: '' },
  { label: 'ERROR', value: 'ERROR' },
  { label: 'WARNING', value: 'WARNING' },
  { label: 'INFO', value: 'INFO' },
  { label: 'DEBUG', value: 'DEBUG' },
])

const lineOptions = [
  { label: '50', value: 50 },
  { label: '100', value: 100 },
  { label: '200', value: 200 },
  { label: '500', value: 500 },
]

const filteredEntries = computed(() => {
  if (!searchQuery.value) return entries.value
  const q = searchQuery.value.toLowerCase()
  return entries.value.filter(e =>
    e.message.toLowerCase().includes(q) ||
    e.logger.toLowerCase().includes(q) ||
    (e.raw || '').toLowerCase().includes(q),
  )
})

function levelClass(level: string): string {
  switch (level) {
    case 'ERROR': return 'level-error'
    case 'WARNING': return 'level-warning'
    case 'DEBUG': return 'level-debug'
    default: return 'level-info'
  }
}

function formatTime(ts: string): string {
  const match = ts.match(/\d{2}:\d{2}:\d{2}/)
  return match ? match[0] : ts
}

function parseAccessLog(msg: string) {
  const match = msg.match(/"(\w+)\s+(\S+)\s+HTTP\/[^"]+"\s+(\d+)/)
  if (match) return { method: match[1], path: match[2], status: match[3] }
  return null
}

async function loadLogs() {
  if (!selectedLog.value || disposed) return
  const currentLoad = ++loadId
  loading.value = true
  try {
    const data = await fetchLogs(selectedLog.value, {
      lines: lineCount.value,
      level: levelFilter.value || undefined,
      text: selectedLog.value === 'ekko-agent' ? searchQuery.value || undefined : undefined,
    })
    if (currentLoad === loadId) entries.value = data.filter((e): e is LogEntry => e !== null)
  } catch (e: any) {
    if (currentLoad === loadId) message.error(e.message)
  } finally {
    if (currentLoad === loadId) loading.value = false
  }
}

onMounted(async () => {
  try {
    const files = await fetchLogFiles()
    if (disposed) return
    logFiles.value = files
    if (!logFiles.value.some(file => file.name === selectedLog.value)) {
      selectedLog.value = logFiles.value.find(file => file.name === 'webui')?.name
        || logFiles.value.find(file => file.name === 'ekko-agent')?.name
        || logFiles.value[0]?.name
        || ''
    }
    await loadLogs()
  } catch (e: any) {
    if (!disposed) message.error(e.message)
  } finally {
    initializing.value = false
  }
})

onUnmounted(() => {
  disposed = true
  loadId++
})
</script>

<template>
  <PageLoading :show="pageLoading" class="logs-view">
    <PageHeader>
    <header class="page-header logs-page-header">
      <h2 class="header-title">{{ t('logs.title') }}</h2>
      <div class="header-actions">
        <NSelect
          v-model:value="selectedLog"
          :options="logOptions"
          :disabled="initializing || logFiles.length === 0"
          size="small"
          class="logs-file-select"
          :aria-label="t('logs.file')"
          @update:value="loadLogs"
        />
        <NSelect
          :value="levelFilter"
          :options="levelOptions"
          :disabled="initializing || !selectedLog"
          size="small"
          class="logs-level-select logs-inline-filter"
          :aria-label="t('logs.level')"
          @update:value="(v: string) => { levelFilter = v; loadLogs() }"
        />
        <NSelect
          :value="lineCount"
          :options="lineOptions"
          :disabled="initializing || !selectedLog"
          size="small"
          class="logs-lines-select logs-inline-filter"
          :aria-label="t('logs.lines')"
          @update:value="(v: number) => { lineCount = v; loadLogs() }"
        />
        <input
          v-model="searchQuery"
          class="search-input logs-inline-filter"
          :placeholder="t('logs.searchPlaceholder')"
          :disabled="initializing || !selectedLog"
          @keyup.enter="loadLogs"
        />
        <NPopover trigger="click" placement="bottom-end">
          <template #trigger>
            <NButton class="logs-filter-toggle" size="small" :disabled="initializing || !selectedLog" :title="t('logs.filters')" :aria-label="t('logs.filters')">
              <template #icon>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M7 12h10M10 17h4" /></svg>
              </template>
            </NButton>
          </template>
          <div class="logs-filter-popover">
            <label>
              <span>{{ t('logs.level') }}</span>
              <NSelect :value="levelFilter" :options="levelOptions" size="small" :aria-label="t('logs.level')" @update:value="(v: string) => { levelFilter = v; loadLogs() }" />
            </label>
            <label>
              <span>{{ t('logs.lines') }}</span>
              <NSelect :value="lineCount" :options="lineOptions" size="small" :aria-label="t('logs.lines')" @update:value="(v: number) => { lineCount = v; loadLogs() }" />
            </label>
            <input v-model="searchQuery" class="search-input" :placeholder="t('logs.searchPlaceholder')" @keyup.enter="loadLogs" />
          </div>
        </NPopover>
        <NButton class="logs-refresh" size="small" :loading="loading" :disabled="initializing || !selectedLog" :title="t('logs.refresh')" :aria-label="t('logs.refresh')" @click="loadLogs">
          <template #icon>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 11-2l3 3M4 16l3 3a7 7 0 0 0 11-2"/></svg>
          </template>
          <span>{{ t('logs.refresh') }}</span>
        </NButton>
      </div>
    </header>
    </PageHeader>

    <div class="logs-body">
      <div v-if="filteredEntries.length === 0 && !pageLoading" class="logs-empty">
        {{ t('logs.noEntries') }}
      </div>
      <div v-else class="log-list">
        <div
          v-for="(entry, idx) in filteredEntries"
          :key="idx"
          class="log-entry"
          :class="levelClass(entry.level)"
        >
          <span class="log-time">{{ formatTime(entry.timestamp) }}</span>
          <span class="log-level" :class="levelClass(entry.level)">{{ entry.level }}</span>
          <span class="log-logger">{{ displayLogName(entry.logger) }}</span>
          <template v-if="parseAccessLog(entry.message)">
            <span class="access-method">{{ parseAccessLog(entry.message)!.method }}</span>
            <span class="access-path">{{ parseAccessLog(entry.message)!.path }}</span>
            <span class="access-status" :class="'status-' + (parseAccessLog(entry.message)!.status?.[0] || 'x')">
              {{ parseAccessLog(entry.message)!.status }}
            </span>
          </template>
          <span v-else class="log-message">{{ entry.message }}</span>
        </div>
      </div>
    </div>
  </PageLoading>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.logs-view {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.logs-page-header {
  --header-actions-shrink: 1;
  container: studio-page-header / inline-size;
  gap: 12px;
  flex-wrap: wrap;

  .header-title { flex-shrink: 0; }
}

.logs-page-header .header-actions {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  max-width: 680px;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.logs-file-select {
  flex: 1 1 200px;
  width: 0;
  min-width: 96px;
  max-width: 200px;
}

.logs-level-select,
.logs-lines-select {
  flex: 0 1 90px;
  width: 90px;
  min-width: 64px;
}

.logs-lines-select { min-width: 54px; }
.logs-filter-toggle { display: none; }

.search-input {
  box-sizing: border-box;
  flex: 1 1 160px;
  min-width: 72px;
  max-width: 160px;
  padding: 4px 10px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  background: $bg-input;
  color: $text-primary;
  font-size: 13px;
  outline: none;
  width: 160px;
  transition: border-color $transition-fast;

  &:focus { border-color: $accent-primary; }
  &::placeholder { color: $text-muted; }
}

.logs-filter-popover {
  display: grid;
  gap: 12px;
  width: min(260px, calc(100vw - 48px));

  label { display: grid; gap: 4px; }
  .search-input { width: 100%; max-width: none; }
}

@media (min-width: 769px) {
  .logs-page-header { flex: 1; }

  @container studio-page-header (max-width: 540px) {
    .logs-inline-filter { display: none; }
    .logs-filter-toggle { display: inline-flex; }
    .logs-file-select { min-width: 0; }
    .logs-refresh {
      padding-inline: 6px;
      :deep(.n-button__content) { display: none; }
      :deep(.n-button__icon) { margin: 0; }
    }
  }
}

@media (max-width: $breakpoint-mobile) {
  .logs-page-header .header-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    flex-basis: 100%;
    max-width: none;
  }

  .logs-file-select { grid-column: 1 / -1; }
  .logs-file-select,
  .logs-level-select,
  .logs-lines-select,
  .search-input { width: 100%; min-width: 0; max-width: none; }
}

.logs-body {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.logs-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: $text-muted;
  font-size: 13px;
}

.log-list {
  padding: 4px 0;
  min-height: 100%;
}

.log-entry {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 20px;
  font-family: $font-code;
  font-size: 12px;
  line-height: 1.6;
  border-inline-start: 2px solid transparent;

  &:hover {
    background-color: rgba(var(--accent-primary-rgb), 0.03);
  }

  &.level-error {
    border-inline-start-color: $error;
    .log-message { color: $error; }
  }

  &.level-warning {
    border-inline-start-color: $warning;
    .log-message { color: $warning; }
  }
}

.log-time {
  color: $text-muted;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.log-level {
  flex-shrink: 0;
  font-weight: 600;
  font-size: 10px;
  padding: 0 4px;
  border-radius: 2px;
  min-width: 42px;
  text-align: center;

  &.level-error { background: rgba(var(--error-rgb), 0.12); color: $error; }
  &.level-warning { background: rgba(var(--warning-rgb), 0.12); color: $warning; }
  &.level-debug { background: rgba(var(--accent-primary-rgb), 0.06); color: $text-muted; }
  &.level-info { background: rgba(var(--accent-primary-rgb), 0.06); color: $text-muted; }
}

.log-logger {
  color: $text-muted;
  flex-shrink: 0;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-message {
  color: $text-secondary;
  overflow: visible;
  white-space: normal;
  word-break: break-word;
  min-width: 0;
}

.access-method {
  font-weight: 600;
  color: $text-primary;
  flex-shrink: 0;
}

.access-path {
  color: $accent-primary;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.access-status {
  font-weight: 600;
  flex-shrink: 0;
  font-size: 11px;

  &.status-2 { color: $success; }
  &.status-3 { color: $warning; }
  &.status-4 { color: $error; }
  &.status-5 { color: $error; }
}
</style>
