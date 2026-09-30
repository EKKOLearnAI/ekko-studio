<script setup lang="ts">
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchPerformanceRuntime, type PerformanceRuntimeSnapshot } from '@/api/studio/performance-monitor'

const { t } = useI18n()
const message = useMessage()
const snapshot = ref<PerformanceRuntimeSnapshot | null>(null)
const loading = ref(true)
const autoRefresh = ref(true)
let timer: ReturnType<typeof setInterval> | undefined

const brokerMemory = computed(() => snapshot.value?.bridge.broker.process?.memoryRssBytes ?? null)
const webRssMemory = computed(() => snapshot.value?.web.memory.rss ?? null)
const workerCount = computed(() => snapshot.value?.bridge.workers.length ?? 0)
const runningWorkerCount = computed(() => snapshot.value?.bridge.workers.filter(worker => worker.running).length ?? 0)

function formatBytes(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function formatPercent(value?: number | null): string {
  return value == null || !Number.isFinite(value) ? '-' : `${value.toFixed(1)}%`
}

function formatDuration(seconds?: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '-'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function formatTime(seconds?: number): string {
  if (!seconds) return '-'
  return new Date(seconds * 1000).toLocaleString()
}

function statusText(running: boolean): string {
  return running ? t('performance.running') : t('performance.stopped')
}

async function loadRuntime(showError = true) {
  loading.value = true
  try {
    snapshot.value = await fetchPerformanceRuntime()
  } catch (err: any) {
    if (showError) message.error(err?.message || t('performance.loadFailed'))
  } finally {
    loading.value = false
  }
}

function setAutoRefresh(enabled: boolean) {
  autoRefresh.value = enabled
  if (timer) {
    clearInterval(timer)
    timer = undefined
  }
  if (enabled) {
    timer = setInterval(() => loadRuntime(false), 5000)
  }
}

onMounted(() => {
  loadRuntime()
  setAutoRefresh(true)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <PageLoading :show="loading && !snapshot" class="performance-view">
    <PageHeader>
    <header class="page-header">
      <h2 class="header-title">{{ t('performance.title') }}</h2>
      <div class="header-actions">
        <NButton size="small" :type="autoRefresh ? 'primary' : 'default'" secondary @click="setAutoRefresh(!autoRefresh)">
          {{ autoRefresh ? t('performance.autoRefreshOn') : t('performance.autoRefreshOff') }}
        </NButton>
        <NButton size="small" :loading="loading" @click="loadRuntime()">{{ t('performance.refresh') }}</NButton>
      </div>
    </header>
    </PageHeader>

    <div class="performance-spin">
      <main v-if="snapshot" class="performance-content">
        <section class="summary-grid">
          <div class="summary-item">
            <span class="summary-label">{{ t('performance.systemCpu') }}</span>
            <strong>{{ formatPercent(snapshot.system.cpuPercent) }}</strong>
            <div class="meter"><span :style="{ width: `${snapshot.system.cpuPercent || 0}%` }" /></div>
          </div>
          <div class="summary-item">
            <span class="summary-label">{{ t('performance.systemMemory') }}</span>
            <strong>{{ formatPercent(snapshot.system.memoryPercent) }}</strong>
            <small>{{ formatBytes(snapshot.system.usedMemoryBytes) }} / {{ formatBytes(snapshot.system.totalMemoryBytes) }}</small>
            <div class="meter"><span :style="{ width: `${snapshot.system.memoryPercent || 0}%` }" /></div>
          </div>
          <div class="summary-item">
            <span class="summary-label">{{ t('performance.activeSessions') }}</span>
            <strong>{{ snapshot.sessions.active }}</strong>
            <small>{{ t('performance.runningSessions', { count: snapshot.sessions.running }) }}</small>
          </div>
          <div class="summary-item">
            <span class="summary-label">{{ t('performance.workers') }}</span>
            <strong>{{ runningWorkerCount }} / {{ workerCount }}</strong>
            <small>{{ t('performance.totalWorkerMemory') }} {{ formatBytes(snapshot.bridge.totalWorkerMemoryRssBytes) }}</small>
          </div>
        </section>

        <section class="runtime-section">
          <div class="section-header">
            <h3>{{ t('performance.processes') }}</h3>
            <span>{{ snapshot.system.platform }} {{ snapshot.system.arch }} · {{ snapshot.system.cpuCount }} CPU · {{ t('performance.uptime') }} {{ formatDuration(snapshot.system.uptimeSeconds) }}</span>
          </div>
          <div class="process-grid">
            <div class="process-row">
              <div>
                <strong>Web UI</strong>
                <span>PID {{ snapshot.web.pid }}</span>
              </div>
              <span>{{ formatPercent(snapshot.web.cpuPercent) }}</span>
              <span>{{ formatBytes(webRssMemory) }}</span>
              <span class="status running">{{ statusText(true) }}</span>
            </div>
            <div class="process-row">
              <div>
                <strong>Bridge Broker</strong>
                <span>{{ snapshot.bridge.endpoint }}</span>
              </div>
              <span>{{ formatPercent(snapshot.bridge.broker.process?.cpuPercent) }}</span>
              <span>{{ formatBytes(brokerMemory) }}</span>
              <span class="status" :class="{ running: snapshot.bridge.reachable && snapshot.bridge.broker.running }">
                {{ snapshot.bridge.reachable && snapshot.bridge.broker.running ? statusText(true) : statusText(false) }}
              </span>
            </div>
          </div>
          <div v-if="snapshot.bridge.error" class="runtime-error">{{ snapshot.bridge.error }}</div>
        </section>

        <section class="runtime-section">
          <div class="section-header">
            <h3>{{ t('performance.workerMemory') }}</h3>
            <span>{{ t('performance.lastUpdated') }} {{ new Date(snapshot.timestamp).toLocaleTimeString() }}</span>
          </div>
          <div class="worker-table-wrap">
            <table class="worker-table">
              <thead>
                <tr>
                  <th>{{ t('performance.profile') }}</th>
                  <th>PID</th>
                  <th>CPU</th>
                  <th>{{ t('performance.memory') }}</th>
                  <th>{{ t('performance.runningActiveSessions') }}</th>
                  <th>{{ t('performance.lastUsed') }}</th>
                  <th>{{ t('performance.status') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="snapshot.bridge.workers.length === 0">
                  <td colspan="7" class="empty-cell">{{ t('performance.noWorkers') }}</td>
                </tr>
                <tr v-for="worker in snapshot.bridge.workers" :key="worker.profile || worker.pid">
                  <td>{{ worker.profile || '-' }}</td>
                  <td>{{ worker.pid || '-' }}</td>
                  <td>{{ formatPercent(worker.cpuPercent) }}</td>
                  <td>{{ formatBytes(worker.memoryRssBytes) }}</td>
                  <td>{{ worker.runningSessionCount }} / {{ worker.sessionCount }}</td>
                  <td>{{ formatTime(worker.lastUsedAt) }}</td>
                  <td><span class="status" :class="{ running: worker.running }">{{ statusText(worker.running) }}</span></td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="runtime-section">
          <div class="section-header">
            <h3>{{ t('performance.sessionsByProfile') }}</h3>
          </div>
          <div class="session-list">
            <div v-if="Object.keys(snapshot.sessions.byProfile).length === 0" class="session-empty">
              {{ t('performance.noActiveSessions') }}
            </div>
            <div v-for="(count, profile) in snapshot.sessions.byProfile" :key="profile" class="session-row">
              <span>{{ profile }}</span>
              <strong>{{ count }}</strong>
            </div>
          </div>
        </section>
      </main>
    </div>
  </PageLoading>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.performance-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.performance-spin {
  flex: 1;
  min-height: 0;
}

.performance-content {
  height: 100%;
  overflow-y: auto;
  padding: 20px;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.summary-item,
.runtime-section {
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  background: $bg-card;
}

.summary-item {
  min-height: 108px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.summary-label,
.summary-item small,
.section-header span,
.process-row div span {
  color: $text-muted;
  font-size: 12px;
}

.summary-item strong {
  color: $text-primary;
  font-size: 24px;
  font-weight: 650;
}

.meter {
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: $bg-secondary;

  span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: $accent-primary;
  }
}

.runtime-section {
  margin-top: 12px;
  overflow: hidden;
}

.section-header {
  min-height: 46px;
  padding: 12px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid $border-light;

  h3 {
    margin: 0;
    color: $text-primary;
    font-size: 14px;
    font-weight: 600;
  }
}

.process-grid {
  display: grid;
  grid-template-columns: 1fr;
}

.process-row {
  min-height: 56px;
  padding: 10px 14px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 80px 110px 86px;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid $border-light;
  color: $text-secondary;
  font-size: 13px;

  &:last-child {
    border-bottom: 0;
  }

  div {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  strong {
    color: $text-primary;
    font-size: 13px;
  }

  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.status {
  width: fit-content;
  max-width: 100%;
  padding: 2px 8px;
  border: 1px solid $border-color;
  border-radius: 999px;
  color: $text-muted;
  font-size: 12px;

  &.running {
    border-color: rgba(var(--success-rgb), 0.35);
    color: $success;
    background: rgba(var(--success-rgb), 0.08);
  }
}

.runtime-error {
  padding: 10px 14px;
  border-top: 1px solid $border-light;
  color: $error;
  font-size: 12px;
}

.worker-table-wrap {
  overflow-x: auto;
}

.worker-table {
  width: 100%;
  min-width: 760px;
  border-collapse: collapse;
  color: $text-secondary;
  font-size: 13px;

  th,
  td {
    padding: 11px 14px;
    border-bottom: 1px solid $border-light;
    text-align: start;
    white-space: nowrap;
  }

  th {
    color: $text-muted;
    font-size: 12px;
    font-weight: 600;
  }

  td:first-child {
    color: $text-primary;
    font-weight: 600;
  }

  tr:last-child td {
    border-bottom: 0;
  }
}

.empty-cell,
.session-empty {
  color: $text-muted;
  text-align: center;
}

.session-list {
  padding: 6px 14px;
}

.session-row {
  min-height: 34px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid $border-light;
  color: $text-secondary;
  font-size: 13px;

  &:last-child {
    border-bottom: 0;
  }

  strong {
    color: $text-primary;
  }
}

.session-empty {
  padding: 18px 0;
  font-size: 13px;
}

@media (max-width: 960px) {
  .summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: $breakpoint-mobile) {
  .page-header,
  .header-actions,
  .section-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .page-header {
    position: sticky;
    top: 0;
    z-index: 20;
    background: $bg-primary;
  }

  .header-actions {
    width: 100%;
  }

  .summary-grid {
    grid-template-columns: 1fr;
  }

  .process-row {
    grid-template-columns: 1fr 72px;

    > span:nth-child(3),
    > span:nth-child(4) {
      justify-self: start;
    }
  }
}
</style>
