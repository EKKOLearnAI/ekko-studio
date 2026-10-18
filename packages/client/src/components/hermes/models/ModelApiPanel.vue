<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { NAlert, NButton, NEmpty, NInput, NModal, NPopconfirm, NSelect, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { createModelApiKey, getApiModels, getModelApiKeys, modelApiBaseUrl, revokeModelApiKey, type ApiModel, type ModelApiKey } from '@/api/studio/model-api'
import { copyToClipboard } from '@/utils/clipboard'

const { t, locale } = useI18n()
const date = (value: number) => new Intl.DateTimeFormat(locale.value, { dateStyle: 'short', timeStyle: 'short' }).format(value)
const router = useRouter()
const message = useMessage()
const baseUrl = modelApiBaseUrl()
const loading = ref(true)
const busy = ref(false)
const error = ref('')
const catalogError = ref('')
const keys = ref<ModelApiKey[]>([])
const models = ref<ApiModel[]>([])
const name = ref('')
const newKey = ref('')
const selectedModel = ref<string | null>(null)
const modelOptions = computed(() => models.value.map(model => ({
  label: model.responses_supported ? model.id : `${model.id} · ${t('modelApi.unsupported')}`,
  value: model.id, disabled: !model.responses_supported,
})))
const availableCount = computed(() => models.value.filter(model => model.responses_supported).length)
const example = computed(() => `from openai import OpenAI

client = OpenAI(
    base_url=${JSON.stringify(baseUrl)},
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
    if (!models.value.some(model => model.id === selectedModel.value && model.responses_supported)) {
      selectedModel.value = models.value.find(model => model.responses_supported)?.id || null
    }
  } catch (err) { if (!disposed) error.value = err instanceof Error ? err.message : t('modelApi.failed') }
  finally { if (!disposed) loading.value = false }
}
onMounted(load)

async function create() {
  if (busy.value || !name.value.trim()) return
  busy.value = true
  try {
    const result = await createModelApiKey(name.value.trim())
    if (disposed) return
    keys.value.unshift(result.key)
    newKey.value = result.apiKey
    name.value = ''
  } catch (err) { if (!disposed) message.error(err instanceof Error ? err.message : t('modelApi.failed')) }
  finally { if (!disposed) busy.value = false }
}
async function revoke(id: string) {
  if (busy.value) return
  busy.value = true
  try {
    await revokeModelApiKey(id)
    if (disposed) return
    keys.value = keys.value.filter(key => key.id !== id)
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
      <NButton :loading="loading" :disabled="busy" @click="load">{{ t('modelApi.refresh') }}</NButton>
    </div>
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <NSpin :show="loading">
      <div v-if="!error" class="panel-sections">
        <section class="api-card" data-theme-surface="card">
          <h4>{{ t('modelApi.connection') }}</h4>
          <label class="field-label" for="model-api-base-url">{{ t('modelApi.baseUrl') }}</label>
          <div class="copy-row">
            <NInput :value="baseUrl" readonly :input-props="{ id: 'model-api-base-url' }" />
            <NButton @click="copy(baseUrl)">{{ t('common.copy') }}</NButton>
          </div>
          <p class="hint">{{ t('modelApi.addressHint') }}</p>
          <dl class="endpoints"><dt>GET</dt><dd>/models</dd><dt>POST</dt><dd>/responses</dd></dl>
        </section>

        <section class="api-card" data-theme-surface="card">
          <h4>{{ t('modelApi.keys') }}</h4>
          <p class="hint">{{ t('modelApi.keysHint') }}</p>
          <form class="create-key" @submit.prevent="create">
            <NInput v-model:value="name" :maxlength="80" :placeholder="t('modelApi.namePlaceholder')" :disabled="busy || loading" :input-props="{ 'aria-label': t('modelApi.keyName') }" />
            <NButton type="primary" attr-type="submit" :loading="busy" :disabled="loading || busy || !name.trim()">{{ t('modelApi.createKey') }}</NButton>
          </form>
          <NEmpty v-if="!loading && !keys.length" :description="t('modelApi.noKeys')" size="small" />
          <ul v-else class="key-list">
            <li v-for="key in keys" :key="key.id" class="key-row">
              <div class="key-info">
                <strong>{{ key.name }}</strong> <code>{{ key.preview }}</code>
                <p class="hint">{{ t('modelApi.createdAt', { date: date(key.createdAt) }) }} · {{ key.lastUsedAt ? t('modelApi.lastUsed', { date: date(key.lastUsedAt) }) : t('modelApi.neverUsed') }}</p>
              </div>
              <NPopconfirm :positive-text="t('modelApi.revoke')" :negative-text="t('common.cancel')" @positive-click="revoke(key.id)">
                <template #trigger><NButton type="error" secondary size="small" :disabled="busy || loading">{{ t('modelApi.revoke') }}</NButton></template>
                {{ t('modelApi.revokeConfirm', { name: key.name }) }}
              </NPopconfirm>
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
    <NModal :show="!!newKey" preset="card" :title="t('modelApi.created')" class="model-api-key-modal" :mask-closable="false" :close-on-esc="false" :closable="false">
      <p>{{ t('modelApi.oneTimeHint') }}</p>
      <NInput :value="newKey" type="password" show-password-on="click" readonly :input-props="{ 'aria-label': t('modelApi.created') }" />
      <template #footer><div class="modal-actions"><NButton type="primary" @click="copy(newKey)">{{ t('common.copy') }}</NButton><NButton @click="newKey = ''">{{ t('modelApi.savedKey') }}</NButton></div></template>
    </NModal>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.model-api-panel { min-width: 0; max-width: 1000px; }
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
.create-key { margin: 16px 0; }
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
.model-api-key-modal { width: min(540px, calc(100vw - 32px)); }
@media (max-width: 640px) {
  .api-card { padding: 16px; }
  .create-key { flex-direction: column; }
  .key-row { align-items: flex-start; }
}
</style>
