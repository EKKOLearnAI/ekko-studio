<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NButton, NInput, NInputNumber, NModal, NSelect, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  fetchAuxiliaryModels,
  fetchDelegationModel,
  saveAuxiliaryModels,
  saveDelegationModel,
  type AuxiliaryModelSettings,
  type AuxiliaryModelTask,
  type AuxiliaryModelsConfig,
  type DelegationModelConfig,
} from '@/api/hermes/config'
import { useModelsStore } from '@/stores/hermes/models'
import { useProfilesStore } from '@/stores/hermes/profiles'
import FallbackProvidersPanel from './FallbackProvidersPanel.vue'

const { t } = useI18n()
const message = useMessage()
const modelsStore = useModelsStore()
const profilesStore = useProfilesStore()

const loading = ref(false)
const saving = ref(false)
const savingDelegation = ref(false)
const tasks = ref<AuxiliaryModelTask[]>([])
const auxiliary = ref<AuxiliaryModelsConfig>({})
const delegation = ref<DelegationModelConfig>({})
const showEditor = ref(false)
const showDelegationEditor = ref(false)
const editingTask = ref<AuxiliaryModelTask | null>(null)
const hydratingForm = ref(false)
const hydratingDelegationForm = ref(false)
const form = ref({
  provider: '',
  model: '',
  timeout: null as number | null,
  download_timeout: null as number | null,
  extra_body: '',
})
const delegationForm = ref({
  provider: '',
  model: '',
  reasoning_effort: null as string | null,
})

const modelOptions = computed(() => {
  const provider = form.value.provider.trim()
  if (!provider || provider === 'auto' || provider === 'main') return []
  return modelsForProvider(provider).map(model => ({ label: model, value: model }))
})

const delegationProviderOptions = computed(() => {
  const options = modelsStore.providers
    .filter(group => group.provider && group.provider.toLowerCase() !== 'moa')
    .map(group => ({ label: group.label || group.provider, value: group.provider }))
  const current = delegationForm.value.provider.trim()
  if (current && !options.some(option => option.value === current)) {
    options.unshift({ label: current, value: current })
  }
  return options
})

const delegationModelOptions = computed(() => {
  const provider = delegationForm.value.provider.trim()
  if (!provider) return []
  const options = modelsForProvider(provider).map(model => ({ label: model, value: model }))
  const current = delegationForm.value.model.trim()
  if (current && !options.some(option => option.value === current)) {
    options.unshift({ label: current, value: current })
  }
  return options
})

const reasoningEffortOptions = computed(() => [
  { label: t('chat.reasoningEffort.options.none'), value: 'none' },
  { label: t('chat.reasoningEffort.options.minimal'), value: 'minimal' },
  { label: t('chat.reasoningEffort.options.low'), value: 'low' },
  { label: t('chat.reasoningEffort.options.medium'), value: 'medium' },
  { label: t('chat.reasoningEffort.options.high'), value: 'high' },
  { label: t('chat.reasoningEffort.options.xhigh'), value: 'xhigh' },
  { label: t('chat.reasoningEffort.options.max'), value: 'max' },
  { label: t('chat.reasoningEffort.options.ultra'), value: 'ultra' },
])

const delegationModelLabel = computed(() => {
  if (!delegation.value.model) return t('models.delegationInheritMain')
  return delegation.value.provider
    ? `${delegation.value.provider} / ${delegation.value.model}`
    : delegation.value.model
})

const delegationReasoningLabel = computed(() => {
  if (!delegation.value.reasoning_effort) return t('models.delegationInheritReasoning')
  const option = reasoningEffortOptions.value.find(item => item.value === delegation.value.reasoning_effort)
  return option?.label || delegation.value.reasoning_effort
})

const hasDelegationOverride = computed(() => !!(
  delegation.value.provider || delegation.value.model || delegation.value.reasoning_effort
))

const isEditingVision = computed(() => editingTask.value?.key === 'vision')
const isEditingStudioImage = computed(() => (
  editingTask.value?.key === 'image_generation' || editingTask.value?.key === 'image_edit'
))

