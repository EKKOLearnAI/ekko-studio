<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  NButton,
  NCheckbox,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  NSpin,
  NTag,
  useDialog,
  useMessage,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type {
  AvailableModelGroup,
  ProviderEditableField,
  ProviderEditorDetail,
  ProviderEditorPatch,
} from '@/api/hermes/system'
import type { ProviderApiMode } from '@/api/studio/provider-api-mode'
import * as systemApi from '@/api/hermes/system'
import { useModelsStore } from '@/stores/hermes/models'

const props = defineProps<{
  show: boolean
  provider: AvailableModelGroup
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  saved: []
}>()

const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()
const modelsStore = useModelsStore()

const detail = ref<ProviderEditorDetail | null>(null)
const loading = ref(false)
const saving = ref(false)
const testing = ref(false)
const clearingCredential = ref(false)
const label = ref('')
const baseUrl = ref('')
const apiMode = ref<ProviderApiMode>('chat_completions')
const preferredModel = ref('')
const newApiKey = ref('')
const contextDraft = ref<Record<string, number | null>>({})
const discoverModels = ref(false)
const rateLimitDelay = ref<number | null>(null)
const requestTimeoutSeconds = ref<number | null>(null)
const staleTimeoutSeconds = ref<number | null>(null)
const extraBodyText = ref('')

const providerLabelInputProps = {
  name: 'provider-display-name',
  autocomplete: 'off',
  spellcheck: false,
  'data-form-type': 'other',
}
const providerBaseUrlInputProps = {
  name: 'provider-base-url',
  autocomplete: 'off',
  spellcheck: false,
  'data-form-type': 'other',
}
const providerModelInputProps = {
  name: 'provider-preferred-model',
  autocomplete: 'off',
  spellcheck: false,
  'data-form-type': 'other',
}
const providerCredentialInputProps = {
  name: 'provider-api-key-replacement',
  autocomplete: 'new-password',
  autocapitalize: 'none',
  spellcheck: false,
  'data-form-type': 'other',
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
}

const API_MODE_OPTIONS = [
  { label: 'Chat Completions', value: 'chat_completions' },
  { label: 'Codex Responses', value: 'codex_responses' },
  { label: 'Anthropic Messages', value: 'anthropic_messages' },
  { label: 'Bedrock Converse', value: 'bedrock_converse' },
  { label: 'Codex App Server', value: 'codex_app_server' },
]

const knownModelIds = computed(() => new Set(
  props.provider.available_models?.length ? props.provider.available_models : props.provider.models,
))
const modelIds = computed(() => {
  const unique = new Set(knownModelIds.value)
  if (preferredModel.value) unique.add(preferredModel.value)
  return [...unique]
})
const modelOptions = computed(() => modelIds.value.map(value => ({ label: value, value })))
const manualModelWarning = computed(() => !!preferredModel.value && !knownModelIds.value.has(preferredModel.value))

function can(field: ProviderEditableField): boolean {
  return !!detail.value?.editable_fields.includes(field)
}

function resetDraft(next: ProviderEditorDetail) {
  detail.value = next
  label.value = next.label
  baseUrl.value = next.base_url
  apiMode.value = next.api_mode || 'chat_completions'
  preferredModel.value = next.preferred_model || props.provider.models[0] || ''
  newApiKey.value = ''
  discoverModels.value = next.discover_models ?? false
  rateLimitDelay.value = next.rate_limit_delay ?? null
  requestTimeoutSeconds.value = next.request_timeout_seconds ?? null
  staleTimeoutSeconds.value = next.stale_timeout_seconds ?? null
  extraBodyText.value = next.extra_body ? JSON.stringify(next.extra_body, null, 2) : ''
  const contexts: Record<string, number | null> = {}
  for (const model of new Set([...modelIds.value, ...Object.keys(next.context_lengths)])) {
    contexts[model] = next.context_lengths[model] ?? null
  }
  contextDraft.value = contexts
}

async function loadEditor() {
  loading.value = true
  try {
    resetDraft(await modelsStore.fetchProviderEditor(props.provider.provider))
  } catch (error: any) {
    message.error(error?.message || t('models.providerEditorLoadFailed'))
    close()
  } finally {
    loading.value = false
  }
}

watch(() => props.show, (show) => {
  if (show) void loadEditor()
}, { immediate: true })

function close() {
  emit('update:show', false)
}

