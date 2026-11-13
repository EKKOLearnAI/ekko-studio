<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NTooltip, useMessage } from 'naive-ui'
import type { Job } from '@/api/hermes/jobs'
import { scheduleToDisplayText } from '@/api/hermes/jobs'
import { useJobsStore } from '@/stores/hermes/jobs'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  job: Job
  selected?: boolean
}>()

const emit = defineEmits<{
  edit: [jobId: string]
  select: [jobId: string]
}>()

const { t } = useI18n()
const jobsStore = useJobsStore()
const message = useMessage()
const runPending = ref(false)

const jobId = computed(() => props.job.job_id || props.job.id)

const statusLabel = computed(() => {
  if (props.job.state === 'running') return t('jobs.status.running')
  if (props.job.state === 'paused') return t('jobs.status.paused')
  if (!props.job.enabled) return t('jobs.status.disabled')
  return t('jobs.status.scheduled')
})

const statusType = computed(() => {
  if (props.job.state === 'running') return 'info' as const
  if (props.job.state === 'paused') return 'warning' as const
  if (!props.job.enabled) return 'error' as const
  return 'success' as const
})

const scheduleExpr = computed(() => scheduleToDisplayText(props.job.schedule, props.job.schedule_display || '—'))
const providerLabel = computed(() => props.job.provider || '—')
const modelLabel = computed(() => props.job.model || '—')

const formatTime = (t?: string | null) => {
  if (!t) return '—'
  return new Date(t).toLocaleString()
}

async function handlePause() {
  try {
    await jobsStore.pauseJob(jobId.value)
    message.success(t('jobs.jobPaused'))
  } catch (e: any) {
    message.error(e.message)
  }
}

async function handleResume() {
  try {
    await jobsStore.resumeJob(jobId.value)
    message.success(t('jobs.jobResumed'))
  } catch (e: any) {
    message.error(e.message)
  }
}

async function handleRun() {
  if (runPending.value) return
  runPending.value = true
  try {
    await jobsStore.runJob(jobId.value)
    message.info(t('jobs.jobTriggered'))
  } catch (e: any) {
    message.error(e.message)
  } finally {
    runPending.value = false
  }
}

async function handleDelete() {
  try {
    await jobsStore.deleteJob(jobId.value)
    message.success(t('jobs.jobDeleted'))
  } catch (e: any) {
    message.error(e.message)
  }
}

function handleCardClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (target.closest('.card-actions')) return
  emit('select', jobId.value)
}
</script>

