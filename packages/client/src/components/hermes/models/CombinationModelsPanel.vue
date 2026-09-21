<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NButton, NInput, NInputNumber, NModal, NSelect, NSpin, NSwitch, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchMoaConfig, saveMoaConfig, type MoaConfig, type MoaModelSlot, type MoaPreset } from '@/api/hermes/config'
import { useAppStore } from '@/stores/hermes/app'
import { useModelsStore } from '@/stores/hermes/models'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useCollapsedProviderGroups } from '@/composables/useCollapsedProviderGroups'

const { t } = useI18n()
const message = useMessage()
const appStore = useAppStore()
const modelsStore = useModelsStore()
const profilesStore = useProfilesStore()

const loading = ref(false)
const saving = ref(false)
const moa = ref<MoaConfig | null>(null)
const showEditor = ref(false)
const editingName = ref('')
const formName = ref('')
const formPreset = ref<MoaPreset>(createEmptyPreset())
const showModelPicker = ref(false)
const pickerTarget = ref<{ kind: 'reference' | 'aggregator'; index?: number } | null>(null)
const pickerSearch = ref('')
const { isGroupCollapsed: isModelPickerGroupCollapsed, toggleGroup: toggleModelPickerGroup } = useCollapsedProviderGroups()
const customProvider = ref('')
const customInput = ref('')

const providerOptions = computed(() => modelsStore.providers
  .filter(group => group.provider && group.provider.toLowerCase() !== 'moa')
  .map(group => ({ label: group.label || group.provider, value: group.provider })))

const modelGroupsWithCustom = computed(() => modelsStore.providers
  .filter(group => group.provider && group.provider.toLowerCase() !== 'moa')
  .map(group => ({
    ...group,
    models: [
      ...group.models,
      ...(appStore.customModels[group.provider] || []).filter(model => !group.models.includes(model)),
    ],
  })))

const filteredModelGroups = computed(() => {
  const query = pickerSearch.value.trim().toLowerCase()
  if (!query) return modelGroupsWithCustom.value
  return modelGroupsWithCustom.value
    .map(group => ({
      ...group,
      models: group.models.filter(model => {
        const display = appStore.displayModelName(model, group.provider)
        return model.toLowerCase().includes(query) || display.toLowerCase().includes(query)
      }),
    }))
    .filter(group => group.models.length > 0 || String(group.label || group.provider).toLowerCase().includes(query))
})

const presetRows = computed(() => {
  if (!moa.value) return []
  return Object.entries(moa.value.presets).map(([name, preset]) => ({ name, preset }))
})

function createEmptyPreset(): MoaPreset {
  return {
    enabled: true,
    reference_models: [],
    aggregator: { provider: '', model: '', reasoning_effort: undefined },
    reference_temperature: 0.6,
    aggregator_temperature: 0.4,
    max_tokens: 4096,
  }
}

function cloneMoaConfig(config: MoaConfig): MoaConfig {
  return JSON.parse(JSON.stringify(config))
}

function clonePreset(preset: MoaPreset): MoaPreset {
  return JSON.parse(JSON.stringify(preset))
}

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

function slotLabel(slot?: MoaModelSlot): string {
  if (!slot?.provider || !slot?.model) return t('models.combinationNotSet')
  return `${slot.provider} / ${slot.model}`
}

function modelDisplayName(model: string, provider: string): string {
  return appStore.displayModelName(model, provider)
}

function modelAlias(model: string, provider: string): string {
  return appStore.getModelAlias(model, provider)
}

function isCustomModel(model: string, provider: string): boolean {
  return (appStore.customModels[provider] || []).includes(model)
}

async function loadMoaConfig() {
  loading.value = true
  try {
    const data = await fetchMoaConfig()
    moa.value = cloneMoaConfig(data)
  } catch (e: any) {
    message.error(e.message || t('models.combinationLoadFailed'))
  } finally {
    loading.value = false
  }
}

function openCreateModal() {
  editingName.value = ''
  formName.value = ''
  formPreset.value = createEmptyPreset()
  showEditor.value = true
}

function openEditModal(name: string) {
  if (!moa.value?.presets[name]) return
  editingName.value = name
  formName.value = name
  formPreset.value = clonePreset(moa.value.presets[name])
  showEditor.value = true
}

function addReference() {
  openModelPicker('reference')
}

function removeReference(index: number) {
  formPreset.value.reference_models.splice(index, 1)
}

