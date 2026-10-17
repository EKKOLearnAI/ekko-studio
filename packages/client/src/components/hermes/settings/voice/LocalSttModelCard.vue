<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, NProgress, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useLocalSttModel } from '@/composables/useLocalSttModel'
import type { LocalSttModelDownloadSource } from '@/api/studio/local-stt-model'
import type { VoiceApiCardTestState } from './VoiceApiCard.vue'

const props = defineProps<{
  active: boolean
  testState?: VoiceApiCardTestState
}>()

const emit = defineEmits<{
  setActive: []
  test: []
  ready: []
}>()

const { t } = useI18n()
const message = useMessage()
const localModel = useLocalSttModel()
const actionLoading = ref(false)
let pollTimer: ReturnType<typeof setTimeout> | null = null
let wasUsable = false

const status = computed(() => localModel.status.value)
const job = computed(() => status.value?.job || null)
const downloading = computed(() => job.value?.status === 'queued' || job.value?.status === 'running')
const progress = computed(() => Math.max(0, Math.min(100, job.value?.percent || 0)))
const statusType = computed(() => props.active ? 'success' : status.value?.usable ? 'info' : downloading.value ? 'warning' : 'default')
const statusLabel = computed(() => {
  if (props.active) return t('settings.voice.active')
  if (status.value?.usable) return t('settings.voice.localSttModelReady')
  if (downloading.value) return t('settings.voice.localSttModelDownloading')
  return t('settings.voice.localSttModelNotInstalled')
})
const stageLabel = computed(() => job.value ? t(`settings.voice.localSttStage.${job.value.stage}`) : '')
const feedbackText = computed(() => props.testState?.message || '')

