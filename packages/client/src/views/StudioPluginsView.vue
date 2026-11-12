<script setup lang="ts">
import { ref, shallowRef, computed, watch, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NCheckbox, NEmpty, NInput, NSelect, NTag, NDrawer, NDrawerContent, NModal, NTabs, NTab, NTabPane, NSpin, useDialog, useMessage } from 'naive-ui'
import { isStoredSuperAdmin } from '@/api/client'
import { pluginList, pluginRequest, pluginInvoke, type InstalledPlugin, type PluginDevelopmentProject, type Json } from '@/api/studio/plugins'
import { pluginPages, pluginPageLocation, usePluginCatalog } from '@/composables/usePluginCatalog'
import PageHeader from '@/components/layout/PageHeader.vue'
import PluginIcon from '@/components/plugins/PluginIcon.vue'
import PluginConfigFields from '@/components/plugins/PluginConfigFields.vue'
import PluginSubmissionDialog from '@/components/plugins/PluginSubmissionDialog.vue'
import RouteLinkItem from '@/components/common/RouteLinkItem.vue'
import { pluginLinks, safePluginLink } from '@/plugins/navigation'
import { usePluginUpdates } from '@/composables/usePluginUpdates'
import { usePluginMarket } from '@/composables/usePluginMarket'
import type { MarketPlugin } from '@/api/studio/plugin-market'
import { pluginCategories as categories, matchesPluginCategory, matchesPluginSearch, installedMarketPlugin, type PluginCategory } from '@/plugins/catalog'
import { availablePluginUpdate } from '@/plugins/updates'

const { t } = useI18n(), dialog = useDialog(), message = useMessage(), router = useRouter(), route = useRoute()
const { profile, snapshot, loading, error, refresh } = usePluginCatalog()
const { updates: availableUpdates, failed: updateCheckFailed, checking: checkingUpdates, refresh: refreshUpdates } = usePluginUpdates(computed(() => snapshot.value.plugins))
const busy = ref(false), actionError = ref(''), source = ref(''), trusted = ref(false), showInstall = ref(false)
const scope = ref<'installed' | 'all' | 'development'>('installed')
function scopeKeydown(event: KeyboardEvent) {
  const tabs = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="tab"]')]
  const current = tabs.findIndex(tab => tab === document.activeElement)
  if (current < 0) return
  const target = event.key === 'ArrowRight' ? (current + 1) % tabs.length : event.key === 'ArrowLeft' ? (current + tabs.length - 1) % tabs.length
    : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : ['Enter', ' '].includes(event.key) ? current : -1
  if (target >= 0) { event.preventDefault(); tabs[target].click(); tabs[target].focus() }
}
const { entries: marketEntries, loading: marketLoading, failed: marketFailed, loaded: marketLoaded, refresh: refreshMarket } = usePluginMarket(computed(() => scope.value === 'all'))
const search = ref(''), category = ref<PluginCategory>('all'), state = ref('all')
const selectedMarket = ref<MarketPlugin>()
const showSubmission = ref(false)
const selectedId = ref(''), detailTab = ref('overview')
const configs = ref<Record<string, Record<string, Json>>>({}), sources = ref<Record<string, string>>({})
const configValid = ref<Record<string, boolean>>({})
const configDirty = ref<Record<string, boolean>>({}), configRevisions = ref<Record<string, number>>({})
const selections = ref<Record<string, string>>({}), argumentsText = ref<Record<string, string>>({}), outputs = ref<Record<string, string>>({})
const canManage = computed(isStoredSuperAdmin)
const projects = shallowRef<PluginDevelopmentProject[]>([]), developmentError = ref('')
watch(() => projects.value.length, count => { if (!count && scope.value === 'development') scope.value = 'installed' })
const controller = new AbortController()
let developmentTimer: ReturnType<typeof setTimeout> | undefined, developmentSequence = 0
async function refreshDevelopment() {
  if (!canManage.value) return
  const current = ++developmentSequence
  try {
    const result = await pluginRequest<{ projects: PluginDevelopmentProject[] }>(undefined, '/development', undefined, 'GET', controller.signal)
    if (!controller.signal.aborted && current === developmentSequence) { projects.value = result.projects || []; developmentError.value = '' }
  } catch (cause) { if (!controller.signal.aborted && current === developmentSequence) developmentError.value = String(cause) }
}
async function pollDevelopment() { await refreshDevelopment(); if (!controller.signal.aborted && canManage.value) developmentTimer = setTimeout(pollDevelopment, 2000) }
watch(canManage, enabled => { if (developmentTimer) clearTimeout(developmentTimer); if (enabled) void pollDevelopment(); else { developmentSequence++; projects.value = [] } }, { immediate: true })
onBeforeUnmount(() => { controller.abort(); if (developmentTimer) clearTimeout(developmentTimer) })
type CatalogPlugin = InstalledPlugin & { installed: boolean; development?: PluginDevelopmentProject }
const catalog = computed<CatalogPlugin[]>(() => {
  const entries = new Map(snapshot.value.plugins.map(plugin => [plugin.manifest.id, { ...plugin, installed: true } as CatalogPlugin]))
  for (const project of projects.value) {
    const installed = entries.get(project.id)
    entries.set(project.id, installed ? { ...installed, development: project } : {
      manifest: project.manifest || { id: project.id, name: project.id, version: '', apiVersion: 1, capabilities: [] },
      source: project.directory, installedAt: project.createdAt || 0, installed: false, enabled: false,
      status: ['missing', 'error'].includes(project.status) ? 'failed' : 'disabled', error: project.error,
      config: {}, tools: [], commands: [], actions: [], development: project,
    })
  }
  return [...entries.values()]
})
const selected = computed(() => catalog.value.find(plugin => plugin.manifest.id === selectedId.value))
const activeCount = computed(() => snapshot.value.plugins.filter(plugin => plugin.status === 'active').length)
const localEntries = computed(() => catalog.value.filter(plugin => scope.value === 'development' ? plugin.development : plugin.installed))
const filtered = computed(() => localEntries.value.filter(plugin => matchesPluginCategory(plugin.manifest.capabilities, category.value)
  && (state.value === 'all' || plugin.status === state.value) && matchesPluginSearch(plugin.manifest, search.value)))
