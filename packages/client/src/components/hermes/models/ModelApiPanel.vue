<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { NAlert, NButton, NEmpty, NInput, NInputNumber, NModal, NPopconfirm, NSelect, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { changeModelApiCloudLink, getModelApiCloudLink, type ModelApiCloudLink, createModelApiKey, editModelApiKey, getApiModels, getModelApiKeys, modelApiBaseUrl, revokeModelApiKey, type ApiModel, type ModelApiKey } from '@/api/studio/model-api'
import { copyToClipboard } from '@/utils/clipboard'
import ModelApiModelsModal from './ModelApiModelsModal.vue'

const { t, locale } = useI18n()
const date = (value: number) => new Intl.DateTimeFormat(locale.value, { dateStyle: 'short', timeStyle: 'short' }).format(value)
const router = useRouter()
const message = useMessage()
const localBaseUrl = modelApiBaseUrl()
const cloudLink = ref<ModelApiCloudLink>({ available: false, urls: null })
const cloudBusy = ref(false)
const addressRoute = ref('local')
const addressOptions = computed(() => [
  { label: t('modelApi.localRoute'), value: 'local' },
  ...(cloudLink.value.urls ? [{ label: t('modelApi.officialRoute'), value: 'official' }, { label: 'Cloudflare', value: 'cloudflare' }] : []),
])
const baseUrl = computed(() => addressRoute.value === 'local' ? localBaseUrl : cloudLink.value.urls?.[addressRoute.value as 'official' | 'cloudflare'] || localBaseUrl)
let cloudSequence = 0
async function loadCloudLink() {
  if (cloudBusy.value) return
  const sequence = ++cloudSequence
  try { const result = await getModelApiCloudLink(abort.signal); if (!disposed && sequence === cloudSequence) cloudLink.value = result }
  catch { if (!disposed && sequence === cloudSequence) cloudLink.value = { available: false, urls: null } }
  if (!cloudLink.value.urls) addressRoute.value = 'local'
}
async function changeCloudLink(action: 'create' | 'rotate' | 'revoke') {
  if (cloudBusy.value) return
  cloudBusy.value = true
  ++cloudSequence
  try {
    const result = await changeModelApiCloudLink(action)
    if (disposed) return
    cloudLink.value = result
    if (!result.available) message.error(t('modelApi.cloudUnavailable'))
    addressRoute.value = result.urls ? 'official' : 'local'
  } catch { if (!disposed) message.error(t('modelApi.failed')) }
  finally { if (!disposed) cloudBusy.value = false }
}
const loading = ref(true)
const busy = ref(false)
const error = ref('')
const catalogError = ref('')
const keys = ref<ModelApiKey[]>([])
const models = ref<ApiModel[]>([])
const name = ref('')
const budgetUsd = ref<number | null>(null)
const editingKeyId = ref('')
const selectedKeyModels = ref<string[]>([])
const modelPickerVisible = ref(false)
const keyForm = ref<HTMLFormElement | null>(null)
let keySelectionInitialized = false
const callableModels = computed(() => models.value.filter(model => model.responses_supported))
const canSaveKey = computed(() => !loading.value && !busy.value && !catalogError.value && !!name.value.trim() && selectedKeyModels.value.length > 0 && (budgetUsd.value === null || (Number.isFinite(budgetUsd.value) && budgetUsd.value >= 0 && budgetUsd.value <= 1_000_000)))
const newKey = ref('')
const selectedModel = ref<string | null>(null)
const modelOptions = computed(() => models.value.map(model => ({
  label: model.responses_supported ? model.id : `${model.id} · ${t('modelApi.unsupported')}`,
  value: model.id, disabled: !model.responses_supported,
})))
const availableCount = computed(() => models.value.filter(model => model.responses_supported).length)
const example = computed(() => `from openai import OpenAI

client = OpenAI(
    base_url=${JSON.stringify(baseUrl.value)},
    api_key="YOUR_MODEL_API_KEY",
)
response = client.responses.create(
    model=${JSON.stringify(selectedModel.value || 'provider/model')},
    input="Hello",
    store=False,
)
print(response.output_text)`)
const abort = new AbortController()
let disposed = false
onUnmounted(() => { disposed = true; newKey.value = ''; abort.abort() })

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [keyList, catalog] = await Promise.allSettled([getModelApiKeys(abort.signal), getApiModels(abort.signal)])
    if (disposed) return
    if (keyList.status === 'rejected') throw keyList.reason
    keys.value = keyList.value.keys
    catalogError.value = catalog.status === 'rejected'
      ? catalog.reason instanceof Error ? catalog.reason.message : t('modelApi.failed') : ''
    models.value = catalog.status === 'fulfilled' ? catalog.value.data : []
    if (catalog.status === 'fulfilled') {
      const available = new Set(callableModels.value.map(model => model.id))
      selectedKeyModels.value = keySelectionInitialized ? selectedKeyModels.value.filter(id => available.has(id)) : [...available]
      keySelectionInitialized = true
    }
    if (!models.value.some(model => model.id === selectedModel.value && model.responses_supported)) {
      selectedModel.value = models.value.find(model => model.responses_supported)?.id || null
    }
  } catch (err) { if (!disposed) error.value = err instanceof Error ? err.message : t('modelApi.failed') }
  finally { if (!disposed) loading.value = false }
}
onMounted(() => { void load(); void loadCloudLink() })