<template>
  <div class="job-card" :class="{ selected }" @click="handleCardClick">
    <div class="card-header">
      <h3 class="job-name">{{ job.name }}</h3>
      <span class="status-badge" :class="statusType">{{ statusLabel }}</span>
    </div>

    <div class="card-body">
      <div class="info-row">
        <span class="info-label">{{ t('jobs.info.schedule') }}</span>
        <code class="info-value mono">{{ scheduleExpr }}</code>
      </div>
      <div class="info-row">
        <span class="info-label">{{ t('jobs.info.provider') }}</span>
        <span class="info-value mono">{{ providerLabel }}</span>
      </div>
      <div class="info-row">
        <span class="info-label">{{ t('jobs.info.model') }}</span>
        <span class="info-value mono">{{ modelLabel }}</span>
      </div>
      <div class="info-row">
        <span class="info-label">{{ t('jobs.info.lastRun') }}</span>
        <span class="info-value">
          {{ formatTime(job.last_run_at) }}
          <span v-if="job.last_status" class="run-status" :class="{ ok: job.last_status === 'ok', err: job.last_status !== 'ok' }">
            {{ job.last_status === 'ok' ? t('common.ok') : job.last_status }}
          </span>
        </span>
      </div>
      <div class="info-row">
        <span class="info-label">{{ t('jobs.info.nextRun') }}</span>
        <span class="info-value">{{ formatTime(job.next_run_at) }}</span>
      </div>
      <div class="info-row">
        <span class="info-label">{{ t('jobs.info.deliver') }}</span>
        <span class="info-value">{{ job.deliver }}<template v-if="job.origin"> ({{ job.origin.platform }})</template></span>
      </div>
      <div v-if="job.repeat" class="info-row">
        <span class="info-label">{{ t('jobs.info.repeat') }}</span>
        <span class="info-value">
          <template v-if="typeof job.repeat === 'string'">{{ job.repeat }}</template>
          <template v-else>{{ job.repeat.completed }} / {{ job.repeat.times ?? '∞' }}</template>
        </span>
      </div>
    </div>

    <div class="card-actions">
      <NTooltip v-if="job.state !== 'paused' && job.enabled">
        <template #trigger>
          <NButton size="tiny" quaternary @click.stop="handlePause">{{ t('jobs.action.pause') }}</NButton>
        </template>
        {{ t('jobs.action.pauseJob') }}
      </NTooltip>
      <NTooltip v-else-if="job.state === 'paused'">
        <template #trigger>
          <NButton size="tiny" quaternary @click.stop="handleResume">{{ t('jobs.action.resume') }}</NButton>
        </template>
        {{ t('jobs.action.resumeJob') }}
      </NTooltip>
      <NButton
        size="tiny"
        quaternary
        :loading="runPending"
        :disabled="runPending"
        @click.stop="handleRun"
      >
        {{ t('jobs.action.runNow') }}
      </NButton>
      <NButton size="tiny" quaternary @click.stop="emit('edit', jobId)">{{ t('common.edit') }}</NButton>
      <NButton size="tiny" quaternary type="error" @click.stop="handleDelete">{{ t('common.delete') }}</NButton>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.job-card {
  background-color: var(--theme-card-bg, $bg-card);
  border: var(--border-width, 1px) solid $border-color;
  border-radius: $radius-md;
  padding: calc(16px * var(--spacing-scale, 1));
  transition: border-color $transition-fast;
  cursor: pointer;

  &:hover {
    border-color: rgba(var(--accent-primary-rgb), 0.3);
  }

  &.selected {
    border-color: rgba(var(--accent-primary-rgb), 0.6);
    background-color: rgba(var(--accent-primary-rgb), 0.04);
  }
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.job-name {
  font-size: calc(var(--font-size-base, 14px) * 15 / 14);
  font-weight: 600;
  color: $text-primary;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 70%;
}

.status-badge {
  font-size: calc(var(--font-size-base, 14px) * 11 / 14);
  padding: calc(2px * var(--spacing-scale, 1)) calc(8px * var(--spacing-scale, 1));
  border-radius: var(--radius-component, 10px);
  font-weight: 500;

  &.success {
    background: rgba(var(--success-rgb), 0.12);
    color: $success;
  }

  &.info {
    background: rgba(var(--accent-primary-rgb), 0.12);
    color: $accent-primary;
  }

  &.warning {
    background: rgba(var(--warning-rgb), 0.12);
    color: $warning;
  }

  &.error {
    background: rgba(var(--error-rgb), 0.12);
    color: $error;
  }
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: calc(6px * var(--spacing-scale, 1));
  margin-bottom: 14px;
}

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.info-label {
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  color: $text-muted;
}

.info-value {
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  color: $text-secondary;
}

.run-status {
  margin-inline-start: 6px;
  font-size: calc(var(--font-size-base, 14px) * 11 / 14);
  font-weight: 500;

  &.ok { color: $success; }
  &.err { color: $error; }
}

.mono {
  font-family: var(--font-code, $font-code);
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
}

.card-actions {
  display: flex;
  gap: calc(4px * var(--spacing-scale, 1));
  border-top: var(--border-width, 1px) solid $border-light;
  padding-top: calc(10px * var(--spacing-scale, 1));
}
</style>