const filteredMarket = computed(() => marketEntries.value.filter(plugin => matchesPluginCategory(plugin.capabilities, category.value) && matchesPluginSearch(plugin, search.value)))
const categoryCount = (value: PluginCategory) => scope.value === 'all'
  ? marketEntries.value.filter(plugin => matchesPluginCategory(plugin.capabilities, value)).length
  : localEntries.value.filter(plugin => matchesPluginCategory(plugin.manifest.capabilities, value)).length
const marketInstalled = (plugin: MarketPlugin) => installedMarketPlugin(plugin, snapshot.value.plugins)
const marketConflict = (plugin: MarketPlugin) => !marketInstalled(plugin) && snapshot.value.plugins.some(local => local.manifest.id === plugin.manifestId)
const marketUpdate = (plugin: MarketPlugin) => {
  const installed = marketInstalled(plugin)
  return installed && plugin.release ? availablePluginUpdate(installed, plugin.release) : undefined
}
function manageMarket(plugin: MarketPlugin) {
  const installed = marketInstalled(plugin)
  if (installed) { selectedMarket.value = undefined; details(installed) }
}
function installMarket(plugin: MarketPlugin) {
  const release = plugin.release
  if (!canManage.value || !release || marketConflict(plugin)) return
  const installed = marketInstalled(plugin)
  if (installed && !marketUpdate(plugin)) return
  dialog.warning({
    title: t(installed ? 'studioPlugins.updateAvailable' : 'studioPlugins.installTitle'),
    content: t('studioPlugins.marketInstallConfirm', { name: plugin.name, version: release.version, repository: release.repository }),
    positiveText: t(installed ? 'studioPlugins.upgrade' : 'studioPlugins.install'), negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      const success = await perform(async () => {
        const latest = await pluginList(), current = installedMarketPlugin(plugin, latest.plugins)
        if (installed ? !current || current.manifest.version !== installed.manifest.version || !availablePluginUpdate(current, release)
          : latest.plugins.some(local => local.manifest.id === release.manifestId)) throw new Error(t('studioPlugins.marketChanged'))
        // Verify the package identity for both new installs and upgrades.
        await pluginRequest(undefined, '/install', { source: release.installSource, pluginId: release.manifestId,
          expectedVersion: release.version, revision: latest.revision, trusted: true })
        message.success(t('common.ok'))
      })
      if (!success) message.error(actionError.value)
      return success
    },
  })
}
const stateOptions = computed(() => ['all', 'active', 'disabled', 'failed'].map(value => ({ value, label: t('studioPlugins.' + (value === 'all' ? 'allStates' : value)) })))
function syncDrafts() {
  for (const plugin of snapshot.value.plugins) {
    if (!configDirty.value[plugin.manifest.id]) {
      configs.value[plugin.manifest.id] = JSON.parse(JSON.stringify(plugin.config))
      configRevisions.value[plugin.manifest.id] = snapshot.value.revision
    }
    sources.value[plugin.manifest.id] ??= plugin.source
  }
}
watch(snapshot, syncDrafts)
async function reloadCatalog() { await Promise.all([refresh(true), refreshDevelopment(), refreshUpdates(true), refreshMarket(true)]); configDirty.value = {}; actionError.value = ''; syncDrafts() }
watch(profile, () => {
  outputs.value = {}; argumentsText.value = {}; actionError.value = ''
})
watch(() => route.query.manage, value => { selectedId.value = typeof value === 'string' ? value : ''; detailTab.value = 'overview' }, { immediate: true })
function details(plugin: InstalledPlugin) { void router.replace({ query: { ...route.query, manage: plugin.manifest.id } }) }
function closeDetails() { const { manage: _, ...query } = route.query; selectedId.value = ''; void router.replace({ query }) }
async function perform(work: (boundProfile: string) => Promise<unknown>) {
  if (busy.value) return false
  const bound = profile.value
  busy.value = true; actionError.value = ''
  try {
    await work(bound)
    window.dispatchEvent(new Event('studio.plugins.changed'))
    await Promise.all([refresh(true), refreshDevelopment()])
    return true
  } catch (cause) {
    if (bound === profile.value) actionError.value = cause instanceof Error ? cause.message : String(cause)
    await Promise.all([refresh(true), refreshDevelopment()])
    return false
  } finally { busy.value = false }
}
async function install(id?: string) {
  const success = await perform(() => pluginRequest(undefined, '/install', { source: id ? sources.value[id] : source.value, pluginId: id, revision: snapshot.value.revision, trusted: trusted.value }))
  if (success && !id) { showInstall.value = false; source.value = ''; trusted.value = false }
}
function upgrade(plugin: InstalledPlugin) {
  const release = availableUpdates.value[plugin.manifest.id]
  if (!release) return
  dialog.warning({
    title: t('studioPlugins.updateAvailable'),
    content: t('studioPlugins.updateConfirm', { name: plugin.manifest.name, current: plugin.manifest.version, version: release.version, repository: release.repository }),
    positiveText: t('studioPlugins.updateTo', { version: release.version }), negativeText: t('common.cancel'),
    onPositiveClick: () => perform(async () => {
      await pluginRequest(undefined, '/install', { source: release.installSource, pluginId: plugin.manifest.id,
        expectedVersion: release.version, revision: snapshot.value.revision, trusted: true })
      sources.value[plugin.manifest.id] = release.installSource
      message.success(t('studioPlugins.updateSucceeded', { version: release.version }))
    }),
  })
}
async function update(plugin: InstalledPlugin, input: object) {
  const revision = 'config' in input ? configRevisions.value[plugin.manifest.id] : snapshot.value.revision
  const success = await perform(() => pluginRequest(undefined, '/' + plugin.manifest.id, { ...input, revision }, 'PATCH'))
  if (success) { configDirty.value[plugin.manifest.id] = false; syncDrafts() }
  return success
}
function uninstall(plugin: CatalogPlugin) {
  const linked = Boolean(plugin.development)
  dialog.warning({ title: t(linked ? 'studioPlugins.devUnlink' : 'studioPlugins.uninstall'), content: t(linked ? 'studioPlugins.devUnlinkConfirm' : 'studioPlugins.uninstallConfirm', { name: plugin.manifest.name }), positiveText: t('common.confirm'), negativeText: t('common.cancel'), onPositiveClick: async () => {
    const success = linked
      ? await perform(async () => { const { revision } = await pluginList(); await pluginRequest(undefined, '/' + encodeURIComponent(plugin.manifest.id) + '/development?revision=' + revision, undefined, 'DELETE') })
      : await update(plugin, { action: 'uninstall' })
    if (success) {
      if (!linked) { delete configs.value[plugin.manifest.id]; delete sources.value[plugin.manifest.id] }
      else if (plugin.installed) scope.value = 'installed'
      closeDetails()
    }
  } })
}
function activateLinkedPlugin(plugin: CatalogPlugin, label: 'common.enable' | 'studioPlugins.reload') {
  const activate = () => perform(async () => {
    const { revision } = await pluginList()
    await pluginRequest(undefined, '/' + encodeURIComponent(plugin.manifest.id) + '/development', { revision, trusted: true })
  })
  if (plugin.developmentDirectory === plugin.development!.directory) { void activate(); return }
  dialog.warning({ title: t(label), content: t('studioPlugins.devTrust', { path: plugin.development!.directory }), positiveText: t(label), negativeText: t('common.cancel'), onPositiveClick: activate })
}
function enablePlugin(plugin: CatalogPlugin) {
  if (plugin.development && plugin.development.status !== 'missing') activateLinkedPlugin(plugin, 'common.enable')
  else void update(plugin, { enabled: true })
}
function reloadPlugin(plugin: CatalogPlugin) {
  if (plugin.development && plugin.development.status !== 'missing') activateLinkedPlugin(plugin, 'studioPlugins.reload')
  else void update(plugin, { action: 'reload' })
}
function activationBusy(plugin: CatalogPlugin) { return busy.value || plugin.development?.status === 'building' || (!plugin.installed && plugin.development?.status === 'missing') }
function operations(plugin: InstalledPlugin) {
  return [ ...plugin.tools.map(x => ({ label: t('studioPlugins.tool') + ': ' + x.name, value: 'tool/' + x.name })),
    ...plugin.commands.map(x => ({ label: '/' + plugin.manifest.id + ':' + x.name, value: 'command/' + x.name })),
    ...plugin.actions.map(x => ({ label: t('studioPlugins.action') + ': ' + x.name, value: 'action/' + x.name })) ]
}
async function invoke(plugin: InstalledPlugin) {
  const id = plugin.manifest.id, [kind, name] = (selections.value[id] || '').split('/')
  if (!kind || !name) return
  await perform(async bound => {
    const input = kind === 'command' ? argumentsText.value[id] || '' : JSON.parse(argumentsText.value[id] || '{}')
    const result = await pluginInvoke(bound, id, kind, name, input)
    if (bound === profile.value) outputs.value[id] = JSON.stringify(result, null, 2)
    message.success(t('common.ok'))
  })
}
async function logs(id: string) {
  await perform(async bound => {
    const result = await pluginRequest(undefined, '/' + id + '/logs')
    if (bound === profile.value) outputs.value[id] = JSON.stringify(result, null, 2)
  })
}
</script>