function parseExtraBody(): Record<string, unknown> | null {
  const raw = extraBodyText.value.trim()
  if (!raw) return null
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error(t('models.extraBodyInvalid')) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('models.extraBodyInvalid'))
  return value as Record<string, unknown>
}

function buildPatch(): ProviderEditorPatch {
  const patch: ProviderEditorPatch = {}
  if (can('label')) patch.label = label.value.trim()
  if (can('base_url')) patch.base_url = baseUrl.value.trim()
  if (can('api_mode')) patch.api_mode = apiMode.value
  if (can('preferred_model')) patch.preferred_model = preferredModel.value.trim()
  if (can('api_key')) {
    patch.credential_action = newApiKey.value.trim() ? 'replace' : 'keep'
    if (newApiKey.value.trim()) patch.api_key = newApiKey.value.trim()
  }
  if (detail.value) {
    if (can('discover_models') && discoverModels.value !== (detail.value.discover_models ?? false)) {
      patch.discover_models = discoverModels.value
    }
    if (can('rate_limit_delay') && rateLimitDelay.value !== (detail.value.rate_limit_delay ?? null)) {
      patch.rate_limit_delay = rateLimitDelay.value
    }
    if (can('request_timeout_seconds') && requestTimeoutSeconds.value !== (detail.value.request_timeout_seconds ?? null)) {
      patch.request_timeout_seconds = requestTimeoutSeconds.value
    }
    if (can('stale_timeout_seconds') && staleTimeoutSeconds.value !== (detail.value.stale_timeout_seconds ?? null)) {
      patch.stale_timeout_seconds = staleTimeoutSeconds.value
    }
    if (can('extra_body')) {
      const nextExtraBody = parseExtraBody()
      if (JSON.stringify(nextExtraBody) !== JSON.stringify(detail.value.extra_body ?? null)) patch.extra_body = nextExtraBody
    }
  }
  return patch
}

function contextChanges(): Record<string, number | null> {
  const changes: Record<string, number | null> = {}
  if (!detail.value || !can('context_lengths')) return changes
  for (const [model, value] of Object.entries(contextDraft.value)) {
    const previous = detail.value.context_lengths[model] ?? null
    if (value !== previous) changes[model] = value
  }
  return changes
}

async function testDraft(showSuccess = true): Promise<{ success: boolean; catalogUnavailable?: boolean; error?: string }> {
  if (!detail.value?.connection_test_supported) {
    return { success: false, error: detail.value?.connection_test_reason || t('models.providerTestUnsupported') }
  }
  testing.value = true
  try {
    const result = await systemApi.testProviderEditor(props.provider.provider, buildPatch())
    if (result.success) {
      // Reachable without a catalog is a warning, not a success: the provider
      // works, but nothing was listed and the model ID has to be typed in.
      if (showSuccess && result.catalog_unavailable) message.warning(t('models.providerTestNoCatalog'))
      else if (showSuccess) message.success(t('models.providerTestSuccess', { count: result.model_count || 0 }))
    } else if (showSuccess) {
      message.error(result.error || t('models.providerTestFailed'))
    }
    return {
      success: result.success,
      catalogUnavailable: result.catalog_unavailable,
      error: result.error,
    }
  } catch (error: any) {
    const errorText = error?.message || t('models.providerTestFailed')
    if (showSuccess) message.error(errorText)
    return { success: false, error: errorText }
  } finally {
    testing.value = false
  }
}

function confirmSaveAfterFailedTest(error: string): Promise<boolean> {
  return new Promise(resolve => {
    dialog.warning({
      title: t('models.providerTestFailedTitle'),
      content: `${error}\n\n${t('models.providerSaveAnywayHint')}`,
      positiveText: t('models.saveAnyway'),
      negativeText: t('common.cancel'),
      onPositiveClick: () => resolve(true),
      onNegativeClick: () => resolve(false),
      onClose: () => resolve(false),
    })
  })
}

