<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { NAlert, NButton, NForm, NFormItem, NInput, NInputNumber, NPopconfirm, NSpace, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { deleteJevSettings, getJevSettings, saveJevSettings, testJevConnection, type JevSettings } from '@/api/studio/jev'

const props = defineProps<{ profile: string }>()
const { t } = useI18n()
const message = useMessage()
const settings = ref<JevSettings | null>(null)
const apiKey = ref('')
const loading = ref(true)
const busy = ref(false)
const error = ref('')
const testResult = ref('')
let disposed = false
onUnmounted(() => { disposed = true })

async function load() {
  loading.value = true
  error.value = ''
  try { settings.value = await getJevSettings(props.profile) }
  catch (err: any) { if (!disposed) error.value = err.message }
  finally { loading.value = false }
}
onMounted(load)

async function perform(action: 'save' | 'delete' | 'test') {
  if (!settings.value || busy.value) return
  busy.value = true
  error.value = ''
  testResult.value = ''
  // Capture the profile for the whole operation, including a late response after switching tabs.
  const profile = props.profile
  try {
    if (action === 'test') {
      const result = await testJevConnection(profile)
      if (!disposed) testResult.value = JSON.stringify(result, null, 2)
    } else {
      const { baseUrl, model, timeoutMs } = settings.value
      const result = action === 'delete' ? await deleteJevSettings(profile)
        : await saveJevSettings(profile, { baseUrl, model, timeoutMs, ...(apiKey.value.trim() ? { apiKey: apiKey.value.trim() } : {}) })
      if (!disposed) { settings.value = result; apiKey.value = ''; message.success(t('common.saved')) }
    }
  } catch (err: any) { if (!disposed) error.value = err.message }
  finally { busy.value = false }
}
</script>

<template>
  <section class="jev-settings">
    <p class="description">{{ t('jev.description') }}</p>
    <NSpin :show="loading">
      <NSpace v-if="error" vertical class="feedback">
        <NAlert type="error">{{ error }}</NAlert>
        <NButton v-if="!settings" @click="load">{{ t('common.retry') }}</NButton>
      </NSpace>
      <NForm v-if="settings" :disabled="busy" label-placement="top" @submit.prevent="perform('save')">
        <NFormItem :label="t('models.baseUrl')">
          <NInput v-model:value="settings.baseUrl" :input-props="{ 'aria-label': 'JEV Base URL' }" placeholder="https://api.typesafe.ai" />
        </NFormItem>
        <NFormItem :label="t('profiles.model')">
          <NInput v-model:value="settings.model" :input-props="{ 'aria-label': 'JEV Model' }" placeholder="jev-latest" />
        </NFormItem>
        <NFormItem :label="t('models.apiKey')">
          <div class="key-field">
            <NInput v-model:value="apiKey" :input-props="{ 'aria-label': 'JEV API Key', autocomplete: 'new-password' }" type="password" show-password-on="click" :placeholder="settings.hasApiKey ? t('jev.keyHint') : 'API Key'" />
            <small>{{ t(settings.hasApiKey ? 'common.configured' : 'common.notConfigured') }}</small>
          </div>
        </NFormItem>
        <NFormItem :label="t('jev.timeout')">
          <NInputNumber :value="settings.timeoutMs" :min="1000" :max="120000" :step="1000" :input-props="{ 'aria-label': 'JEV Timeout' }" @update:value="value => { if (value !== null) settings!.timeoutMs = value }" />
        </NFormItem>
        <NSpace>
          <NButton type="primary" :loading="busy" :disabled="busy" @click="perform('save')">{{ t('common.save') }}</NButton>
          <NButton :disabled="busy || !settings.hasApiKey" @click="perform('test')">{{ t('jev.testSaved') }}</NButton>
          <NPopconfirm :positive-text="t('common.confirm')" :negative-text="t('common.cancel')" @positive-click="perform('delete')">
            <template #trigger><NButton type="error" secondary :disabled="busy">{{ t('common.delete') }}</NButton></template>
            {{ t('jev.deleteConfirm') }}
          </NPopconfirm>
        </NSpace>
      </NForm>
      <pre v-if="testResult" class="test-result" data-testid="jev-test-result">{{ testResult }}</pre>
    </NSpin>
  </section>
</template>

<style scoped lang="scss">
.jev-settings { max-width: 680px; }
.description { margin: 0 0 20px; opacity: 0.75; line-height: 1.6; }
.key-field { width: 100%; small { display: block; margin-top: 6px; opacity: 0.7; } }
.feedback { margin-bottom: 16px; }
.test-result { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 20px; }
</style>
