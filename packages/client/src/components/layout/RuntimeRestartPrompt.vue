<script setup lang="ts">
import { deploymentUrl } from '@/utils/deployment-url'

import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NCard, NModal, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  fetchVersionDownloadJobs,
  restartWebUiAfterRuntimeChange,
} from '@/api/hermes/runtime-versions'
import { useRuntimeRestartPrompt } from '@/composables/useRuntimeRestartPrompt'
import { isStoredSuperAdmin } from '@/api/client'
import { desktopBridge } from '@/utils/desktop-bridge'

const POLL_INTERVAL_MS = 2000
const HANDLED_JOBS_KEY = 'hermes-runtime-restart-handled-jobs'

const { t } = useI18n()
const message = useMessage()
const {
  runtimeDownloadCheckRevision,
  pendingRuntimeRestart,
  requestRuntimeRestart,
  clearRuntimeRestart,
} = useRuntimeRestartPrompt()
const restarting = ref(false)
const handledJobIds = new Set<string>()
let mounted = false
let checking = false
let checkRequested = false
let pollTimer: ReturnType<typeof setTimeout> | null = null
let restartWaitTimer: ReturnType<typeof setInterval> | null = null

function restoreHandledJobs() {
  try {
    const stored = JSON.parse(localStorage.getItem(HANDLED_JOBS_KEY) || '[]')
    if (Array.isArray(stored)) {
      for (const id of stored) if (typeof id === 'string') handledJobIds.add(id)
    }
  } catch {
    // Ignore malformed or unavailable storage.
  }
}

function rememberHandledJob(jobId?: string) {
  if (!jobId) return
  handledJobIds.add(jobId)
  try {
    localStorage.setItem(HANDLED_JOBS_KEY, JSON.stringify([...handledJobIds]))
  } catch {
    // The in-memory marker still prevents duplicate prompts in this page.
  }
}

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
}

async function checkCompletedRuntimeDownloads() {
  stopPolling()
  if (!mounted || !isStoredSuperAdmin()) return
  if (checking) {
    checkRequested = true
    return
  }
  checking = true
  let hasRunningJobs = false
  try {
    const response = await fetchVersionDownloadJobs()
    if (!mounted || !isStoredSuperAdmin()) return
    hasRunningJobs = response.jobs.some(job =>
      job.kind === 'runtime' && (job.status === 'queued' || job.status === 'running'),
    )
    const completed = response.jobs.filter(job =>
      job.kind === 'runtime'
      && job.status === 'completed'
      && !handledJobIds.has(job.id),
    )
    if (completed.length === 0) return
    if (pendingRuntimeRestart.value) {
      for (const job of completed) rememberHandledJob(job.id)
      return
    }
    for (const job of completed.slice(1)) rememberHandledJob(job.id)
    requestRuntimeRestart(completed[0].version, completed[0].id)
  } catch {
    // Stop on errors, including denied access. Opening version management or
    // starting a download explicitly retries without an endless error loop.
    checkRequested = false
  } finally {
    checking = false
    if (mounted && isStoredSuperAdmin()) {
      if (checkRequested) {
        checkRequested = false
        void checkCompletedRuntimeDownloads()
      } else if (hasRunningJobs) {
        pollTimer = setTimeout(() => {
          void checkCompletedRuntimeDownloads()
        }, POLL_INTERVAL_MS)
      }
    }
  }
}

watch(runtimeDownloadCheckRevision, () => {
  void checkCompletedRuntimeDownloads()
})

function restartStandaloneWebUi() {
  let attempts = 0
  let sawUnavailable = false
  restartWaitTimer = setInterval(async () => {
    attempts += 1
    try {
      const response = await fetch(deploymentUrl('/health'), { cache: 'no-store' })
      if (response.ok && (sawUnavailable || attempts >= 15)) {
        if (restartWaitTimer) clearInterval(restartWaitTimer)
        restartWaitTimer = null
        window.location.reload()
      }
    } catch {
      sawUnavailable = true
    }
    if (attempts >= 60) {
      if (restartWaitTimer) clearInterval(restartWaitTimer)
      restartWaitTimer = null
      window.location.reload()
    }
  }, 1000)
}

async function restartNow() {
  if (!isStoredSuperAdmin() || !pendingRuntimeRestart.value || restarting.value) return
  restarting.value = true
  try {
    const bridge = desktopBridge()
    if (bridge?.isDesktop === true && bridge.remoteMode !== true) {
      if (!bridge.restartApp) throw new Error('Desktop restart is unavailable')
      if (!await bridge.restartApp()) throw new Error('Desktop restart could not be scheduled')
    } else {
      await restartWebUiAfterRuntimeChange()
      restartStandaloneWebUi()
    }
    rememberHandledJob(pendingRuntimeRestart.value.jobId)
  } catch (err) {
    restarting.value = false
    message.error(`${t('runtimeVersions.restartFailed')}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function restartLater() {
  rememberHandledJob(pendingRuntimeRestart.value?.jobId)
  clearRuntimeRestart()
}

onMounted(() => {
  mounted = true
  restoreHandledJobs()
  void checkCompletedRuntimeDownloads()
})

onBeforeUnmount(() => {
  mounted = false
  stopPolling()
  if (restartWaitTimer) clearInterval(restartWaitTimer)
})
</script>

<template>
  <NModal
    :show="!!pendingRuntimeRestart"
    :mask-closable="false"
    :close-on-esc="false"
  >
    <NCard
      data-testid="runtime-restart-prompt"
      role="dialog"
      :title="t('runtimeVersions.restartPromptTitle')"
      :bordered="false"
      style="width: min(460px, calc(100vw - 32px))"
    >
      <p>
        {{ t('runtimeVersions.restartPromptContent', { version: pendingRuntimeRestart?.version || '-' }) }}
      </p>
      <template #footer>
        <div class="actions">
          <NButton
            data-testid="runtime-restart-later"
            :disabled="restarting"
            @click="restartLater"
          >
            {{ t('runtimeVersions.restartLater') }}
          </NButton>
          <NButton
            data-testid="runtime-restart-now"
            type="primary"
            :loading="restarting"
            @click="restartNow"
          >
            {{ t('runtimeVersions.restartNow') }}
          </NButton>
        </div>
      </template>
    </NCard>
  </NModal>
</template>

<style scoped lang="scss">
p {
  margin: 0;
  line-height: var(--line-height, 1.6);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: calc(10px * var(--spacing-scale, 1));
}
</style>
