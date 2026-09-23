<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { NAlert, NButton, NForm, NInput, NInputNumber, NPopconfirm, NSpace, NSpin, NSwitch, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { deleteJevSettings, getJevSettings, saveJevSettings, testJevConnection, type JevSettings } from '@/api/studio/jev'
import SettingRow from '@/components/hermes/settings/SettingRow.vue'

const props = defineProps<{ profile: string }>()
const { t, te, n } = useI18n()
const message = useMessage()
const settings = ref<JevSettings | null>(null)
const apiKey = ref('')
const loading = ref(true)
const busy = ref(false)
const error = ref('')
const testResult = ref<{ model: string; durationMs: number } | null>(null)
let disposed = false
onUnmounted(() => { disposed = true })

function errorKey(err: unknown): string {
  const failure = err as { code?: string; status?: number } | null
  const key = typeof failure?.code === 'string' && failure.code.startsWith('jev_')
    ? `jev.errors.${failure.code.slice(4)}` : ''
  if (key && te(key)) return key
  if (failure?.status === 403) return 'jev.errors.forbidden'
  return 'jev.errors.unavailable'
}

async function load() {
  loading.value = true
  error.value = ''
  try { settings.value = await getJevSettings(props.profile) }
  catch (err) { if (!disposed) error.value = errorKey(err) }
  finally { loading.value = false }
}
onMounted(load)

async function perform(action: 'save' | 'delete' | 'test') {
  if (!settings.value || busy.value) return
  busy.value = true
  error.value = ''
  testResult.value = null
  // Capture the profile for the whole operation, including a late response after switching tabs.
  const profile = props.profile
  try {
    if (action === 'test') {
      const result = await testJevConnection(profile)
      if (!disposed) testResult.value = { model: result.model, durationMs: result.durationMs }
    } else {
      const { baseUrl, model, timeoutMs, ekkoMemoryEnabled } = settings.value
      const result = action === 'delete' ? await deleteJevSettings(profile)
        : await saveJevSettings(profile, { baseUrl, model, timeoutMs, ekkoMemoryEnabled, ...(apiKey.value.trim() ? { apiKey: apiKey.value.trim() } : {}) })
      if (!disposed) { settings.value = result; apiKey.value = ''; message.success(t(action === 'delete' ? 'jev.deleted' : 'common.saved')) }
    }
  } catch (err) { if (!disposed) error.value = errorKey(err) }
  finally { busy.value = false }
}
</script>

<template>
  <section class="settings-section jev-settings">
    <h3 class="section-title">JEV</h3>
    <p class="section-hint">{{ t('jev.description') }}</p>
    <NSpin :show="loading" :description="t('common.loading')">
      <NSpace v-if="error" vertical class="feedback">
        <NAlert type="error">{{ t(error) }}</NAlert>
        <NButton v-if="!settings" @click="load">{{ t('common.retry') }}</NButton>
      </NSpace>
      <NForm v-if="settings" :disabled="busy" @submit.prevent="perform('save')">
        <div class="settings-rows">
          <SettingRow :label="t('jev.baseUrl')" class="text-setting">
            <NInput v-model:value="settings.baseUrl" size="small" :input-props="{ 'aria-label': `JEV ${t('jev.baseUrl')}` }" placeholder="https://api.typesafe.ai" />
          </SettingRow>
          <SettingRow :label="t('profiles.model')" class="text-setting">
            <NInput v-model:value="settings.model" size="small" :input-props="{ 'aria-label': `JEV ${t('profiles.model')}` }" placeholder="jev-latest" />
          </SettingRow>
          <SettingRow :label="t('jev.apiKey')" :hint="t(settings.hasApiKey ? 'common.configured' : 'common.notConfigured')" class="text-setting">
            <NInput v-model:value="apiKey" size="small" :input-props="{ 'aria-label': `JEV ${t('jev.apiKey')}`, autocomplete: 'new-password' }" type="password" show-password-on="click" :placeholder="t(settings.hasApiKey ? 'jev.keyHint' : 'jev.keyPlaceholder')" />
          </SettingRow>
          <SettingRow :label="t('jev.timeout')">
            <NInputNumber :value="settings.timeoutMs" size="small" class="input-md" :min="1000" :max="120000" :step="1000" :placeholder="t('jev.timeout')" :input-props="{ 'aria-label': `JEV ${t('jev.timeout')}` }" @update:value="value => { if (value !== null) settings!.timeoutMs = value }" />
          </SettingRow>
          <SettingRow :label="t('jev.ekkoMemoryEnabled')">
            <NSwitch v-model:value="settings.ekkoMemoryEnabled" :aria-label="t('jev.ekkoMemoryEnabled')" />
          </SettingRow>
        </div>
        <div class="settings-actions">
          <NButton type="primary" :loading="busy" :disabled="busy" @click="perform('save')">{{ t('common.save') }}</NButton>
          <NButton :disabled="busy || !settings.hasApiKey" @click="perform('test')">{{ t('jev.testSaved') }}</NButton>
          <NPopconfirm :positive-text="t('common.confirm')" :negative-text="t('common.cancel')" @positive-click="perform('delete')">
            <template #trigger><NButton type="error" secondary :disabled="busy">{{ t('common.delete') }}</NButton></template>
            {{ t('jev.deleteConfirm') }}
          </NPopconfirm>
        </div>
      </NForm>
      <NAlert v-if="testResult" type="success" class="test-result" data-testid="jev-test-result">
        {{ t('jev.testSuccess', { model: testResult.model, duration: n(testResult.durationMs) }) }}
      </NAlert>
    </NSpin>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.settings-section {
  width: 100%;
  min-width: 0;
}

.section-title {
  margin: 0 0 6px;
  font-size: 18px;
  color: $text-primary;
}

.section-hint {
  margin: 0 0 16px;
  color: $text-muted;
  font-size: 13px;
  line-height: 1.6;
}

.text-setting :deep(.setting-info),
.text-setting :deep(.setting-control) {
  min-width: 0;
  flex: 1;
}

.settings-actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 16px;
}

.feedback { margin-bottom: 16px; }
.test-result { overflow-wrap: anywhere; margin-top: 16px; }
</style>
