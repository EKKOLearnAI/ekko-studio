<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NDropdown, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import ProviderMetaItem from './ProviderMetaItem.vue'
import type { VoiceApiConnection } from '@/types/voice-api'

export type VoiceApiCardTestState = {
  status: 'idle' | 'recording' | 'loading' | 'success' | 'error'
  message?: string
}

const props = defineProps<{
  connection: VoiceApiConnection
  testState?: VoiceApiCardTestState
}>()

const emit = defineEmits<{
  setActive: [connection: VoiceApiConnection]
  test: [connection: VoiceApiConnection]
  edit: [connection: VoiceApiConnection]
  connect: [connection: VoiceApiConnection]
  remove: [connection: VoiceApiConnection]
}>()

const { t } = useI18n()
const showErrorDetails = ref(false)

watch(() => props.testState?.message, () => {
  showErrorDetails.value = false
})

const canEdit = computed(() => !(props.connection.kind === 'stt' && props.connection.provider === 'browser'))
const requiresKey = computed(() => !props.connection.isBuiltin)
const keyStateLabel = computed(() => {
  if (!requiresKey.value) return t('settings.voice.builtin')
  return props.connection.hasSecret ? t('settings.voice.keyStored') : t('settings.voice.keyMissing')
})

const providerTypeLabel = computed(() => props.connection.isBuiltin
  ? t('settings.voice.builtin')
  : t('settings.voice.customApi'))

const statusType = computed(() => {
  if (props.connection.active) return 'success'
  if (requiresKey.value && !props.connection.hasSecret) return 'warning'
  return 'default'
})

const statusLabel = computed(() => {
  if (props.connection.active) return t('settings.voice.active')
  if (requiresKey.value && !props.connection.hasSecret) return t('settings.voice.keyMissing')
  return t('settings.voice.connected')
})

const modelValue = computed(() => props.connection.model || String(props.connection.settings.model || ''))
const voiceValue = computed(() => props.connection.voice || String(props.connection.settings.voice || ''))
const sourceValue = computed(() => props.connection.baseUrl || (props.connection.isBuiltin ? t('settings.voice.localBuiltin') : ''))
const lastTestLabel = computed(() => {
  const status = props.testState?.status
  if (status === 'success') return t('settings.voice.testSuccess')
  if (status === 'error') return t('settings.voice.testFailedShort')
  if (status === 'loading') return t('settings.voice.testing')
  if (status === 'recording') return t('settings.voice.recording')
  return t('settings.voice.notTested')
})

const actionLabel = computed(() => requiresKey.value && !props.connection.hasSecret
  ? t('settings.voice.connect')
  : t('common.edit'))
const testActionLabel = computed(() => props.testState?.status === 'recording'
  ? t('settings.voice.sttTestStopButton')
  : t('settings.voice.testAction'))

const metaItems = computed(() => {
  if (props.connection.kind === 'tts') {
    return [
      { key: 'source', label: t('settings.voice.source'), value: sourceValue.value },
      { key: 'model', label: t('settings.voice.model'), value: modelValue.value },
      { key: 'voice', label: t('settings.voice.voice'), value: voiceValue.value },
      { key: 'api-key', label: t('settings.voice.apiKey'), value: keyStateLabel.value },
    ]
  }
  return [
    { key: 'source', label: t('settings.voice.source'), value: sourceValue.value },
    { key: 'model', label: t('settings.voice.model'), value: modelValue.value },
    { key: 'api-key', label: t('settings.voice.apiKey'), value: keyStateLabel.value },
    { key: 'last-test', label: t('settings.voice.lastTest'), value: lastTestLabel.value },
  ]
})

const hasInlineFeedback = computed(() => {
  const status = props.testState?.status
  return !!status && status !== 'idle' && status !== 'error'
})

const hasError = computed(() => props.testState?.status === 'error')
const rawErrorMessage = computed(() => props.testState?.message || '')

function parseErrorPayload(raw: string): string | null {
  const jsonStart = raw.indexOf('{')
  if (jsonStart < 0) return null
  try {
    const parsed = JSON.parse(raw.slice(jsonStart)) as { error?: unknown; message?: unknown; detail?: unknown }
    const candidate = parsed.error || parsed.message || parsed.detail
    return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null
  } catch {
    return null
  }
}

function stripTechnicalPrefix(raw: string): string {
  return raw
    .replace(/^API Error\s+\d+\s*:\s*/i, '')
    .replace(/^Error\s*:\s*/i, '')
    .trim()
}

const friendlyErrorMessage = computed(() => {
  const raw = rawErrorMessage.value.trim()
  if (!raw) return t('settings.voice.testFailedSummary')
  const parsed = parseErrorPayload(raw)
  const candidate = parsed || stripTechnicalPrefix(raw)
  if (!candidate || candidate.startsWith('{') || candidate.startsWith('[')) {
    return t('settings.voice.testFailedSummary')
  }
  return candidate.length > 180 ? `${candidate.slice(0, 177).trim()}…` : candidate
})

const showDetailsToggle = computed(() => {
  const raw = rawErrorMessage.value.trim()
  return raw.length > 0 && raw !== friendlyErrorMessage.value
})

const moreOptions = computed(() => [
  {
    label: t('settings.voice.remove'),
    key: 'remove',
    disabled: props.connection.isBuiltin,
  },
])

function handleEditAction() {
  if (requiresKey.value && !props.connection.hasSecret) {
    emit('connect', props.connection)
    return
  }
  emit('edit', props.connection)
}

function handleMoreSelect(key: string | number) {
  if (key === 'remove' && !props.connection.isBuiltin) {
    emit('remove', props.connection)
  }
}
</script>

