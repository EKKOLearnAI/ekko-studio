<script setup lang="ts">
import { NSpin, NAlert, NButton, NDrawer, NDrawerContent, NPopconfirm, NProgress, NTag, useMessage } from 'naive-ui'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import {
  activateRuntimeVersion,
  deleteRuntimeVersion,
  downloadRuntimeVersion,
  fetchRuntimeVersionStatus,
  fetchVersionDownloadJobs,
  selectRuntimeRoot,
  type InstalledRuntimeVersion,
  type RuntimeVersionStatus,
  type VersionDownloadJob,
  type VersionDownloadJobStatus,
  type VersionDownloadKind,
  type VersionDownloadSource,
} from '@/api/hermes/runtime-versions'
import HermesDataDirectoryHint from '@/components/hermes/HermesDataDirectoryHint.vue'
import { useRuntimeRestartPrompt } from '@/composables/useRuntimeRestartPrompt'
import { desktopBridge } from '@/utils/desktop-bridge'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (event: 'update:show', value: boolean): void }>()

const { t } = useI18n()
const message = useMessage()
const { requestRuntimeRestart, checkRuntimeDownloads } = useRuntimeRestartPrompt()

const status = ref<RuntimeVersionStatus | null>(null)
const jobs = ref<VersionDownloadJob[]>([])
const loading = ref(false)
const actionLoading = ref<Record<string, boolean>>({})
const loadError = ref('')
const cliDetailsShow = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null

const canSelectRuntimeDirectory = computed(() => typeof desktopBridge()?.selectRuntimeDirectory === 'function')
const isDefaultRuntimeDirectory = computed(() => {
  const defaultDirectory = status.value?.hermes.defaultStorageDirectory
  const selectedDirectory = status.value?.hermes.pendingStorageDirectory || status.value?.hermes.storageDirectory
  return !defaultDirectory || selectedDirectory === defaultDirectory
})

const currentHermesSource = computed(() =>
  status.value?.hermes.source
  || status.value?.hermes.cliInstallations?.find(item => item.selected)?.source
  || 'none',
)

const currentPlatformRuntime = computed(() =>
  (status.value?.hermes.installed || []).filter(item => item.platform === status.value?.platform),
)

const runtimeVersions = computed(() => uniqueVersions([
  ...(status.value?.hermes.remoteVersions || []),
  ...currentPlatformRuntime.value.map(item => item.version),
  ...(status.value?.active?.runtimeValidationFailures || [])
    .filter(failure => failure.platform === status.value?.platform)
    .map(failure => failure.version),
]))

const runtimeJobs = computed(() => jobs.value.filter(job => job.kind === 'runtime'))

watch(() => props.show, show => {
  if (show) {
    void loadAll()
  } else {
    cliDetailsShow.value = false
    stopPolling()
  }
})

onBeforeUnmount(() => {
  stopPolling()
})

function updateShow(show: boolean) {
  emit('update:show', show)
}

function uniqueVersions(values: string[]): string[] {
  return Array.from(new Set(values.map(item => item.trim().replace(/^v/, '')).filter(Boolean)))
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
}

async function loadAll() {
  loading.value = true
  loadError.value = ''
  try {
    await Promise.all([loadStatus(), loadJobs()])
    checkRuntimeDownloads()
    if (hasRunningJobs()) startPolling()
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

async function loadStatus() {
  status.value = await fetchRuntimeVersionStatus()
}

async function loadJobs() {
  const nextJobs = await fetchVersionDownloadJobs()
  jobs.value = nextJobs.jobs
}

async function refreshJobs() {
  try {
    const hadRunning = hasRunningJobs()
    await loadJobs()
    if (hadRunning && !hasRunningJobs()) {
      stopPolling()
      await loadStatus()
    } else if (!hasRunningJobs()) {
      stopPolling()
    }
  } catch {
    stopPolling()
  }
}

function startPolling() {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    void refreshJobs()
  }, 2000)
}

function stopPolling() {
  if (!pollTimer) return
  clearInterval(pollTimer)
  pollTimer = null
}

