<script setup lang="ts">
import { computed, h, onMounted, ref, useId, watch } from 'vue'
import { NAlert, NButton, NDropdown, NSelect, type DropdownOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { listDshSessionPresets, type DshSessionPreset } from '@/api/coding-agents/dsh'

const selected = defineModel<string>()
const show = defineModel<boolean>('show', { default: false })
const emit = defineEmits<{ valid: [value: boolean] }>()
const inputId = useId()
const props = defineProps<{ disabled?: boolean; compact?: boolean }>()
const { t } = useI18n()
const presets = ref<DshSessionPreset[]>([])
const loading = ref(true)
const failed = ref(false)
const current = computed(() => presets.value.find(preset => preset.id === selected.value))
const presetTitle = computed(() => failed.value ? t('dshPresets.unavailable')
  : [current.value?.name || current.value?.id || t('dshPresets.sessionMode'), current.value?.description].filter(Boolean).join('\n'))
watch([loading, failed, current], () => emit('valid', !loading.value && !failed.value && !!current.value && !current.value.unavailable), { immediate: true })
const options = computed(() => presets.value.map(preset => ({
  value: preset.id,
  label: `${preset.name || preset.id}${preset.isDefault ? ` (${t('dshPresets.default')})` : ''}`,
  disabled: preset.unavailable,
})))
const dropdownOptions = computed<DropdownOption[]>(() => {
  if (failed.value) return [
    { key: 'unavailable', label: t('dshPresets.unavailable'), disabled: true },
    { key: 'retry', label: t('common.retry') },
  ]
  if (!loading.value && !presets.value.some(preset => !preset.unavailable)) {
    return [{ key: 'empty', label: t('dshPresets.empty'), disabled: true }]
  }
  return options.value.map(option => ({ ...option, key: option.value }))
})

function renderPresetLabel(option: DropdownOption) {
  const description = presets.value.find(preset => preset.id === option.key)?.description
  return h('div', { style: { maxWidth: '280px', whiteSpace: 'normal', padding: '3px 0' } }, [
    h('div', String(option.label || '')),
    description ? h('div', { style: { fontSize: '12px', opacity: .65, lineHeight: '1.5', marginTop: '2px' } }, description) : null,
  ])
}

function selectPreset(key: string | number) {
  if (props.disabled) return
  if (failed.value && key === 'retry') { void load(); return }
  if (presets.value.some(preset => preset.id === key && !preset.unavailable)) selected.value = String(key)
}
async function load() {
  loading.value = true
  failed.value = false
  try {
    presets.value = (await listDshSessionPresets()).presets
    if (!selected.value || (props.compact && !presets.value.some(preset => preset.id === selected.value && !preset.unavailable))) {
      selected.value = presets.value.find(preset => preset.isDefault && !preset.unavailable)?.id
        || presets.value.find(preset => !preset.unavailable)?.id
    }
  } catch { failed.value = true }
  finally { loading.value = false }
}
onMounted(load)
</script>

<template>
  <div v-if="compact" class="preset-compact" data-testid="dsh-session-preset">
    <NDropdown v-model:show="show" trigger="click" placement="bottom-end" :value="selected" :options="dropdownOptions"
      :render-label="renderPresetLabel" :disabled="props.disabled || loading" @select="selectPreset">
      <NButton quaternary circle size="small" class="preset-icon" :loading="loading" :disabled="props.disabled" :type="failed ? 'error' : undefined"
        :aria-label="t('dshPresets.sessionMode')" :aria-expanded="show" aria-haspopup="menu" :title="presetTitle" :data-preset="current?.id">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></svg>
      </NButton>
    </NDropdown>
  </div>
  <div v-else class="preset-field" data-testid="dsh-session-preset">
    <label class="preset-label" :for="inputId">{{ t('dshPresets.sessionMode') }}</label>
    <NSelect :input-props="{ id: inputId, 'aria-label': t('dshPresets.sessionMode') }" :value="selected" :options="options" :loading="loading"
      :disabled="props.disabled || loading || failed" :placeholder="t('dshPresets.selectMode')"
      @update:value="selected = $event" />
    <p v-if="current?.description" class="description">{{ current.description }}</p>
    <p class="hint">{{ t('dshPresets.sessionHint') }}</p>
    <NAlert v-if="failed" type="error" :show-icon="false">
      {{ t('dshPresets.unavailable') }}
      <NButton size="small" :disabled="props.disabled" @click="load">{{ t('common.retry') }}</NButton>
    </NAlert>
    <p v-else-if="!loading && !presets.some(preset => !preset.unavailable)" class="hint">{{ t('dshPresets.empty') }}</p>
  </div>
</template>

<style scoped lang="scss">
.preset-field { display: flex; flex-direction: column; gap: 8px; }
.preset-label { font-size: 12px; color: var(--text-secondary); }
.description, .hint { margin: 0; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.hint { color: var(--text-secondary); }
.preset-compact { min-width: 0; }
.preset-icon { width: 28px; height: 28px; padding: 0; }
</style>
