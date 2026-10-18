<script setup lang="ts">
import { usePageLoadingTask } from '@/composables/usePageLoading'
import { NSpin, NAlert, NEmpty, NInput, NSelect, NTag } from 'naive-ui'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { readNativeDshPlugins, type DshNativePluginInventory } from '@/api/coding-agents/dsh'
import DshWebPackagesPanel from './DshWebPackagesPanel.vue'
const { t } = useI18n()
const emit = defineEmits<{ changed: [] }>()
function packagesChanged() { emit('changed'); void refresh() }
const inventory = ref<DshNativePluginInventory | null>(null)
const loading = ref(true)
const failed = ref(false)
const failureDetail = ref('')
const selected = ref<string | null>(null)
const search = ref('')
const status = ref<string | null>(null)
const preset = computed(() => inventory.value?.presets.find(item => item.id === selected.value))
const entries = computed(() => (preset.value?.entries || []).filter(entry => (!status.value || String(entry.configuredEnabled) === status.value) && `${entry.entryId} ${entry.moduleName} ${entry.title || ''} ${entry.description || ''}`.toLowerCase().includes(search.value.toLowerCase().trim())))
const options = computed(() => (inventory.value?.presets || []).map(item => ({ label: `${item.name} (${item.id}) · ${item.entries.length}`, value: item.id })))
const summary = computed(() => ({
  total: preset.value?.entries.length || 0,
  enabled: preset.value?.entries.filter(entry => entry.configuredEnabled === true).length || 0,
  disabled: preset.value?.entries.filter(entry => entry.configuredEnabled === false).length || 0,
  conditional: preset.value?.entries.filter(entry => entry.configuredEnabled === 'conditional').length || 0,
}))
const statusOptions = computed(() => [
  { value: 'true', label: t('dshPlugins.enabled') },
  { value: 'false', label: t('dshPlugins.disabled') },
  { value: 'conditional', label: t('dshPlugins.conditional') },
])
function statusLabel(enabled: boolean | 'conditional') {
  return t(enabled === 'conditional' ? 'dshPlugins.conditional' : enabled ? 'dshPlugins.enabled' : 'dshPlugins.disabled')
}
let sequence = 0
let disposed = false
async function refresh() {
  const version = ++sequence
  loading.value = true; failed.value = false; failureDetail.value = ''
  try {
    const result = await readNativeDshPlugins()
    if (disposed || version !== sequence) return
    inventory.value = result
    if (!result.presets.some(item => item.id === selected.value)) selected.value = result.presets.find(item => item.isDefault)?.id || result.presets[0]?.id || null
  } catch (error) { if (!disposed && version === sequence) {
    failed.value = true
    failureDetail.value = error instanceof Error ? [Reflect.get(error, 'code'), error.message].filter(Boolean).join(': ') : ''
  } }
  finally { if (!disposed && version === sequence) loading.value = false }
}
onMounted(refresh)
onUnmounted(() => { disposed = true })
defineExpose({ refresh })

usePageLoadingTask(() => loading.value)
</script>
<template>
  <div class="native-plugins" data-testid="dsh-native-plugins">
    <div v-if="loading" class="plugins-loading-state"><NSpin /></div>
    <NAlert v-else-if="failed" type="error" class="plugins-notice">{{ t('dshPlugins.nativeFailed') }}<div v-if="failureDetail">{{ failureDetail }}</div></NAlert>
    <template v-else-if="inventory">
      <DshWebPackagesPanel v-if="inventory.web" :web="inventory.web" @changed="packagesChanged" />
      <h3>{{ t('dshPlugins.presetEntries') }}</h3>
      <NAlert type="info" :bordered="false" class="plugins-notice">{{ t('dshPlugins.nativeHint') }}</NAlert>
      <div class="summary-grid native-summary">
        <div class="summary-card"><span class="summary-label">{{ t('plugins.summary.total') }}</span><strong data-testid="native-plugin-count">{{ summary.total }}</strong></div>
        <div class="summary-card success"><span class="summary-label">{{ t('dshPlugins.enabled') }}</span><strong>{{ summary.enabled }}</strong></div>
        <div class="summary-card warning"><span class="summary-label">{{ t('dshPlugins.conditional') }}</span><strong>{{ summary.conditional }}</strong></div>
        <div class="summary-card error"><span class="summary-label">{{ t('dshPlugins.disabled') }}</span><strong>{{ summary.disabled }}</strong></div>
      </div>
      <div class="filter-row native-filters">
        <NInput v-model:value="search" clearable :placeholder="t('dshPlugins.searchPlugins')" :input-props="{ 'aria-label': t('dshPlugins.searchPlugins') }" />
        <NSelect v-model:value="selected" :options="options" data-testid="native-preset-select" />
        <NSelect v-model:value="status" :options="statusOptions" :placeholder="t('plugins.statusTitle')" clearable data-testid="native-status-select" />
      </div>
      <template v-if="preset">
        <NAlert v-if="preset.error" type="error" class="plugins-notice">{{ t('dshPlugins.nativeFailed') }}</NAlert>
        <div v-else-if="entries.length" class="plugins-table-wrap">
          <table class="plugins-table">
            <thead><tr>
              <th>{{ t('plugins.table.plugin') }}</th><th>{{ t('plugins.table.status') }}</th><th>{{ t('plugins.table.source') }}</th><th>{{ t('plugins.table.path') }}</th><th>{{ t('plugins.table.manage') }}</th>
            </tr></thead>
            <tbody>
              <tr v-for="entry in entries" :key="[...entry.groupPath, entry.entryId].join('/')" data-testid="native-plugin-entry">
                <td><div class="plugin-name"><strong>{{ entry.title || entry.entryId }}</strong><span v-if="entry.description">{{ entry.description }}</span><span>{{ entry.entryId }} · {{ entry.moduleName }}</span></div><div v-if="entry.groupPath.length" class="meta-line">{{ entry.groupPath.join(' / ') }}</div></td>
                <td><NTag size="small" :type="entry.configuredEnabled === 'conditional' ? 'warning' : entry.configuredEnabled ? 'success' : 'error'">{{ statusLabel(entry.configuredEnabled) }}</NTag></td>
                <td><NTag size="small" round>{{ t(preset.trust === 'system' ? 'dshPlugins.shipped' : 'dshPlugins.userPreset') }}</NTag></td>
                <td><code class="path-cell" :title="preset.sourcePath">{{ preset.sourcePath }}</code></td>
                <td><span class="muted">{{ t('plugins.managedElsewhere') }}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
        <NEmpty v-else :description="t('plugins.noMatch')" />
        <div class="metadata-panel">
          <span>{{ preset.name }}<template v-if="preset.description"> · {{ preset.description }}</template></span>
          <span><code>{{ inventory.sourceHome }}</code></span><span>DSH {{ inventory.packageVersion }}</span>
        </div>
      </template>
      <NEmpty v-else :description="t('dshPlugins.noEntries')" />
    </template>
  </div>
</template>
<style scoped lang="scss">
@use '@/styles/plugins-page' as plugins-page;
@include plugins-page.layout;
.native-summary { grid-template-columns: repeat(4, minmax(120px, 1fr)); }
.native-filters { grid-template-columns: minmax(240px, 1fr) minmax(180px, 240px) minmax(140px, 200px); }
@media (max-width: 900px) { .native-summary, .native-filters { grid-template-columns: 1fr; } }
</style>