<template>
  <main class="studio-plugins">
    <PageHeader><header class="page-header center-header"><h2 class="header-title">{{ t('studioPlugins.title') }}</h2><NButton quaternary size="small" :loading="loading || (scope === 'all' && marketLoading)" @click="reloadCatalog">{{ t('mcp.refresh') }}</NButton></header></PageHeader>
    <div class="center-scroll">
    <div class="center-content">
      <header class="center-intro">
        <div>
          <span class="eyebrow">{{ t('studioPlugins.globalScope') }}</span>
          <h1>{{ t('studioPlugins.hero') }}</h1>
          <p>{{ t('studioPlugins.description') }}</p>
        </div>
        <div class="actions">
          <NButton size="large" @click="showSubmission = true">{{ t('studioPluginSubmission.title') }}</NButton>
          <NButton v-if="canManage" type="primary" size="large" @click="showInstall = true">{{ t('studioPlugins.installTitle') }}</NButton>
        </div>
      </header>
      <NAlert v-if="error || actionError" type="error" closable @close="error = ''; actionError = ''">{{ actionError || error }}</NAlert>
      <NAlert v-if="developmentError" type="error" closable @close="developmentError = ''">{{ developmentError }}</NAlert>
      <NAlert v-if="updateCheckFailed" type="warning">{{ t('studioPlugins.updateCheckFailed') }} <NButton text :loading="checkingUpdates" @click="refreshUpdates(true)">{{ t('common.retry') }}</NButton></NAlert>
      <NTabs v-model:value="scope" type="line" class="catalog-scopes" role="tablist" :aria-label="t('studioPlugins.title')" @keydown="scopeKeydown">
        <NTab name="installed" id="plugins-tab-installed" role="tab" :aria-selected="scope === 'installed'" :tabindex="scope === 'installed' ? 0 : -1" aria-controls="plugin-catalog-panel">{{ t('studioPlugins.installed') }} <span class="scope-count">{{ snapshot.plugins.length }}</span></NTab>
        <NTab name="all" id="plugins-tab-all" role="tab" :aria-selected="scope === 'all'" :tabindex="scope === 'all' ? 0 : -1" aria-controls="plugin-catalog-panel">{{ t('studioPlugins.all') }} <span v-if="marketLoaded" class="scope-count">{{ marketEntries.length }}</span></NTab>
        <NTab v-if="canManage && projects.length" name="development" id="plugins-tab-development" role="tab" :aria-selected="scope === 'development'" :tabindex="scope === 'development' ? 0 : -1" aria-controls="plugin-catalog-panel">{{ t('studioPlugins.devProjects') }} <span class="scope-count">{{ projects.length }}</span></NTab>
      </NTabs>
      <section id="plugin-catalog-panel" class="catalog-panel" role="tabpanel" :aria-labelledby="'plugins-tab-' + scope">
      <NAlert v-if="scope === 'all' && marketFailed" type="warning">{{ t('studioPlugins.marketUnavailable') }} <NButton text :loading="marketLoading" @click="refreshMarket(true)">{{ t('common.retry') }}</NButton></NAlert>
      <div class="search-row">
        <NInput v-model:value="search" clearable size="large" :placeholder="t('studioPlugins.search')" :aria-label="t('studioPlugins.search')">
          <template #prefix><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg></template>
        </NInput>
        <NSelect v-if="scope !== 'all'" v-model:value="state" class="state-filter" :options="stateOptions" :aria-label="t('studioPlugins.allStates')" />
      </div>
      <div class="catalog-toolbar">
        <nav class="category-tabs" :aria-label="t('studioPlugins.categories')">
          <button v-for="item in categories" :key="item" type="button" :class="{ selected: category === item }" :aria-pressed="category === item" @click="category = item">
            {{ t('studioPlugins.' + (item === 'all' ? 'categoryAll' : item)) }}<span>{{ categoryCount(item) }}</span>
          </button>
        </nav>
        <span v-if="scope !== 'all'" class="catalog-count">{{ t('studioPlugins.activeCount', { count: activeCount }) }}</span>
      </div>
      <template v-if="scope === 'all'">
        <div v-if="marketLoading && !marketLoaded" class="catalog-empty"><NSpin /></div>
        <div v-else-if="!filteredMarket.length && !marketFailed" class="catalog-empty"><NEmpty :description="t(marketEntries.length ? 'studioPlugins.noResults' : 'studioPlugins.marketEmpty')" /></div>
        <div v-else class="plugin-grid" :aria-busy="marketLoading">
          <article v-for="plugin in filteredMarket" :key="plugin.id" class="plugin-card" data-theme-surface="card" :data-testid="`market-plugin-${plugin.manifestId || plugin.id}`">
            <div class="card-top"><PluginIcon :plugin="{ manifest: { name: plugin.name } }" :icon-url="plugin.iconUrl" /><NTag v-if="marketInstalled(plugin)" size="small" :bordered="false">{{ t('studioPlugins.installed') }}</NTag></div>
            <div class="card-copy"><button type="button" class="card-title" @click="selectedMarket = plugin">{{ plugin.name }}</button><p>{{ plugin.description }}</p></div>
            <div class="card-features"><span v-for="item in categories.slice(1).filter(value => matchesPluginCategory(plugin.capabilities, value))" :key="item">{{ t('studioPlugins.' + item) }}</span></div>
            <footer class="card-footer">
              <span class="version">{{ plugin.version ? 'v' + plugin.version : '' }}</span>
              <div class="actions">
                <NButton size="small" quaternary @click="selectedMarket = plugin">{{ t('studioPlugins.details') }}</NButton>
                <NButton v-if="marketInstalled(plugin)" size="small" secondary @click="manageMarket(plugin)">{{ t('studioPlugins.manage') }}</NButton>
                <NButton v-if="canManage && marketUpdate(plugin)" size="small" type="primary" secondary :disabled="busy" @click="installMarket(plugin)">{{ t('studioPlugins.updateTo', { version: plugin.version }) }}</NButton>
                <NButton v-else-if="canManage && !marketInstalled(plugin)" size="small" type="primary" secondary :disabled="busy || !plugin.release || marketConflict(plugin)" @click="installMarket(plugin)">{{ t(marketConflict(plugin) ? 'studioPlugins.marketConflict' : plugin.release ? 'studioPlugins.install' : 'studioPlugins.marketNotInstallable') }}</NButton>
              </div>
            </footer>
          </article>
        </div>
      </template>
      <div v-else-if="loading && !localEntries.length" class="catalog-empty"><NSpin /></div>
      <div v-else-if="!filtered.length" class="catalog-empty"><NEmpty :description="t(localEntries.length || search || category !== 'all' || state !== 'all' ? 'studioPlugins.noResults' : 'studioPlugins.empty')" /></div>
      <div v-else class="plugin-grid">
        <article v-for="plugin in filtered" :key="plugin.manifest.id" class="plugin-card" data-theme-surface="card" :data-testid="`plugin-card-${plugin.manifest.id}`">
          <div class="card-top"><PluginIcon :plugin="plugin" /><div class="actions"><NTag v-if="plugin.development" size="small" :bordered="false">{{ t('studioPlugins.devLabel') }}</NTag><span class="status" :class="{ running: plugin.status === 'active' }"><i aria-hidden="true" />{{ t('studioPlugins.' + plugin.status) }}</span></div></div>
          <div class="card-copy">
            <button type="button" class="card-title" @click="details(plugin)">{{ plugin.manifest.name }}</button>
            <p>{{ plugin.manifest.description || plugin.manifest.id }}</p>
          </div>
          <div class="card-features"><span v-for="item in categories.slice(1).filter(value => matchesPluginCategory(plugin.manifest.capabilities, value))" :key="item">{{ t('studioPlugins.' + item) }}</span></div>
          <footer class="card-footer">
            <div class="version"><span>{{ plugin.manifest.version ? 'v' + plugin.manifest.version : '' }}</span><NTag v-if="availableUpdates[plugin.manifest.id]" size="small" type="warning" :bordered="false">{{ t('studioPlugins.updateAvailable') }}</NTag></div>
            <div class="actions">
              <NButton v-if="canManage && availableUpdates[plugin.manifest.id]" size="small" type="primary" secondary :disabled="busy" @click="upgrade(plugin)">{{ t('studioPlugins.updateTo', { version: availableUpdates[plugin.manifest.id]!.version }) }}</NButton>
              <NButton size="small" quaternary @click="details(plugin)">{{ t('studioPlugins.details') }}</NButton>
              <NButton v-if="plugin.status === 'active' && pluginPages(plugin).length" size="small" secondary @click="router.push(pluginPageLocation(plugin))">{{ t('studioPlugins.open') }} <span aria-hidden="true">&nbsp;↗</span></NButton>
              <NButton v-else-if="canManage && !plugin.enabled" size="small" secondary :disabled="activationBusy(plugin)" @click="enablePlugin(plugin)">{{ t('common.enable') }}</NButton>
              <NButton v-if="canManage && plugin.development" size="small" quaternary type="error" :aria-label="t('studioPlugins.devUnlink')" :title="t('studioPlugins.devUnlink')" :disabled="busy" @click="uninstall(plugin)">{{ t('common.delete') }}</NButton>
            </div>
          </footer>
        </article>
      </div>
      </section>
    </div>
    </div>

    <PluginSubmissionDialog v-model:show="showSubmission" />
    <NModal v-model:show="showInstall" preset="card" :title="t('studioPlugins.installTitle')" class="plugin-install-modal" style="width: min(540px, calc(100vw - 32px))">
      <div class="detail-stack">
        <p>{{ t('studioPlugins.installHint') }}</p>
        <NInput v-model:value="source" :placeholder="t('studioPlugins.source')" :aria-label="t('studioPlugins.source')" />
        <NCheckbox v-model:checked="trusted">{{ t('studioPlugins.trust') }}</NCheckbox>
        <NAlert v-if="actionError" type="error">{{ actionError }}</NAlert>
        <NButton type="primary" :disabled="!trusted || !source.trim() || busy" :loading="busy" @click="install()">{{ t('studioPlugins.install') }}</NButton>
      </div>
    </NModal>

    <NDrawer :show="Boolean(selectedMarket)" :width="'min(560px, 100vw)'" @update:show="value => { if (!value) selectedMarket = undefined }">
      <NDrawerContent v-if="selectedMarket" :title="selectedMarket.name" closable>
        <div class="detail-stack">
          <div class="detail-identity"><PluginIcon :plugin="{ manifest: { name: selectedMarket.name } }" :icon-url="selectedMarket.iconUrl" /><span>{{ selectedMarket.version ? 'v' + selectedMarket.version : '' }}</span><NTag v-if="marketInstalled(selectedMarket)">{{ t('studioPlugins.installed') }}</NTag></div>
          <p class="detail-description">{{ selectedMarket.description }}</p>
          <div class="card-features"><span v-for="item in categories.slice(1).filter(value => matchesPluginCategory(selectedMarket!.capabilities, value))" :key="item">{{ t('studioPlugins.' + item) }}</span></div>
          <div class="project-metadata">
            <p v-if="selectedMarket.author"><strong>{{ t('studioPlugins.author') }}:</strong> {{ selectedMarket.author.name }}</p>
            <p v-if="selectedMarket.license"><strong>{{ t('studioPlugins.license') }}:</strong> {{ selectedMarket.license }}</p>
            <a :href="selectedMarket.repository" target="_blank" rel="noopener noreferrer">{{ selectedMarket.repository }}</a>
          </div>
          <div class="actions">
            <NButton v-if="marketInstalled(selectedMarket)" @click="manageMarket(selectedMarket)">{{ t('studioPlugins.manage') }}</NButton>
            <NButton v-if="canManage && marketUpdate(selectedMarket)" type="primary" :disabled="busy" @click="installMarket(selectedMarket)">{{ t('studioPlugins.updateTo', { version: selectedMarket.version }) }}</NButton>
            <NButton v-else-if="canManage && !marketInstalled(selectedMarket)" type="primary" :disabled="busy || !selectedMarket.release || marketConflict(selectedMarket)" @click="installMarket(selectedMarket)">{{ t(marketConflict(selectedMarket) ? 'studioPlugins.marketConflict' : selectedMarket.release ? 'studioPlugins.install' : 'studioPlugins.marketNotInstallable') }}</NButton>
          </div>
          <NAlert v-if="actionError" type="error">{{ actionError }}</NAlert>
        </div>
      </NDrawerContent>
    </NDrawer>

    <NDrawer :show="Boolean(selected)" :width="'min(560px, 100vw)'" @update:show="value => { if (!value) closeDetails() }">
      <NDrawerContent v-if="selected" :title="selected.manifest.name" closable>
        <div class="detail-stack">
          <div class="detail-identity"><PluginIcon :plugin="selected" /><div class="identity-copy"><h3>{{ selected.manifest.name }}</h3><span class="eyebrow">{{ selected.manifest.id }} · v{{ selected.manifest.version }}</span></div><NTag size="small" :bordered="false">{{ t('studioPlugins.' + selected.status) }}</NTag></div>
          <p class="detail-description">{{ selected.manifest.description }}</p>
          <NAlert v-if="availableUpdates[selected.manifest.id]" type="info">
            {{ t('studioPlugins.newVersion', { current: selected.manifest.version, version: availableUpdates[selected.manifest.id]!.version }) }}
            <NButton v-if="canManage" text :disabled="busy" @click="upgrade(selected)">{{ t('studioPlugins.updateTo', { version: availableUpdates[selected.manifest.id]!.version }) }}</NButton>
          </NAlert>
          <div class="actions">
            <NButton v-if="selected.status === 'active' && pluginPages(selected).length" type="primary" @click="router.push(pluginPageLocation(selected))">{{ t('studioPlugins.open') }}</NButton>
            <NButton v-if="canManage" :disabled="selected.enabled ? busy : activationBusy(selected)" @click="selected.enabled ? update(selected, { enabled: false }) : enablePlugin(selected)">{{ t(selected.enabled ? 'common.disable' : 'common.enable') }}</NButton>
          </div>
          <NAlert v-if="selected.error || selected.development?.error || actionError" type="error">{{ actionError || selected.development?.error || selected.error }}</NAlert>
          <NTabs v-model:value="detailTab" type="line" animated>
            <NTabPane name="overview" :tab="t('studioPlugins.overview')">
              <div class="detail-stack">
                <div class="project-metadata">
                  <p v-if="selected.manifest.author"><strong>{{ t('studioPlugins.author') }}:</strong> <a v-if="safePluginLink(selected.manifest.author.url)" :href="safePluginLink(selected.manifest.author.url)" target="_blank" rel="noopener noreferrer">{{ selected.manifest.author.name }}</a><span v-else>{{ selected.manifest.author.name }}</span></p>
                  <p v-if="selected.manifest.license"><strong>{{ t('studioPlugins.license') }}:</strong> {{ selected.manifest.license }}</p>
                  <div class="actions"><a v-for="link in pluginLinks(selected)" :key="link.key" :href="link.url" target="_blank" rel="noopener noreferrer">{{ t('studioPlugins.' + link.key) }} ↗</a></div>
                  <div class="capability-list"><NTag v-for="keyword in selected.manifest.keywords || []" :key="keyword" size="small" :bordered="false">{{ keyword }}</NTag></div>
                </div>
                <h4>{{ t('studioPlugins.availableIn') }}</h4>
                <div v-if="pluginPages(selected).length" class="view-list">
                  <RouteLinkItem v-for="view in pluginPages(selected)" :key="view.id" :to="pluginPageLocation(selected, view.id)" class="view-link"><span>{{ view.title }}</span><span aria-hidden="true">↗</span></RouteLinkItem>
                </div>
                <p v-else>{{ t('studioPlugins.noPage') }}</p>
                <div class="capability-list"><NTag v-for="slot in [...new Set(pluginPages(selected).map(view => view.slot))]" :key="slot" size="small">{{ t('studioPlugins.slot_' + slot) }}</NTag></div>
                <h4>{{ t('studioPlugins.capabilities') }}</h4>
                <div class="capability-list"><NTag v-for="capability in selected.manifest.capabilities" :key="capability" size="small" :bordered="false">{{ capability }}</NTag></div>
                <div class="operation-list"><p v-for="operation in [...selected.tools, ...selected.commands, ...selected.actions]" :key="operation.name"><strong>{{ operation.name }}</strong><span>{{ operation.description }}</span></p></div>
              </div>
            </NTabPane>
            <NTabPane name="settings" :tab="t('studioPlugins.configuration')" display-directive="if">
              <div class="detail-stack">
                <template v-if="canManage && selected.installed && selected.manifest.configSchema">
                  <PluginConfigFields :key="selected.manifest.id + ':' + configRevisions[selected.manifest.id]" v-model="configs[selected.manifest.id]!" :schema="selected.manifest.configSchema" @update:model-value="configDirty[selected.manifest.id] = true" @valid="configValid[selected.manifest.id] = $event" />
                  <p>{{ t('studioPlugins.secretHint') }}</p>
                  <NButton :disabled="busy || configValid[selected.manifest.id] === false" @click="update(selected, { config: configs[selected.manifest.id] })">{{ t('common.save') }}</NButton>
                </template>
                <NEmpty v-else-if="!(selected.manifest.views || []).some(view => view.slot === 'settings')" :description="t('studioPlugins.noConfiguration')" />
                <template v-if="selected.status === 'active'"><RouteLinkItem v-for="view in pluginPages(selected).filter(view => view.slot === 'settings')" :key="view.id" :to="pluginPageLocation(selected, view.id)" class="view-link">{{ view.title }} ↗</RouteLinkItem></template>
              </div>
            </NTabPane>
            <NTabPane name="developer" :tab="t('studioPlugins.developer')" display-directive="if">
              <div class="detail-stack">
                <template v-if="canManage">
                  <h4>{{ t('studioPlugins.maintenance') }}</h4>
                  <p v-if="selected.development" class="development-path">{{ selected.development.directory }}</p>
                  <div v-if="selected.installed" class="actions">
                    <NButton :disabled="activationBusy(selected) || !selected.enabled" @click="reloadPlugin(selected)">{{ t('studioPlugins.reload') }}</NButton>
                    <NButton :disabled="busy || !selected.previousVersion" @click="update(selected, { action: 'rollback' })">{{ t('studioPlugins.rollback') }} {{ selected.previousVersion }}</NButton>
                    <NButton :disabled="busy" @click="logs(selected.manifest.id)">{{ t('studioPlugins.logs') }}</NButton>
                  </div>
                  <template v-if="selected.installed && !selected.development">
                    <NInput v-model:value="sources[selected.manifest.id]" :placeholder="t('studioPlugins.source')" :aria-label="t('studioPlugins.source')" />
                    <NCheckbox v-model:checked="trusted">{{ t('studioPlugins.trust') }}</NCheckbox>
                    <NButton :disabled="!trusted || busy" @click="install(selected.manifest.id)">{{ t('studioPlugins.upgrade') }}</NButton>
                  </template>
                </template>
                <template v-if="selected.status === 'active' && operations(selected).length">
                  <h4>{{ t('studioPlugins.invoke') }}</h4>
                  <NSelect v-model:value="selections[selected.manifest.id]" :options="operations(selected)" />
                  <NInput v-model:value="argumentsText[selected.manifest.id]" type="textarea" :placeholder="t('studioPlugins.arguments')" />
                  <NButton :disabled="busy || !selections[selected.manifest.id]" @click="invoke(selected)">{{ t('studioPlugins.invoke') }}</NButton>
                </template>
                <pre v-if="outputs[selected.manifest.id]">{{ outputs[selected.manifest.id] }}</pre>
                <NButton v-if="canManage" :disabled="busy" type="error" secondary @click="uninstall(selected)">{{ t(selected.development ? 'studioPlugins.devUnlink' : 'studioPlugins.uninstall') }}</NButton>
              </div>
            </NTabPane>
          </NTabs>
        </div>
      </NDrawerContent>
    </NDrawer>
  </main>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.studio-plugins { display: flex; flex-direction: column; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; color: $text-primary; }
