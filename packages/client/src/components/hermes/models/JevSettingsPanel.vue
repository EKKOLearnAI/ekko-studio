<script setup lang="ts">
import { usePageLoadingTask } from '@/composables/usePageLoading'
import { useModelCatalogNotice } from '@/composables/useModelCatalogNotice'
import { NSpin, NAlert, NButton, NForm, NInput, NInputNumber, NPopconfirm, NSelect, NSpace, NSwitch, useMessage } from 'naive-ui'
import { computed, onMounted, onUnmounted, ref } from 'vue'

import { useI18n } from 'vue-i18n'
import { deleteJevSettings, getJevSettings, saveJevSettings, testJevConnection, type JevSettings } from '@/api/studio/jev'
import { isStoredSuperAdmin } from '@/api/client'
import SettingRow from '@/components/hermes/settings/SettingRow.vue'

const { t, te, n } = useI18n()
const message = useMessage()
const canConfigure = isStoredSuperAdmin()
const settings = ref<JevSettings | null>(null)
const apiKey = ref('')
const loading = ref(true)
const busy = ref(false)
const catalogChanged = useModelCatalogNotice(() => busy.value)
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
const personMemoryStatus = computed(() => !settings.value?.personMemoryEnabled ? 'jev.memoryDisabled'
  : !settings.value.hasApiKey ? 'common.notConfigured'
    : !settings.value.personMemoryKindRoutingEnabled && !settings.value.personMemoryRelevanceFilterEnabled && !settings.value.personMemoryRerankEnabled && !settings.value.personMemoryWriteReviewEnabled
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
  try { settings.value = await getJevSettings() }
  catch (err) { if (!disposed) error.value = errorKey(err) }
  finally { loading.value = false }
}
onMounted(load)

async function perform(action: 'save' | 'delete' | 'test') {
  if (!settings.value || busy.value || !canConfigure) return
  busy.value = true
  error.value = ''
  testResult.value = null
  try {
    if (action === 'test') {
      const result = await testJevConnection()
      if (!disposed) testResult.value = { model: result.model, durationMs: result.durationMs }
    } else {
      const { ekkoComputerUseMatchEnabled, ekkoComputerUseMatchCandidateLimit, ekkoComputerUseMatchMinConfidence, ekkoComputerUseMatchTimeoutMs, ekkoComputerUseVerifyEnabled, ekkoComputerUseVerifyMinConfidence, ekkoComputerUseVerifyTimeoutMs, groupSummaryReviewEnabled, groupSummaryReviewMinConfidence, groupSummaryRevisionEnabled, groupSummaryReviewTimeoutMs, workflowQualityEnabled, workflowQualityMinConfidence, workflowQualityTimeoutMs, groupMessageRoutingEnabled, groupHandoffReviewEnabled, groupLoopDetectionEnabled, groupMessageRoutingMinConfidence, groupMessageRoutingMode, groupMessageRoutingTimeoutMs, browserMatchEnabled, browserMatchCandidateLimit, browserMatchMinConfidence, browserMatchTimeoutMs, browserVerifyEnabled, browserVerifyMinConfidence, browserVerifyTimeoutMs, baseUrl, model, timeoutMs, ekkoSkillsEnabled, ekkoSkillsCandidateLimit, ekkoSkillsMinConfidence, ekkoSkillsTimeoutMs, ekkoMemoryEnabled, ekkoMemoryKindRoutingEnabled, ekkoMemoryRelevanceFilterEnabled, ekkoMemoryRerankEnabled,
        ekkoMemoryWriteReviewEnabled, ekkoMemoryCandidateLimit, ekkoMemoryRecallMinConfidence, ekkoMemoryFilterMinConfidence, ekkoMemoryMinConfidence, ekkoMemoryTimeoutMs, personMemoryEnabled, personMemoryKindRoutingEnabled, personMemoryRelevanceFilterEnabled, personMemoryRerankEnabled, personMemoryWriteReviewEnabled, personMemoryCandidateLimit, personMemoryRecallMinConfidence, personMemoryFilterMinConfidence, personMemoryMinConfidence, personMemoryTimeoutMs } = settings.value
      const result = action === 'delete' ? await deleteJevSettings()
        : await saveJevSettings({ ekkoComputerUseMatchEnabled, ekkoComputerUseMatchCandidateLimit, ekkoComputerUseMatchMinConfidence, ekkoComputerUseMatchTimeoutMs, ekkoComputerUseVerifyEnabled, ekkoComputerUseVerifyMinConfidence, ekkoComputerUseVerifyTimeoutMs, groupSummaryReviewEnabled, groupSummaryReviewMinConfidence, groupSummaryRevisionEnabled, groupSummaryReviewTimeoutMs, workflowQualityEnabled, workflowQualityMinConfidence, workflowQualityTimeoutMs, groupMessageRoutingEnabled, groupHandoffReviewEnabled, groupLoopDetectionEnabled, groupMessageRoutingMinConfidence, groupMessageRoutingMode, groupMessageRoutingTimeoutMs, browserMatchEnabled, browserMatchCandidateLimit, browserMatchMinConfidence, browserMatchTimeoutMs, browserVerifyEnabled, browserVerifyMinConfidence, browserVerifyTimeoutMs, baseUrl, model, timeoutMs, ekkoSkillsEnabled, ekkoSkillsCandidateLimit, ekkoSkillsMinConfidence, ekkoSkillsTimeoutMs, ekkoMemoryEnabled, ekkoMemoryKindRoutingEnabled, ekkoMemoryRelevanceFilterEnabled, ekkoMemoryRerankEnabled,
          ekkoMemoryWriteReviewEnabled, ekkoMemoryCandidateLimit, ekkoMemoryRecallMinConfidence, ekkoMemoryFilterMinConfidence, ekkoMemoryMinConfidence, ekkoMemoryTimeoutMs,
          personMemoryEnabled, personMemoryKindRoutingEnabled, personMemoryRelevanceFilterEnabled, personMemoryRerankEnabled, personMemoryWriteReviewEnabled, personMemoryCandidateLimit, personMemoryRecallMinConfidence, personMemoryFilterMinConfidence, personMemoryMinConfidence, personMemoryTimeoutMs, ...(apiKey.value.trim() ? { apiKey: apiKey.value.trim() } : {}) })
      if (!disposed) { settings.value = result; apiKey.value = ''; message.success(t(action === 'delete' ? 'jev.deleted' : 'common.saved')); catalogChanged() }
    }
  } catch (err) { if (!disposed) error.value = errorKey(err) }
  finally { busy.value = false }
}

