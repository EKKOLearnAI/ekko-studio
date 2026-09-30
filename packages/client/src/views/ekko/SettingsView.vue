<script setup lang="ts">
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  NAlert,
  NCheckbox,
  NCheckboxGroup,
  NDynamicTags,
  NInput,
  NInputNumber,
  NSelect,
  NSwitch,
  NTabPane,
  NTabs,
  useMessage,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import SettingRow from '@/components/hermes/settings/SettingRow.vue'
import {
  fetchEkkoSettings,
  saveEkkoSettings,
  type EkkoSettingsConfig,
} from '@/api/ekko/config'

type SettingsTab = 'runtime' | 'model' | 'tools' | 'modules' | 'advanced'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const message = useMessage()
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const activeTab = ref<SettingsTab>('runtime')
const schemaVersion = ref(0)
const configPath = ref('')
const form = ref<EkkoSettingsConfig | null>(null)
let saveTimer: ReturnType<typeof setTimeout> | undefined
let editVersion = 0
let saveAfterCurrent = false

const reasoningEffortOptions = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  .map(value => ({ label: value, value }))
const reasoningSummaryOptions = ['auto', 'concise', 'detailed']
  .map(value => ({ label: value, value }))
function normalizeTab(value: unknown): SettingsTab {
  return value === 'model' || value === 'tools' || value === 'modules' || value === 'advanced'
    ? value
    : 'runtime'
}

function handleTabUpdate(tab: SettingsTab) {
  activeTab.value = normalizeTab(tab)
  void router.replace({
    query: {
      ...route.query,
      tab: activeTab.value === 'runtime' ? undefined : activeTab.value,
    },
  })
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

async function loadSettings() {
  loading.value = true
  error.value = ''
  try {
    const snapshot = await fetchEkkoSettings()
    schemaVersion.value = snapshot.schemaVersion
    configPath.value = snapshot.configPath
    form.value = structuredClone(snapshot.config)
  } catch (loadError) {
    error.value = errorMessage(loadError)
  } finally {
    loading.value = false
  }
}

async function saveSettings() {
  if (!form.value) return
  if (saving.value) {
    saveAfterCurrent = true
    return
  }
  const version = editVersion
  const pendingConfig = structuredClone(toRaw(form.value))
  saving.value = true
  error.value = ''
  try {
    const snapshot = await saveEkkoSettings(pendingConfig)
    schemaVersion.value = snapshot.schemaVersion
    configPath.value = snapshot.configPath
    message.success(t('common.saved'))
  } catch (saveError) {
    error.value = errorMessage(saveError)
    message.error(t('common.saveFailed'))
  } finally {
    saving.value = false
    if (saveAfterCurrent || editVersion > version) {
      saveAfterCurrent = false
      void saveSettings()
    }
  }
}

function saveImmediateChange() {
  editVersion += 1
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = undefined
  void saveSettings()
}

function saveDebouncedChange() {
  editVersion += 1
  scheduleSave()
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = undefined
    void saveSettings()
  }, 400)
}

watch(() => route.query.tab, value => {
  activeTab.value = normalizeTab(value)
}, { immediate: true })

onMounted(() => {
  void loadSettings()
})

onBeforeUnmount(() => {
  if (!saveTimer) return
  clearTimeout(saveTimer)
  saveTimer = undefined
  void saveSettings()
})
</script>