const providerOptions = computed(() => {
  const seen = new Set<string>()
  const options = [{
    label: isEditingStudioImage.value
      ? t('models.auxiliaryProviderStudioDefault')
      : t('models.auxiliaryProviderAuto'),
    value: 'auto',
  }]
  if (!isEditingStudioImage.value) {
    options.push({ label: t('models.auxiliaryProviderMain'), value: 'main' })
  }
  for (const group of modelsStore.providers) {
    if (!group.provider) continue
    if (isEditingStudioImage.value && !group.provider.startsWith('custom:')) continue
    if (seen.has(group.provider)) continue
    seen.add(group.provider)
    options.push({ label: group.label || group.provider, value: group.provider })
  }
  return options
})

function canonicalProviderValue(value: string): string {
  const normalized = value.startsWith('custom:') ? value.slice('custom:'.length) : value
  return normalized.trim().toLowerCase().replace(/ /g, '-')
}

function selectableProviderValue(provider: string, customOnly = false): string {
  if (!provider || provider === 'auto') return provider
  if (provider === 'main') return customOnly ? '' : provider
  const direct = modelsStore.providers.find(group => group.provider === provider)
  if (direct && (!customOnly || direct.provider.startsWith('custom:'))) return direct.provider
  const canonical = canonicalProviderValue(provider)
  return modelsStore.providers.find(group => (
    (!customOnly || group.provider.startsWith('custom:')) &&
    canonicalProviderValue(group.provider) === canonical
  ))?.provider || ''
}

function modelsForProvider(provider: string): string[] {
  const group = modelsStore.providers.find(item => item.provider === provider)
  return group?.models || []
}

function taskLabel(task: AuxiliaryModelTask): string {
  switch (task.key) {
    case 'compression': return t('models.auxiliaryTaskCompression')
    case 'vision': return t('models.auxiliaryTaskVision')
    case 'web_extract': return t('models.auxiliaryTaskWebExtract')
    case 'skills_hub': return t('models.auxiliaryTaskSkillsHub')
    case 'approval': return t('models.auxiliaryTaskApproval')
    case 'mcp': return t('models.auxiliaryTaskMcp')
    case 'title_generation': return t('models.auxiliaryTaskTitleGeneration')
    case 'triage_specifier': return t('models.auxiliaryTaskTriageSpecifier')
    case 'kanban_decomposer': return t('models.auxiliaryTaskKanbanDecomposer')
    case 'profile_describer': return t('models.auxiliaryTaskProfileDescriber')
    case 'curator': return t('models.auxiliaryTaskCurator')
    case 'session_search': return t('models.auxiliaryTaskSessionSearch')
    case 'flush_memories': return t('models.auxiliaryTaskFlushMemories')
    case 'image_generation': return t('models.auxiliaryTaskImageGeneration')
    case 'image_edit': return t('models.auxiliaryTaskImageEdit')
    default: return task.label || task.key
  }
}

function configuredLabel(task: AuxiliaryModelTask, settings?: AuxiliaryModelSettings): string {
  const defaultProviderLabel = task.key === 'image_generation' || task.key === 'image_edit'
    ? t('models.auxiliaryProviderStudioDefault')
    : t('models.auxiliaryProviderAuto')
  if (!settings || Object.keys(settings).length === 0) return defaultProviderLabel
  const provider = !settings.provider || settings.provider === 'auto'
    ? (settings.base_url ? t('models.auxiliaryCustomEndpoint') : defaultProviderLabel)
    : settings.provider
  return settings.model ? `${provider} / ${settings.model}` : provider
}

function timeoutLabel(task: AuxiliaryModelTask, settings?: AuxiliaryModelSettings): string {
  const timeout = settings?.timeout ?? task.default_timeout
  const downloadTimeout = task.key === 'vision'
    ? (settings?.download_timeout ?? task.default_download_timeout)
    : undefined
  if (!timeout && !downloadTimeout) return t('models.auxiliaryDefault')
  const values = []
  if (timeout) values.push(`${timeout}s`)
  if (downloadTimeout) values.push(`${t('models.auxiliaryDownloadShort')} ${downloadTimeout}s`)
  return values.join(' / ')
}

