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
const routingStatus = computed(() => !settings.value?.groupMessageRoutingEnabled ? 'jev.groupRoutingDisabled' : !settings.value.hasApiKey ? 'common.notConfigured' : 'jev.groupRoutingReady')
const workflowStatus = computed(() => !settings.value?.workflowQualityEnabled ? 'jev.workflowQualityDisabled' : !settings.value.hasApiKey ? 'common.notConfigured' : 'jev.workflowQualityReady')
const summaryStatus = computed(() => !settings.value?.groupSummaryReviewEnabled ? 'jev.groupSummaryDisabled' : !settings.value.hasApiKey ? 'common.notConfigured' : 'jev.groupSummaryReady')
const skillsStatus = computed(() => !settings.value?.ekkoSkillsEnabled ? 'jev.skillsDisabled'
  : !settings.value.hasApiKey ? 'common.notConfigured' : 'jev.skillsReady')
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
      const { groupSummaryReviewEnabled, groupSummaryReviewMinConfidence, groupSummaryReviewTimeoutMs, workflowQualityEnabled, workflowQualityMinConfidence, workflowQualityTimeoutMs, groupMessageRoutingEnabled, groupMessageRoutingMinConfidence, groupMessageRoutingTimeoutMs, browserMatchEnabled, browserMatchCandidateLimit, browserMatchMinConfidence, browserMatchTimeoutMs, browserVerifyEnabled, browserVerifyMinConfidence, browserVerifyTimeoutMs, baseUrl, model, timeoutMs, ekkoSkillsEnabled, ekkoSkillsCandidateLimit, ekkoSkillsMinConfidence, ekkoSkillsTimeoutMs, ekkoMemoryEnabled, ekkoMemoryKindRoutingEnabled, ekkoMemoryRelevanceFilterEnabled, ekkoMemoryRerankEnabled,
        ekkoMemoryWriteReviewEnabled, ekkoMemoryCandidateLimit, ekkoMemoryRecallMinConfidence, ekkoMemoryFilterMinConfidence, ekkoMemoryMinConfidence, ekkoMemoryTimeoutMs } = settings.value
      const result = action === 'delete' ? await deleteJevSettings(profile)
        : await saveJevSettings(profile, { groupSummaryReviewEnabled, groupSummaryReviewMinConfidence, groupSummaryReviewTimeoutMs, workflowQualityEnabled, workflowQualityMinConfidence, workflowQualityTimeoutMs, groupMessageRoutingEnabled, groupMessageRoutingMinConfidence, groupMessageRoutingTimeoutMs, browserMatchEnabled, browserMatchCandidateLimit, browserMatchMinConfidence, browserMatchTimeoutMs, browserVerifyEnabled, browserVerifyMinConfidence, browserVerifyTimeoutMs, baseUrl, model, timeoutMs, ekkoSkillsEnabled, ekkoSkillsCandidateLimit, ekkoSkillsMinConfidence, ekkoSkillsTimeoutMs, ekkoMemoryEnabled, ekkoMemoryKindRoutingEnabled, ekkoMemoryRelevanceFilterEnabled, ekkoMemoryRerankEnabled,
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
      <NForm v-if="settings" class="jev-form" :disabled="busy" @submit.prevent="perform('save')">
        <section class="config-card connection-card" :aria-label="t('jev.connectionSettings')">
          <header class="card-header">
            <h4 class="card-title">{{ t('jev.connectionSettings') }}</h4>
          </header>
          <div class="settings-rows connection-fields">
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
        </section>
        <section class="config-group" :aria-label="t('jev.useCases')">
          <h4 class="group-title">{{ t('jev.useCases') }}</h4>
          <div class="config-grid">
            <section class="config-card" :aria-label="t('jev.ekkoMemoryEnabled')">
              <header class="card-header">
                <h5 class="card-title">{{ t('jev.ekkoMemoryEnabled') }}</h5>
                <NSwitch v-model:value="settings.ekkoMemoryEnabled" :aria-label="t('jev.ekkoMemoryEnabled')" />
              </header>
              <p class="card-hint">{{ t(memoryStatus) }}</p>
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
            </section>
            <section class="config-card" :aria-label="t('jev.ekkoSkillsEnabled')">
              <header class="card-header">
                <h5 class="card-title">{{ t('jev.ekkoSkillsEnabled') }}</h5>
                <NSwitch v-model:value="settings.ekkoSkillsEnabled" :aria-label="t('jev.ekkoSkillsEnabled')" />
              </header>
              <p class="card-hint">{{ t(skillsStatus) }}</p>
              <details class="skills-options" :open="settings.ekkoSkillsEnabled">
                <summary>{{ t('jev.skillsOptions') }}</summary>
                <p class="section-hint">{{ t('jev.skillsOptionsHint') }}</p>
                <div class="settings-rows">
                  <SettingRow :label="t('jev.skillsCandidateLimit')" :hint="t('jev.skillsCandidateLimitHint')">
                    <NInputNumber :value="settings.ekkoSkillsCandidateLimit" @update:value="value => { if (value !== null) settings!.ekkoSkillsCandidateLimit = value }" size="small" class="input-md" :min="1" :max="50" :precision="0" :input-props="{ 'aria-label': t('jev.skillsCandidateLimit') }" />
                  </SettingRow>
                  <SettingRow :label="t('jev.skillsMinConfidence')" :hint="t('jev.skillsMinConfidenceHint')">
                    <NInputNumber :value="settings.ekkoSkillsMinConfidence" @update:value="value => { if (value !== null) settings!.ekkoSkillsMinConfidence = value }" size="small" class="input-md" :min="0.5" :max="1" :step="0.05" :input-props="{ 'aria-label': t('jev.skillsMinConfidence') }" />
                  </SettingRow>
                  <SettingRow :label="t('jev.skillsTimeout')" :hint="t('jev.skillsTimeoutHint')">
                    <NInputNumber :value="settings.ekkoSkillsTimeoutMs" @update:value="value => { if (value !== null) settings!.ekkoSkillsTimeoutMs = value }" size="small" class="input-md" :min="100" :max="30000" :step="100" :precision="0" :input-props="{ 'aria-label': t('jev.skillsTimeout') }" />
                  </SettingRow>
                </div>
              </details>
            </section>
          </div>
        </section>
        <section class="config-group" :aria-label="t('jev.groupMessageRoutingEnabled')">
          <h4 class="group-title">{{ t('jev.groupMessageRoutingEnabled') }}</h4>
          <div class="config-grid">
            <section class="config-card"><header class="card-header"><h5 class="card-title">{{ t('jev.groupMessageRoutingEnabled') }}</h5><NSwitch v-model:value="settings.groupMessageRoutingEnabled" :aria-label="t('jev.groupMessageRoutingEnabled')" /></header><p class="card-hint">{{ t(routingStatus) }}</p><div class="settings-rows"><SettingRow :label="t('jev.groupMessageRoutingMinConfidence')" :hint="t('jev.groupMessageRoutingMinConfidenceHint')"><NInputNumber :value="settings.groupMessageRoutingMinConfidence" @update:value="value => { if (value !== null) settings!.groupMessageRoutingMinConfidence = value }" size="small" class="input-md" :min="0.5" :max="1" :step="0.05" /></SettingRow><SettingRow :label="t('jev.groupMessageRoutingTimeout')" :hint="t('jev.groupMessageRoutingTimeoutHint')"><NInputNumber :value="settings.groupMessageRoutingTimeoutMs" @update:value="value => { if (value !== null) settings!.groupMessageRoutingTimeoutMs = value }" size="small" class="input-md" :min="100" :max="30000" :step="100" /></SettingRow></div></section>
            <section class="config-card"><header class="card-header"><h5 class="card-title">{{ t('jev.workflowQualityEnabled') }}</h5><NSwitch v-model:value="settings.workflowQualityEnabled" :aria-label="t('jev.workflowQualityEnabled')" /></header><p class="card-hint">{{ t(workflowStatus) }}</p><div class="settings-rows"><SettingRow :label="t('jev.workflowQualityMinConfidence')" :hint="t('jev.workflowQualityMinConfidenceHint')"><NInputNumber :value="settings.workflowQualityMinConfidence" @update:value="value => { if (value !== null) settings!.workflowQualityMinConfidence = value }" size="small" class="input-md" :min="0.5" :max="1" :step="0.05" :input-props="{ 'aria-label': t('jev.workflowQualityMinConfidence') }" /></SettingRow><SettingRow :label="t('jev.workflowQualityTimeout')" :hint="t('jev.workflowQualityTimeoutHint')"><NInputNumber :value="settings.workflowQualityTimeoutMs" @update:value="value => { if (value !== null) settings!.workflowQualityTimeoutMs = value }" size="small" class="input-md" :min="100" :max="30000" :step="100" :input-props="{ 'aria-label': t('jev.workflowQualityTimeout') }" /></SettingRow></div></section>
            <section class="config-card"><header class="card-header"><h5 class="card-title">{{ t('jev.groupSummaryReviewEnabled') }}</h5><NSwitch v-model:value="settings.groupSummaryReviewEnabled" :aria-label="t('jev.groupSummaryReviewEnabled')" /></header><p class="card-hint">{{ t(summaryStatus) }}</p><div class="settings-rows"><SettingRow :label="t('jev.groupSummaryReviewMinConfidence')" :hint="t('jev.groupSummaryReviewMinConfidenceHint')"><NInputNumber :value="settings.groupSummaryReviewMinConfidence" @update:value="value => { if (value !== null) settings!.groupSummaryReviewMinConfidence = value }" size="small" class="input-md" :min="0.5" :max="1" :step="0.05" :input-props="{ 'aria-label': t('jev.groupSummaryReviewMinConfidence') }" /></SettingRow><SettingRow :label="t('jev.groupSummaryReviewTimeout')" :hint="t('jev.groupSummaryReviewTimeoutHint')"><NInputNumber :value="settings.groupSummaryReviewTimeoutMs" @update:value="value => { if (value !== null) settings!.groupSummaryReviewTimeoutMs = value }" size="small" class="input-md" :min="100" :max="30000" :step="100" :precision="0" :input-props="{ 'aria-label': t('jev.groupSummaryReviewTimeout') }" /></SettingRow></div></section>
          </div>
        </section>
        <section class="config-group" :aria-label="t('jev.browserAutomation')">
          <h4 class="group-title">{{ t('jev.browserAutomation') }}</h4>
          <p class="section-hint">{{ t('jev.browserAutomationHint') }}</p>
          <div class="config-grid">
            <section class="config-card" :aria-label="t('jev.browserMatchEnabled')">
              <header class="card-header">
                <h5 class="card-title">{{ t('jev.browserMatchEnabled') }}</h5>
                <NSwitch v-model:value="settings.browserMatchEnabled" :aria-label="t('jev.browserMatchEnabled')" />
              </header>
              <p class="card-hint">{{ t('jev.browserMatchHint') }}</p>
              <details class="browser-options" :open="settings.browserMatchEnabled">
                <summary>{{ t('jev.browserMatchOptions') }}</summary>
                <div class="settings-rows">
                  <SettingRow :label="t('jev.browserMatchCandidateLimit')">
                    <NInputNumber :value="settings.browserMatchCandidateLimit" @update:value="value => { if (value !== null) settings!.browserMatchCandidateLimit = value }" size="small" class="input-md" :min="1" :max="50" :precision="0" :input-props="{ 'aria-label': t('jev.browserMatchCandidateLimit') }" />
                  </SettingRow>
                  <SettingRow :label="t('jev.browserMatchMinConfidence')">
                    <NInputNumber :value="settings.browserMatchMinConfidence" @update:value="value => { if (value !== null) settings!.browserMatchMinConfidence = value }" size="small" class="input-md" :min="0.5" :max="1" :step="0.05" :input-props="{ 'aria-label': t('jev.browserMatchMinConfidence') }" />
                  </SettingRow>
                  <SettingRow :label="t('jev.browserMatchTimeoutMs')">
                    <NInputNumber :value="settings.browserMatchTimeoutMs" @update:value="value => { if (value !== null) settings!.browserMatchTimeoutMs = value }" size="small" class="input-md" :min="100" :max="30000" :step="100" :precision="0" :input-props="{ 'aria-label': t('jev.browserMatchTimeoutMs') }" />
                  </SettingRow>
                </div>
              </details>
            </section>
            <section class="config-card" :aria-label="t('jev.browserVerifyEnabled')">
              <header class="card-header">
                <h5 class="card-title">{{ t('jev.browserVerifyEnabled') }}</h5>
                <NSwitch v-model:value="settings.browserVerifyEnabled" :aria-label="t('jev.browserVerifyEnabled')" />
              </header>
              <p class="card-hint">{{ t('jev.browserVerifyHint') }}</p>
              <details class="browser-options" :open="settings.browserVerifyEnabled">
                <summary>{{ t('jev.browserVerifyOptions') }}</summary>
                <div class="settings-rows">
                  <SettingRow :label="t('jev.browserVerifyMinConfidence')">
                    <NInputNumber :value="settings.browserVerifyMinConfidence" @update:value="value => { if (value !== null) settings!.browserVerifyMinConfidence = value }" size="small" class="input-md" :min="0.5" :max="1" :step="0.05" :input-props="{ 'aria-label': t('jev.browserVerifyMinConfidence') }" />
                  </SettingRow>
                  <SettingRow :label="t('jev.browserVerifyTimeoutMs')">
                    <NInputNumber :value="settings.browserVerifyTimeoutMs" @update:value="value => { if (value !== null) settings!.browserVerifyTimeoutMs = value }" size="small" class="input-md" :min="100" :max="30000" :step="100" :precision="0" :input-props="{ 'aria-label': t('jev.browserVerifyTimeoutMs') }" />
                  </SettingRow>
                </div>
              </details>
            </section>
          </div>
        </section>
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
  container-type: inline-size;
}

.section-title {
  margin: 0 0 6px;
  font-size: 18px;
  color: $text-primary;
}

.section-hint,
.card-hint {
  margin: 0;
  color: $text-secondary;
  font-size: 13px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.section-hint { margin-bottom: 16px; }
.card-hint { margin-top: 8px; }

.jev-form {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.config-grid,
.connection-fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.config-card {
  min-width: 0;
  padding: 20px;
  border: 1px solid $border-color;
  border-radius: 12px;
  background: $bg-card;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;

  :deep(.n-switch) { flex-shrink: 0; }
}

.card-title,
.group-title {
  color: $text-primary;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
}

.card-title { margin: 0; overflow-wrap: anywhere; }
.group-title { margin: 0 0 12px; }

.connection-fields {
  margin-top: 16px;
  column-gap: 24px;

  :deep(.setting-row) {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    padding: 0;
    border: 0;
  }

  :deep(.setting-info) { margin-inline-end: 0; }
  :deep(.setting-control) { width: 100%; }
}

.config-card :deep(.setting-info) { min-width: 0; }
.config-card :deep(.setting-hint) { overflow-wrap: anywhere; }
.config-card :deep(.input-md) { width: 140px; max-width: 100%; }
.connection-card :deep(.input-md) { width: 100%; }

.memory-options,
.skills-options,
.browser-options,
.memory-advanced {
  margin-top: 16px;
  border-top: 1px solid $border-light;

  summary {
    cursor: pointer;
    padding: 12px 0 0;
    color: $text-primary;
    font-size: 13px;
    line-height: 1.5;
  }

  &[open] > summary { padding-bottom: 12px; }
}

.settings-actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 16px;
  border-top: 1px solid $border-color;
}

.feedback { margin-bottom: 16px; }
.test-result { overflow-wrap: anywhere; margin-top: 16px; }

@container (min-width: 760px) {
  .config-grid,
  .connection-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: $breakpoint-mobile) {
  .config-card { padding: 16px; }
  .config-card :deep(.input-md) { width: 100%; }
}
</style>