function validatePreset(): boolean {
  const name = formName.value.trim()
  if (!name) {
    message.error(t('models.combinationNameRequired'))
    return false
  }
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(name)) {
    message.error(t('models.combinationNameInvalid'))
    return false
  }
  if (!editingName.value && moa.value?.presets[name]) {
    message.error(t('models.combinationPresetExists'))
    return false
  }
  if (editingName.value && name !== editingName.value && moa.value?.presets[name]) {
    message.error(t('models.combinationPresetExists'))
    return false
  }
  const refs = formPreset.value.reference_models.filter(slot => slot.provider.trim() && slot.model.trim())
  if (refs.length === 0) {
    message.error(t('models.combinationReferenceRequired'))
    return false
  }
  if (!formPreset.value.aggregator.provider.trim() || !formPreset.value.aggregator.model.trim()) {
    message.error(t('models.combinationAggregatorRequired'))
    return false
  }
  return true
}

async function saveEditor() {
  if (!moa.value || !validatePreset()) return
  const name = formName.value.trim()
  const next = cloneMoaConfig(moa.value)
  const preset: MoaPreset = {
    ...clonePreset(formPreset.value),
    reference_models: formPreset.value.reference_models
      .filter(slot => slot.provider.trim() && slot.model.trim())
      .map(slot => ({ provider: slot.provider.trim(), model: slot.model.trim(), reasoning_effort: slot.reasoning_effort || undefined })),
    aggregator: {
      provider: formPreset.value.aggregator.provider.trim(),
      model: formPreset.value.aggregator.model.trim(),
      reasoning_effort: formPreset.value.aggregator.reasoning_effort || undefined,
    },
    max_tokens: Math.max(1, Math.floor(Number(formPreset.value.max_tokens) || 4096)),
  }
  if (editingName.value && editingName.value !== name) {
    delete next.presets[editingName.value]
    if (next.default_preset === editingName.value) next.default_preset = name
    if (next.active_preset === editingName.value) next.active_preset = name
  }
  next.presets[name] = preset
  if (!next.default_preset || !next.presets[next.default_preset]) next.default_preset = name
  await persist(next)
  showEditor.value = false
}

async function setDefaultPreset(name: string) {
  if (!moa.value || moa.value.default_preset === name) return
  const next = cloneMoaConfig(moa.value)
  next.default_preset = name
  await persist(next)
}

async function deletePreset(name: string) {
  if (!moa.value || Object.keys(moa.value.presets).length <= 1) return
  const next = cloneMoaConfig(moa.value)
  delete next.presets[name]
  const fallback = Object.keys(next.presets)[0]
  if (next.default_preset === name) next.default_preset = fallback
  if (next.active_preset === name) next.active_preset = ''
  await persist(next)
}

function openModelPicker(kind: 'reference' | 'aggregator', index?: number) {
  pickerTarget.value = { kind, index }
  pickerSearch.value = ''
  customProvider.value = modelGroupsWithCustom.value[0]?.provider || ''
  customInput.value = ''
  showModelPicker.value = true
}

function applyPickedModel(slot: MoaModelSlot) {
  if (!pickerTarget.value) return
  if (pickerTarget.value.kind === 'aggregator') {
    formPreset.value.aggregator = slot
  } else if (typeof pickerTarget.value.index === 'number') {
    formPreset.value.reference_models[pickerTarget.value.index] = slot
  } else {
    formPreset.value.reference_models.push(slot)
  }
  showModelPicker.value = false
}

function pickModel(model: string, provider: string) {
  const meta = modelGroupsWithCustom.value.find(group => group.provider === provider)?.model_meta?.[model]
  if (meta?.disabled) return
  applyPickedModel({ provider, model })
}

function handleCustomModelSubmit() {
  const model = customInput.value.trim()
  if (!customProvider.value || !model) return
  const meta = modelGroupsWithCustom.value.find(group => group.provider === customProvider.value)?.model_meta?.[model]
  if (meta?.disabled) return
  applyPickedModel({ provider: customProvider.value, model })
}

async function removeCustomModel(model: string, provider: string) {
  await appStore.removeCustomModel(model, provider)
}

async function persist(next: MoaConfig) {
  saving.value = true
  try {
    const saved = await saveMoaConfig(next)
    moa.value = cloneMoaConfig(saved.moa)
    await Promise.all([
      modelsStore.fetchProviders(),
      appStore.reloadModels({ preserveSelection: true }),
    ])
    message.success(t('models.combinationSaved'))
  } catch (e: any) {
    message.error(e.message || t('models.combinationSaveFailed'))
    throw e
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  void loadMoaConfig()
})

watch(() => profilesStore.activeProfileName, () => {
  void loadMoaConfig()
})
</script>