async function create() {
  if (!canSaveKey.value) return
  busy.value = true
  try {
    if (editingKeyId.value) {
      const result = await editModelApiKey(editingKeyId.value, name.value.trim(), [...selectedKeyModels.value], budgetUsd.value)
      if (disposed) return
      keys.value = keys.value.map(key => key.id === result.key.id ? result.key : key)
      message.success(t('modelApi.saved'))
    } else {
      const result = await createModelApiKey(name.value.trim(), [...selectedKeyModels.value], budgetUsd.value)
      if (disposed) return
      keys.value.unshift(result.key)
      newKey.value = result.apiKey
    }
    resetKeyForm()
  } catch (err) { if (!disposed) message.error(err instanceof Error ? err.message : t('modelApi.failed')) }
  finally { if (!disposed) busy.value = false }
}
function resetKeyForm() {
  modelPickerVisible.value = false
  editingKeyId.value = ''
  name.value = ''
  budgetUsd.value = null
  selectedKeyModels.value = callableModels.value.map(model => model.id)
}
function edit(key: ModelApiKey) {
  if (busy.value || loading.value || catalogError.value) return
  editingKeyId.value = key.id
  name.value = key.name
  budgetUsd.value = key.budgetUsd
  const available = new Set(callableModels.value.map(model => model.id))
  selectedKeyModels.value = key.models.filter(id => available.has(id))
  void nextTick(() => keyForm.value?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
}
function dollars(value: number) { return new Intl.NumberFormat(locale.value, { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value) }
function keyBudget(key: ModelApiKey) {
  return t('modelApi.budgetUsage', { used: dollars(key.spentUsd), limit: key.budgetUsd === null ? t('modelApi.unlimited') : `${dollars(key.budgetUsd)} USD` })
}
function applyKeyModels(models: string[]) {
  const selected = new Set(models)
  selectedKeyModels.value = callableModels.value.filter(model => selected.has(model.id)).map(model => model.id)
  modelPickerVisible.value = false
}
async function revoke(id: string) {
  if (busy.value) return
  busy.value = true
  try {
    await revokeModelApiKey(id)
    if (disposed) return
    keys.value = keys.value.filter(key => key.id !== id)
    if (editingKeyId.value === id) resetKeyForm()
    message.success(t('modelApi.revoked'))
  } catch (err) { if (!disposed) message.error(err instanceof Error ? err.message : t('modelApi.failed')) }
  finally { if (!disposed) busy.value = false }
}
async function copy(value: string) {
  const copied = await copyToClipboard(value)
  if (!disposed) message[copied ? 'success' : 'error'](t(copied ? 'common.copied' : 'modelApi.copyFailed'))
}
</script>

<template>
  <section class="model-api-panel" data-testid="model-api-panel" :aria-busy="loading">
    <div class="panel-heading">
      <div><h3>{{ t('modelApi.title') }}</h3><p class="hint">{{ t('modelApi.description') }}</p></div>
      <NButton :loading="loading" :disabled="busy" @click="load(); loadCloudLink()">{{ t('modelApi.refresh') }}</NButton>
    </div>
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <NSpin :show="loading">
      <div v-if="!error" class="panel-sections">
        <section class="api-card" data-theme-surface="card">
          <h4>{{ t('modelApi.connection') }}</h4>
          <NSelect v-model:value="addressRoute" :options="addressOptions" :aria-label="t('modelApi.connectionRoute')" />
          <label class="field-label" for="model-api-base-url">{{ t('modelApi.baseUrl') }}</label>
          <div class="copy-row">
            <NInput :value="baseUrl" readonly :input-props="{ id: 'model-api-base-url' }" />
            <NButton @click="copy(baseUrl)">{{ t('common.copy') }}</NButton>
          </div>
          <p class="hint">{{ t('modelApi.addressHint') }}</p>
          <p class="hint">{{ t('modelApi.cloudHint') }}</p>
          <p v-if="!cloudLink.available" class="hint">{{ t('modelApi.cloudUnavailable') }}</p>
          <div v-if="cloudLink.available" class="form-actions">
            <NButton v-if="!cloudLink.urls" :loading="cloudBusy" @click="changeCloudLink('create')">{{ t('modelApi.createCloudLink') }}</NButton>
            <template v-else>
              <NPopconfirm @positive-click="changeCloudLink('rotate')"><template #trigger><NButton :disabled="cloudBusy">{{ t('modelApi.rotateCloudLink') }}</NButton></template>{{ t('modelApi.cloudRevokeHint') }}</NPopconfirm>
              <NPopconfirm @positive-click="changeCloudLink('revoke')"><template #trigger><NButton :disabled="cloudBusy">{{ t('modelApi.revokeCloudLink') }}</NButton></template>{{ t('modelApi.cloudRevokeHint') }}</NPopconfirm>
            </template>
          </div>
          <dl class="endpoints"><dt>GET</dt><dd>/models</dd><dt>POST</dt><dd>/responses</dd></dl>
        </section>

        <section class="api-card" data-theme-surface="card">
          <h4>{{ t('modelApi.keys') }}</h4>
          <p class="hint">{{ t('modelApi.keysHint') }}</p>
          <form ref="keyForm" class="create-key" @submit.prevent="create">
            <h4 v-if="editingKeyId">{{ t('modelApi.editKey') }}</h4>
            <NInput v-model:value="name" :maxlength="80" :placeholder="t('modelApi.namePlaceholder')" :disabled="busy || loading" :input-props="{ 'aria-label': t('modelApi.keyName') }" />
            <label class="field-label">{{ t('modelApi.allowedModels') }}</label>
            <NButton class="key-model-trigger" :disabled="busy || loading || !!catalogError" :aria-label="t('modelApi.selectModels')" @click="modelPickerVisible = true">{{ t('modelApi.selectModels') }} · {{ t('modelApi.selectedModels', { count: selectedKeyModels.length }) }}</NButton>
            <p class="hint">{{ t('modelApi.selectionHint') }}</p>
            <label class="field-label">{{ t('modelApi.budgetLabel') }}</label>
            <NInputNumber v-model:value="budgetUsd" :min="0" :max="1000000" :show-button="false" clearable :disabled="busy || loading" :placeholder="t('modelApi.unlimited')" :input-props="{ 'aria-label': t('modelApi.budgetLabel') }" />
            <p class="hint">{{ t('modelApi.budgetHint') }}</p>
            <div class="form-actions"><NButton v-if="editingKeyId" :disabled="busy" @click="resetKeyForm">{{ t('common.cancel') }}</NButton><NButton type="primary" attr-type="submit" :loading="busy" :disabled="!canSaveKey">{{ t(editingKeyId ? 'modelApi.saveKey' : 'modelApi.createKey') }}</NButton></div>
          </form>
          <NEmpty v-if="!loading && !keys.length" :description="t('modelApi.noKeys')" size="small" />
          <ul v-else class="key-list">
            <li v-for="key in keys" :key="key.id" class="key-row">
              <div class="key-info">
                <strong>{{ key.name }}</strong> <code>{{ key.preview }}</code>
                <p class="hint key-models" :title="key.models.join(', ')">{{ t('modelApi.keyModels', { count: key.models.length }) }} · {{ key.models.slice(0, 3).join(', ') }}{{ key.models.length > 3 ? ' …' : '' }}</p>
                <p class="hint key-budget">{{ keyBudget(key) }}<template v-if="key.budgetUsd !== null && key.spentUsd >= key.budgetUsd"> · {{ t('modelApi.budgetExhausted') }}</template></p>
                <p v-if="key.unpricedRequests" class="hint">{{ t('modelApi.budgetUnknown') }}</p>
                <p class="hint">{{ t('modelApi.createdAt', { date: date(key.createdAt) }) }} · {{ key.lastUsedAt ? t('modelApi.lastUsed', { date: date(key.lastUsedAt) }) : t('modelApi.neverUsed') }}</p>
              </div>
              <div class="key-actions"><NButton size="small" :disabled="busy || loading || !!catalogError" @click="edit(key)">{{ t('modelApi.editKey') }}</NButton><NPopconfirm :positive-text="t('modelApi.revoke')" :negative-text="t('common.cancel')" @positive-click="revoke(key.id)">
                <template #trigger><NButton type="error" secondary size="small" :disabled="busy || loading">{{ t('modelApi.revoke') }}</NButton></template>
                {{ t('modelApi.revokeConfirm', { name: key.name }) }}
              </NPopconfirm></div>
            </li>
          </ul>
        </section>

        <section class="api-card" data-theme-surface="card">
          <h4>{{ t('modelApi.models') }}</h4>
          <NAlert v-if="catalogError" type="error" role="alert">{{ catalogError }}</NAlert>
          <p class="hint">{{ t('modelApi.modelsHint', { available: availableCount, total: models.length }) }}</p>
          <NSelect v-model:value="selectedModel" :options="modelOptions" :loading="loading" :disabled="loading || !models.length" filterable :placeholder="t('modelApi.selectModel')" :aria-label="t('modelApi.selectModel')" />
          <div v-if="selectedModel" class="model-id"><code>{{ selectedModel }}</code><NButton size="small" @click="copy(selectedModel)">{{ t('modelApi.copyModel') }}</NButton></div>
          <NEmpty v-if="!loading && !catalogError && !models.length" :description="t('modelApi.noModels')" size="small" />
          <template v-if="selectedModel">
            <div class="example-heading"><h4>{{ t('modelApi.example') }}</h4><NButton size="small" @click="copy(example)">{{ t('common.copy') }}</NButton></div>
            <pre class="request-example"><code>{{ example }}</code></pre>
          </template>
          <p class="hint">{{ t('modelApi.historyHint') }}</p>
        </section>

        <section class="api-card" data-theme-surface="card">
          <h4>{{ t('modelApi.usage') }}</h4>
          <p class="hint">{{ t('modelApi.usageHint') }}</p>
          <NButton @click="router.push({ name: 'hermes.usage', query: { origin: 'external' } })">{{ t('modelApi.viewUsage') }}</NButton>
        </section>
      </div>
    </NSpin>
    <ModelApiModelsModal :visible="modelPickerVisible" :models="models" :selected="selectedKeyModels" @confirm="applyKeyModels" @cancel="modelPickerVisible = false" />
    <NModal :show="!!newKey" preset="card" :title="t('modelApi.created')" class="model-api-key-modal" :style="{ width: 'min(540px, calc(100vw - 32px))' }" :mask-closable="false" :close-on-esc="false" :closable="false">
      <p>{{ t('modelApi.oneTimeHint') }}</p>
      <NInput :value="newKey" type="password" show-password-on="click" readonly :input-props="{ 'aria-label': t('modelApi.created') }" />
      <template #footer><div class="modal-actions"><NButton type="primary" @click="copy(newKey)">{{ t('common.copy') }}</NButton><NButton @click="newKey = ''">{{ t('modelApi.savedKey') }}</NButton></div></template>
    </NModal>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.model-api-panel { min-width: 0; width: 100%; }
.panel-heading, .example-heading, .model-id, .key-row { display: flex; align-items: center; justify-content: space-between; gap: calc(12px * var(--spacing-scale, 1)); }
.panel-heading { align-items: flex-start; margin-bottom: 20px; }
h3, h4 { margin: 0; color: $text-primary; }
h3 { font-size: calc(var(--font-size-base, 14px) * 18 / 14); }
h4 { font-size: var(--font-size-base, 14px); }
.hint { margin: 8px 0 12px; color: $text-secondary; line-height: var(--line-height, 1.6); overflow-wrap: anywhere; }
.panel-sections { display: grid; gap: calc(16px * var(--spacing-scale, 1)); }
.api-card { min-width: 0; padding: calc(20px * var(--spacing-scale, 1)); border: var(--border-width, 1px) solid $border-color; border-radius: var(--radius-component, 12px); }
.field-label { display: block; margin: 16px 0 8px; color: $text-primary; }
.copy-row, .create-key, .modal-actions { display: flex; gap: calc(8px * var(--spacing-scale, 1)); }
.copy-row :deep(.n-input), .create-key :deep(.n-input) { min-width: 0; flex: 1; }
.create-key { margin: 16px 0; flex-direction: column; }
.create-key .field-label, .create-key .hint { margin: 0; }
.form-actions, .key-actions { display: flex; gap: calc(8px * var(--spacing-scale, 1)); flex-wrap: wrap; }
.key-actions { flex-shrink: 0; justify-content: flex-end; }
.endpoints { display: grid; grid-template-columns: auto 1fr; gap: 8px 16px; margin-bottom: 0; }
.endpoints dd { margin: 0; font-family: monospace; }
.key-list { list-style: none; padding: 0; margin: 0; }
.key-row { padding: 12px 0; border-top: var(--border-width, 1px) solid $border-light; }
.key-info { min-width: 0; overflow-wrap: anywhere; }
.key-info code { color: $text-secondary; margin-inline-start: 8px; }
.key-info .hint { margin-bottom: 0; font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
.model-id { margin-top: 12px; overflow-wrap: anywhere; }
.model-id code { min-width: 0; }
.example-heading { margin-top: 24px; }
.request-example { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; color: $text-primary; font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
.modal-actions { justify-content: flex-end; flex-wrap: wrap; }
@media (max-width: 640px) {
  .api-card { padding: 16px; }
  .create-key { flex-direction: column; }
  .key-row { align-items: flex-start; }
  .key-actions { flex-direction: column; }
}
</style>
