<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NSelect } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { CodingAgentId } from '@/api/coding-agents'
import { useCodingAgentModels } from '@/composables/useCodingAgentModels'
import { nativeCatalogModel, nativeModelEffortChoices, nativeModelFamilies, nativeModelPickerId, selectNativeModelEffort } from '@/utils/native-model-families'
import ModelCascader from './ModelCascader.vue'

const props = defineProps<{ agent: CodingAgentId; model: string; reasoningEffort: string; disabled?: boolean; field?: 'model' | 'reasoning-effort' }>()
const emit = defineEmits<{ change: [selection: { model: string; reasoningEffort: string }] }>()
const { t, te } = useI18n()
const { catalog, loading, refreshFailed, reload } = useCodingAgentModels(() => props.agent, () => true)
const models = computed(() => catalog.value?.models || [])
const selected = computed(() => nativeCatalogModel(models.value, props.model))
const choices = computed(() => nativeModelEffortChoices(models.value, props.model))
const effort = computed(() => props.reasoningEffort || selected.value?.reasoningEffort || '')
const effortLabel = (value: string) => !value ? t('chat.reasoningEffort.defaultLabel')
  : te(`chat.reasoningEffort.options.${value}`) ? t(`chat.reasoningEffort.options.${value}`) : value
const effortOptions = computed(() => {
  const options = choices.value?.map(choice => ({ label: effortLabel(choice.effort), value: choice.effort }))
    || ['', ...(selected.value?.reasoningEfforts || [])].map(value => ({ label: effortLabel(value), value }))
  if (effort.value && !options.some(option => option.value === effort.value)) options.push({ label: effortLabel(effort.value), value: effort.value })
  return options
})
const canSelectEffort = computed(() => Boolean(selected.value?.reasoningEfforts?.length)
  && effortOptions.value.length > 1 && (!effort.value || (choices.value
    ? choices.value.some(choice => choice.effort === effort.value)
    : selected.value?.reasoningEfforts?.includes(effort.value))))
const groups = computed(() => [{ provider: `native:${props.agent}`, label: catalog.value?.name || props.agent,
  base_url: '', api_key: '', models: ['', ...new Set(nativeModelFamilies(models.value).map(model => model.id))] }])
function displayName(id: string) {
  const model = nativeCatalogModel(models.value, id)
  return id ? model?.modelFamilyName || model?.name || id : t('codingAgents.nativeModelDefault')
}
function selectModel({ model }: { model: string }) {
  if (props.disabled) return
  const sameFamily = model === nativeModelPickerId(models.value, props.model)
  emit('change', sameFamily && model ? selectNativeModelEffort(models.value, model, effort.value)
    : { model, reasoningEffort: nativeCatalogModel(models.value, model)?.reasoningEffort || '' })
}
function selectEffort(value: string) {
  if (!props.disabled && canSelectEffort.value) emit('change', selectNativeModelEffort(models.value, props.model, value))
}
</script>

<template>
  <div class="native-coding-agent-model-fields">
    <ModelCascader v-if="field !== 'reasoning-effort'" :groups="groups" :provider="`native:${agent}`" :model="nativeModelPickerId(models, model)"
      :custom-models="{}" :display-name="displayName" :disabled="disabled" @select="selectModel">
      <template #trigger="{ show, open, openWithKeyboard }">
        <button type="button" class="native-model-trigger" :disabled="disabled" aria-haspopup="dialog"
          :aria-expanded="show" @click="open" @keydown.down="openWithKeyboard">
          {{ displayName(model) }}
        </button>
      </template>
      <template #footer>
        <div class="native-model-status" :aria-busy="loading">
          <span v-if="loading && !catalog">{{ t('common.loading') }}</span>
          <span v-else-if="refreshFailed && catalog && ['ready', 'empty'].includes(catalog.status)">{{ t('codingAgents.nativeModelsRefreshFailed') }}</span>
          <span v-else-if="!loading && (!catalog || !['ready', 'empty'].includes(catalog.status))">{{ t('codingAgents.nativeModelsFailed') }}</span>
          <span v-else-if="catalog?.status === 'empty'">{{ t('models.noModels') }}</span>
          <NButton size="small" quaternary :loading="loading" :disabled="disabled || loading" @click="reload(true)">{{ t('codingAgents.refresh') }}</NButton>
        </div>
      </template>
    </ModelCascader>
    <NSelect v-else class="native-reasoning-effort" :value="effort"
      :options="effortOptions" size="small" :disabled="disabled || !canSelectEffort"
      :aria-label="t('chat.reasoningEffort.tooltip')"
      :placeholder="t('chat.reasoningEffort.tooltip')" @update:value="selectEffort" />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.native-coding-agent-model-fields { min-width: 0; }
.native-model-trigger {
  width: 100%; padding: 6px 8px; border: 1px solid $border-color; border-radius: $radius-sm;
  background: $bg-input; color: $text-primary; font-size: 13px; text-align: start; cursor: pointer;
  &:disabled { opacity: .6; cursor: default; }
  &:focus-visible { outline: 2px solid $accent-primary; }
}
.native-model-status { display: flex; align-items: center; gap: 8px; padding: 0 14px 12px; color: $text-secondary; font-size: 12px; > span { flex: 1; } }
</style>