<template>
  <section class="combination-models-panel">
    <div class="combination-header">
      <div>
        <h3>{{ t('models.combinationTitle') }}</h3>
        <p>{{ t('models.combinationSubtitle') }}</p>
      </div>
      <div class="combination-header-actions">
        <NButton size="small" quaternary :loading="loading" @click="loadMoaConfig">
          {{ t('models.auxiliaryRefresh') }}
        </NButton>
        <NButton size="small" type="primary" :disabled="!moa" @click="openCreateModal">
          {{ t('models.combinationAddModel') }}
        </NButton>
      </div>
    </div>

    <NSpin :show="loading">
      <div class="combination-table">
        <div class="combination-row combination-row-head">
          <span>{{ t('models.combinationName') }}</span>
          <span>{{ t('models.combinationReferenceModels') }}</span>
          <span>{{ t('models.combinationAggregator') }}</span>
          <span>{{ t('models.auxiliaryActions') }}</span>
        </div>
        <div v-for="{ name, preset } in presetRows" :key="name" class="combination-row">
          <span class="preset-name">
            {{ name }}
            <span v-if="moa?.default_preset === name" class="default-badge">{{ t('models.defaultShort') }}</span>
          </span>
          <span class="slot-summary">{{ preset.reference_models.map(slotLabel).join(', ') }}</span>
          <span class="slot-summary">{{ slotLabel(preset.aggregator) }}</span>
          <span class="row-actions">
            <NButton size="tiny" quaternary @click="openEditModal(name)">{{ t('common.edit') }}</NButton>
            <NButton size="tiny" quaternary :disabled="moa?.default_preset === name" @click="setDefaultPreset(name)">
              {{ t('models.combinationSetDefault') }}
            </NButton>
            <NButton size="tiny" quaternary :disabled="presetRows.length <= 1" @click="deletePreset(name)">
              {{ t('common.delete') }}
            </NButton>
          </span>
        </div>
      </div>
    </NSpin>

    <NModal
      v-model:show="showEditor"
      preset="card"
      :title="editingName ? t('models.combinationEditModel') : t('models.combinationAddModel')"
      :style="{ width: 'min(760px, calc(100vw - 32px))' }"
      :mask-closable="!saving"
    >
      <div class="combination-form">
        <label>
          <span>{{ t('models.combinationName') }}</span>
          <NInput v-model:value="formName" :placeholder="t('models.combinationPresetPlaceholder')" />
        </label>
        <label class="switch-row">
          <span>{{ t('models.combinationEnabled') }}</span>
          <NSwitch v-model:value="formPreset.enabled" />
        </label>
        <label>
          <span>{{ t('models.combinationReferenceTemperature') }}</span>
          <NInputNumber v-model:value="formPreset.reference_temperature" :min="0" :max="2" :step="0.1" />
        </label>
        <label>
          <span>{{ t('models.combinationAggregatorTemperature') }}</span>
          <NInputNumber v-model:value="formPreset.aggregator_temperature" :min="0" :max="2" :step="0.1" />
        </label>
        <label>
          <span>{{ t('models.combinationMaxTokens') }}</span>
          <NInputNumber v-model:value="formPreset.max_tokens" :min="1" :precision="0" />
        </label>

        <div class="slot-section">
          <div class="slot-section-header">
            <h4>{{ t('models.combinationReferenceModels') }}</h4>
            <NButton size="tiny" type="primary" secondary @click="addReference">
              {{ t('models.combinationAddReference') }}
            </NButton>
          </div>
          <div class="slot-editor-list">
            <div v-for="(slot, index) in formPreset.reference_models" :key="index" class="slot-editor-row">
              <span class="slot-pair">{{ slotLabel(slot) }}</span>
              <NSelect
                v-model:value="slot.reasoning_effort"
                :options="reasoningEffortOptions"
                size="small"
                clearable
                :placeholder="t('chat.reasoningEffort.tooltip')"
                :style="{ width: '130px' }"
              />
              <span class="slot-row-actions">
                <NButton size="small" quaternary @click="openModelPicker('reference', index)">
                  {{ t('common.edit') }}
                </NButton>
                <NButton size="small" quaternary @click="removeReference(index)">
                  {{ t('common.delete') }}
                </NButton>
              </span>
            </div>
          </div>
        </div>

        <div class="slot-section">
          <div class="slot-section-header">
            <h4>{{ t('models.combinationAggregator') }}</h4>
          </div>
          <div class="slot-editor-row aggregator-row">
            <span class="slot-pair">{{ slotLabel(formPreset.aggregator) }}</span>
            <NSelect
              v-model:value="formPreset.aggregator.reasoning_effort"
              :options="reasoningEffortOptions"
              size="small"
              clearable
              :placeholder="t('chat.reasoningEffort.tooltip')"
              :style="{ width: '130px' }"
            />
            <span class="slot-row-actions">
              <NButton size="small" quaternary @click="openModelPicker('aggregator')">
                {{ t('common.edit') }}
              </NButton>
            </span>
          </div>
        </div>
      </div>
      <template #footer>
        <div class="modal-actions">
          <NButton :disabled="saving" @click="showEditor = false">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="saving" @click="saveEditor">{{ t('common.save') }}</NButton>
        </div>
      </template>
    </NModal>

    <NModal
      v-model:show="showModelPicker"
      preset="card"
      :title="t('models.selectModel')"
      :style="{ width: 'min(480px, calc(100vw - 32px))' }"
      :mask-closable="true"
    >
      <NInput
        v-model:value="pickerSearch"
        :placeholder="t('models.searchPlaceholder')"
        clearable
        size="small"
        class="model-search"
      />
      <div class="model-list">
        <div v-for="group in filteredModelGroups" :key="group.provider" class="model-group">
          <div class="model-group-header" @click="toggleModelPickerGroup(group.provider)">
            <svg
              class="model-group-arrow"
              :class="{ collapsed: isModelPickerGroupCollapsed(group.provider) }"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
            <span class="model-group-label">{{ group.label || group.provider }}</span>
            <span class="model-group-count">{{ group.models.length }}</span>
          </div>
          <div v-show="!isModelPickerGroupCollapsed(group.provider)" class="model-group-items">
            <div
              v-for="model in group.models"
              :key="model"
              class="model-item"
              :class="{ disabled: !!group.model_meta?.[model]?.disabled }"
              :title="group.model_meta?.[model]?.disabled ? t('models.disabledTooltip') : ''"
              @click="pickModel(model, group.provider)"
            >
              <span class="model-item-label">
                <span class="model-item-name">{{ modelDisplayName(model, group.provider) }}</span>
                <span v-if="modelAlias(model, group.provider)" class="model-item-id">
                  {{ t('models.aliasCanonical', { model }) }}
                </span>
              </span>
              <span v-if="group.model_meta?.[model]?.preview" class="model-badge-preview">{{ t('models.previewBadge') }}</span>
              <span v-if="group.model_meta?.[model]?.disabled" class="model-badge-disabled">{{ t('models.disabledBadge') }}</span>
              <span v-if="isCustomModel(model, group.provider)" class="model-badge-custom">{{ t('models.customBadge') }}</span>
              <button
                v-if="isCustomModel(model, group.provider)"
                class="model-custom-remove"
                type="button"
                :title="t('models.removeCustomModel')"
                @click.stop="removeCustomModel(model, group.provider)"
              >
                ×
              </button>
            </div>
          </div>
        </div>
        <div v-if="filteredModelGroups.length === 0" class="model-empty">
          {{ pickerSearch ? t('models.noResults') : t('models.noModels') }}
        </div>
        <div class="model-custom">
          <div class="model-custom-row">
            <NSelect
              v-model:value="customProvider"
              :options="providerOptions"
              size="small"
              class="model-custom-provider"
            />
            <NInput
              v-model:value="customInput"
              :placeholder="t('models.customModelPlaceholder')"
              size="small"
              class="model-custom-input"
              @keydown.enter="handleCustomModelSubmit"
            />
          </div>
          <div class="model-custom-hint">
            {{ t('models.customModelHint') }}
          </div>
        </div>
      </div>
    </NModal>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.combination-models-panel {
  --combination-table-min-width: 860px;

  background-color: $bg-card;
  border: 1px solid $border-color;
  border-radius: $radius-md;
}

