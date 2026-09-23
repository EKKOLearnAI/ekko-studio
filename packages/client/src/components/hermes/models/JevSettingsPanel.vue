<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
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
const memoryStatus = computed(() => !settings.value?.ekkoMemoryEnabled ? 'jev.memoryDisabled'
  : !settings.value.hasApiKey ? 'common.notConfigured'
    : !settings.value.ekkoMemoryKindRoutingEnabled && !settings.value.ekkoMemoryRelevanceFilterEnabled && !settings.value.ekkoMemoryRerankEnabled && !settings.value.ekkoMemoryWriteReviewEnabled
      ? 'jev.memoryNoFeatures' : 'jev.memoryReady')
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
      const { baseUrl, model, timeoutMs, ekkoMemoryEnabled, ekkoMemoryKindRoutingEnabled, ekkoMemoryRelevanceFilterEnabled, ekkoMemoryRerankEnabled,
        ekkoMemoryWriteReviewEnabled, ekkoMemoryCandidateLimit, ekkoMemoryRecallMinConfidence, ekkoMemoryFilterMinConfidence, ekkoMemoryMinConfidence, ekkoMemoryTimeoutMs } = settings.value
      const result = action === 'delete' ? await deleteJevSettings(profile)
        : await saveJevSettings(profile, { baseUrl, model, timeoutMs, ekkoMemoryEnabled, ekkoMemoryKindRoutingEnabled, ekkoMemoryRelevanceFilterEnabled, ekkoMemoryRerankEnabled,
          ekkoMemoryWriteReviewEnabled, ekkoMemoryCandidateLimit, ekkoMemoryRecallMinConfidence, ekkoMemoryFilterMinConfidence, ekkoMemoryMinConfidence, ekkoMemoryTimeoutMs,
          ...(apiKey.value.trim() ? { apiKey: apiKey.value.trim() } : {}) })
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
        <h4 class="group-title">{{ t('jev.connectionSettings') }}</h4>
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
        </div>
        <h4 class="group-title">{{ t('jev.useCases') }}</h4>
        <div class="settings-rows">
          <SettingRow :label="t('jev.ekkoMemoryEnabled')" :hint="t(memoryStatus)">
            <NSwitch v-model:value="settings.ekkoMemoryEnabled" :aria-label="t('jev.ekkoMemoryEnabled')" />
          </SettingRow>
        </div>
        <details class="memory-options" :open="settings.ekkoMemoryEnabled">
          <summary>{{ t('jev.memoryOptions') }}</summary>
          <p class="section-hint">{{ t('jev.memoryOptionsHint') }}</p>
          <div class="settings-rows">
            <SettingRow :label="t('jev.memoryKindRouting')" :hint="t('jev.memoryKindRoutingHint')">
              <NSwitch v-model:value="settings.ekkoMemoryKindRoutingEnabled" :aria-label="t('jev.memoryKindRouting')" />
            </SettingRow>
            <SettingRow :label="t('jev.memoryRelevanceFilter')" :hint="t('jev.memoryRelevanceFilterHint')">
              <NSwitch v-model:value="settings.ekkoMemoryRelevanceFilterEnabled" :aria-label="t('jev.memoryRelevanceFilter')" />
            </SettingRow>
            <SettingRow :label="t('jev.memoryRerank')" :hint="t('jev.memoryRerankHint')">
              <NSwitch v-model:value="settings.ekkoMemoryRerankEnabled" :aria-label="t('jev.memoryRerank')" />
            </SettingRow>
            <SettingRow :label="t('jev.memoryWriteReview')" :hint="t('jev.memoryWriteReviewHint')">
              <NSwitch v-model:value="settings.ekkoMemoryWriteReviewEnabled" :aria-label="t('jev.memoryWriteReview')" />
            </SettingRow>
          </div>
          <details class="memory-advanced">
            <summary>{{ t('jev.memoryAdvanced') }}</summary>
            <div class="settings-rows">
              <SettingRow :label="t('jev.memoryCandidateLimit')" :hint="t('jev.memoryCandidateLimitHint')">
                <NInputNumber :value="settings.ekkoMemoryCandidateLimit" @update:value="value => { if (value !== null) settings!.ekkoMemoryCandidateLimit = value }" size="small" class="input-md" :min="1" :max="50" :precision="0" :input-props="{ 'aria-label': t('jev.memoryCandidateLimit') }" />
              </SettingRow>
              <SettingRow :label="t('jev.memoryRecallMinConfidence')" :hint="t('jev.memoryRecallMinConfidenceHint')">
                <NInputNumber :value="settings.ekkoMemoryRecallMinConfidence" @update:value="value => { if (value !== null) settings!.ekkoMemoryRecallMinConfidence = value }" size="small" class="input-md" :min="0.5" :max="1" :step="0.05" :input-props="{ 'aria-label': t('jev.memoryRecallMinConfidence') }" />
              </SettingRow>
              <SettingRow :label="t('jev.memoryFilterMinConfidence')" :hint="t('jev.memoryFilterMinConfidenceHint')">
                <NInputNumber :value="settings.ekkoMemoryFilterMinConfidence" @update:value="value => { if (value !== null) settings!.ekkoMemoryFilterMinConfidence = value }" size="small" class="input-md" :min="0.5" :max="1" :step="0.05" :input-props="{ 'aria-label': t('jev.memoryFilterMinConfidence') }" />
              </SettingRow>
              <SettingRow :label="t('jev.memoryMinConfidence')" :hint="t('jev.memoryMinConfidenceHint')">
                <NInputNumber :value="settings.ekkoMemoryMinConfidence" @update:value="value => { if (value !== null) settings!.ekkoMemoryMinConfidence = value }" size="small" class="input-md" :min="0.5" :max="1" :step="0.05" :input-props="{ 'aria-label': t('jev.memoryMinConfidence') }" />
              </SettingRow>
              <SettingRow :label="t('jev.memoryTimeout')" :hint="t('jev.memoryTimeoutHint')">
                <NInputNumber :value="settings.ekkoMemoryTimeoutMs" @update:value="value => { if (value !== null) settings!.ekkoMemoryTimeoutMs = value }" size="small" class="input-md" :min="100" :max="30000" :step="100" :precision="0" :input-props="{ 'aria-label': t('jev.memoryTimeout') }" />
              </SettingRow>
            </div>
          </details>
        </details>
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
.group-title { margin: 20px 0 8px; color: $text-primary; font-size: 14px; }
.memory-options, .memory-advanced {
  margin-top: 12px;
  summary { cursor: pointer; padding: 8px 0; color: $text-primary; font-size: 13px; }
}
.test-result { overflow-wrap: anywhere; margin-top: 16px; }
</style>
