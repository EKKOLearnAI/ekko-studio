<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NInputNumber, NSelect, NSwitch } from 'naive-ui'
import type { PersonGeneralSettings, PersonSnapshot } from '@/api/person'
import PersonPanelIcon from './PersonPanelIcon.vue'

const props = defineProps<{
  settings: PersonGeneralSettings
  compression: PersonSnapshot['compression']
  contextTokens: number
  modelLabel: string
  saving: boolean
  busy: boolean
  saveError?: string
  save: (patch: Partial<PersonGeneralSettings>) => Promise<boolean>
}>()
const { t } = useI18n()
const keys = ['compressionThreshold', 'maxSteps', 'maxConcurrentTasks', 'timezone'] as const
const pickSettings = (): PersonGeneralSettings => ({ maxSteps: props.settings.maxSteps,
  maxConcurrentTasks: props.settings.maxConcurrentTasks, timezone: props.settings.timezone, compressionThreshold: props.settings.compressionThreshold })
const draft = ref<{ compressionThreshold: number | null; maxSteps: number | null; maxConcurrentTasks: number | null; timezone: string }>(pickSettings())
const saved = ref(false)
const dirty = computed(() => keys.some(key => draft.value[key] !== props.settings[key]))
// Live updates refresh untouched fields without discarding this tab's draft.
watch(pickSettings, (next, previous) => {
  for (const key of keys) {
    if (draft.value[key] !== previous[key]) continue
    if (key === 'timezone') draft.value.timezone = next.timezone
    else draft.value[key] = next[key]
  }
})
watch(draft, () => { saved.value = false }, { deep: true })
const supportedTimezones = (Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone')
  || ['Asia/Shanghai', 'Asia/Tokyo', 'Europe/London', 'America/New_York', 'America/Los_Angeles']
const timezones = computed(() => [...new Set(['UTC', props.settings.timezone, ...supportedTimezones])].map(value => ({ label: value, value })))
const integerInRange = (value: number | null, min: number, max: number) => value !== null && Number.isSafeInteger(value) && value >= min && value <= max
const compressionPercent = computed(() => Math.round((draft.value.compressionThreshold ?? props.compression.globalThreshold) * 100))
const compressionTokens = computed(() => Math.floor(props.contextTokens * compressionPercent.value / 100).toLocaleString())
const valid = computed(() => integerInRange(draft.value.maxSteps, 2, 30) && integerInRange(draft.value.maxConcurrentTasks, 1, 4) && !!draft.value.timezone
  && (draft.value.compressionThreshold === null || (draft.value.compressionThreshold >= 0.05 && draft.value.compressionThreshold <= 0.95)))
function reset() { draft.value = pickSettings(); saved.value = false }
async function submit() {
  if (!valid.value || !dirty.value || props.busy || props.saving) return
  const patch = Object.fromEntries(keys.filter(key => draft.value[key] !== props.settings[key]).map(key => [key, draft.value[key]])) as Partial<PersonGeneralSettings>
  saved.value = await props.save(patch)
}
</script>

<template>
  <form class="person-panel person-general-settings" @submit.prevent="submit">
    <header class="panel-heading"><div><h2>{{ t('person.generalSettings') }}</h2><p>{{ t('person.generalSettingsHint') }}</p></div></header>
    <NAlert v-if="saveError" class="panel-error" type="error">{{ saveError }}</NAlert>
    <NAlert v-if="busy" class="panel-error" type="info">{{ t('person.settingsBusy') }}</NAlert>
    <div class="panel-grid">
      <section class="panel-tile context-card" data-theme-surface="card" aria-labelledby="person-context-title">
        <div class="setting-heading"><span class="tile-icon"><PersonPanelIcon name="memory" /></span><div><h3 id="person-context-title">{{ t('person.contextBudget') }}</h3><p>{{ t('person.contextBudgetHint') }}</p></div></div>
        <div class="model-context"><span class="model-context-name" :title="modelLabel">{{ modelLabel }}</span><span class="model-context-capacity"><strong>{{ contextTokens ? contextTokens.toLocaleString() : '—' }}</strong> tokens</span></div>
        <p class="setting-note">{{ t('person.contextBudgetLimit') }}</p>
        <div class="compression-setting">
          <div class="compression-heading"><label for="person-compression-threshold">{{ t('settings.compression.threshold') }}</label><span class="compression-inherit">{{ t('person.followGlobalCompression') }}<NSwitch :value="draft.compressionThreshold === null" :disabled="saving" :aria-label="t('person.followGlobalCompression')" @update:value="draft.compressionThreshold = $event ? null : compressionPercent / 100" /></span></div>
          <NInputNumber id="person-compression-threshold" :value="compressionPercent" :min="5" :max="95" :step="5" :precision="0" :disabled="saving || draft.compressionThreshold === null" :input-props="{ 'aria-label': t('settings.compression.threshold') }" @update:value="value => { if (value !== null) draft.compressionThreshold = value / 100 }"><template #suffix>%</template></NInputNumber>
          <p class="setting-note">{{ compression.enabled ? t('person.compressionThresholdHint', { percent: compressionPercent, tokens: compressionTokens }) : t('person.compressionDisabled') }}</p>
        </div>
      </section>
      <section class="panel-tile" data-theme-surface="card" aria-labelledby="person-runtime-title">
        <div class="setting-heading"><span class="tile-icon"><PersonPanelIcon name="agents" /></span><h3 id="person-runtime-title">{{ t('person.runLimits') }}</h3></div>
        <div class="setting-fields">
          <label><span>{{ t('person.maxSteps') }}</span><NInputNumber v-model:value="draft.maxSteps" :min="2" :max="30" :precision="0" :disabled="saving" :input-props="{ 'aria-label': t('person.maxSteps') }" /><small>{{ t('person.maxStepsHint') }}</small></label>
          <label><span>{{ t('person.maxConcurrentTasks') }}</span><NInputNumber v-model:value="draft.maxConcurrentTasks" :min="1" :max="4" :precision="0" :disabled="saving" :input-props="{ 'aria-label': t('person.maxConcurrentTasks') }" /><small>{{ t('person.maxConcurrentTasksHint') }}</small></label>
        </div>
      </section>
      <section class="panel-tile" data-theme-surface="card" aria-labelledby="person-timezone-title">
        <div class="setting-heading"><span class="tile-icon"><PersonPanelIcon name="schedule" /></span><h3 id="person-timezone-title">{{ t('person.timezone') }}</h3></div>
        <NSelect v-model:value="draft.timezone" filterable :options="timezones" :disabled="saving" :aria-label="t('person.timezone')" />
        <p class="setting-note">{{ t('person.timezoneHint') }}</p>
      </section>
    </div>
    <footer class="editor-actions general-actions">
      <span class="save-status" role="status">{{ saved ? t('person.settingsSaved') : dirty ? t('person.unsavedSettings') : '' }}</span>
      <NButton :disabled="saving || !dirty" @click="reset">{{ t('common.cancel') }}</NButton>
      <NButton attr-type="submit" type="primary" :loading="saving" :disabled="busy || saving || !dirty || !valid">{{ t('common.save') }}</NButton>
    </footer>
  </form>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use './person-panels';
.context-card { grid-column: 1 / -1; }
.setting-heading { display: flex; align-items: center; gap: 14px; margin-bottom: 24px; }
.setting-heading p { margin: 6px 0 0; color: $text-secondary; font-size: 13px; line-height: 1.7; }
.model-context { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 24px; }
.model-context-name { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
.model-context-capacity { color: $text-secondary; font-size: 12px; }
.model-context-capacity strong { color: $text-primary; font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }
.setting-note, .setting-fields small { color: $text-secondary; font-size: 12px; line-height: 1.8; }
.setting-note { margin: 16px 0 0; }
.compression-setting { margin-top: 24px; padding-top: 20px; border-top: 1px solid $border-light; }
.compression-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; font-size: 13px; }
.compression-inherit { display: flex; align-items: center; gap: 10px; font-size: 12px; color: $text-secondary; }
.compression-setting .n-input-number { max-width: 240px; }
.setting-fields { display: flex; flex-direction: column; gap: 20px; }
.setting-fields label { display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
.save-status { margin-inline-end: auto; font-size: 12px; color: $text-secondary; }
@media (max-width: 640px) {
  .setting-heading { align-items: flex-start; }
  .general-actions { flex-wrap: wrap; }
}
</style>