.combination-header {
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

.combination-header-actions,
.row-actions,
.modal-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.combination-table {
  min-width: var(--combination-table-min-width);
}

.combination-row {
  display: grid;
  grid-template-columns: minmax(150px, 0.8fr) minmax(260px, 1.7fr) minmax(220px, 1.2fr) minmax(220px, auto);
  gap: 12px;
  align-items: center;
  padding: 10px 16px;
  border-bottom: 1px solid $border-light;

  &:last-child {
    border-bottom: 0;
  }
}

.combination-row-head {
  color: $text-muted;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}

.preset-name {
  color: $text-primary;
  font-size: 13px;
  font-weight: 600;
  min-width: 0;
}

.default-badge {
  display: inline-flex;
  margin-inline-start: 6px;
  border-radius: 999px;
  padding: 1px 6px;
  background: rgba(var(--accent-primary-rgb), 0.12);
  color: $accent-primary;
  font-size: 10px;
  font-weight: 600;
}

.slot-summary {
  color: $text-secondary;
  font-family: $font-code;
  font-size: 12px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.combination-form {
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

.switch-row {
  flex-direction: row !important;
  align-items: center;
  justify-content: space-between;
  min-height: 34px;
}

.slot-section {
  grid-column: 1 / -1;
  border: 1px solid $border-light;
  border-radius: 8px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
}

.slot-section :deep(.n-button) {
  white-space: nowrap;
}

.slot-editor-list,
.slot-section > .slot-editor-row {
  min-width: 420px;
}

.slot-editor-list {
  overflow: hidden;
}

.slot-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  background: $bg-secondary;

  h4 {
    margin: 0;
    color: $text-primary;
    font-size: 13px;
    font-weight: 600;
  }
}

.slot-editor-list {
  display: flex;
  flex-direction: column;
}

.slot-editor-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 130px auto;
  gap: 10px;
  align-items: center;
  padding: 10px 12px;
  border-top: 1px solid $border-light;
}

.slot-pair {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: $text-secondary;
  font-family: $font-code;
  font-size: 12px;
}

.slot-row-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.model-search {
  margin-bottom: 12px;
}

.model-list {
  max-height: 50vh;
  overflow-y: auto;
  scrollbar-width: thin;
}

.model-group {
  margin-bottom: 4px;
}

.model-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px;
  border-radius: $radius-sm;
  color: $text-secondary;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  transition: background-color $transition-fast;
  user-select: none;

  &:hover {
    background-color: $bg-secondary;
  }
}

