<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue'
import { NAlert, NButton, NForm, NFormItem, NInput, NModal, NSelect, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { addCustomProvider, fetchProviderModels } from '@/api/hermes/system'
import type { ProviderImport } from '@/utils/provider-import'
import type { ProviderApiMode } from '@/api/studio/provider-api-mode'

const props = defineProps<{
  draft: ProviderImport
  profile: string
  profiles: Array<{ name: string }>
}>()
const emit = defineEmits<{ close: []; saved: [profile: string] }>()
const { t } = useI18n()
const message = useMessage()
const targetProfile = ref(props.profile)
const host = new URL(props.draft.baseUrl).hostname
const generatedName = (host.charAt(0).toUpperCase() + host.slice(1)).replace(/[^\p{L}\p{N} ._-]/gu, '-').slice(0, 80)
const name = ref(props.draft.name || generatedName)
const model = ref(props.draft.model)
const apiMode = ref<ProviderApiMode | 'auto'>(props.draft.apiMode)
const modelOptions = ref(props.draft.model ? [{ label: props.draft.model, value: props.draft.model }] : [])
const fetching = ref(false)
let requestId = 0
const modes = computed(() => [
  ...['chat_completions', 'codex_responses', 'anthropic_messages'].map(value => ({ label: value, value })),
  { label: t('models.apiModeAuto'), value: 'auto' },
])
const apiKey = ref(props.draft.apiKey || '')
const saving = ref(false)
const keyInputProps = { autocomplete: 'new-password', name: 'import-provider-api-key', 'data-1p-ignore': 'true' }

watch([apiKey, targetProfile], () => { requestId++; fetching.value = false; modelOptions.value = []; model.value = '' })
onUnmounted(() => { requestId++ })
async function fetchModels() {
  const id = ++requestId
  fetching.value = true
  try {
    // Explicit user action only. Do not persist provider catalog or credentials during preview.
    const result = await fetchProviderModels({ base_url: props.draft.baseUrl, api_key: apiKey.value.trim(), update_cache: false })
    if (id !== requestId) return
    modelOptions.value = result.models.map(value => ({ label: value, value }))
    if (!model.value || !result.models.includes(model.value)) model.value = result.models[0] || ''
  } catch {
    if (id === requestId) message.error(t('models.fetchFailed'))
  } finally { if (id === requestId) fetching.value = false }
}
async function save() {
  if (saving.value || fetching.value || !props.profiles.some(p => p.name === targetProfile.value)) return
  if (!name.value.trim() || !apiKey.value.trim() || !model.value.trim()) {
    message.error(t('models.importRequired'))
    return
  }
  saving.value = true
  const profile = targetProfile.value
  try {
    await addCustomProvider({
      name: name.value.trim(), base_url: props.draft.baseUrl, model: model.value.trim(),
      api_key: apiKey.value.trim(), api_mode: apiMode.value === 'auto' ? null : apiMode.value, create_only: true,
    }, profile)
    apiKey.value = ''
    message.success(t('models.providerAdded'))
    emit('saved', profile)
  } catch (error: any) {
    message.error(error?.status === 409 ? t('models.importDuplicate') : t('models.importFailed'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <NModal :show="true" preset="card" :title="t('models.importTitle')"
    :style="{ width: 'min(520px, calc(100vw - 32px))' }"
    :mask-closable="!saving" :closable="!saving" :close-on-esc="!saving"
    @update:show="value => { if (!value && !saving) emit('close') }">
    <NAlert type="warning" :show-icon="false">{{ t('models.importNotice') }}</NAlert>
    <NForm label-placement="top" autocomplete="off">
      <NFormItem :label="t('workflow.profile')" required>
        <NSelect v-model:value="targetProfile" :disabled="saving"
          :options="profiles.map(p => ({ label: p.name, value: p.name }))" />
      </NFormItem>
      <NFormItem :label="t('models.provider')" required>
        <NInput v-model:value="name" :disabled="saving" :maxlength="80" :input-props="{ autocomplete: 'off', name: 'import-provider-name' }" />
      </NFormItem>
      <NFormItem :label="t('models.baseUrl')"><NInput :value="draft.baseUrl" readonly /></NFormItem>
      <NFormItem :label="t('models.defaultModel')" required>
        <NSelect v-model:value="model" filterable tag :options="modelOptions" :disabled="saving || fetching" />
        <NButton :loading="fetching" :disabled="saving || !apiKey.trim()" @click="fetchModels">{{ t('common.fetch') }}</NButton>
      </NFormItem>
      <NFormItem :label="t('models.apiMode')"><NSelect v-model:value="apiMode" :options="modes" :disabled="saving" /></NFormItem>
      <NFormItem :label="t('models.apiKey')" required>
        <NInput v-model:value="apiKey" type="password" show-password-on="click" :disabled="saving"
          :input-props="keyInputProps" />
      </NFormItem>
    </NForm>
    <template #footer>
      <div class="import-actions">
        <NButton :disabled="saving" @click="emit('close')">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="saving" @click="save">{{ t('models.importConfirm') }}</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.import-actions { display: flex; justify-content: flex-end; gap: calc(8px * var(--spacing-scale, 1)); }
</style>