<template>
  <PageLoading :show="loading" class="ekko-settings-view">
    <PageHeader>
    <header class="page-header">
      <h2 class="header-title">{{ t('settings.title') }}</h2>
    </header>
    </PageHeader>

    <div class="ekko-settings-content">
      <NAlert v-if="error" type="error" closable class="settings-error" @close="error = ''">
        {{ error }}
      </NAlert>
      <div>
        <NTabs v-if="form" v-model:value="activeTab" type="line" animated @update:value="handleTabUpdate">
          <NTabPane name="runtime" :tab="t('ekkoConfig.settingsRuntime')">
            <section class="settings-section">
              <SettingRow :label="t('ekkoConfig.maxSteps')" :hint="t('ekkoConfig.runLimitHint')">
                <NInputNumber v-model:value="form.runtime.maxSteps" :min="1" :step="5" size="small" class="input-sm" @update:value="value => value != null && saveDebouncedChange()" />
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.maxModelRetries')" :hint="t('ekkoConfig.retryLimitHint')">
                <NInputNumber v-model:value="form.runtime.maxModelRetries" :min="0" size="small" class="input-sm" @update:value="value => value != null && saveDebouncedChange()" />
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.maxToolFailures')" :hint="t('ekkoConfig.failureLimitHint')">
                <NInputNumber v-model:value="form.runtime.toolFailureRecoveryThreshold" :min="1" size="small" class="input-sm" @update:value="value => value != null && saveDebouncedChange()" />
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.backgroundDelegation')" :hint="t('ekkoConfig.featureToggleHint')">
                <NSwitch v-model:value="form.delegation.backgroundEnabled" @update:value="saveImmediateChange" />
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.subtaskMaxSteps')" :hint="t('ekkoConfig.runLimitHint')">
                <NInputNumber v-model:value="form.delegation.subtaskMaxSteps" :min="1" :step="5" size="small" class="input-sm" @update:value="value => value != null && saveDebouncedChange()" />
              </SettingRow>
            </section>
          </NTabPane>

          <NTabPane name="model" :tab="t('ekkoConfig.settingsModel')">
            <section class="settings-section">
              <SettingRow :label="t('ekkoConfig.requestTimeoutMs')" :hint="t('ekkoConfig.timeoutHint')">
                <NInputNumber v-model:value="form.model.requestTimeoutMs" :min="1" :step="1000" size="small" class="input-sm" @update:value="value => value != null && saveDebouncedChange()" />
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.temperature')" :hint="t('ekkoConfig.modelParameterHint')">
                <NInputNumber v-model:value="form.model.temperature" :min="0" :step="0.1" clearable size="small" class="input-sm" @update:value="saveDebouncedChange" />
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.maxTokens')" :hint="t('ekkoConfig.modelParameterHint')">
                <NInputNumber v-model:value="form.model.maxTokens" :min="1" clearable size="small" class="input-sm" @update:value="saveDebouncedChange" />
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.reasoningEffort')" :hint="t('ekkoConfig.modelParameterHint')">
                <NSelect v-model:value="form.model.reasoningEffort" :options="reasoningEffortOptions" size="small" class="input-md" @update:value="saveImmediateChange" />
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.reasoningSummary')" :hint="t('ekkoConfig.modelParameterHint')">
                <NSelect v-model:value="form.model.reasoningSummary" :options="reasoningSummaryOptions" size="small" class="input-md" @update:value="saveImmediateChange" />
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.authorizationLeewayMs')" :hint="t('ekkoConfig.authorizationLeewayHint')">
                <NInputNumber v-model:value="form.model.authorizationRefreshLeewayMs" :min="0" :step="1000" size="small" class="input-sm" @update:value="value => value != null && saveDebouncedChange()" />
              </SettingRow>
            </section>
          </NTabPane>

          <!-- Ekko compression settings stay hidden until Studio delegates its
          compression policy to the agent-level config. Studio currently owns
          this configuration through the main Hermes settings.
          <NTabPane name="compression" :tab="t('settings.tabs.compression')">
            <section class="settings-section">
              <SettingRow :label="t('settings.compression.enabled')" :hint="t('settings.compression.enabledHint')">
                <NSwitch v-model:value="form.compression.enabled" @update:value="saveImmediateChange" />
              </SettingRow>
              <SettingRow :label="t('settings.compression.threshold')" :hint="t('settings.compression.thresholdHint')">
                <NInputNumber v-model:value="form.compression.threshold" :min="0.1" :max="0.95" :step="0.05" size="small" class="input-sm" @update:value="value => value != null && saveDebouncedChange()" />
              </SettingRow>
              <SettingRow :label="t('settings.compression.targetRatio')" :hint="t('settings.compression.targetRatioHint')">
                <NInputNumber v-model:value="form.compression.targetRatio" :min="0.05" :max="0.8" :step="0.05" size="small" class="input-sm" @update:value="value => value != null && saveDebouncedChange()" />
              </SettingRow>
              <SettingRow :label="t('settings.compression.protectLastN')" :hint="t('settings.compression.protectLastNHint')">
                <NInputNumber v-model:value="form.compression.protectLastN" :min="0" :max="200" size="small" class="input-sm" @update:value="value => value != null && saveDebouncedChange()" />
              </SettingRow>
              <SettingRow :label="t('settings.compression.protectFirstN')" :hint="t('settings.compression.protectFirstNHint')">
                <NInputNumber v-model:value="form.compression.protectFirstN" :min="0" :max="50" size="small" class="input-sm" @update:value="value => value != null && saveDebouncedChange()" />
              </SettingRow>
            </section>
          </NTabPane>
          -->

          <NTabPane name="tools" :tab="t('ekkoConfig.settingsTools')">
            <section class="settings-section">
              <SettingRow :label="t('ekkoConfig.toolsEnabled')" :hint="t('ekkoConfig.featureToggleHint')">
                <NSwitch v-model:value="form.tools.enabled" @update:value="saveImmediateChange" />
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.toolTimeoutMs')" :hint="t('ekkoConfig.timeoutHint')">
                <NInputNumber v-model:value="form.tools.executionTimeoutMs" :min="1" :step="1000" size="small" class="input-sm" @update:value="value => value != null && saveDebouncedChange()" />
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.approvalsEnabled')" :hint="t('ekkoConfig.featureToggleHint')">
                <NSwitch v-model:value="form.tools.approvals.enabled" @update:value="saveImmediateChange" />
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.approvalTimeoutMs')" :hint="t('ekkoConfig.timeoutHint')">
                <NInputNumber v-model:value="form.tools.approvals.timeoutMs" :min="1" :step="1000" size="small" class="input-sm" @update:value="value => value != null && saveDebouncedChange()" />
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.permanentAllow')" :hint="t('ekkoConfig.allowlistHint')">
                <NDynamicTags v-model:value="form.tools.approvals.permanentAllow" class="input-lg" @update:value="saveImmediateChange" />
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.codeExecEnabled')" :hint="t('ekkoConfig.featureToggleHint')">
                <NSwitch v-model:value="form.tools.codeExec.enabled" @update:value="saveImmediateChange" />
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.codeExecLanguages')" :hint="t('ekkoConfig.languagesHint')">
                <NCheckboxGroup v-model:value="form.tools.codeExec.languages" class="input-md" @update:value="saveImmediateChange">
                  <NCheckbox value="node">Node.js</NCheckbox>
                  <NCheckbox value="python">Python</NCheckbox>
                </NCheckboxGroup>
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.codeExecTimeoutMs')" :hint="t('ekkoConfig.timeoutHint')">
                <NInputNumber v-model:value="form.tools.codeExec.timeoutMs" :min="1" :step="1000" size="small" class="input-sm" @update:value="value => value != null && saveDebouncedChange()" />
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.codeExecMaxCalls')" :hint="t('ekkoConfig.runLimitHint')">
                <NInputNumber v-model:value="form.tools.codeExec.maxToolCalls" :min="1" size="small" class="input-sm" @update:value="value => value != null && saveDebouncedChange()" />
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.maxOutputBytes')" :hint="t('ekkoConfig.outputSizeHint')">
                <NInputNumber v-model:value="form.tools.codeExec.maxOutputBytes" :min="1" :step="1000" size="small" class="input-sm" @update:value="value => value != null && saveDebouncedChange()" />
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.maxStderrBytes')" :hint="t('ekkoConfig.outputSizeHint')">
                <NInputNumber v-model:value="form.tools.codeExec.maxStderrBytes" :min="1" :step="1000" size="small" class="input-sm" @update:value="value => value != null && saveDebouncedChange()" />
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.maxSourceBytes')" :hint="t('ekkoConfig.outputSizeHint')">
                <NInputNumber v-model:value="form.tools.codeExec.maxSourceBytes" :min="1" :step="1000" size="small" class="input-sm" @update:value="value => value != null && saveDebouncedChange()" />
              </SettingRow>
            </section>
          </NTabPane>

          <NTabPane name="modules" :tab="t('ekkoConfig.settingsModules')">
            <section class="settings-section">
              <SettingRow :label="t('ekkoConfig.memoryEnabled')" :hint="t('ekkoConfig.featureToggleHint')">
                <NSwitch v-model:value="form.memory.enabled" @update:value="saveImmediateChange" />
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.recentMessageLimit')" :hint="t('ekkoConfig.memoryWindowHint')">
                <NInputNumber v-model:value="form.memory.recentMessageLimit" :min="1" size="small" class="input-sm" @update:value="value => value != null && saveDebouncedChange()" />
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.recallTokenBudget')" :hint="t('ekkoConfig.recallBudgetHint')">
                <NInputNumber v-model:value="form.memory.automaticRecallTokenBudget" :min="0" :step="100" size="small" class="input-sm" @update:value="value => value != null && saveDebouncedChange()" />
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.memorySearchLimit')" :hint="t('ekkoConfig.resultLimitHint')">
                <NInputNumber v-model:value="form.memory.searchResultLimit" :min="1" size="small" class="input-sm" @update:value="value => value != null && saveDebouncedChange()" />
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.skillsEnabled')" :hint="t('ekkoConfig.featureToggleHint')">
                <NSwitch v-model:value="form.skills.enabled" @update:value="saveImmediateChange" />
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.skillReviewInterval')" :hint="t('ekkoConfig.reviewIntervalHint')">
                <NInputNumber v-model:value="form.skills.reviewEveryToolCalls" :min="0" size="small" class="input-sm" @update:value="value => value != null && saveDebouncedChange()" />
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.mcpEnabled')" :hint="t('ekkoConfig.featureToggleHint')">
                <NSwitch v-model:value="form.mcp.enabled" @update:value="saveImmediateChange" />
              </SettingRow>
            </section>
          </NTabPane>

          <NTabPane name="advanced" :tab="t('ekkoConfig.settingsAdvanced')">
            <section class="settings-section">
              <SettingRow :label="t('ekkoConfig.logMaxBytes')" :hint="t('ekkoConfig.outputSizeHint')">
                <NInputNumber v-model:value="form.logging.maxBytes" :min="1" :step="1048576" size="small" class="input-sm" @update:value="value => value != null && saveDebouncedChange()" />
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.promptInstructions')" :hint="t('ekkoConfig.promptInstructionsHint')">
                <NDynamicTags v-model:value="form.prompt.instructions" class="input-lg" @update:value="saveImmediateChange" />
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.schemaVersion')" :hint="t('ekkoConfig.readonlyConfigHint')">
                <span class="readonly-value">{{ schemaVersion }}</span>
              </SettingRow>
              <SettingRow :label="t('ekkoConfig.configPath')" :hint="t('ekkoConfig.readonlyConfigHint')">
                <NInput :value="configPath" readonly size="small" class="input-lg" />
              </SettingRow>
            </section>
          </NTabPane>
        </NTabs>
      </div>
    </div>
  </PageLoading>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.ekko-settings-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.ekko-settings-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.settings-error {
  margin-bottom: 12px;
}

.settings-section {
  margin-top: 16px;
}

.input-sm { width: 120px; }
.input-md { width: 240px; }
.input-lg { width: 360px; }

.readonly-value {
  color: $text-secondary;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

@media (max-width: $breakpoint-mobile) {
  .input-sm,
  .input-md,
  .input-lg {
    width: 100%;
  }
}

</style>