usePageLoadingTask(() => loading.value)
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
      <NAlert v-if="settings && !canConfigure" type="info">{{ t('jev.globalReadonlyHint') }}</NAlert>
      <NForm v-if="settings" class="jev-form" :disabled="busy || !canConfigure" @submit.prevent="perform('save')">
        <section class="config-card connection-card" :aria-label="t('jev.connectionSettings')">
          <header class="card-header">
            <h4 class="card-title">{{ t('jev.connectionSettings') }}</h4>
          </header>
          <div class="settings-rows connection-fields">
            <SettingRow :label="t('jev.baseUrl')" class="text-setting">
              <NInput :disabled="busy || !canConfigure" v-model:value="settings.baseUrl" size="small" :input-props="{ 'aria-label': `JEV ${t('jev.baseUrl')}` }" placeholder="https://api.typesafe.ai" />
            </SettingRow>
            <SettingRow :label="t('profiles.model')" class="text-setting">
              <NInput :disabled="busy || !canConfigure" v-model:value="settings.model" size="small" :input-props="{ 'aria-label': `JEV ${t('profiles.model')}` }" placeholder="jev-latest" />
            </SettingRow>
            <SettingRow :label="t('jev.apiKey')" :hint="t(settings.hasApiKey ? 'common.configured' : 'common.notConfigured')" class="text-setting">
              <NInput :disabled="busy || !canConfigure" v-model:value="apiKey" size="small" :input-props="{ 'aria-label': `JEV ${t('jev.apiKey')}`, autocomplete: 'new-password' }" type="password" show-password-on="click" :placeholder="t(settings.hasApiKey ? 'jev.keyHint' : 'jev.keyPlaceholder')" />
            </SettingRow>
            <SettingRow :label="t('jev.timeout')">
              <NInputNumber :disabled="busy || !canConfigure" :value="settings.timeoutMs" size="small" class="input-md" :min="1000" :max="120000" :step="1000" :placeholder="t('jev.timeout')" :input-props="{ 'aria-label': `JEV ${t('jev.timeout')}` }" @update:value="value => { if (value !== null) settings!.timeoutMs = value }" />
            </SettingRow>
          </div>
        </section>
        <section class="config-group" :aria-label="t('jev.useCases')">
          <h4 class="group-title">{{ t('jev.useCases') }}</h4>
          <div class="config-grid">
            <section class="config-card" :aria-label="t('jev.ekkoMemoryEnabled')">
              <header class="card-header">
                <h5 class="card-title">{{ t('jev.ekkoMemoryEnabled') }}</h5>
                <NSwitch :disabled="busy || !canConfigure" :aria-disabled="busy || !canConfigure" v-model:value="settings.ekkoMemoryEnabled" :aria-label="t('jev.ekkoMemoryEnabled')" />
              </header>
              <p class="card-hint">{{ t(memoryStatus) }}</p>
              <details class="memory-options" :open="settings.ekkoMemoryEnabled">
                <summary>{{ t('jev.memoryOptions') }}</summary>
                <p class="section-hint">{{ t('jev.memoryOptionsHint') }}</p>
                <div class="settings-rows">
                  <SettingRow :label="t('jev.memoryKindRouting')" :hint="t('jev.memoryKindRoutingHint')">
                    <NSwitch :disabled="busy || !canConfigure" :aria-disabled="busy || !canConfigure" v-model:value="settings.ekkoMemoryKindRoutingEnabled" :aria-label="t('jev.memoryKindRouting')" />
                  </SettingRow>
                  <SettingRow :label="t('jev.memoryRelevanceFilter')" :hint="t('jev.memoryRelevanceFilterHint')">
                    <NSwitch :disabled="busy || !canConfigure" :aria-disabled="busy || !canConfigure" v-model:value="settings.ekkoMemoryRelevanceFilterEnabled" :aria-label="t('jev.memoryRelevanceFilter')" />
                  </SettingRow>
                  <SettingRow :label="t('jev.memoryRerank')" :hint="t('jev.memoryRerankHint')">
                    <NSwitch :disabled="busy || !canConfigure" :aria-disabled="busy || !canConfigure" v-model:value="settings.ekkoMemoryRerankEnabled" :aria-label="t('jev.memoryRerank')" />
                  </SettingRow>
                  <SettingRow :label="t('jev.memoryWriteReview')" :hint="t('jev.memoryWriteReviewHint')">
                    <NSwitch :disabled="busy || !canConfigure" :aria-disabled="busy || !canConfigure" v-model:value="settings.ekkoMemoryWriteReviewEnabled" :aria-label="t('jev.memoryWriteReview')" />
                  </SettingRow>
                </div>
                <details class="memory-advanced">
                  <summary>{{ t('jev.memoryAdvanced') }}</summary>
                  <div class="settings-rows">
                    <SettingRow :label="t('jev.memoryCandidateLimit')" :hint="t('jev.memoryCandidateLimitHint')">
                      <NInputNumber :disabled="busy || !canConfigure" :value="settings.ekkoMemoryCandidateLimit" @update:value="value => { if (value !== null) settings!.ekkoMemoryCandidateLimit = value }" size="small" class="input-md" :min="1" :max="50" :precision="0" :input-props="{ 'aria-label': t('jev.memoryCandidateLimit') }" />
                    </SettingRow>
                    <SettingRow :label="t('jev.memoryRecallMinConfidence')" :hint="t('jev.memoryRecallMinConfidenceHint')">
                      <NInputNumber :disabled="busy || !canConfigure" :value="settings.ekkoMemoryRecallMinConfidence" @update:value="value => { if (value !== null) settings!.ekkoMemoryRecallMinConfidence = value }" size="small" class="input-md" :min="0.5" :max="1" :step="0.05" :input-props="{ 'aria-label': t('jev.memoryRecallMinConfidence') }" />
                    </SettingRow>
                    <SettingRow :label="t('jev.memoryFilterMinConfidence')" :hint="t('jev.memoryFilterMinConfidenceHint')">
                      <NInputNumber :disabled="busy || !canConfigure" :value="settings.ekkoMemoryFilterMinConfidence" @update:value="value => { if (value !== null) settings!.ekkoMemoryFilterMinConfidence = value }" size="small" class="input-md" :min="0.5" :max="1" :step="0.05" :input-props="{ 'aria-label': t('jev.memoryFilterMinConfidence') }" />
                    </SettingRow>
                    <SettingRow :label="t('jev.memoryMinConfidence')" :hint="t('jev.memoryMinConfidenceHint')">
                      <NInputNumber :disabled="busy || !canConfigure" :value="settings.ekkoMemoryMinConfidence" @update:value="value => { if (value !== null) settings!.ekkoMemoryMinConfidence = value }" size="small" class="input-md" :min="0.5" :max="1" :step="0.05" :input-props="{ 'aria-label': t('jev.memoryMinConfidence') }" />
                    </SettingRow>
                    <SettingRow :label="t('jev.memoryTimeout')" :hint="t('jev.memoryTimeoutHint')">
                      <NInputNumber :disabled="busy || !canConfigure" :value="settings.ekkoMemoryTimeoutMs" @update:value="value => { if (value !== null) settings!.ekkoMemoryTimeoutMs = value }" size="small" class="input-md" :min="100" :max="30000" :step="100" :precision="0" :input-props="{ 'aria-label': t('jev.memoryTimeout') }" />
                    </SettingRow>
                  </div>
                </details>
              </details>
            </section>
            <section class="config-card" data-theme-surface="card" :aria-label="t('jev.personMemoryEnabled')">
              <header class="card-header">
                <h5 class="card-title">{{ t('jev.personMemoryEnabled') }}</h5>
                <NSwitch :disabled="busy || !canConfigure" :aria-disabled="busy || !canConfigure" v-model:value="settings.personMemoryEnabled" :aria-label="t('jev.personMemoryEnabled')" />
              </header>
              <p class="card-hint">{{ t('jev.personMemoryHint') }}</p>
              <p class="card-hint">{{ t(personMemoryStatus) }}</p>
              <details class="memory-options" :open="settings.personMemoryEnabled">
                <summary>{{ t('jev.memoryOptions') }}</summary>
                <p class="section-hint">{{ t('jev.memoryOptionsHint') }}</p>
                <div class="settings-rows">
                  <SettingRow :label="t('jev.memoryKindRouting')" :hint="t('jev.memoryKindRoutingHint')">
                    <NSwitch :disabled="busy || !canConfigure" :aria-disabled="busy || !canConfigure" v-model:value="settings.personMemoryKindRoutingEnabled" :aria-label="`${t('person.title')} · ${t('jev.memoryKindRouting')}`" />
                  </SettingRow>
                  <SettingRow :label="t('jev.memoryRelevanceFilter')" :hint="t('jev.memoryRelevanceFilterHint')">
                    <NSwitch :disabled="busy || !canConfigure" :aria-disabled="busy || !canConfigure" v-model:value="settings.personMemoryRelevanceFilterEnabled" :aria-label="`${t('person.title')} · ${t('jev.memoryRelevanceFilter')}`" />
                  </SettingRow>
                  <SettingRow :label="t('jev.memoryRerank')" :hint="t('jev.memoryRerankHint')">
                    <NSwitch :disabled="busy || !canConfigure" :aria-disabled="busy || !canConfigure" v-model:value="settings.personMemoryRerankEnabled" :aria-label="`${t('person.title')} · ${t('jev.memoryRerank')}`" />
                  </SettingRow>
                  <SettingRow :label="t('jev.memoryWriteReview')" :hint="t('jev.memoryWriteReviewHint')">
                    <NSwitch :disabled="busy || !canConfigure" :aria-disabled="busy || !canConfigure" v-model:value="settings.personMemoryWriteReviewEnabled" :aria-label="`${t('person.title')} · ${t('jev.memoryWriteReview')}`" />
                  </SettingRow>
                </div>
                <details class="memory-advanced">
                  <summary>{{ t('jev.memoryAdvanced') }}</summary>
                  <div class="settings-rows">
                    <SettingRow :label="t('jev.memoryCandidateLimit')" :hint="t('jev.memoryCandidateLimitHint')">
                      <NInputNumber :disabled="busy || !canConfigure" :value="settings.personMemoryCandidateLimit" @update:value="value => { if (value !== null) settings!.personMemoryCandidateLimit = value }" size="small" class="input-md" :min="1" :max="50" :precision="0" :input-props="{ 'aria-label': `${t('person.title')} · ${t('jev.memoryCandidateLimit')}` }" />
                    </SettingRow>
                    <SettingRow :label="t('jev.memoryRecallMinConfidence')" :hint="t('jev.memoryRecallMinConfidenceHint')">
                      <NInputNumber :disabled="busy || !canConfigure" :value="settings.personMemoryRecallMinConfidence" @update:value="value => { if (value !== null) settings!.personMemoryRecallMinConfidence = value }" size="small" class="input-md" :min="0.5" :max="1" :step="0.05" :input-props="{ 'aria-label': `${t('person.title')} · ${t('jev.memoryRecallMinConfidence')}` }" />
                    </SettingRow>
                    <SettingRow :label="t('jev.memoryFilterMinConfidence')" :hint="t('jev.memoryFilterMinConfidenceHint')">
                      <NInputNumber :disabled="busy || !canConfigure" :value="settings.personMemoryFilterMinConfidence" @update:value="value => { if (value !== null) settings!.personMemoryFilterMinConfidence = value }" size="small" class="input-md" :min="0.5" :max="1" :step="0.05" :input-props="{ 'aria-label': `${t('person.title')} · ${t('jev.memoryFilterMinConfidence')}` }" />
                    </SettingRow>
                    <SettingRow :label="t('jev.memoryMinConfidence')" :hint="t('jev.memoryMinConfidenceHint')">
                      <NInputNumber :disabled="busy || !canConfigure" :value="settings.personMemoryMinConfidence" @update:value="value => { if (value !== null) settings!.personMemoryMinConfidence = value }" size="small" class="input-md" :min="0.5" :max="1" :step="0.05" :input-props="{ 'aria-label': `${t('person.title')} · ${t('jev.memoryMinConfidence')}` }" />
                    </SettingRow>
                    <SettingRow :label="t('jev.memoryTimeout')" :hint="t('jev.memoryTimeoutHint')">
                      <NInputNumber :disabled="busy || !canConfigure" :value="settings.personMemoryTimeoutMs" @update:value="value => { if (value !== null) settings!.personMemoryTimeoutMs = value }" size="small" class="input-md" :min="100" :max="30000" :step="100" :precision="0" :input-props="{ 'aria-label': `${t('person.title')} · ${t('jev.memoryTimeout')}` }" />
                    </SettingRow>
                  </div>
                </details>
              </details>
            </section>
            <section class="config-card" :aria-label="t('jev.ekkoSkillsEnabled')">
              <header class="card-header">
                <h5 class="card-title">{{ t('jev.ekkoSkillsEnabled') }}</h5>
                <NSwitch :disabled="busy || !canConfigure" :aria-disabled="busy || !canConfigure" v-model:value="settings.ekkoSkillsEnabled" :aria-label="t('jev.ekkoSkillsEnabled')" />
              </header>
              <p class="card-hint">{{ t(skillsStatus) }}</p>
              <details class="skills-options" :open="settings.ekkoSkillsEnabled">
                <summary>{{ t('jev.skillsOptions') }}</summary>
                <p class="section-hint">{{ t('jev.skillsOptionsHint') }}</p>
                <div class="settings-rows">
                  <SettingRow :label="t('jev.skillsCandidateLimit')" :hint="t('jev.skillsCandidateLimitHint')">
                    <NInputNumber :disabled="busy || !canConfigure" :value="settings.ekkoSkillsCandidateLimit" @update:value="value => { if (value !== null) settings!.ekkoSkillsCandidateLimit = value }" size="small" class="input-md" :min="1" :max="50" :precision="0" :input-props="{ 'aria-label': t('jev.skillsCandidateLimit') }" />
                  </SettingRow>
                  <SettingRow :label="t('jev.skillsMinConfidence')" :hint="t('jev.skillsMinConfidenceHint')">
                    <NInputNumber :disabled="busy || !canConfigure" :value="settings.ekkoSkillsMinConfidence" @update:value="value => { if (value !== null) settings!.ekkoSkillsMinConfidence = value }" size="small" class="input-md" :min="0.5" :max="1" :step="0.05" :input-props="{ 'aria-label': t('jev.skillsMinConfidence') }" />
                  </SettingRow>
                  <SettingRow :label="t('jev.skillsTimeout')" :hint="t('jev.skillsTimeoutHint')">
                    <NInputNumber :disabled="busy || !canConfigure" :value="settings.ekkoSkillsTimeoutMs" @update:value="value => { if (value !== null) settings!.ekkoSkillsTimeoutMs = value }" size="small" class="input-md" :min="100" :max="30000" :step="100" :precision="0" :input-props="{ 'aria-label': t('jev.skillsTimeout') }" />
                  </SettingRow>
                </div>
              </details>
            </section>
          </div>
        </section>
        <section class="config-group" :aria-label="t('jev.groupSchedulingTitle')">
          <h4 class="group-title">{{ t('jev.groupSchedulingTitle') }}</h4>
          <div class="config-grid">
            <section class="config-card"><header class="card-header"><h5 class="card-title">{{ t('jev.groupMessageRoutingEnabled') }}</h5><NSwitch :disabled="busy || !canConfigure" :aria-disabled="busy || !canConfigure" v-model:value="settings.groupMessageRoutingEnabled" :aria-label="t('jev.groupMessageRoutingEnabled')" /></header><p class="card-hint">{{ t(routingStatus) }}</p><div class="settings-rows"><SettingRow :label="t('jev.groupHandoffReviewEnabled')" :hint="t('jev.groupHandoffReviewHint')"><NSwitch :disabled="busy || !canConfigure" :aria-disabled="busy || !canConfigure" v-model:value="settings.groupHandoffReviewEnabled" :aria-label="t('jev.groupHandoffReviewEnabled')" /></SettingRow><SettingRow :label="t('jev.groupLoopDetectionEnabled')" :hint="t('jev.groupLoopDetectionHint')"><NSwitch :disabled="busy || !canConfigure" :aria-disabled="busy || !canConfigure" v-model:value="settings.groupLoopDetectionEnabled" :aria-label="t('jev.groupLoopDetectionEnabled')" /></SettingRow><SettingRow :label="t('jev.groupMessageRoutingMode')"><NSelect :disabled="busy || !canConfigure" data-testid="jev-routing-mode" :aria-label="t('jev.groupMessageRoutingMode')" v-model:value="settings.groupMessageRoutingMode" :options="[{ label: t('jev.groupRoutingSuggest'), value: 'suggest' }, { label: t('jev.groupRoutingAuto'), value: 'auto' }]" size="small" /></SettingRow><SettingRow :label="t('jev.groupMessageRoutingMinConfidence')" :hint="t('jev.groupMessageRoutingMinConfidenceHint')"><NInputNumber :disabled="busy || !canConfigure" :value="settings.groupMessageRoutingMinConfidence" @update:value="value => { if (value !== null) settings!.groupMessageRoutingMinConfidence = value }" :input-props="{ 'aria-label': t('jev.groupMessageRoutingMinConfidence') }" size="small" class="input-md" :min="0.5" :max="1" :step="0.05" /></SettingRow><SettingRow :label="t('jev.groupMessageRoutingTimeout')" :hint="t('jev.groupMessageRoutingTimeoutHint')"><NInputNumber :disabled="busy || !canConfigure" :value="settings.groupMessageRoutingTimeoutMs" @update:value="value => { if (value !== null) settings!.groupMessageRoutingTimeoutMs = value }" :input-props="{ 'aria-label': t('jev.groupMessageRoutingTimeout') }" size="small" class="input-md" :min="100" :max="30000" :step="100" /></SettingRow></div></section>
            <section class="config-card"><header class="card-header"><h5 class="card-title">{{ t('jev.workflowExpectationTitle') }}</h5><NSwitch :disabled="busy || !canConfigure" :aria-disabled="busy || !canConfigure" v-model:value="settings.workflowQualityEnabled" :aria-label="t('jev.workflowQualityEnabled')" /></header><p class="card-hint">{{ t(workflowStatus) }}</p><div class="settings-rows"><SettingRow :label="t('jev.workflowQualityMinConfidence')" :hint="t('jev.workflowQualityMinConfidenceHint')"><NInputNumber :disabled="busy || !canConfigure" :value="settings.workflowQualityMinConfidence" @update:value="value => { if (value !== null) settings!.workflowQualityMinConfidence = value }" size="small" class="input-md" :min="0.5" :max="1" :step="0.05" :input-props="{ 'aria-label': t('jev.workflowQualityMinConfidence') }" /></SettingRow><SettingRow :label="t('jev.workflowQualityTimeout')" :hint="t('jev.workflowQualityTimeoutHint')"><NInputNumber :disabled="busy || !canConfigure" :value="settings.workflowQualityTimeoutMs" @update:value="value => { if (value !== null) settings!.workflowQualityTimeoutMs = value }" size="small" class="input-md" :min="100" :max="30000" :step="100" :input-props="{ 'aria-label': t('jev.workflowQualityTimeout') }" /></SettingRow></div></section>
            <section class="config-card"><header class="card-header"><h5 class="card-title">{{ t('jev.groupSummaryTitle') }}</h5><NSwitch :disabled="busy || !canConfigure" :aria-disabled="busy || !canConfigure" v-model:value="settings.groupSummaryReviewEnabled" :aria-label="t('jev.groupSummaryReviewEnabled')" /></header><p class="card-hint">{{ t(summaryStatus) }}</p><div class="settings-rows"><SettingRow :label="t('jev.groupSummaryRevisionEnabled')" :hint="t('jev.groupSummaryRevisionHint')"><NSwitch :disabled="busy || !canConfigure" :aria-disabled="busy || !canConfigure" v-model:value="settings.groupSummaryRevisionEnabled" :aria-label="t('jev.groupSummaryRevisionEnabled')" /></SettingRow><SettingRow :label="t('jev.groupSummaryReviewMinConfidence')" :hint="t('jev.groupSummaryReviewMinConfidenceHint')"><NInputNumber :disabled="busy || !canConfigure" :value="settings.groupSummaryReviewMinConfidence" @update:value="value => { if (value !== null) settings!.groupSummaryReviewMinConfidence = value }" size="small" class="input-md" :min="0.5" :max="1" :step="0.05" :input-props="{ 'aria-label': t('jev.groupSummaryReviewMinConfidence') }" /></SettingRow><SettingRow :label="t('jev.groupSummaryReviewTimeout')" :hint="t('jev.groupSummaryReviewTimeoutHint')"><NInputNumber :disabled="busy || !canConfigure" :value="settings.groupSummaryReviewTimeoutMs" @update:value="value => { if (value !== null) settings!.groupSummaryReviewTimeoutMs = value }" size="small" class="input-md" :min="100" :max="30000" :step="100" :precision="0" :input-props="{ 'aria-label': t('jev.groupSummaryReviewTimeout') }" /></SettingRow></div></section>
          </div>
        </section>
        <section class="config-group" :aria-label="t('jev.computerUseAutomation')">
          <h4 class="group-title">{{ t('jev.computerUseAutomation') }}</h4>
          <p class="section-hint">{{ t('jev.computerUseAutomationHint') }}</p>
          <div class="config-grid">
            <section class="config-card" data-theme-surface="card" :aria-label="t('jev.computerUseMatchEnabled')">
              <header class="card-header">
                <h5 class="card-title">{{ t('jev.computerUseMatchEnabled') }}</h5>
                <NSwitch :disabled="busy || !canConfigure" :aria-disabled="busy || !canConfigure" v-model:value="settings.ekkoComputerUseMatchEnabled" :aria-label="t('jev.computerUseMatchEnabled')" />
              </header>
              <p class="card-hint">{{ t('jev.computerUseMatchHint') }}</p>
              <div class="settings-rows">
                <SettingRow :label="t('jev.computerUseMatchCandidateLimit')">
                  <NInputNumber :disabled="busy || !canConfigure" :value="settings.ekkoComputerUseMatchCandidateLimit" @update:value="value => { if (value !== null) settings!.ekkoComputerUseMatchCandidateLimit = value }" size="small" class="input-md" :min="1" :max="50" :precision="0" :input-props="{ 'aria-label': t('jev.computerUseMatchCandidateLimit') }" />
                </SettingRow>
                <SettingRow :label="t('jev.computerUseMatchMinConfidence')">
                  <NInputNumber :disabled="busy || !canConfigure" :value="settings.ekkoComputerUseMatchMinConfidence" @update:value="value => { if (value !== null) settings!.ekkoComputerUseMatchMinConfidence = value }" size="small" class="input-md" :min="0.5" :max="1" :step="0.05" :input-props="{ 'aria-label': t('jev.computerUseMatchMinConfidence') }" />
                </SettingRow>
                <SettingRow :label="t('jev.computerUseMatchTimeoutMs')">
                  <NInputNumber :disabled="busy || !canConfigure" :value="settings.ekkoComputerUseMatchTimeoutMs" @update:value="value => { if (value !== null) settings!.ekkoComputerUseMatchTimeoutMs = value }" size="small" class="input-md" :min="100" :max="30000" :step="100" :precision="0" :input-props="{ 'aria-label': t('jev.computerUseMatchTimeoutMs') }" />
                </SettingRow>
              </div>
            </section>
            <section class="config-card" data-theme-surface="card" :aria-label="t('jev.computerUseVerifyEnabled')">
              <header class="card-header">
                <h5 class="card-title">{{ t('jev.computerUseVerifyEnabled') }}</h5>
                <NSwitch :disabled="busy || !canConfigure" :aria-disabled="busy || !canConfigure" v-model:value="settings.ekkoComputerUseVerifyEnabled" :aria-label="t('jev.computerUseVerifyEnabled')" />
              </header>
              <p class="card-hint">{{ t('jev.computerUseVerifyHint') }}</p>
              <div class="settings-rows">
                <SettingRow :label="t('jev.computerUseVerifyMinConfidence')">
                  <NInputNumber :disabled="busy || !canConfigure" :value="settings.ekkoComputerUseVerifyMinConfidence" @update:value="value => { if (value !== null) settings!.ekkoComputerUseVerifyMinConfidence = value }" size="small" class="input-md" :min="0.5" :max="1" :step="0.05" :input-props="{ 'aria-label': t('jev.computerUseVerifyMinConfidence') }" />
                </SettingRow>
                <SettingRow :label="t('jev.computerUseVerifyTimeoutMs')">
                  <NInputNumber :disabled="busy || !canConfigure" :value="settings.ekkoComputerUseVerifyTimeoutMs" @update:value="value => { if (value !== null) settings!.ekkoComputerUseVerifyTimeoutMs = value }" size="small" class="input-md" :min="100" :max="30000" :step="100" :precision="0" :input-props="{ 'aria-label': t('jev.computerUseVerifyTimeoutMs') }" />
                </SettingRow>
              </div>
            </section>
          </div>
        </section>

        <section class="config-group" :aria-label="t('jev.browserAutomation')">
          <h4 class="group-title">{{ t('jev.browserAutomation') }}</h4>
          <p class="section-hint">{{ t('jev.browserAutomationHint') }}</p>
          <div class="config-grid">
            <section class="config-card" :aria-label="t('jev.browserMatchEnabled')">
              <header class="card-header">
                <h5 class="card-title">{{ t('jev.browserMatchEnabled') }}</h5>
                <NSwitch :disabled="busy || !canConfigure" :aria-disabled="busy || !canConfigure" v-model:value="settings.browserMatchEnabled" :aria-label="t('jev.browserMatchEnabled')" />
              </header>
              <p class="card-hint">{{ t('jev.browserMatchHint') }}</p>
              <details class="browser-options" :open="settings.browserMatchEnabled">
                <summary>{{ t('jev.browserMatchOptions') }}</summary>
                <div class="settings-rows">
                  <SettingRow :label="t('jev.browserMatchCandidateLimit')">
                    <NInputNumber :disabled="busy || !canConfigure" :value="settings.browserMatchCandidateLimit" @update:value="value => { if (value !== null) settings!.browserMatchCandidateLimit = value }" size="small" class="input-md" :min="1" :max="50" :precision="0" :input-props="{ 'aria-label': t('jev.browserMatchCandidateLimit') }" />
                  </SettingRow>
                  <SettingRow :label="t('jev.browserMatchMinConfidence')">
                    <NInputNumber :disabled="busy || !canConfigure" :value="settings.browserMatchMinConfidence" @update:value="value => { if (value !== null) settings!.browserMatchMinConfidence = value }" size="small" class="input-md" :min="0.5" :max="1" :step="0.05" :input-props="{ 'aria-label': t('jev.browserMatchMinConfidence') }" />
                  </SettingRow>
                  <SettingRow :label="t('jev.browserMatchTimeoutMs')">
                    <NInputNumber :disabled="busy || !canConfigure" :value="settings.browserMatchTimeoutMs" @update:value="value => { if (value !== null) settings!.browserMatchTimeoutMs = value }" size="small" class="input-md" :min="100" :max="30000" :step="100" :precision="0" :input-props="{ 'aria-label': t('jev.browserMatchTimeoutMs') }" />
                  </SettingRow>
                </div>
              </details>
            </section>
            <section class="config-card" :aria-label="t('jev.browserVerifyEnabled')">
              <header class="card-header">
                <h5 class="card-title">{{ t('jev.browserVerifyEnabled') }}</h5>
                <NSwitch :disabled="busy || !canConfigure" :aria-disabled="busy || !canConfigure" v-model:value="settings.browserVerifyEnabled" :aria-label="t('jev.browserVerifyEnabled')" />
              </header>
              <p class="card-hint">{{ t('jev.browserVerifyHint') }}</p>
              <details class="browser-options" :open="settings.browserVerifyEnabled">
                <summary>{{ t('jev.browserVerifyOptions') }}</summary>
                <div class="settings-rows">
                  <SettingRow :label="t('jev.browserVerifyMinConfidence')">
                    <NInputNumber :disabled="busy || !canConfigure" :value="settings.browserVerifyMinConfidence" @update:value="value => { if (value !== null) settings!.browserVerifyMinConfidence = value }" size="small" class="input-md" :min="0.5" :max="1" :step="0.05" :input-props="{ 'aria-label': t('jev.browserVerifyMinConfidence') }" />
                  </SettingRow>
                  <SettingRow :label="t('jev.browserVerifyTimeoutMs')">
                    <NInputNumber :disabled="busy || !canConfigure" :value="settings.browserVerifyTimeoutMs" @update:value="value => { if (value !== null) settings!.browserVerifyTimeoutMs = value }" size="small" class="input-md" :min="100" :max="30000" :step="100" :precision="0" :input-props="{ 'aria-label': t('jev.browserVerifyTimeoutMs') }" />
                  </SettingRow>
                </div>
              </details>
            </section>
          </div>
        </section>
        <div class="settings-actions">
          <NButton type="primary" :loading="busy" :disabled="busy || !canConfigure" @click="perform('save')">{{ t('common.save') }}</NButton>
          <NButton :disabled="busy || !canConfigure || !settings.hasApiKey" @click="perform('test')">{{ t('jev.testSaved') }}</NButton>
          <NPopconfirm :positive-text="t('common.confirm')" :negative-text="t('common.cancel')" @positive-click="perform('delete')">
            <template #trigger><NButton type="error" secondary :disabled="busy || !canConfigure">{{ t('common.delete') }}</NButton></template>
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
  font-size: calc(var(--font-size-base, 14px) * 18 / 14);
  color: $text-primary;
}