function hasRunningJobs(): boolean {
  return runtimeJobs.value.some(job => job.status === 'queued' || job.status === 'running')
}

function runtimeFor(version: string): InstalledRuntimeVersion | undefined {
  return currentPlatformRuntime.value.find(item => item.version === version)
}

function activeJob(kind: VersionDownloadKind, version: string): VersionDownloadJob | undefined {
  return jobs.value.find(job =>
    job.kind === kind &&
    job.version === version.replace(/^v/, '') &&
    (job.status === 'queued' || job.status === 'running'),
  )
}

function jobType(statusValue: VersionDownloadJobStatus): 'default' | 'info' | 'success' | 'error' | 'warning' {
  if (statusValue === 'completed') return 'success'
  if (statusValue === 'failed') return 'error'
  if (statusValue === 'running') return 'info'
  return 'warning'
}

function jobLabel(job: VersionDownloadJob): string {
  if (job.status === 'completed' || job.status === 'failed') {
    return t(`runtimeVersions.jobStatus.${job.status}`)
  }
  return t(`runtimeVersions.jobStageStatus.${job.stage}`)
}

function messageText(message: string): string {
  return message.startsWith('runtimeVersions.') ? t(message) : message
}

function setActionLoading(key: string, value: boolean) {
  actionLoading.value = { ...actionLoading.value, [key]: value }
}

async function runAction(key: string, action: () => Promise<void>) {
  setActionLoading(key, true)
  try {
    await action()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    setActionLoading(key, false)
  }
}

function sourceLabel(source: VersionDownloadSource): string {
  return source === 'github' ? t('runtimeVersions.github') : t('runtimeVersions.cf')
}