async function loadModelRouting() {
  loading.value = true
  try {
    const [auxiliaryData, delegationData] = await Promise.all([
      fetchAuxiliaryModels(),
      fetchDelegationModel(),
    ])
    tasks.value = auxiliaryData.tasks
    auxiliary.value = auxiliaryData.auxiliary
    delegation.value = delegationData.delegation
  } catch (e: any) {
    message.error(e.message || t('models.modelRoutingLoadFailed'))
  } finally {
    loading.value = false
  }
}

function openDelegationEditor() {
  hydratingDelegationForm.value = true
  delegationForm.value = {
    provider: delegation.value.provider || '',
    model: delegation.value.model || '',
    reasoning_effort: delegation.value.reasoning_effort || null,
  }
  hydratingDelegationForm.value = false
  showDelegationEditor.value = true
}

async function saveDelegation() {
  const provider = delegationForm.value.provider.trim()
  const model = delegationForm.value.model.trim()
  if (!provider || !model) {
    message.error(t('models.delegationModelRequired'))
    return
  }

  savingDelegation.value = true
  try {
    const saved = await saveDelegationModel({
      provider,
      model,
      reasoning_effort: delegationForm.value.reasoning_effort || undefined,
    })
    delegation.value = saved.delegation
    showDelegationEditor.value = false
    message.success(t('models.delegationSaved'))
  } catch (e: any) {
    message.error(e.message || t('models.delegationSaveFailed'))
  } finally {
    savingDelegation.value = false
  }
}

async function clearDelegation() {
  savingDelegation.value = true
  try {
    const saved = await saveDelegationModel({})
    delegation.value = saved.delegation
    message.success(t('models.delegationSaved'))
  } catch (e: any) {
    message.error(e.message || t('models.delegationSaveFailed'))
  } finally {
    savingDelegation.value = false
  }
}

function openEditor(task: AuxiliaryModelTask) {
  const current = auxiliary.value[task.key] || {}
  const isStudioImage = task.key === 'image_generation' || task.key === 'image_edit'
  const provider = selectableProviderValue(current.provider || '', isStudioImage) || 'auto'
  const model = provider === 'auto' || provider === 'main' || modelsForProvider(provider).includes(current.model || '')
    ? (current.model || '')
    : ''
  editingTask.value = task
  hydratingForm.value = true
  form.value = {
    provider,
    model,
    timeout: current.timeout ?? task.default_timeout ?? null,
    download_timeout: task.key === 'vision' ? (current.download_timeout ?? task.default_download_timeout ?? null) : null,
    extra_body: current.extra_body ? JSON.stringify(current.extra_body, null, 2) : '',
  }
  hydratingForm.value = false
  showEditor.value = true
}

function readExtraBody(): Record<string, any> | undefined {
  const raw = form.value.extra_body.trim()
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(t('models.auxiliaryInvalidExtraBody'))
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(t('models.auxiliaryInvalidExtraBody'))
  }
  return parsed as Record<string, any>
}

function buildSettings(): AuxiliaryModelSettings {
  const settings: AuxiliaryModelSettings = {}
  const provider = form.value.provider.trim()
  if (provider === 'auto') {
    settings.provider = 'auto'
    if (form.value.timeout) settings.timeout = form.value.timeout
    if (isEditingVision.value && form.value.download_timeout) settings.download_timeout = form.value.download_timeout
    return settings
  }

  const extraBody = readExtraBody()
  const model = form.value.model.trim()
  if (provider) settings.provider = provider
  if (provider && provider !== 'auto' && provider !== 'main' && !model) {
    throw new Error(t('models.modelRequired'))
  }
  if (model) settings.model = model
  if (form.value.timeout) settings.timeout = form.value.timeout
  if (isEditingVision.value && form.value.download_timeout) settings.download_timeout = form.value.download_timeout
  if (extraBody && Object.keys(extraBody).length > 0) settings.extra_body = extraBody
  if (Object.keys(settings).length === 0) settings.provider = 'auto'
  return settings
}