.section-hint,
.card-hint {
  margin: 0;
  color: $text-secondary;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  line-height: var(--line-height, 1.6);
  overflow-wrap: anywhere;
}

.section-hint { margin-bottom: 16px; }
.card-hint { margin-top: 8px; }

.jev-form {
  display: flex;
  flex-direction: column;
  gap: calc(24px * var(--spacing-scale, 1));
}

.config-grid,
.connection-fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: calc(16px * var(--spacing-scale, 1));
  align-items: start;
}

.config-card {
  min-width: 0;
  padding: calc(20px * var(--spacing-scale, 1));
  border: var(--border-width, 1px) solid $border-color;
  border-radius: var(--radius-component, 12px);
  background: var(--theme-card-bg, $bg-card);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: calc(16px * var(--spacing-scale, 1));

  :deep(.n-switch) { flex-shrink: 0; }
}

.card-title,
.group-title {
  color: $text-primary;
  font-size: calc(var(--font-size-base, 14px) * 14 / 14);
  font-weight: 600;
  line-height: var(--line-height, 1.5);
}

.card-title { margin: 0; overflow-wrap: anywhere; }
.group-title { margin: 0 0 12px; }

.connection-fields {
  margin-top: 16px;
  column-gap: calc(24px * var(--spacing-scale, 1));

  :deep(.setting-row) {
    flex-direction: column;
    align-items: stretch;
    gap: calc(8px * var(--spacing-scale, 1));
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
  border-top: var(--border-width, 1px) solid $border-light;

  summary {
    cursor: pointer;
    padding: calc(12px * var(--spacing-scale, 1)) 0 0;
    color: $text-primary;
    font-size: calc(var(--font-size-base, 14px) * 13 / 14);
    line-height: var(--line-height, 1.5);
  }

  &[open] > summary { padding-bottom: calc(12px * var(--spacing-scale, 1)); }
}

.settings-actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: calc(8px * var(--spacing-scale, 1));
  padding-top: calc(16px * var(--spacing-scale, 1));
  border-top: var(--border-width, 1px) solid $border-color;
}

.feedback { margin-bottom: 16px; }
.test-result { overflow-wrap: anywhere; margin-top: 16px; }

@container (min-width: 760px) {
  .config-grid,
  .connection-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: $breakpoint-mobile) {
  .config-card { padding: calc(16px * var(--spacing-scale, 1)); }
  .config-card :deep(.input-md) { width: 100%; }
}
</style>