async function save() {
  if (!detail.value || saving.value) return
  if (!label.value.trim() || !baseUrl.value.trim() || !preferredModel.value.trim()) {
    message.error(t('models.providerEditorRequired'))
    return
  }
  try { buildPatch() } catch (error: any) {
    message.error(error?.message || t('models.providerEditorSaveFailed'))
    return
  }
  if (detail.value.connection_test_supported) {
    const test = await testDraft(false)
    if (test.catalogUnavailable) message.warning(t('models.providerTestNoCatalog'))
    if (!test.success && !await confirmSaveAfterFailedTest(test.error || t('models.providerTestFailed'))) return
  }

  saving.value = true
  try {
    const saved = await modelsStore.saveProviderEditor(
      props.provider.provider,
      detail.value.revision,
      buildPatch(),
      contextChanges(),
    )
    resetDraft(saved)
    message.success(t('models.providerEditorSaved'))
    message.info(t('models.providerReconnectHint'))
    emit('saved')
    close()
  } catch (error: any) {
    const text = String(error?.message || '')
    if (text.includes('412') || text.includes('REVISION_CONFLICT')) {
      message.warning(t('models.providerEditorConflict'))
      await loadEditor()
    } else {
      message.error(text || t('models.providerEditorSaveFailed'))
    }
  } finally {
    saving.value = false
  }
}