.model-group-arrow {
  flex-shrink: 0;
  transition: transform $transition-fast;

  &.collapsed {
    transform: rotate(-90deg);
  }
}

.model-group-label {
  flex: 1;
}

.model-group-count {
  color: $text-muted;
  font-size: 11px;
  font-weight: 400;
}

.model-group-items {
  padding-inline-start: 8px;
}

.model-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: $radius-sm;
  color: $text-secondary;
  cursor: pointer;
  font-size: 13px;
  transition: all $transition-fast;

  &:hover {
    background-color: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;
  }

  &.disabled {
    cursor: not-allowed;
    opacity: 0.45;

    &:hover {
      background-color: transparent;
      color: $text-secondary;
    }
  }
}

.model-item-label {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
}

.model-item-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: $font-code;
  font-size: 12px;
}

.model-item-id {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: $text-muted;
  font-family: $font-code;
  font-size: 10px;
  font-weight: 400;
}

.model-badge-custom {
  flex-shrink: 0;
  border-radius: 3px;
  margin-inline-end: 4px;
  padding: 1px 5px;
  background: $accent-primary;
  color: #fff;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.03em;
}

.model-custom-remove {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: 50%;
  padding: 0;
  background: transparent;
  color: $text-muted;
  cursor: pointer;
  line-height: 18px;

  &:hover {
    background: rgba(var(--error-rgb), 0.12);
    color: $error;
  }
}

.model-badge-preview {
  flex-shrink: 0;
  border-radius: 3px;
  margin-inline-end: 4px;
  padding: 1px 5px;
  background: #d97706;
  color: #fff;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.03em;
}

.model-badge-disabled {
  flex-shrink: 0;
  border: 1px solid $border-color;
  border-radius: 3px;
  margin-inline-end: 4px;
  padding: 0 5px;
  background: transparent;
  color: $text-muted;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.03em;
}

.model-empty {
  padding: 24px 0;
  color: $text-muted;
  font-size: 13px;
  text-align: center;
}

.model-custom {
  margin-top: 12px;
  border-top: 1px solid $border-color;
  padding-top: 12px;
}

.model-custom-row {
  display: flex;
  gap: 8px;
}

.model-custom-provider {
  width: 160px;
  flex-shrink: 0;
}

.model-custom-input {
  flex: 1;
}

.model-custom-hint {
  margin-top: 6px;
  color: $text-muted;
  font-size: 11px;
}

@media (max-width: 860px) {
  .combination-models-panel {
    overflow-x: auto;
  }

  .combination-header {
    min-width: var(--combination-table-min-width);
  }

  .combination-form {
    grid-template-columns: 1fr;
  }

  .model-custom-row {
    flex-direction: column;
  }

  .model-custom-provider {
    width: 100%;
  }
}
</style>