.center-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; width: 100%; }
.center-header h2 { margin: 0; font-size: 16px; }
.center-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 0 24px; }
.center-content { width: 100%; max-width: 1200px; margin: 0 auto; display: flex; flex-direction: column; gap: 24px; padding: 28px 8px; }
.center-intro { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding-bottom: 12px; }
.center-intro h1 { margin: 10px 0; font-size: clamp(24px, 3vw, 32px); font-weight: 650; letter-spacing: -.5px; line-height: 1.35; }
.eyebrow { color: $text-muted; font-size: 12px; }
p { margin: 0; color: $text-secondary; line-height: 1.7; }
.search-row { display: flex; gap: 12px; align-items: center; }
.state-filter { flex: 0 0 140px; }
.catalog-panel { display: flex; flex-direction: column; gap: 24px; min-width: 0; }
.scope-count { margin-inline-start: 8px; color: $text-muted; font-size: 12px; }
.catalog-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.category-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.category-tabs button { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border: 0; background: transparent; border-radius: $radius-sm; color: $text-secondary; cursor: pointer; font: inherit; }
.category-tabs button.selected { color: $text-primary; background: rgba(var(--accent-primary-rgb), .1); font-weight: 600; }
.category-tabs button:hover { background: rgba(var(--accent-primary-rgb), .06); }
.category-tabs span, .catalog-count { color: $text-muted; font-size: 12px; }
.catalog-count { white-space: nowrap; }
.plugin-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px; }
.plugin-card { display: flex; flex-direction: column; gap: 18px; min-width: 0; padding: 24px; background: $bg-card; border: 1px solid $border-light; border-radius: $radius-lg; transition: transform .15s; }
.plugin-card:hover { transform: translateY(-2px); }
.card-top, .card-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.status { display: inline-flex; align-items: center; gap: 6px; color: $text-muted; font-size: 12px; }
.status i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.status.running { color: $text-secondary; }
.card-copy { flex: 1; }
.card-title { padding: 0; margin: 0 0 8px; border: 0; background: transparent; color: $text-primary; text-align: start; font: inherit; font-size: 17px; font-weight: 600; cursor: pointer; }
.card-title:hover { text-decoration: underline; text-underline-offset: 4px; }
.card-copy p { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; min-height: 48px; font-size: 13px; }
.card-features { display: flex; flex-wrap: wrap; gap: 12px; color: $text-muted; font-size: 12px; min-height: 18px; }
.card-footer { border-top: 1px solid $border-color; padding-top: 16px; }
.version { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: $text-muted; font-size: 12px; }
.actions, .capability-list { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.catalog-empty { display: grid; place-items: center; min-height: 280px; }
.detail-stack { display: flex; flex-direction: column; gap: 20px; }
.detail-stack h3, .detail-stack h4 { margin: 0; }
.detail-identity { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; }
.identity-copy { flex: 1; min-width: 120px; }
.detail-description { white-space: pre-line; }
.project-metadata { display: flex; flex-direction: column; gap: 12px; overflow-wrap: anywhere; }
.project-metadata a { color: $accent-primary; }
.development-path { overflow-wrap: anywhere; }
.view-list { display: flex; flex-direction: column; gap: 8px; }
.view-link { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid $border-color; text-decoration: none; color: $text-primary; }
.operation-list { display: flex; flex-direction: column; gap: 12px; }
.operation-list strong { display: block; color: $text-primary; font-weight: 500; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow: auto; font-size: 12px; }
@media (max-width: 600px) {
  .center-scroll { padding: 0 16px; }
  .center-content { padding: 20px 0; gap: 20px; }
  .center-intro { align-items: flex-start; flex-direction: column; gap: 16px; }
  .plugin-grid { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .plugin-card { padding: 20px; }
  .catalog-toolbar { align-items: flex-start; flex-direction: column; }
  .category-tabs { gap: 2px; }
  .category-tabs button { padding: 6px 8px; }
  .search-row { flex-wrap: wrap; }
  .state-filter { flex-basis: 100%; }
}
</style>