<template>
  <article class="voice-api-card" :class="{ active: connection.active }" :data-state="testState?.status || 'idle'"><div class="card-main">
      <div class="provider-identity">
        <div class="provider-icon" aria-hidden="true">
          {{ connection.kind === 'tts' ? 'T' : 'S' }}
        </div>
        <div class="provider-copy">
          <div class="provider-title-row">
            <h5 class="provider-title" :title="connection.label">{{ connection.label }}</h5>
            <span class="provider-kind">{{ providerTypeLabel }}</span>
          </div>
          <p class="provider-description">
            {{ connection.kind === 'tts' ? t('settings.voice.ttsCardHint') : t('settings.voice.sttCardHint') }}
          </p>
        </div>
      </div>

      <dl class="provider-meta">
        <ProviderMetaItem
          v-for="item in metaItems"
          :key="item.key"
          :label="item.label"
          :value="item.value"
        />
      </dl>

      <div class="provider-control">
        <NTag class="status-badge" size="small" :type="statusType" round :bordered="false">
          {{ statusLabel }}
        </NTag>
        <div class="card-actions" :aria-label="`${connection.label} actions`">
          <NButton
            v-if="!connection.active"
            size="tiny"
            secondary
            @click="emit('setActive', connection)"
          >
            {{ t('settings.voice.setActive') }}
          </NButton>
          <NButton
            size="tiny"
            :loading="testState?.status === 'loading'"
            :data-testid="`voice-card-test-${connection.id}`"
            @click="emit('test', connection)"
          >
            {{ testActionLabel }}
          </NButton>
          <NButton
            v-if="canEdit"
            size="tiny"
            @click="handleEditAction"
          >
            {{ actionLabel }}
          </NButton>
          <NDropdown
            v-if="requiresKey"
            trigger="click"
            size="small"
            :options="moreOptions"
            @select="handleMoreSelect"
          >
            <NButton size="tiny" :aria-label="t('settings.voice.moreActionsFor', { provider: connection.label })">
              {{ t('settings.voice.moreActions') }}
            </NButton>
          </NDropdown>
        </div>
      </div>
    </div>

    <div v-if="hasInlineFeedback" class="feedback-row" :class="testState?.status" role="status">
      {{ testState?.message || (testState?.status === 'success' ? t('settings.voice.testSuccess') : '') }}
    </div>

    <div v-if="hasError" class="feedback-row error" role="alert">
      <div class="error-summary">{{ friendlyErrorMessage }}</div>
      <NButton
        v-if="showDetailsToggle"
        class="details-toggle"
        text
        size="tiny"
        @click="showErrorDetails = !showErrorDetails"
      >
        {{ showErrorDetails ? t('settings.voice.hideDetails') : t('settings.voice.showDetails') }}
      </NButton>
      <pre v-if="showErrorDetails" class="error-details">{{ rawErrorMessage }}</pre>
    </div>
  </article>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.voice-api-card {
  position: relative;
  overflow: hidden;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  background: $bg-card;
  transition: background $transition-fast;

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
  gap: 16px;
  min-width: 0;
  padding: 14px 16px 14px 18px;
}

.provider-identity {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
}

.provider-icon {
  width: 32px;
  height: 32px;
  border-radius: $radius-sm;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border: 1px solid $border-color;
  background: $bg-input;
  color: $text-secondary;
  font-size: 13px;
  font-weight: 700;
}

.provider-copy {
  min-width: 0;
}

.provider-title-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.provider-title {
  min-width: 0;
  margin: 0;
  color: $text-primary;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-kind {
  flex-shrink: 0;
  color: $text-muted;
  font-size: 11px;
  line-height: 1.35;
}

.provider-description {
  margin: 5px 0 0;
  color: $text-muted;
  font-size: 12px;
  line-height: 1.45;
}

.provider-meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px 16px;
  margin: 0;
  min-width: 0;
}

.provider-control {
  display: grid;
  justify-items: end;
  gap: 8px;
  width: 188px;
  min-width: 0;
}

.status-badge {
  max-width: 100%;
}

.card-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
  width: 100%;

  :deep(.n-button) {
    min-width: 82px;
  }
}

.feedback-row {
  margin: 0 16px 14px 18px;
  padding: 8px 10px;
  border-radius: $radius-sm;
  background: $bg-input;
  color: $text-muted;
  font-size: 12px;
  line-height: 1.45;

  &.success {
    color: $success;
  }

  &.error {
    border: 1px solid rgba(var(--error-rgb), 0.22);
    background: rgba(var(--error-rgb), 0.06);
    color: $error;
  }
}

.error-summary {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.details-toggle {
  margin-top: 4px;
}

.error-details {
  max-height: 160px;
  overflow: auto;
  margin: 6px 0 0;
  padding: 8px;
  border-radius: $radius-sm;
  background: $code-bg;
  color: $text-secondary;
  font-family: $font-code;
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}

@media (max-width: 1080px) {
  .card-main {
    grid-template-columns: minmax(170px, 190px) minmax(0, 1fr) 156px;
    gap: 14px;
  }

  .provider-meta {
    grid-template-columns: 1fr;
  }

  .provider-control {
    width: 156px;
  }

  .card-actions {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 820px) {
  .card-main {
    grid-template-columns: 1fr;
    gap: 12px;
  }

  .provider-control {
    grid-column: auto;
    grid-row: auto;
    width: 100%;
    justify-items: start;
  }

  .provider-meta {
    grid-column: auto;
    grid-row: auto;
  }

  .card-actions {
    grid-template-columns: repeat(2, minmax(0, 120px));
    width: auto;
  }
}

@media (max-width: 520px) {
  .provider-meta {
    grid-template-columns: 1fr;
  }

  .card-actions {
    grid-template-columns: 1fr;
    width: 100%;
  }
}
</style>
