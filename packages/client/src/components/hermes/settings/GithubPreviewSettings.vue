<script setup lang="ts">
import { usePageLoadingTask } from '@/composables/usePageLoading'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { NAlert, NButton, NDescriptions, NDescriptionsItem, NSelect, NSpace, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  fetchPreviewStatus,
  fetchPreviewTags,
  installPreview,
  preparePreview,
  startPreview,
  stopPreview,
  type PreviewActionResponse,
  type PreviewStatus,
  type PreviewTag,
} from '@/api/studio/system'

const { t } = useI18n()
const message = useMessage()

const loading = ref(false)
const tagsLoading = ref(false)
const actionLoading = ref('')
const tags = ref<PreviewTag[]>([])
const selectedTag = ref('')
const status = ref<PreviewStatus | null>(null)
const lastHandledCompletion = ref('')
const completionNotificationsReady = ref(false)
let pollTimer: number | null = null

const tagOptions = computed(() => tags.value.map(tag => ({
  label: tag.name,
  value: tag.name,
})))
const actionLog = computed(() => status.value?.action_log || '')
const devLog = computed(() => status.value?.dev_log || '')
const activeAction = computed(() => actionLoading.value || status.value?.active_action || '')
const hasActiveAction = computed(() => Boolean(activeAction.value))
const actionSuccessKeys: Record<string, string> = {
  prepare: 'githubPreview.prepareSuccess',
  install: 'githubPreview.installSuccess',
  start: 'githubPreview.startSuccess',
  stop: 'githubPreview.stopSuccess',
}

function applyErrorStatus(err: any) {
  const messageText = String(err?.message || '')
  const jsonStart = messageText.indexOf('{')
  if (jsonStart < 0) return
  try {
    const parsed = JSON.parse(messageText.slice(jsonStart))
    if (parsed && typeof parsed === 'object' && 'preview_dir' in parsed) {
      status.value = parsed as PreviewStatus
    }
  } catch {}
}

function errorCodeMessage(code?: string, fallback?: string): string {
  if (code === 'node_environment_missing') return t('githubPreview.nodeEnvironmentMissing')
  return fallback || t('githubPreview.actionFailed')
}