function formatBytes(value?: number): string {
  if (!value || value <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`
}

function displayHermesAgentVersion(value?: string): string {
  return value?.split('·')[0]?.trim() || '-'
}

function jobProgressText(job: VersionDownloadJob): string {
  if (job.receivedBytes && job.totalBytes) {
    return `${formatBytes(job.receivedBytes)} / ${formatBytes(job.totalBytes)}`
  }
  if (job.receivedBytes) return formatBytes(job.receivedBytes)
  return messageText(job.message)
}

async function startRuntimeDownload(version: string, source: VersionDownloadSource) {
  await runAction(`download-runtime-${source}-${version}`, async () => {
    const response = await downloadRuntimeVersion(version, source)
    jobs.value = [response.job, ...jobs.value.filter(job => job.id !== response.job.id)]
    checkRuntimeDownloads()
    message.success(t('runtimeVersions.downloadStarted'))
    startPolling()
  })
}

async function useRuntime(version: string) {
  await runAction(`activate-runtime-${version}`, async () => {
    await activateRuntimeVersion(version)
    message.success(t('runtimeVersions.activateSuccess'))
    requestRuntimeRestart(version)
  })
}

async function chooseRuntimeDirectory() {
  const selectDirectory = desktopBridge()?.selectRuntimeDirectory
  if (!selectDirectory) return

  await runAction('select-runtime-directory', async () => {
    const directory = await selectDirectory(
      status.value?.hermes.pendingStorageDirectory || status.value?.hermes.storageDirectory || undefined,
    )
    if (!directory) return
    await selectRuntimeRoot(directory)
    message.success(t('runtimeVersions.runtimeDirectorySaved'))
    await loadAll()
  })
}

async function resetRuntimeDirectory() {
  const directory = status.value?.hermes.defaultStorageDirectory
  if (!directory) return

  await runAction('reset-runtime-directory', async () => {
    await selectRuntimeRoot(directory)
    message.success(t('runtimeVersions.runtimeDirectorySaved'))
    await loadAll()
  })
}

async function removeRuntime(version: string) {
  await runAction(`delete-runtime-${version}`, async () => {
    await deleteRuntimeVersion(version)
    message.success(t('runtimeVersions.deleteRuntimeSuccess'))
    await loadAll()
  })
}

</script>

<template>
  <NDrawer
    :show="props.show"
    placement="right"
    :width="'min(860px, calc(100vw - 24px))'"
    @update:show="updateShow"
  >
    <NDrawerContent :title="t('runtimeVersions.title')" closable>
      <NSpin :show="loading">
        <div class="version-management">
          <NAlert v-if="loadError" type="error" :bordered="false">
            {{ loadError }}
          </NAlert>
          <NAlert v-if="status?.remoteError" type="warning" :bordered="false">
            {{ t('runtimeVersions.remoteLoadFailed') }}: {{ status.remoteError }}
          </NAlert>

        <section class="version-section">
          <div class="section-heading">
            <div>
              <h3>{{ t('runtimeVersions.runtimeTitle') }}</h3>
              <p>{{ t('runtimeVersions.platform') }}: {{ status?.platform || '-' }}</p>
            </div>
            <div class="section-heading-actions">
              <NButton
                v-if="currentHermesSource === 'user-cli'"
                data-testid="view-cli-details"
                size="small"
                secondary
                @click="cliDetailsShow = true"
              >
                {{ t('runtimeVersions.viewCliDetails') }}
              </NButton>
              <NButton size="small" secondary @click="loadAll">{{ t('runtimeVersions.refresh') }}</NButton>
            </div>
          </div>
          <div class="active-path stacked">
            <span
              data-testid="active-hermes-agent-version"
              :title="status?.hermes.agentVersion || ''"
            >
              {{ t('runtimeVersions.currentHermesAgentVersion') }}: {{ displayHermesAgentVersion(status?.hermes.agentVersion) }}
            </span>
            <span
              data-testid="active-runtime-directory"
              :title="status?.hermes.activeDirectory || ''"
            >
              {{ t('runtimeVersions.activeRuntimeDirectory') }}: {{ status?.hermes.activeDirectory || '-' }}
            </span>
            <span
              v-if="currentHermesSource !== 'user-cli'"
              data-testid="active-python-path"
              :title="status?.hermes.pythonPath || ''"
            >
              {{ t('runtimeVersions.activePythonPath') }}: {{ status?.hermes.pythonPath || '-' }}
            </span>
            <span
              v-if="currentHermesSource !== 'user-cli'"
              data-testid="active-agent-root"
              :title="status?.hermes.agentRoot || ''"
            >
              {{ t('runtimeVersions.activeAgentRoot') }}: {{ status?.hermes.agentRoot || '-' }}
            </span>
            <span
              v-if="currentHermesSource === 'managed-runtime'"
              data-testid="active-data-directory"
              :title="status?.hermes.dataDirectory || ''"
            >
              {{ t('runtimeVersions.activeDataDirectory') }}: {{ status?.hermes.dataDirectory || '-' }}
            </span>
          </div>
          <HermesDataDirectoryHint v-if="currentHermesSource === 'managed-runtime'" />
          <NAlert
            data-testid="runtime-cli-update-note"
            type="info"
            :bordered="false"
          >
            <div class="runtime-update-note">
              <span>{{ t('runtimeVersions.cliUpdateDescription') }}</span>
              <code>ekko-studio cli update</code>
            </div>
          </NAlert>
          <div class="runtime-directory-control">
            <div class="runtime-directory-value">
              <strong>{{ t('runtimeVersions.runtimeDirectory') }}</strong>
              <span :title="status?.hermes.storageDirectory || ''">
                {{ status?.hermes.storageDirectory || '-' }}
              </span>
            </div>
            <div v-if="canSelectRuntimeDirectory" class="runtime-directory-actions">
              <NButton
                data-testid="select-runtime-directory"
                size="small"
                secondary
                :loading="actionLoading['select-runtime-directory']"
                @click="chooseRuntimeDirectory"
              >
                {{ t('runtimeVersions.chooseRuntimeDirectory') }}
              </NButton>
              <NButton
                data-testid="reset-runtime-directory"
                size="small"
                secondary
                :disabled="isDefaultRuntimeDirectory"
                :loading="actionLoading['reset-runtime-directory']"
                @click="resetRuntimeDirectory"
              >
                {{ t('runtimeVersions.resetRuntimeDirectory') }}
              </NButton>
            </div>
          </div>
          <p v-if="canSelectRuntimeDirectory" class="runtime-directory-hint">
            {{ t('runtimeVersions.runtimeDirectoryHint') }}
          </p>
          <NAlert v-if="status?.hermes.pendingStorageDirectory" type="info" :bordered="false">
            {{ t('runtimeVersions.runtimeMigrationPending', { directory: status.hermes.pendingStorageDirectory }) }}
          </NAlert>
          <NAlert v-if="status?.hermes.migrationError" type="error" :bordered="false">
            {{ t('runtimeVersions.runtimeMigrationFailed') }}: {{ status.hermes.migrationError }}
          </NAlert>
          <NAlert
            v-if="status?.hermes.activationError"
            data-testid="runtime-activation-error"
            type="error"
            :bordered="false"
          >
            {{ t('runtimeVersions.runtimeActivationFailed') }}: {{ status.hermes.activationError }}
          </NAlert>
          <div class="version-list">
            <div v-for="version in runtimeVersions" :key="`runtime-${version}`" class="version-row">
              <div class="version-main">
                <strong>{{ version }}</strong>
                <NTag v-if="runtimeFor(version)?.active" size="small" type="success" :bordered="false">
                  {{ t('runtimeVersions.active') }}
                </NTag>
                <NTag v-else-if="runtimeFor(version)" size="small" :bordered="false">
                  {{ t('runtimeVersions.installed') }}
                </NTag>
                <NTag v-if="activeJob('runtime', version)" size="small" :type="jobType(activeJob('runtime', version)!.status)" :bordered="false">
                  {{ jobLabel(activeJob('runtime', version)!) }}
                </NTag>
              </div>
              <div class="version-actions">
                <NButton
                  v-if="runtimeFor(version) && !runtimeFor(version)?.active"
                  size="small"
                  secondary
                  :loading="actionLoading[`activate-runtime-${version}`]"
                  @click="useRuntime(version)"
                >
                  {{ t('runtimeVersions.useVersion') }}
                </NButton>
                <NPopconfirm
                  v-if="runtimeFor(version) && !runtimeFor(version)?.active"
                  @positive-click="removeRuntime(version)"
                >
                  <template #trigger>
                    <NButton
                      size="small"
                      type="error"
                      secondary
                      :loading="actionLoading[`delete-runtime-${version}`]"
                    >
                      {{ t('runtimeVersions.deleteVersion') }}
                    </NButton>
                  </template>
                  {{ t('runtimeVersions.deleteRuntimeConfirm', { version }) }}
                </NPopconfirm>
                <NButton
                  v-if="!runtimeFor(version)"
                  size="small"
                  type="primary"
                  secondary
                  :disabled="!!activeJob('runtime', version)"
                  :loading="actionLoading[`download-runtime-github-${version}`]"
                  @click="startRuntimeDownload(version, 'github')"
                >
                  {{ t('runtimeVersions.downloadGithub') }}
                </NButton>
                <NButton
                  v-if="!runtimeFor(version)"
                  size="small"
                  type="primary"
                  secondary
                  :disabled="!!activeJob('runtime', version)"
                  :loading="actionLoading[`download-runtime-cf-${version}`]"
                  @click="startRuntimeDownload(version, 'cf')"
                >
                  {{ t('runtimeVersions.downloadCf') }}
                </NButton>
              </div>
            </div>
            <div v-if="runtimeVersions.length === 0" class="empty-row">{{ t('runtimeVersions.noVersions') }}</div>
          </div>
        </section>

        <section class="version-section" v-if="runtimeJobs.length > 0">
          <div class="section-heading compact">
            <h3>{{ t('runtimeVersions.downloadTasks') }}</h3>
          </div>
          <div class="job-list">
            <div v-for="job in runtimeJobs.slice(0, 6)" :key="job.id" class="job-row">
              <div class="job-main">
                <span>{{ t('runtimeVersions.runtimeTitle') }} {{ job.version }} · {{ sourceLabel(job.source) }}</span>
                <div v-if="job.status === 'running' || job.status === 'queued'" class="job-progress">
                  <NProgress
                    type="line"
                    :percentage="Math.round(job.percent || 0)"
                    :show-indicator="typeof job.percent === 'number'"
                    :processing="job.status === 'running' && job.stage === 'download'"
                  />
                  <small>{{ jobProgressText(job) }}</small>
                </div>
                <small v-if="job.error">{{ job.error }}</small>
              </div>
              <NTag size="small" :type="jobType(job.status)" :bordered="false">{{ jobLabel(job) }}</NTag>
            </div>
          </div>
        </section>
        </div>
      </NSpin>
    </NDrawerContent>
  </NDrawer>
  <NDrawer
    :show="cliDetailsShow"
    placement="right"
    :width="'min(620px, calc(100vw - 24px))'"
    @update:show="cliDetailsShow = $event"
  >
    <NDrawerContent :title="t('runtimeVersions.cliDetailsTitle')" closable>
      <div data-testid="cli-details" class="cli-details">
        <div class="cli-detail-row">
          <strong>{{ t('runtimeVersions.activePythonPath') }}</strong>
          <code :title="status?.hermes.pythonPath || ''">{{ status?.hermes.pythonPath || '-' }}</code>
        </div>
        <div class="cli-detail-row">
          <strong>{{ t('runtimeVersions.activeAgentRoot') }}</strong>
          <code :title="status?.hermes.agentRoot || ''">{{ status?.hermes.agentRoot || '-' }}</code>
        </div>
        <div class="cli-detail-row">
          <strong>{{ t('runtimeVersions.activeDataDirectory') }}</strong>
          <code :title="status?.hermes.dataDirectory || ''">{{ status?.hermes.dataDirectory || '-' }}</code>
        </div>
        <HermesDataDirectoryHint />
      </div>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped lang="scss">
.version-management {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.version-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;

  h3 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }

  p {
    margin: 4px 0 0;
    color: var(--text-color-3);
    font-size: 12px;
  }

  &.compact {
    align-items: center;
  }
}

.section-heading-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.active-path {
  display: grid;
  grid-template-columns: minmax(130px, auto) minmax(0, 1fr);
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-color-2);
  font-size: 12px;

  span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &.stacked {
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;

    span {
      overflow: visible;
      text-overflow: clip;
      white-space: normal;
      word-break: break-word;
    }

    span:last-child {
      color: var(--text-color-3);
    }
  }
}

.runtime-directory-control {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
}

.runtime-update-note {
  display: flex;
  flex-direction: column;
  gap: 6px;

  code {
    width: fit-content;
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--hover-color);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 12px;
  }
}

.runtime-directory-value {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;

  span {
    overflow: hidden;
    color: var(--text-color-2);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.runtime-directory-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 8px;
}

.runtime-directory-hint {
  margin: -4px 2px 0;
  color: var(--text-color-3);
  font-size: 12px;
}

.cli-details {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.cli-detail-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;

  strong {
    color: var(--text-color-2);
    font-size: 12px;
  }

  code {
    overflow-wrap: anywhere;
    color: var(--text-color-1);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 12px;
  }
}

.version-list,
.job-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  overflow: hidden;
}

.version-row,
.job-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 44px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-color);

  &:last-child {
    border-bottom: 0;
  }
}

.version-main,
.job-main {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 8px;
}

.job-main {
  flex: 1 1 auto;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;

  small {
    color: var(--text-color-3);
    word-break: break-word;
  }

  > small {
    color: var(--error-color);
  }
}

.job-progress {
  width: 100%;
  display: grid;
  grid-template-columns: minmax(120px, 1fr) auto;
  align-items: center;
  gap: 8px;
}

.version-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-shrink: 0;
  gap: 8px;
}

.empty-row {
  padding: 14px 10px;
  color: var(--text-color-3);
  font-size: 13px;
  text-align: center;
}

@media (max-width: 640px) {
  .section-heading,
  .version-row,
  .job-row,
  .runtime-directory-control {
    align-items: stretch;
    flex-direction: column;
  }

  .runtime-directory-actions {
    flex-wrap: wrap;
  }

  .section-heading-actions {
    justify-content: flex-start;
  }

  .active-path {
    grid-template-columns: 1fr;
    gap: 4px;
  }

  .version-actions {
    justify-content: flex-start;
  }
}
</style>