async function saveTask() {
  if (!editingTask.value) return
  let settings: AuxiliaryModelSettings
  try {
    settings = buildSettings()
  } catch (e: any) {
    message.error(e.message)
    return
  }

  saving.value = true
  try {
    const next = { ...auxiliary.value }
    if (Object.keys(settings).length > 0) next[editingTask.value.key] = settings
    else delete next[editingTask.value.key]
    const saved = await saveAuxiliaryModels(next)
    auxiliary.value = saved.auxiliary
    showEditor.value = false
    message.success(t('models.auxiliarySaved'))
  } catch (e: any) {
    message.error(e.message || t('models.auxiliarySaveFailed'))
  } finally {
    saving.value = false
  }
}

async function clearTask(task: AuxiliaryModelTask) {
  saving.value = true
  try {
    const next = { ...auxiliary.value }
    next[task.key] = {
      provider: 'auto',
      ...(task.default_timeout ? { timeout: task.default_timeout } : {}),
      ...(task.key === 'vision' && task.default_download_timeout ? { download_timeout: task.default_download_timeout } : {}),
    }
    const saved = await saveAuxiliaryModels(next)
    auxiliary.value = saved.auxiliary
    message.success(t('models.auxiliarySaved'))
  } catch (e: any) {
    message.error(e.message || t('models.auxiliarySaveFailed'))
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  void loadModelRouting()
})

watch(() => profilesStore.activeProfileName, () => {
  void loadModelRouting()
})

watch(() => form.value.provider, (provider) => {
  if (hydratingForm.value) return
  if (!provider || provider === 'auto' || provider === 'main') {
    form.value.model = ''
    if (provider === 'auto') form.value.extra_body = ''
    return
  }
  if (!modelsForProvider(provider).includes(form.value.model)) {
    form.value.model = ''
  }
}, { flush: 'sync' })

watch(() => delegationForm.value.provider, (provider) => {
  if (hydratingDelegationForm.value) return
  if (!modelsForProvider(provider).includes(delegationForm.value.model)) {
    delegationForm.value.model = ''
  }
}, { flush: 'sync' })
</script>

