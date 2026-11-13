<script setup lang="ts">
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { computed, ref, watch } from 'vue'
import { NAlert, NButton, NEmpty, NInput, NSelect, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchPlugins, setPluginEnabled, type HermesPluginInfo, type HermesPluginsMetadata } from '@/api/hermes/plugins'
import { useProfilesStore } from '@/stores/hermes/profiles'

const { t, te } = useI18n()
const message = useMessage()
const profilesStore = useProfilesStore()

const plugins = ref<HermesPluginInfo[]>([])
const warnings = ref<string[]>([])
const metadata = ref<HermesPluginsMetadata | null>(null)
const loading = ref(true)
const error = ref('')
const actionLoading = ref<Record<string, boolean>>({})

const searchQuery = ref('')
const sourceFilter = ref<string | null>(null)
const kindFilter = ref<string | null>(null)
const statusFilter = ref<string | null>(null)

const statusValues = ['enabled', 'auto-active', 'inactive', 'disabled', 'provider-managed'] as const
const statusOptions = computed(() => statusValues.map(value => ({
  label: t(`plugins.status.${value}`),
  value,
})))

const sourceOptions = computed(() => toOptions(plugins.value.map(p => p.source)))
const kindOptions = computed(() => toOptions(plugins.value.map(p => p.kind)))

const summary = computed(() => ({
  total: plugins.value.length,
  active: plugins.value.filter(p => p.effectiveStatus === 'enabled' || p.effectiveStatus === 'auto-active').length,
  inactive: plugins.value.filter(p => p.effectiveStatus === 'inactive').length,
  disabled: plugins.value.filter(p => p.effectiveStatus === 'disabled').length,
  providerManaged: plugins.value.filter(p => p.effectiveStatus === 'provider-managed').length,
}))

const filteredPlugins = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  return plugins.value.filter((plugin) => {
    if (sourceFilter.value && plugin.source !== sourceFilter.value) return false
    if (kindFilter.value && plugin.kind !== kindFilter.value) return false
    if (statusFilter.value && plugin.effectiveStatus !== statusFilter.value) return false
    if (!query) return true
    return [plugin.key, plugin.name, plugin.description, plugin.path, plugin.source, plugin.kind]
      .some(value => String(value || '').toLowerCase().includes(query))
  })
})

function toOptions(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b)).map(value => ({
    label: value,
    value,
  }))
}

async function loadPlugins() {
  loading.value = true
  error.value = ''
  try {
    if (!profilesStore.activeProfileName || profilesStore.profiles.length === 0) {
      await profilesStore.fetchProfiles()
    }
    const data = await fetchPlugins()
    plugins.value = data.plugins ?? []
    warnings.value = data.warnings ?? []
    metadata.value = data.metadata ?? null
  } catch (err: any) {
    error.value = err?.message || t('plugins.loadFailed')
  } finally {
    loading.value = false
  }
}

function statusLabel(plugin: HermesPluginInfo) {
  const key = `plugins.statusLabel.${plugin.effectiveStatus}`
  return te(key) ? t(key) : plugin.effectiveStatus
}

function configStatusLabel(plugin: HermesPluginInfo) {
  const key = `plugins.configStatuses.${plugin.configStatus}`
  return te(key) ? t(key) : plugin.configStatus
}

function statusTagType(plugin: HermesPluginInfo): 'success' | 'warning' | 'error' | 'info' | 'default' {
  switch (plugin.effectiveStatus) {
    case 'enabled':
    case 'auto-active':
      return 'success'
    case 'disabled':
      return 'error'
    case 'provider-managed':
      return 'info'
    default:
      return 'warning'
  }
}

function canManagePlugin(plugin: HermesPluginInfo) {
  return plugin.kind === 'standalone' && plugin.source !== 'bundled'
}

function pluginIsEnabled(plugin: HermesPluginInfo) {
  return plugin.effectiveStatus === 'enabled'
}

async function updatePlugin(plugin: HermesPluginInfo, enabled: boolean) {
  actionLoading.value = { ...actionLoading.value, [plugin.key]: true }
  try {
    await setPluginEnabled(plugin.key, enabled)
    message.success(t(enabled ? 'plugins.enableSuccess' : 'plugins.disableSuccess', { name: plugin.key }))
    await loadPlugins()
  } catch (err: any) {
    message.error(err?.message || t('plugins.updateFailed'))
  } finally {
    const next = { ...actionLoading.value }
    delete next[plugin.key]
    actionLoading.value = next
  }
}

watch(() => profilesStore.activeProfileName || 'default', () => {
  plugins.value = []
  warnings.value = []
  metadata.value = null
  void loadPlugins()
}, { immediate: true })
</script>