function parseErrorPayload(err: any): { message?: string; code?: string } | null {
  const messageText = String(err?.message || '')
  const jsonStart = messageText.indexOf('{')
  if (jsonStart < 0) return null
  try {
    const parsed = JSON.parse(messageText.slice(jsonStart))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

async function loadStatus() {
  status.value = await fetchPreviewStatus()
  if (!selectedTag.value && status.value.current_tag) {
    selectedTag.value = status.value.current_tag
  }
}

async function loadTags() {
  tagsLoading.value = true
  try {
    const res = await fetchPreviewTags()
    tags.value = res.tags
    if (!selectedTag.value && tags.value[0]) {
      selectedTag.value = tags.value[0].name
    }
  } finally {
    tagsLoading.value = false
  }
}

async function handleRefresh() {
  loading.value = true
  try {
    await Promise.all([loadStatus(), loadTags()])
  } finally {
    loading.value = false
  }
}

async function runAction(action: string, fn: () => Promise<PreviewActionResponse>, successKey: string) {
  actionLoading.value = action
  try {
    const res = await fn()
    status.value = res
    if (res.success === false) {
      message.warning(errorCodeMessage(res.code, res.message))
      return
    }
    if (!res.accepted && !res.active_action) {
      message.success(t(successKey))
    }
  } catch (err: any) {
    applyErrorStatus(err)
    const payload = parseErrorPayload(err)
    message.error(errorCodeMessage(payload?.code, payload?.message || err?.message))
  } finally {
    actionLoading.value = ''
  }
}

async function pollStatus() {
  try {
    await loadStatus()
  } catch {}
}

function startPolling() {
  if (pollTimer) return
  pollTimer = window.setInterval(() => {
    void pollStatus()
  }, 2000)
}

function stopPolling() {
  if (!pollTimer) return
  window.clearInterval(pollTimer)
  pollTimer = null
}

function requireTag(): string | null {
  if (!selectedTag.value) {
    message.warning(t('githubPreview.selectTag'))
    return null
  }
  return selectedTag.value
}

async function handlePrepare() {
  const tag = requireTag()
  if (!tag) return
  await runAction('prepare', () => preparePreview(tag), 'githubPreview.prepareSuccess')
}

async function handleInstall() {
  await runAction('install', async () => {
    const res = await installPreview()
    if (res.success !== false && !res.accepted && !res.active_action && !res.installed) {
      return {
        ...res,
        success: false,
        message: res.message || t('githubPreview.actionFailed'),
      }
    }
    return res
  }, 'githubPreview.installSuccess')
}

async function handleStart() {
  await runAction('start', () => startPreview(selectedTag.value || undefined), 'githubPreview.startSuccess')
}

async function handleStop() {
  await runAction('stop', stopPreview, 'githubPreview.stopSuccess')
}

const initializing = ref(true)
usePageLoadingTask(() => initializing.value)

onMounted(async () => {
  try {
    await handleRefresh()
    lastHandledCompletion.value = status.value?.last_action_completed_at || ''
    completionNotificationsReady.value = true
  } finally {
    initializing.value = false
  }
})

onUnmounted(() => {
  stopPolling()
})

watch(
  () => status.value?.active_action || '',
  (action) => {
    if (action) startPolling()
    else stopPolling()
  },
)

watch(
  () => status.value?.last_action_completed_at || '',
  (completedAt) => {
    if (!completedAt) return
    if (!completionNotificationsReady.value) {
      lastHandledCompletion.value = completedAt
      return
    }
    if (completedAt === lastHandledCompletion.value || actionLoading.value) return
    lastHandledCompletion.value = completedAt
    const completedAction = status.value?.last_action || ''
    if (status.value?.last_action_success === false) {
      message.error(errorCodeMessage(status.value.last_action_code, status.value.last_action_message))
      return
    }
    const successKey = actionSuccessKeys[completedAction]
    if (successKey) message.success(t(successKey))
  },
)
</script>

<template>
  <div class="github-preview-settings">
    <div class="settings-section">
      <div class="control-row">
        <NSelect
          v-model:value="selectedTag"
          class="tag-select"
          filterable
          :loading="tagsLoading"
          :options="tagOptions"
          :placeholder="t('githubPreview.selectTag')"
        />
        <NSpace>
          <NButton type="primary" :loading="activeAction === 'prepare'" :disabled="hasActiveAction || !selectedTag" @click="handlePrepare">
            {{ t('githubPreview.prepare') }}
          </NButton>
          <NButton :loading="activeAction === 'install'" :disabled="hasActiveAction || !status?.has_package" @click="handleInstall">
            {{ t('githubPreview.install') }}
          </NButton>
          <NButton type="success" :loading="activeAction === 'start'" :disabled="hasActiveAction || !status?.installed" @click="handleStart">
            {{ t('githubPreview.start') }}
          </NButton>
          <NButton :loading="activeAction === 'stop'" :disabled="hasActiveAction || !status?.running" @click="handleStop">
            {{ t('githubPreview.stop') }}
          </NButton>
          <NButton :loading="loading || tagsLoading" @click="handleRefresh">
            {{ t('githubPreview.refresh') }}
          </NButton>
        </NSpace>
      </div>

      <p class="section-description">{{ t('githubPreview.description') }}</p>

      <NAlert type="info" :bordered="false" class="preview-note">
        {{ t('githubPreview.note') }}
      </NAlert>

      <NDescriptions v-if="status" :column="1" bordered size="small" class="status-table">
        <NDescriptionsItem :label="t('githubPreview.path')">
          <code>{{ status.preview_dir }}</code>
        </NDescriptionsItem>
        <NDescriptionsItem :label="t('githubPreview.webuiHome')">
          <code>{{ status.webui_home }}</code>
        </NDescriptionsItem>
        <NDescriptionsItem :label="t('githubPreview.currentTag')">
          {{ status.current_tag || '-' }}
        </NDescriptionsItem>
        <NDescriptionsItem :label="t('githubPreview.repoReady')">
          <NTag size="small" :type="status.has_package ? 'success' : 'default'">
            {{ status.has_package ? t('githubPreview.yes') : t('githubPreview.no') }}
          </NTag>
        </NDescriptionsItem>
        <NDescriptionsItem :label="t('githubPreview.dependencies')">
          <NTag size="small" :type="status.installed ? 'success' : 'warning'">
            {{ status.installed ? t('githubPreview.yes') : t('githubPreview.no') }}
          </NTag>
        </NDescriptionsItem>
        <NDescriptionsItem :label="t('githubPreview.running')">
          <NTag size="small" :type="status.running ? 'success' : 'default'">
            {{ status.running ? `PID ${status.pid}` : t('githubPreview.notRunning') }}
          </NTag>
        </NDescriptionsItem>
        <NDescriptionsItem :label="t('githubPreview.open')">
          <a :href="status.frontend_url" target="_blank" rel="noopener noreferrer">{{ status.frontend_url }}</a>
        </NDescriptionsItem>
        <NDescriptionsItem :label="t('githubPreview.log')">
          <code>{{ status.action_log_path }}</code>
        </NDescriptionsItem>
        <NDescriptionsItem :label="t('githubPreview.devLog')">
          <code>{{ status.dev_log_path }}</code>
        </NDescriptionsItem>
      </NDescriptions>

      <div class="log-output">
        <div class="log-output-header">{{ t('githubPreview.logOutput') }}</div>
        <div class="log-box">
          <div class="log-title">{{ t('githubPreview.actionLog') }}</div>
          <pre>{{ actionLog || '-' }}</pre>
        </div>
        <div class="log-box">
          <div class="log-title">{{ t('githubPreview.devLog') }}</div>
          <pre>{{ devLog || '-' }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.github-preview-settings {
  width: 100%;
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.section-description {
  margin: 0;
  color: $text-secondary;
  font-size: 13px;
  line-height: 1.5;
}

.control-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.tag-select {
  width: 260px;
}

.preview-note {
  width: 100%;
}

.status-table {
  width: 100%;
}

.log-output {
  width: 100%;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  background: $bg-card;
  overflow: hidden;
}

.log-output-header {
  padding: 12px 14px;
  border-bottom: 1px solid $border-color;
  font-size: 14px;
  font-weight: 600;
  color: $text-primary;
}

.log-box {
  border-bottom: 1px solid $border-color;

  &:last-child {
    border-bottom: none;
  }
}

.log-title {
  padding: 8px 14px;
  font-size: 12px;
  color: $text-secondary;
  background: $bg-secondary;
}

pre {
  min-height: 180px;
  max-height: 320px;
  margin: 0;
  padding: 12px 14px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.5;
}

code {
  font-size: 12px;
  word-break: break-all;
}

@media (max-width: 1100px) {
  .control-row {
    align-items: stretch;
  }
}
</style>