<template>
  <section class="auxiliary-panel">
    <div class="auxiliary-header">
      <div>
        <h3>{{ t('models.modelRoutingTitle') }}</h3>
        <p>{{ t('models.modelRoutingSubtitle') }}</p>
      </div>
      <NButton size="small" quaternary :loading="loading" @click="loadModelRouting">
        {{ t('models.auxiliaryRefresh') }}
      </NButton>
    </div>

    <NSpin :show="loading">
      <div class="delegation-section">
        <div class="delegation-header">
          <div>
            <h4>{{ t('models.delegationTitle') }}</h4>
            <p>{{ t('models.delegationSubtitle') }}</p>
          </div>
          <div class="delegation-actions">
            <NButton
              data-testid="delegation-reset"
              size="small"
              quaternary
              :disabled="savingDelegation || !hasDelegationOverride"
              @click="clearDelegation"
            >
              {{ t('models.delegationReset') }}
            </NButton>
            <NButton data-testid="delegation-edit" size="small" type="primary" secondary @click="openDelegationEditor">
              {{ t('common.edit') }}
            </NButton>
          </div>
        </div>
        <div class="delegation-summary">
          <div class="summary-item">
            <span>{{ t('models.defaultModel') }}</span>
            <strong :title="delegationModelLabel">{{ delegationModelLabel }}</strong>
          </div>
          <div class="summary-item">
            <span>{{ t('chat.reasoningEffort.tooltip') }}</span>
            <strong>{{ delegationReasoningLabel }}</strong>
          </div>
        </div>
      </div>

      <div class="auxiliary-tasks-header">
        <h4>{{ t('models.auxiliaryTasksTitle') }}</h4>
        <p>{{ t('models.auxiliarySubtitle') }}</p>
      </div>

      <div class="auxiliary-table-scroll">
        <div class="auxiliary-table">
          <div class="auxiliary-row auxiliary-row-head">
            <span>{{ t('models.auxiliaryTask') }}</span>
            <span>{{ t('models.provider') }} / {{ t('models.defaultModel') }}</span>
            <span>{{ t('models.auxiliaryTimeout') }}</span>
            <span>{{ t('models.auxiliaryActions') }}</span>
          </div>
          <div v-for="task in tasks" :key="task.key" class="auxiliary-row">
            <span class="task-name">{{ taskLabel(task) }}</span>
            <span class="task-config">{{ configuredLabel(task, auxiliary[task.key]) }}</span>
            <span class="task-timeout">{{ timeoutLabel(task, auxiliary[task.key]) }}</span>
            <span class="task-actions">
              <NButton size="tiny" quaternary @click="openEditor(task)">
                {{ t('common.edit') }}
              </NButton>
              <NButton
                size="tiny"
                quaternary
                :disabled="saving"
                @click="clearTask(task)"
              >
                {{ t('models.auxiliaryClear') }}
              </NButton>
            </span>
          </div>
        </div>
      </div>
    </NSpin>

    <div class="fallback-section">
      <FallbackProvidersPanel />
    </div>

    <NModal
      v-model:show="showDelegationEditor"
      preset="card"
      :title="t('models.delegationTitle')"
      :style="{ width: 'min(620px, calc(100vw - 32px))' }"
      :mask-closable="!savingDelegation"
    >
      <div class="delegation-form">
        <label>
          <span>{{ t('models.provider') }}</span>
          <NSelect
            data-testid="delegation-provider"
            v-model:value="delegationForm.provider"
            :options="delegationProviderOptions"
            :placeholder="t('models.chooseProvider')"
            filterable
          />
        </label>
        <label>
          <span>{{ t('models.defaultModel') }}</span>
          <NSelect
            data-testid="delegation-model"
            v-model:value="delegationForm.model"
            :options="delegationModelOptions"
            :placeholder="t('models.selectModel')"
            :disabled="!delegationForm.provider"
            filterable
          />
        </label>
        <label class="reasoning-field">
          <span>{{ t('chat.reasoningEffort.tooltip') }}</span>
          <NSelect
            data-testid="delegation-reasoning"
            v-model:value="delegationForm.reasoning_effort"
            :options="reasoningEffortOptions"
            :placeholder="t('models.delegationInheritReasoning')"
            clearable
          />
        </label>
      </div>
      <p class="delegation-form-hint">{{ t('models.delegationFormHint') }}</p>
      <template #footer>
        <div class="auxiliary-modal-actions">
          <NButton :disabled="savingDelegation" @click="showDelegationEditor = false">{{ t('common.cancel') }}</NButton>
          <NButton data-testid="delegation-save" type="primary" :loading="savingDelegation" @click="saveDelegation">{{ t('common.save') }}</NButton>
        </div>
      </template>
    </NModal>

    <NModal
      v-model:show="showEditor"
      preset="card"
      :title="editingTask ? taskLabel(editingTask) : t('models.auxiliaryTitle')"
      :style="{ width: 'min(620px, calc(100vw - 32px))' }"
      :mask-closable="!saving"
    >
      <div class="auxiliary-form">
        <label>
          <span>{{ t('models.provider') }}</span>
          <NSelect
            data-testid="auxiliary-provider"
            v-model:value="form.provider"
            :options="providerOptions"
            :placeholder="t('models.chooseProvider')"
            filterable
          />
        </label>
        <label>
          <span>{{ t('models.defaultModel') }}</span>
          <NSelect
            data-testid="auxiliary-model"
            v-model:value="form.model"
            :options="modelOptions"
            :placeholder="t('models.selectModel')"
            :disabled="!form.provider || form.provider === 'auto' || form.provider === 'main'"
            filterable
          />
        </label>
        <label>
          <span>{{ t('models.auxiliaryTimeout') }}</span>
          <NInputNumber
            data-testid="auxiliary-timeout"
            v-model:value="form.timeout"
            :min="1"
            :precision="0"
          />
        </label>
        <label v-if="isEditingVision">
          <span>{{ t('models.auxiliaryDownloadTimeout') }}</span>
          <NInputNumber v-model:value="form.download_timeout" :min="1" :precision="0" />
        </label>
        <label class="extra-body-field">
          <span>{{ t('models.auxiliaryExtraBody') }}</span>
          <NInput v-model:value="form.extra_body" type="textarea" :autosize="{ minRows: 4, maxRows: 8 }" />
        </label>
      </div>
      <template #footer>
        <div class="auxiliary-modal-actions">
          <NButton :disabled="saving" @click="showEditor = false">{{ t('common.cancel') }}</NButton>
          <NButton data-testid="auxiliary-save" type="primary" :loading="saving" @click="saveTask">
            {{ t('common.save') }}
          </NButton>
        </div>
      </template>
    </NModal>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.auxiliary-panel {
  --auxiliary-table-min-width: 720px;

  background-color: $bg-card;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  margin-bottom: 16px;
}