async function clearCredentialNow() {
  if (!detail.value || clearingCredential.value) return
  dialog.warning({
    title: t('models.clearProviderCredentials'),
    content: t('models.clearCredentialsConfirm', { name: detail.value.label }),
    positiveText: t('models.clearProviderCredentials'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      clearingCredential.value = true
      try {
        const saved = await modelsStore.saveProviderEditor(
          props.provider.provider,
          detail.value!.revision,
          { credential_action: 'clear' },
        )
        resetDraft(saved)
        message.success(t('models.providerCredentialsCleared'))
        message.warning(t('models.providerCredentialMissingHint'))
        emit('saved')
      } catch (error: any) {
        message.error(error?.message || t('models.providerEditorSaveFailed'))
      } finally {
        clearingCredential.value = false
      }
    },
  })
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    class="provider-editor-modal"
    :title="t('models.editProviderTitle', { name: provider.label })"
    :mask-closable="!saving"
    @update:show="value => !value && close()"
  >
    <NSpin :show="loading">
      <div v-if="detail" class="editor-body">
        <div class="identity-note">
          <span>{{ t('models.providerInternalId') }}</span>
          <code>{{ detail.id }}</code>
          <NTag size="small" :type="detail.builtin ? 'info' : 'success'">
            {{ detail.builtin ? t('models.builtIn') : t('models.customType') }}
          </NTag>
        </div>

        <label v-if="can('label')" class="field">
          <span>{{ t('models.providerDisplayName') }}</span>
          <NInput v-model:value="label" :input-props="providerLabelInputProps" maxlength="100" show-count />
          <small>{{ t('models.providerIdStableHint') }}</small>
        </label>

        <label class="field">
          <span>{{ t('models.baseUrl') }}</span>
          <NInput
            v-model:value="baseUrl"
            :disabled="!can('base_url')"
            :input-props="providerBaseUrlInputProps"
            placeholder="https://api.example.com/v1"
          />
        </label>

        <label v-if="can('api_mode')" class="field">
          <span>API Mode</span>
          <NSelect v-model:value="apiMode" :options="API_MODE_OPTIONS" />
        </label>

        <label v-if="can('preferred_model')" class="field">
          <span>{{ t('models.providerPreferredModel') }}</span>
          <NSelect
            v-model:value="preferredModel"
            :options="modelOptions"
            :input-props="providerModelInputProps"
            filterable
            tag
            :placeholder="t('models.selectOrEnterModel')"
          />
          <small v-if="manualModelWarning" class="warning-text">{{ t('models.unverifiedModelWarning') }}</small>
          <small v-else>{{ t('models.providerPreferredModelHint') }}</small>
        </label>

        <section v-if="can('api_key')" class="credential-section">
          <div class="section-heading">
            <span>API Key</span>
            <NTag size="small" :type="detail.credential_configured ? 'success' : 'warning'">
              {{ detail.credential_configured ? t('models.credentialConfigured') : t('models.credentialNotConfigured') }}
            </NTag>
          </div>
          <NInput
            v-model:value="newApiKey"
            type="password"
            show-password-on="click"
            :input-props="providerCredentialInputProps"
            :placeholder="detail.credential_configured ? t('models.leaveBlankKeepCredential') : t('models.enterCredential')"
          />
          <div class="credential-actions">
            <small>{{ t('models.credentialNeverDisplayedHint') }}</small>
            <NButton
              v-if="detail.credential_configured"
              size="small"
              type="error"
              secondary
              :loading="clearingCredential"
              @click="clearCredentialNow"
            >
              {{ t('models.clearProviderCredentials') }}
            </NButton>
          </div>
        </section>

        <details
          v-if="can('discover_models') || can('rate_limit_delay') || can('request_timeout_seconds') || can('stale_timeout_seconds') || can('extra_body')"
          class="context-section"
        >
          <summary>{{ t('models.providerAdvancedSettings') }}</summary>
          <div class="advanced-settings">
            <NCheckbox v-if="can('discover_models')" v-model:checked="discoverModels">
              {{ t('models.discoverModels') }}
            </NCheckbox>
            <label v-if="can('rate_limit_delay')" class="field">
              <span>{{ t('models.rateLimitDelay') }}</span>
              <NInputNumber v-model:value="rateLimitDelay" :min="0.001" :max="86400" clearable />
            </label>
            <label v-if="can('request_timeout_seconds')" class="field">
              <span>{{ t('models.requestTimeoutSeconds') }}</span>
              <NInputNumber v-model:value="requestTimeoutSeconds" :min="0.001" :max="86400" clearable />
            </label>
            <label v-if="can('stale_timeout_seconds')" class="field">
              <span>{{ t('models.staleTimeoutSeconds') }}</span>
              <NInputNumber v-model:value="staleTimeoutSeconds" :min="0.001" :max="86400" clearable />
            </label>
            <label v-if="can('extra_body')" class="field">
              <span>extra_body (JSON)</span>
              <NInput
                v-model:value="extraBodyText"
                type="textarea"
                :autosize="{ minRows: 3, maxRows: 10 }"
                placeholder="{}"
              />
              <small>{{ t('models.extraBodyHint') }}</small>
            </label>
          </div>
        </details>

        <details v-if="can('context_lengths')" class="context-section">
          <summary>{{ t('models.perModelContextLengths') }}</summary>
          <p>{{ t('models.contextLengthInheritHint') }}</p>
          <div class="context-list">
            <label v-for="model in modelIds" :key="model" class="context-row">
              <code :title="model">{{ model }}</code>
              <NInputNumber
                v-model:value="contextDraft[model]"
                :min="1"
                :max="100000000"
                clearable
                :placeholder="t('models.inheritDefault')"
              />
            </label>
          </div>
        </details>

        <div class="runtime-note">{{ t('models.providerReconnectHint') }}</div>
      </div>
    </NSpin>

    <template #footer>
      <div class="modal-actions">
        <NButton :disabled="saving" @click="close">{{ t('common.cancel') }}</NButton>
        <NButton
          :loading="testing"
          :disabled="loading || saving || !detail?.connection_test_supported"
          :title="detail?.connection_test_reason || t('models.testConnection')"
          @click="testDraft()"
        >
          {{ t('models.testConnection') }}
        </NButton>
        <NButton type="primary" :loading="saving" :disabled="loading || !detail" @click="save">
          {{ t('common.save') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

:global(.provider-editor-modal) {
  width: min(720px, calc(100vw - 28px));
  max-height: calc(100vh - 40px);
}

.editor-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-height: calc(100vh - 220px);
  overflow-y: auto;
  padding-inline-end: 4px;
}

.identity-note,
.section-heading,
.credential-actions,
.modal-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.identity-note {
  flex-wrap: wrap;
  color: $text-secondary;

  code {
    color: $text-primary;
  }
}

.field {
  display: flex;
  flex-direction: column;
  gap: 7px;

  > span {
    color: $text-primary;
    font-weight: 600;
  }

  small {
    color: $text-muted;
  }
}

.warning-text {
  color: $warning !important;
}

.credential-section,
.context-section {
  border: 1px solid $border-color;
  border-radius: $radius-md;
  padding: 14px;
}

.section-heading {
  justify-content: space-between;
  margin-bottom: 10px;
  font-weight: 600;
}

.credential-actions {
  justify-content: space-between;
  margin-top: 8px;
  color: $text-muted;
}

.context-section summary {
  cursor: pointer;
  font-weight: 600;
}

.context-section p,
.runtime-note {
  color: $text-muted;
  font-size: 12px;
}

.context-list,
.advanced-settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 12px;
}

.context-list {
  gap: 8px;
}

.context-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 180px;
  align-items: center;
  gap: 12px;

  code {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.runtime-note {
  padding: 10px 12px;
  border-radius: $radius-sm;
  background: color-mix(in srgb, $warning 9%, transparent);
}

.modal-actions {
  justify-content: flex-end;
}

@media (max-width: 560px) {
  .context-row {
    grid-template-columns: 1fr;
  }

  .credential-actions {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