<template>
  <PageLoading :show="loading && plugins.length === 0" class="plugins-view">
    <PageHeader>
    <header class="page-header">
      <h2 class="header-title">{{ t('plugins.title') }}</h2>
      <NButton size="small" quaternary :loading="loading" @click="loadPlugins">
        {{ t('plugins.refresh') }}
      </NButton>
    </header>
    </PageHeader>

    <div class="plugins-content" :class="{ 'is-loading': loading && plugins.length === 0 }">
      <div v-if="loading && plugins.length === 0" class="plugins-loading-state">

      </div>
      <template v-else>
        <NAlert type="info" :bordered="false" class="plugins-notice">
          {{ t('plugins.notice') }}
        </NAlert>

        <NAlert v-if="error" type="error" class="plugins-notice">
          {{ error }}
        </NAlert>

        <NAlert v-for="warning in warnings" :key="warning" type="warning" class="plugins-notice">
          {{ warning }}
        </NAlert>

        <div class="summary-grid">
          <div class="summary-card">
            <span class="summary-label">{{ t('plugins.summary.total') }}</span>
            <strong>{{ summary.total }}</strong>
          </div>
          <div class="summary-card success">
            <span class="summary-label">{{ t('plugins.summary.active') }}</span>
            <strong>{{ summary.active }}</strong>
          </div>
          <div class="summary-card warning">
            <span class="summary-label">{{ t('plugins.summary.inactive') }}</span>
            <strong>{{ summary.inactive }}</strong>
          </div>
          <div class="summary-card error">
            <span class="summary-label">{{ t('plugins.summary.disabled') }}</span>
            <strong>{{ summary.disabled }}</strong>
          </div>
          <div class="summary-card info">
            <span class="summary-label">{{ t('plugins.summary.providerManaged') }}</span>
            <strong>{{ summary.providerManaged }}</strong>
          </div>
        </div>

        <div class="filter-row">
          <NInput v-model:value="searchQuery" :placeholder="t('plugins.searchPlaceholder')" clearable />
          <NSelect v-model:value="sourceFilter" :options="sourceOptions" :placeholder="t('plugins.source')" clearable />
          <NSelect v-model:value="kindFilter" :options="kindOptions" :placeholder="t('plugins.kind')" clearable />
          <NSelect v-model:value="statusFilter" :options="statusOptions" :placeholder="t('plugins.statusTitle')" clearable />
        </div>

        <div v-if="filteredPlugins.length" class="plugins-table-wrap">
          <table class="plugins-table">
            <thead>
              <tr>
                <th>{{ t('plugins.table.plugin') }}</th>
                <th>{{ t('plugins.table.status') }}</th>
                <th>{{ t('plugins.table.source') }}</th>
                <th>{{ t('plugins.table.kind') }}</th>
                <th>{{ t('plugins.table.capabilities') }}</th>
                <th>{{ t('plugins.table.path') }}</th>
                <th>{{ t('plugins.table.manage') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="plugin in filteredPlugins" :key="plugin.key">
                <td>
                  <div class="plugin-name">
                    <strong>{{ plugin.key }}</strong>
                    <span v-if="plugin.name !== plugin.key">{{ plugin.name }}</span>
                  </div>
                  <div v-if="plugin.description" class="description">{{ plugin.description }}</div>
                  <div v-if="plugin.version || plugin.author" class="meta-line">
                    <span v-if="plugin.version">v{{ plugin.version }}</span>
                    <span v-if="plugin.author">{{ plugin.author }}</span>
                  </div>
                </td>
                <td>
                  <NTag size="small" :type="statusTagType(plugin)">{{ statusLabel(plugin) }}</NTag>
                  <div class="config-status">{{ t('plugins.configStatus', { status: configStatusLabel(plugin) }) }}</div>
                </td>
                <td><NTag size="small" round>{{ plugin.source }}</NTag></td>
                <td><NTag size="small" round>{{ plugin.kind }}</NTag></td>
                <td>
                  <div class="capability-list">
                    <span>{{ t('plugins.capabilities.tools', { count: plugin.providesTools.length }) }}</span>
                    <span>{{ t('plugins.capabilities.hooks', { count: plugin.providesHooks.length }) }}</span>
                    <span>{{ t('plugins.capabilities.env', { count: plugin.requiresEnv.length }) }}</span>
                  </div>
                </td>
                <td><code class="path-cell">{{ plugin.path || t('plugins.notAvailable') }}</code></td>
                <td>
                  <NButton
                    v-if="canManagePlugin(plugin)"
                    size="tiny"
                    secondary
                    :type="pluginIsEnabled(plugin) ? 'warning' : 'primary'"
                    :loading="!!actionLoading[plugin.key]"
                    @click="updatePlugin(plugin, !pluginIsEnabled(plugin))"
                  >
                    {{ pluginIsEnabled(plugin) ? t('common.disable') : t('common.enable') }}
                  </NButton>
                  <span v-else class="muted">{{ t('plugins.managedElsewhere') }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <NEmpty v-else :description="t('plugins.noMatch')" />

        <div v-if="metadata" class="metadata-panel">
          <span>{{ t('plugins.metadata.agentRoot') }}: <code>{{ metadata.hermesAgentRoot }}</code></span>
          <span>{{ t('plugins.metadata.python') }}: <code>{{ metadata.pythonExecutable }}</code></span>
          <span>{{ t('plugins.metadata.scanCwd') }}: <code>{{ metadata.cwd }}</code></span>
          <span>{{ t('plugins.metadata.projectPlugins') }}: <code>{{ metadata.projectPluginsEnabled ? t('plugins.enabled') : t('plugins.disabled') }}</code></span>
        </div>
      </template>
    </div>
  </PageLoading>
</template>

<style scoped lang="scss">
@use '@/styles/plugins-page' as plugins-page;
@include plugins-page.layout;
</style>