.auxiliary-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  border-bottom: 1px solid $border-light;

  h3 {
    color: $text-primary;
    font-size: 15px;
    font-weight: 600;
    margin: 0 0 4px;
  }

  p {
    color: $text-muted;
    font-size: 12px;
    margin: 0;
  }
}

.delegation-section {
  margin: 16px;
  overflow: hidden;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  background: $bg-secondary;
}

.delegation-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px 12px;

  h4,
  p {
    margin: 0;
  }

  h4 {
    color: $text-primary;
    font-size: 14px;
    font-weight: 600;
  }

  p {
    margin-top: 5px;
    color: $text-muted;
    font-size: 12px;
    line-height: 1.45;
  }
}

.delegation-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.delegation-summary {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(140px, 1fr);
  border-top: 1px solid $border-light;
}

.summary-item {
  min-width: 0;
  padding: 11px 16px 12px;

  & + & {
    border-inline-start: 1px solid $border-light;
  }

  span,
  strong {
    display: block;
  }

  span {
    margin-bottom: 4px;
    color: $text-muted;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  strong {
    overflow: hidden;
    color: $text-secondary;
    font-family: $font-code;
    font-size: 12px;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.auxiliary-tasks-header {
  padding: 14px 16px 10px;
  border-top: 1px solid $border-light;

  h4,
  p {
    margin: 0;
  }

  h4 {
    color: $text-primary;
    font-size: 14px;
    font-weight: 600;
  }

  p {
    margin-top: 4px;
    color: $text-muted;
    font-size: 12px;
  }
}

.auxiliary-table-scroll {
  overflow-x: auto;
  scrollbar-width: thin;
}

.fallback-section {
  padding: 16px;
  border-top: 1px solid $border-light;
}

.auxiliary-table {
  min-width: var(--auxiliary-table-min-width);
}

.auxiliary-row {
  display: grid;
  grid-template-columns: minmax(160px, 1.1fr) minmax(220px, 1.8fr) minmax(110px, 0.8fr) minmax(130px, auto);
  gap: 12px;
  align-items: center;
  padding: 10px 16px;
  border-bottom: 1px solid $border-light;

  &:last-child {
    border-bottom: 0;
  }
}

.auxiliary-row-head {
  color: $text-muted;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}

.task-name {
  color: $text-primary;
  font-size: 13px;
  font-weight: 500;
}

.task-config,
.task-timeout {
  color: $text-secondary;
  font-family: $font-code;
  font-size: 12px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.auxiliary-form,
.delegation-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;

  label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;

    > span {
      color: $text-secondary;
      font-size: 12px;
      font-weight: 500;
    }
  }
}

.reasoning-field {
  grid-column: 1 / -1;
}

.delegation-form-hint {
  margin: 12px 0 0;
  color: $text-muted;
  font-size: 12px;
  line-height: 1.5;
}

.extra-body-field {
  grid-column: 1 / -1;
}

.auxiliary-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

@media (max-width: 760px) {
  .delegation-header {
    flex-direction: column;
  }

  .delegation-actions {
    justify-content: flex-end;
    width: 100%;
  }

  .delegation-summary {
    grid-template-columns: 1fr;
  }

  .summary-item + .summary-item {
    border-top: 1px solid $border-light;
    border-inline-start: 0;
  }

  .auxiliary-form,
  .delegation-form {
    grid-template-columns: 1fr;
  }

  .reasoning-field {
    grid-column: auto;
  }
}
</style>