function formatBytes(value: number | undefined): string {
  if (!value || value <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let amount = value
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  return `${amount.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`
}

function clearPoll(): void {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
}

async function refreshAndSchedule(): Promise<void> {
  clearPoll()
  try {
    const next = await localModel.refresh()
    if (next.usable && !wasUsable) emit('ready')
    wasUsable = next.usable
    if (next.job?.status === 'queued' || next.job?.status === 'running') {
      pollTimer = setTimeout(() => void refreshAndSchedule(), 750)
    }
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}

async function handleDownload(source: LocalSttModelDownloadSource): Promise<void> {
  actionLoading.value = true
  try {
    await localModel.download(source)
    await refreshAndSchedule()
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    actionLoading.value = false
  }
}

onMounted(() => void refreshAndSchedule())
onBeforeUnmount(clearPoll)
</script>

<template>
  <article class="local-stt-card" :class="{ active }" data-testid="local-stt-model-card">
    <div class="card-main">
      <div class="provider-identity">
        <div class="provider-icon" aria-hidden="true">L</div>
        <div class="provider-copy">
          <div class="provider-title-row">
            <h5 class="provider-title">{{ t('settings.voice.localSttModelTitle') }}</h5>
            <span class="provider-kind">{{ t('settings.voice.builtin') }}</span>
          </div>
          <p class="provider-description">{{ t('settings.voice.localSttModelDescription') }}</p>
        </div>
      </div>

      <dl class="provider-meta">
        <div>
          <dt>{{ t('settings.voice.model') }}</dt>
          <dd>{{ status?.name || 'Streaming Zipformer Chinese-English INT8' }}</dd>
        </div>
        <div>
          <dt>{{ t('settings.voice.localSttLanguages') }}</dt>
          <dd>{{ t('settings.voice.localSttLanguagesValue') }}</dd>
        </div>
        <div>
          <dt>{{ t('settings.voice.localSttDownloadSize') }}</dt>
          <dd>{{ formatBytes(status?.archiveSize) }}</dd>
        </div>
        <div>
          <dt>{{ t('settings.voice.localSttRuntime') }}</dt>
          <dd>sherpa-onnx-node</dd>
        </div>
      </dl>

      <div class="provider-control">
        <NTag class="status-badge" size="small" :type="statusType" round :bordered="false">
          {{ statusLabel }}
        </NTag>
        <div class="card-actions">
          <template v-if="!status?.usable">
            <NButton
              size="tiny"
              secondary
              :disabled="downloading"
              :loading="actionLoading && !downloading"
              data-testid="local-stt-download-cf"
              @click="handleDownload('cf')"
            >
              {{ t('settings.voice.localSttDownloadCf') }}
            </NButton>
            <NButton
              size="tiny"
              secondary
              :disabled="downloading"
              :loading="actionLoading && !downloading"
              data-testid="local-stt-download-github"
              @click="handleDownload('github')"
            >
              {{ t('settings.voice.localSttDownloadGithub') }}
            </NButton>
          </template>
          <template v-else>
            <NButton v-if="!active" size="tiny" secondary data-testid="local-stt-set-active" @click="emit('setActive')">
              {{ t('settings.voice.setActive') }}
            </NButton>
            <NButton
              size="tiny"
              :loading="testState?.status === 'loading'"
              data-testid="local-stt-test"
              @click="emit('test')"
            >
              {{ testState?.status === 'recording' ? t('settings.voice.sttTestStopButton') : t('settings.voice.testAction') }}
            </NButton>
          </template>
        </div>
      </div>
    </div>

    <div v-if="downloading" class="download-progress" role="status">
      <div class="progress-copy">
        <span>{{ stageLabel }}</span>
        <span v-if="job?.receivedBytes">{{ formatBytes(job.receivedBytes) }} / {{ formatBytes(job.totalBytes) }}</span>
      </div>
      <NProgress
        type="line"
        :percentage="progress"
        :show-indicator="Boolean(job?.percent)"
        :processing="job?.stage !== 'download'"
      />
      <small>{{ t('settings.voice.localSttBackgroundHint') }}</small>
    </div>

    <div v-if="job?.status === 'failed'" class="feedback-row error" role="alert">
      {{ t('settings.voice.localSttDownloadFailed', { error: job.error }) }}
    </div>
    <div v-else-if="status?.validationError" class="feedback-row error" role="alert">
      {{ status.validationError }}
    </div>
    <div
      v-if="testState && testState.status !== 'idle'"
      class="feedback-row"
      :class="testState.status"
      :role="testState.status === 'error' ? 'alert' : 'status'"
    >
      {{ feedbackText || (testState.status === 'success' ? t('settings.voice.testSuccess') : '') }}
    </div>
  </article>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.local-stt-card {
  position: relative;
  overflow: hidden;
  border: var(--border-width, 1px) solid $border-color;
  border-radius: $radius-md;
  background: var(--theme-card-bg, $bg-card);

  &.active::before {
    content: '';
    position: absolute;
    inset: 0 auto 0 0;
    width: 3px;
    background: $accent-primary;
  }
}

.card-main {
  display: grid;
  grid-template-columns: minmax(210px, 240px) minmax(0, 1fr) 188px;
  align-items: start;
  gap: calc(16px * var(--spacing-scale, 1));
  padding: calc(14px * var(--spacing-scale, 1)) calc(16px * var(--spacing-scale, 1)) calc(14px * var(--spacing-scale, 1)) calc(18px * var(--spacing-scale, 1));
}

.provider-identity {
  display: flex;
  gap: calc(12px * var(--spacing-scale, 1));
  min-width: 0;
}

.provider-icon {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border: var(--border-width, 1px) solid $border-color;
  border-radius: $radius-sm;
  background: var(--theme-input-bg, $bg-input);
  color: $text-secondary;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  font-weight: 700;
}

.provider-copy {
  min-width: 0;
}

.provider-title-row {
  display: flex;
  align-items: baseline;
  gap: calc(8px * var(--spacing-scale, 1));
}

.provider-title {
  margin: 0;
  color: $text-primary;
  font-size: calc(var(--font-size-base, 14px) * 14 / 14);
  font-weight: 600;
}

.provider-kind,
.provider-description,
.download-progress small {
  color: $text-muted;
  font-size: calc(var(--font-size-base, 14px) * 11 / 14);
}

.provider-description {
  margin: 5px 0 0;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  line-height: var(--line-height, 1.45);
}

.provider-meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: calc(7px * var(--spacing-scale, 1)) calc(16px * var(--spacing-scale, 1));
  margin: 0;
  min-width: 0;

  dt {
    color: $text-muted;
    font-size: calc(var(--font-size-base, 14px) * 10 / 14);
  }

  dd {
    overflow: hidden;
    margin: 2px 0 0;
    color: $text-secondary;
    font-size: calc(var(--font-size-base, 14px) * 12 / 14);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.provider-control {
  display: grid;
  justify-items: end;
  gap: calc(8px * var(--spacing-scale, 1));
  width: 188px;
}

.card-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: calc(6px * var(--spacing-scale, 1));
}

.download-progress,
.feedback-row {
  padding: calc(10px * var(--spacing-scale, 1)) calc(16px * var(--spacing-scale, 1)) calc(12px * var(--spacing-scale, 1)) calc(18px * var(--spacing-scale, 1));
  border-top: var(--border-width, 1px) solid $border-color;
}

.download-progress {
  display: grid;
  gap: calc(7px * var(--spacing-scale, 1));
}

.progress-copy {
  display: flex;
  justify-content: space-between;
  gap: calc(12px * var(--spacing-scale, 1));
  color: $text-secondary;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
}

.feedback-row {
  color: $text-secondary;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
}

.feedback-row.error {
  color: var(--error-color);
}

@media (max-width: 860px) {
  .card-main {
    grid-template-columns: 1fr;
  }

  .provider-control {
    justify-items: start;
    width: 100%;
  }

  .card-actions {
    justify-content: flex-start;
  }
}
</style>
