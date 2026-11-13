<script setup lang="ts">
import { ref, shallowRef, computed, watch, onBeforeUnmount, h } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NCheckbox, NEmpty, NInput, NSelect, NTag, NDrawer, NDrawerContent, NModal, NTabs, NTab, NTabPane, NSpin, useDialog, useMessage } from 'naive-ui'
import { isStoredSuperAdmin } from '@/api/client'
import { pluginList, pluginRequest, pluginInvoke, type InstalledPlugin, type PluginDevelopmentProject, type Json } from '@/api/studio/plugins'
import { pluginPages, pluginPageLocation, usePluginCatalog } from '@/composables/usePluginCatalog'
import PageHeader from '@/components/layout/PageHeader.vue'
import PluginIcon from '@/components/plugins/PluginIcon.vue'
import PluginCardMetadata from '@/components/plugins/PluginCardMetadata.vue'
import PluginInstallFeedback from '@/components/plugins/PluginInstallFeedback.vue'
import PluginConfigFields from '@/components/plugins/PluginConfigFields.vue'
import PluginSubmissionDialog from '@/components/plugins/PluginSubmissionDialog.vue'
import PluginDevelopmentGuide from '@/components/plugins/PluginDevelopmentGuide.vue'
import RouteLinkItem from '@/components/common/RouteLinkItem.vue'
import ExternalLinkIcon from '@/components/common/ExternalLinkIcon.vue'
import ChevronRightIcon from '@/components/common/ChevronRightIcon.vue'
import { pluginLinks, safePluginLink } from '@/plugins/navigation'
import { usePluginUpdates } from '@/composables/usePluginUpdates'
import { usePluginMarket } from '@/composables/usePluginMarket'
import type { MarketPlugin } from '@/api/studio/plugin-market'
import type { PluginRelease } from '@/api/studio/plugin-releases'
import { pluginCategories as categories, matchesPluginCategory, matchesPluginSearch, installedMarketPlugin, type PluginCategory } from '@/plugins/catalog'
import { pluginRepository, pluginUpdateState, pluginInstallationKind, publishedPluginAction, samePluginInstallation, type PublishedPluginAction } from '@/plugins/updates'

const { t } = useI18n(), dialog = useDialog(), message = useMessage(), router = useRouter(), route = useRoute()
const { profile, snapshot, loading, error, refresh } = usePluginCatalog()
const { updates: availableUpdates, releases: publishedReleases, unavailable: unavailableRepositories, failed: updateCheckFailed, checking: checkingUpdates, refresh: refreshUpdates } = usePluginUpdates(computed(() => snapshot.value.plugins))
const busy = ref(false), actionError = ref(''), source = ref(''), trusted = ref(false), showInstall = ref(false)
const installing = ref(false), installingId = ref(''), installConfirmationOpen = ref(false)
let installConfirmationSequence = 0
const scope = ref<'installed' | 'all' | 'development'>('installed')
function scopeKeydown(event: KeyboardEvent) {
  const tabs = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="tab"]')]
  const current = tabs.findIndex(tab => tab === document.activeElement)
  if (current < 0) return
  const target = event.key === 'ArrowRight' ? (current + 1) % tabs.length : event.key === 'ArrowLeft' ? (current + tabs.length - 1) % tabs.length
    : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : ['Enter', ' '].includes(event.key) ? current : -1
  if (target >= 0) { event.preventDefault(); tabs[target].click(); tabs[target].focus() }
}
const { entries: marketEntries, total: marketTotal, loading: marketLoading, failed: marketFailed, loaded: marketLoaded, refresh: refreshMarket } = usePluginMarket(computed(() => scope.value === 'all'))
const search = ref(''), category = ref<PluginCategory>('all'), state = ref('all')
watch(scope, value => { if (value !== 'all' && ['installed', 'notInstalled'].includes(state.value)) state.value = 'all' })
const selectedMarketId = ref('')
const selectedMarket = computed({ get: () => marketEntries.value.find(plugin => plugin.id === selectedMarketId.value), set: (plugin: MarketPlugin | undefined) => { selectedMarketId.value = plugin?.id || '' } })
const showSubmission = ref(false)
const developmentGuide = ref<'create' | 'link' | null>(null)
const selectedId = ref(''), detailTab = ref('overview')
const selectedDevelopment = ref(false)
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
type CatalogPlugin = InstalledPlugin & { installed: boolean; development?: PluginDevelopmentProject; developmentEntry?: boolean }
const catalog = computed<CatalogPlugin[]>(() => snapshot.value.plugins.map(plugin => ({ ...plugin, installed: true,
  development: projects.value.find(project => project.id === plugin.manifest.id && project.directory === plugin.developmentDirectory),
})))
const developmentCatalog = computed<CatalogPlugin[]>(() => projects.value.map(project => {
    const installed = catalog.value.find(plugin => plugin.manifest.id === project.id && plugin.developmentDirectory === project.directory)
    return installed ? { ...installed, development: project, developmentEntry: true } : {
      manifest: project.manifest || { id: project.id, name: project.id, version: '', apiVersion: 1, permissions: [] },
      source: project.directory, installedAt: project.createdAt || 0, installed: false, enabled: false,
      status: ['missing', 'error'].includes(project.status) ? 'failed' : 'disabled', error: project.error,
      config: {}, tools: [], commands: [], actions: [], development: project, developmentEntry: true,
    }
}))
const selected = computed(() => (selectedDevelopment.value ? developmentCatalog.value : catalog.value).find(plugin => plugin.manifest.id === selectedId.value))
const activeCount = computed(() => snapshot.value.plugins.filter(plugin => plugin.status === 'active').length)
const localEntries = computed(() => scope.value === 'development' ? developmentCatalog.value : catalog.value)
const filtered = computed(() => localEntries.value.filter(plugin => matchesPluginCategory(plugin.manifest.permissions, category.value)
  && (state.value === 'all' || plugin.status === state.value) && matchesPluginSearch(plugin.manifest, search.value)))
const categoryCount = (value: PluginCategory) => scope.value === 'all'
  ? marketEntries.value.filter(plugin => matchesPluginCategory(plugin.permissions, value)).length
  : localEntries.value.filter(plugin => matchesPluginCategory(plugin.manifest.permissions, value)).length
const marketInstalled = (plugin: MarketPlugin) => installedMarketPlugin(plugin, snapshot.value.plugins)
const marketConflict = (plugin: MarketPlugin) => !marketInstalled(plugin) && snapshot.value.plugins.some(local => local.manifest.id === plugin.manifestId)
const marketStatus = (plugin: MarketPlugin) => marketInstalled(plugin)?.status || (marketConflict(plugin) ? 'marketConflict' : 'notInstalled')
function matchesMarketState(plugin: MarketPlugin) {
  const installed = marketInstalled(plugin)
  if (state.value === 'all') return true
  if (state.value === 'installed') return Boolean(installed)
  if (state.value === 'notInstalled') return !installed
  return installed?.status === state.value
}
const filteredMarket = computed(() => marketEntries.value.filter(plugin => matchesMarketState(plugin)
  && matchesPluginCategory(plugin.permissions, category.value) && matchesPluginSearch(plugin, search.value)))
const marketAction = (plugin: MarketPlugin) => marketConflict(plugin) ? undefined : publishedPluginAction(marketInstalled(plugin), plugin.release)
const actionLabel = (action: PublishedPluginAction | undefined, version: string | null | undefined) => t('studioPlugins.' + ({ install: 'install', switch: 'installMarketVersion', upgrade: 'updateTo', reinstall: 'reinstallVersion' }[action || 'install']), { version })
const installationLabel = (plugin: InstalledPlugin) => t('studioPlugins.' + ({ development: 'updateDevelopment', local: 'localVersion', package: 'installed' }[pluginInstallationKind(plugin)]))
const localRelease = (plugin: InstalledPlugin) => publishedReleases.value[pluginRepository(plugin) || '']
const localAction = (plugin: CatalogPlugin) => plugin.installed && !plugin.developmentEntry ? publishedPluginAction(plugin, localRelease(plugin)) : undefined
const localPublishedVersion = (plugin: InstalledPlugin) => {
  const release = localRelease(plugin)
  return release?.manifestId === plugin.manifest.id ? release.version : undefined
}
const localUpdateState = (plugin: CatalogPlugin) => plugin.installed
  ? pluginUpdateState(plugin, localRelease(plugin), checkingUpdates.value, unavailableRepositories.value.includes(pluginRepository(plugin) || '')) : undefined
const marketUpdateState = (plugin: MarketPlugin) => {
  const installed = marketInstalled(plugin)
  return installed ? pluginUpdateState(installed, plugin.release, marketLoading.value, marketFailed.value) : undefined
}
function manageMarket(plugin: MarketPlugin) {
  const installed = marketInstalled(plugin)
  if (installed) { selectedMarket.value = undefined; details(installed) }
}
function installMarket(plugin: MarketPlugin) {
  if (marketAction(plugin) && plugin.release) installPublished(plugin.release, plugin.name, marketInstalled(plugin))
}
function installPublished(release: PluginRelease, name: string, installed?: InstalledPlugin) {
  const action = publishedPluginAction(installed, release)
  if (!canManage.value || !action) return
  confirmInstallation({
    title: actionLabel(action, release.version),
    content: t('studioPlugins.' + (action === 'switch' ? 'switchMarketConfirm' : action === 'upgrade' ? 'updateConfirm' : 'marketInstallConfirm'),
      { name, current: installed?.manifest.version, version: release.version, repository: release.repository }),
    positiveText: actionLabel(action, release.version),
  }, () => performInstallation(release.manifestId, async () => {
    const latest = await pluginList(), current = latest.plugins.find(local => local.manifest.id === release.manifestId)
    if (!samePluginInstallation(installed, current) || publishedPluginAction(current, release) !== action) throw new Error(t('studioPlugins.marketChanged'))
    // Verify the package identity for both new installs and upgrades.
    await pluginRequest(undefined, '/install', { source: release.installSource, pluginId: release.manifestId,
      expectedVersion: release.version, revision: latest.revision, trusted: true })
    sources.value[release.manifestId] = release.installSource
    message.success(t('common.ok'))
  }))
}
function confirmInstallation(options: { title: string; content: string; positiveText: string }, work: () => Promise<boolean>) {
  if (busy.value || installConfirmationOpen.value) return
  const pending = ref(false), failure = ref('')
  const sequence = ++installConfirmationSequence
  const closed = () => { if (sequence === installConfirmationSequence) installConfirmationOpen.value = false }
  installConfirmationOpen.value = true
  const confirmation = dialog.create({
    title: options.title, type: 'default', showIcon: false,
    content: () => h(PluginInstallFeedback, { description: options.content, loading: pending.value, error: failure.value }),
    positiveText: options.positiveText, positiveButtonProps: { type: 'primary' }, negativeText: t('common.cancel'),
    onAfterLeave: closed,
    onNegativeClick: () => { if (pending.value) return false; closed() },
    onClose: () => { if (pending.value) return false; closed() },
    onMaskClick: () => { if (!pending.value) closed() },
    onEsc: () => { if (!pending.value) closed() },
    onPositiveClick: async () => {
      if (pending.value || busy.value) return false
      pending.value = true; failure.value = ''
      confirmation.loading = true; confirmation.positiveText = t('studioPlugins.installing')
      confirmation.negativeButtonProps = { disabled: true }
      confirmation.closable = false; confirmation.maskClosable = false; confirmation.closeOnEsc = false
      try {
        const success = await work()
        if (!success) { failure.value = actionError.value; actionError.value = '' }
        return success
      } catch (cause) { failure.value = cause instanceof Error ? cause.message : String(cause); return false }
      finally {
        pending.value = false; confirmation.loading = false; confirmation.positiveText = options.positiveText
        confirmation.negativeButtonProps = { disabled: false }
        confirmation.closable = true; confirmation.maskClosable = true; confirmation.closeOnEsc = true
      }
    },
  })
}
const stateOptions = computed(() => ['all', ...(scope.value === 'all' ? ['installed', 'notInstalled'] : []), 'active', 'disabled', 'failed']
  .map(value => ({ value, label: t('studioPlugins.' + (value === 'all' ? 'allStates' : value)) })))
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
function details(plugin: InstalledPlugin & { developmentEntry?: boolean }) { selectedDevelopment.value = !!plugin.developmentEntry; void router.replace({ query: { ...route.query, manage: plugin.manifest.id } }) }
function closeDetails() { const { manage: _, ...query } = route.query; selectedId.value = ''; selectedDevelopment.value = false; void router.replace({ query }) }
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
  const success = await performInstallation(id || '', () => pluginRequest(undefined, '/install', { source: id ? sources.value[id] : source.value, pluginId: id, revision: snapshot.value.revision, trusted: trusted.value }))
  if (success && !id) { showInstall.value = false; source.value = ''; trusted.value = false }
}
async function performInstallation(id: string, work: () => Promise<unknown>) {
  if (busy.value) return false
  installing.value = true; installingId.value = id
  try { return await perform(work) }
  finally { installing.value = false; installingId.value = '' }
}
function upgrade(plugin: InstalledPlugin) {
  const release = localRelease(plugin)
  if (release) installPublished(release, plugin.manifest.name, plugin)
}
async function update(plugin: InstalledPlugin, input: object) {
  const revision = 'config' in input ? configRevisions.value[plugin.manifest.id] : snapshot.value.revision
  const success = await perform(() => pluginRequest(undefined, '/' + plugin.manifest.id, { ...input, revision }, 'PATCH'))
  if (success) { configDirty.value[plugin.manifest.id] = false; syncDrafts() }
  return success
}
function uninstall(plugin: InstalledPlugin) {
  dialog.warning({ title: t('studioPlugins.uninstall'), content: t('studioPlugins.uninstallConfirm', { name: plugin.manifest.name }), positiveText: t('common.confirm'), positiveButtonProps: { type: 'primary' }, negativeText: t('common.cancel'), onPositiveClick: async () => {
    const success = await perform(async () => {
      const latest = await pluginList(), current = latest.plugins.find(local => local.manifest.id === plugin.manifest.id)
      if (!samePluginInstallation(plugin, current)) throw new Error(t('studioPlugins.marketChanged'))
      await pluginRequest(undefined, '/' + encodeURIComponent(plugin.manifest.id), { action: 'uninstall', revision: latest.revision }, 'PATCH')
    })
    if (success) {
      delete configs.value[plugin.manifest.id]; delete sources.value[plugin.manifest.id]; delete configDirty.value[plugin.manifest.id]
      closeDetails()
    }
  } })
}
function unlinkDevelopment(plugin: CatalogPlugin) {
  dialog.warning({ title: t('studioPlugins.devUnlink'), content: t('studioPlugins.devUnlinkConfirm', { name: plugin.manifest.name }), positiveText: t('common.confirm'), positiveButtonProps: { type: 'primary' }, negativeText: t('common.cancel'), onPositiveClick: async () => {
    const success = await perform(async () => { const { revision } = await pluginList(); await pluginRequest(undefined, '/' + encodeURIComponent(plugin.manifest.id) + '/development?revision=' + revision, undefined, 'DELETE') })
    if (success) { if (plugin.installed) scope.value = 'installed'; closeDetails() }
  } })
}
function activateLinkedPlugin(plugin: CatalogPlugin, label: 'common.enable' | 'studioPlugins.reload') {
  const activate = () => performInstallation(plugin.manifest.id, async () => {
    const { revision } = await pluginList()
    await pluginRequest(undefined, '/' + encodeURIComponent(plugin.manifest.id) + '/development', { revision, trusted: true })
  })
  if (plugin.developmentDirectory === plugin.development!.directory) { void activate(); return }
  confirmInstallation({ title: t(label), content: t('studioPlugins.devTrust', { path: plugin.development!.directory }), positiveText: t(label) }, activate)
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
      <aside class="developer-banner" data-theme-surface="card" :aria-label="t('studioPlugins.developTitle')">
        <svg class="developer-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 7-5 5 5 5m10-10 5 5-5 5M14 4l-4 16" /></svg>
        <div class="developer-copy">
          <h1>{{ t('studioPlugins.developTitle') }}</h1><p>{{ t('studioPlugins.developDescription') }}</p>
          <div class="developer-start-actions">
            <NButton size="small" secondary @click="developmentGuide = 'create'">{{ t('studioPlugins.developCreate') }}</NButton>
            <NButton size="small" secondary @click="developmentGuide = 'link'">{{ t('studioPlugins.developLink') }}</NButton>
          </div>
        </div>
        <nav class="developer-links" :aria-label="t('studioPlugins.developResources')">
          <a href="https://github.com/EKKOLearnAI/ekko-studio/blob/main/docs/plugins.md" target="_blank" rel="noopener noreferrer"><span>{{ t('studioPlugins.developGuide') }}</span><ExternalLinkIcon /></a>
          <a href="https://github.com/EKKOLearnAI/ekko-studio/tree/main/packages/plugin-sdk/template" target="_blank" rel="noopener noreferrer"><span>{{ t('studioPlugins.developTemplate') }}</span><ExternalLinkIcon /></a>
        </nav>
      </aside>
      <PluginDevelopmentGuide v-model:mode="developmentGuide" />
      <PluginInstallFeedback v-if="installing && !installConfirmationOpen && !showInstall && !selected" loading />
      <NAlert v-if="error || actionError" type="error" closable @close="error = ''; actionError = ''">{{ actionError || error }}</NAlert>
      <NAlert v-if="developmentError" type="error" closable @close="developmentError = ''">{{ developmentError }}</NAlert>
      <NAlert v-if="updateCheckFailed" type="warning">{{ t('studioPlugins.updateCheckFailed') }} <NButton text :loading="checkingUpdates" @click="refreshUpdates(true)">{{ t('common.retry') }}</NButton></NAlert>
      <div class="catalog-heading">
        <NTabs v-model:value="scope" type="line" class="catalog-scopes" role="tablist" :aria-label="t('studioPlugins.title')" @keydown="scopeKeydown">
          <NTab name="installed" id="plugins-tab-installed" role="tab" :aria-selected="scope === 'installed'" :tabindex="scope === 'installed' ? 0 : -1" aria-controls="plugin-catalog-panel">{{ t('studioPlugins.installed') }} <span class="scope-count">{{ snapshot.plugins.length }}</span></NTab>
          <NTab name="all" id="plugins-tab-all" role="tab" :aria-selected="scope === 'all'" :tabindex="scope === 'all' ? 0 : -1" aria-controls="plugin-catalog-panel">{{ t('studioPlugins.all') }} <span v-if="marketTotal !== null" class="scope-count">{{ marketTotal }}</span></NTab>
          <NTab v-if="canManage && projects.length" name="development" id="plugins-tab-development" role="tab" :aria-selected="scope === 'development'" :tabindex="scope === 'development' ? 0 : -1" aria-controls="plugin-catalog-panel">{{ t('studioPlugins.devProjects') }} <span class="scope-count">{{ projects.length }}</span></NTab>
        </NTabs>
        <div class="catalog-actions">
          <NButton secondary @click="showSubmission = true">{{ t('studioPluginSubmission.title') }}</NButton>
          <NButton v-if="canManage" type="primary" :disabled="busy" @click="showInstall = true">{{ t('studioPlugins.installTitle') }}</NButton>
        </div>
      </div>
      <section id="plugin-catalog-panel" class="catalog-panel" role="tabpanel" :aria-labelledby="'plugins-tab-' + scope">
      <NAlert v-if="scope === 'all' && marketFailed" type="warning">{{ t('studioPlugins.marketUnavailable') }} <NButton text :loading="marketLoading" @click="refreshMarket(true)">{{ t('common.retry') }}</NButton></NAlert>
      <div class="search-row">
        <NInput v-model:value="search" clearable size="large" :placeholder="t('studioPlugins.search')" :aria-label="t('studioPlugins.search')">
          <template #prefix><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg></template>
        </NInput>
        <NSelect v-model:value="state" class="state-filter" :options="stateOptions" :aria-label="t('studioPlugins.allStates')" />
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
            <PluginIcon class="card-icon" :plugin="{ manifest: { name: plugin.name } }" :icon-url="plugin.iconUrl" />
            <div class="card-copy">
              <div class="card-heading">
                <button type="button" class="card-title" @click="selectedMarket = plugin">{{ plugin.name }}</button>
                <NTag v-if="marketInstalled(plugin)" size="small" :bordered="false">{{ installationLabel(marketInstalled(plugin)!) }}</NTag>
                <span class="status" :class="{ running: marketStatus(plugin) === 'active' }"><i aria-hidden="true" />{{ t('studioPlugins.' + marketStatus(plugin)) }}</span>
              </div>
              <p class="card-description">{{ plugin.description }}</p>
              <PluginCardMetadata compact :author="plugin.author?.name" :repository="plugin.repository" :stars="plugin.repositoryStars"
                :version="marketInstalled(plugin)?.manifest.version || plugin.version" :installed="Boolean(marketInstalled(plugin))"
                :published-version="plugin.version" :update-state="marketUpdateState(plugin)">
                <div class="card-features"><span v-for="item in categories.slice(1).filter(value => matchesPluginCategory(plugin.permissions, value))" :key="item">{{ t('studioPlugins.' + item) }}</span></div>
              </PluginCardMetadata>
            </div>
            <footer class="card-footer">
              <div class="actions">
                <NButton v-if="canManage && marketAction(plugin)" size="small" type="primary" :disabled="busy" @click="installMarket(plugin)">{{ actionLabel(marketAction(plugin), plugin.version) }}</NButton>
                <NButton v-else-if="canManage && !marketInstalled(plugin)" size="small" type="primary" :disabled="busy || !plugin.release || marketConflict(plugin)" @click="installMarket(plugin)">{{ t(marketConflict(plugin) ? 'studioPlugins.marketConflict' : plugin.release ? 'studioPlugins.install' : 'studioPlugins.marketNotInstallable') }}</NButton>
                <NButton v-if="marketInstalled(plugin)" size="small" secondary @click="manageMarket(plugin)">{{ t('studioPlugins.manage') }}</NButton>
              </div>
              <div class="actions secondary-actions">
                <NButton size="tiny" quaternary @click="selectedMarket = plugin">{{ t('studioPlugins.details') }}</NButton>
                <NButton v-if="canManage && marketInstalled(plugin)" size="tiny" quaternary :disabled="busy" @click="uninstall(marketInstalled(plugin)!)">{{ t('studioPlugins.uninstall') }}</NButton>
              </div>
            </footer>
          </article>
        </div>
      </template>
      <div v-else-if="loading && !localEntries.length" class="catalog-empty"><NSpin /></div>
      <div v-else-if="!filtered.length" class="catalog-empty"><NEmpty :description="t(localEntries.length || search || category !== 'all' || state !== 'all' ? 'studioPlugins.noResults' : 'studioPlugins.empty')" /></div>
      <div v-else class="plugin-grid">
        <article v-for="plugin in filtered" :key="plugin.manifest.id" class="plugin-card" data-theme-surface="card" :data-testid="`plugin-card-${plugin.manifest.id}`">
          <PluginIcon class="card-icon" :plugin="plugin" />
          <div class="card-copy">
            <div class="card-heading">
              <button type="button" class="card-title" @click="details(plugin)">{{ plugin.manifest.name }}</button>
              <NTag v-if="plugin.developmentEntry || pluginInstallationKind(plugin) !== 'package'" size="small" :bordered="false">{{ plugin.developmentEntry || plugin.developmentDirectory ? t('studioPlugins.devLabel') : t('studioPlugins.localVersion') }}</NTag><span class="status" :class="{ running: plugin.status === 'active' }"><i aria-hidden="true" />{{ t('studioPlugins.' + plugin.status) }}</span>
            </div>
            <p class="card-description">{{ plugin.manifest.description || plugin.manifest.id }}</p>
            <PluginCardMetadata compact :author="plugin.manifest.author?.name" :repository="pluginRepository(plugin)" :stars="localRelease(plugin)?.repositoryStars"
              :version="plugin.manifest.version" :installed="plugin.installed" :published-version="localPublishedVersion(plugin)" :update-state="localUpdateState(plugin)">
              <div class="card-features"><span v-for="item in categories.slice(1).filter(value => matchesPluginCategory(plugin.manifest.permissions, value))" :key="item">{{ t('studioPlugins.' + item) }}</span></div>
            </PluginCardMetadata>
          </div>
          <footer class="card-footer">
            <div class="actions">
              <NButton v-if="canManage && localAction(plugin)" size="small" type="primary" :disabled="busy" @click="upgrade(plugin)">{{ actionLabel(localAction(plugin), localRelease(plugin)?.version) }}</NButton>
              <NButton v-if="plugin.status === 'active' && pluginPages(plugin).length" size="small" secondary @click="router.push(pluginPageLocation(plugin))">{{ t('studioPlugins.open') }}</NButton>
              <NButton v-else-if="canManage && !plugin.enabled" size="small" secondary :loading="installing && installingId === plugin.manifest.id" :disabled="activationBusy(plugin)" @click="enablePlugin(plugin)">{{ t('common.enable') }}</NButton>
            </div>
            <div class="actions secondary-actions">
              <NButton size="tiny" quaternary @click="details(plugin)">{{ t('studioPlugins.details') }}</NButton>
              <NButton v-if="canManage && plugin.installed" size="tiny" quaternary :disabled="busy" @click="uninstall(plugin)">{{ t('studioPlugins.uninstall') }}</NButton>
              <NButton v-if="canManage && plugin.development" size="tiny" quaternary :disabled="busy" @click="unlinkDevelopment(plugin)">{{ t('studioPlugins.devUnlink') }}</NButton>
            </div>
          </footer>
        </article>
      </div>
      </section>
    </div>
    </div>

    <PluginSubmissionDialog v-model:show="showSubmission" />
    <NModal v-model:show="showInstall" preset="card" :title="t('studioPlugins.installTitle')" :closable="!installing" :mask-closable="!installing" :close-on-esc="!installing" class="plugin-install-modal" style="width: min(540px, calc(100vw - 32px))">
      <div class="detail-stack">
        <p>{{ t('studioPlugins.installHint') }}</p>
        <NInput v-model:value="source" :disabled="installing" :placeholder="t('studioPlugins.source')" :aria-label="t('studioPlugins.source')" />
        <NCheckbox v-model:checked="trusted" :disabled="installing" :aria-disabled="installing">{{ t('studioPlugins.trust') }}</NCheckbox>
        <PluginInstallFeedback v-if="installing" loading />
        <NAlert v-if="actionError" type="error">{{ actionError }}</NAlert>
        <NButton type="primary" :disabled="!trusted || !source.trim() || busy" :loading="installing" @click="install()">{{ t(installing ? 'studioPlugins.installing' : 'studioPlugins.install') }}</NButton>
      </div>
    </NModal>

    <NDrawer :show="Boolean(selectedMarket)" :width="'min(560px, 100vw)'" @update:show="value => { if (!value) selectedMarket = undefined }">
      <NDrawerContent v-if="selectedMarket" :title="selectedMarket.name" closable>
        <div class="detail-stack">
          <div class="detail-identity">
            <PluginIcon :plugin="{ manifest: { name: selectedMarket.name } }" :icon-url="selectedMarket.iconUrl" /><span>{{ selectedMarket.version ? 'v' + selectedMarket.version : '' }}</span>
            <NTag v-if="marketInstalled(selectedMarket)">{{ installationLabel(marketInstalled(selectedMarket)!) }}</NTag>
            <span class="status" :class="{ running: marketStatus(selectedMarket) === 'active' }"><i aria-hidden="true" />{{ t('studioPlugins.' + marketStatus(selectedMarket)) }}</span>
          </div>
          <PluginCardMetadata :author="selectedMarket.author?.name" :repository="selectedMarket.repository" :stars="selectedMarket.repositoryStars"
            :version="marketInstalled(selectedMarket)?.manifest.version || selectedMarket.version" :installed="Boolean(marketInstalled(selectedMarket))"
            :published-version="selectedMarket.version" :update-state="marketUpdateState(selectedMarket)" />
          <p class="detail-description">{{ selectedMarket.description }}</p>
          <div class="card-features"><span v-for="item in categories.slice(1).filter(value => matchesPluginCategory(selectedMarket!.permissions, value))" :key="item">{{ t('studioPlugins.' + item) }}</span></div>
          <div class="project-metadata">
            <p v-if="selectedMarket.license"><strong>{{ t('studioPlugins.license') }}:</strong> {{ selectedMarket.license }}</p>
          </div>
          <div class="actions">
            <NButton v-if="marketInstalled(selectedMarket)" @click="manageMarket(selectedMarket)">{{ t('studioPlugins.manage') }}</NButton>
            <NButton v-if="canManage && marketAction(selectedMarket)" type="primary" :disabled="busy" @click="installMarket(selectedMarket)">{{ actionLabel(marketAction(selectedMarket), selectedMarket.version) }}</NButton>
            <NButton v-else-if="canManage && !marketInstalled(selectedMarket)" type="primary" :disabled="busy || !selectedMarket.release || marketConflict(selectedMarket)" @click="installMarket(selectedMarket)">{{ t(marketConflict(selectedMarket) ? 'studioPlugins.marketConflict' : selectedMarket.release ? 'studioPlugins.install' : 'studioPlugins.marketNotInstallable') }}</NButton>
            <NButton v-if="canManage && marketInstalled(selectedMarket)" quaternary type="error" :disabled="busy" @click="uninstall(marketInstalled(selectedMarket)!)">{{ t('studioPlugins.uninstall') }}</NButton>
          </div>
          <NAlert v-if="actionError" type="error">{{ actionError }}</NAlert>
        </div>
      </NDrawerContent>
    </NDrawer>

    <NDrawer :show="Boolean(selected)" :width="'min(560px, 100vw)'" :mask-closable="!installing" :close-on-esc="!installing" @update:show="value => { if (!value) closeDetails() }">
      <NDrawerContent v-if="selected" :title="selected.manifest.name" :closable="!installing">
        <div class="detail-stack">
          <div class="detail-identity"><PluginIcon :plugin="selected" /><div class="identity-copy"><h3>{{ selected.manifest.name }}</h3><span class="eyebrow">{{ selected.manifest.id }} · v{{ selected.manifest.version }}</span></div><NTag size="small" :bordered="false">{{ t('studioPlugins.' + selected.status) }}</NTag></div>
          <p class="detail-description">{{ selected.manifest.description }}</p>
          <PluginInstallFeedback v-if="installing && installingId === selected.manifest.id && !installConfirmationOpen" loading />
          <NAlert v-if="selected.installed && !selected.developmentEntry && availableUpdates[selected.manifest.id]" type="info">
            {{ t('studioPlugins.newVersion', { current: selected.manifest.version, version: availableUpdates[selected.manifest.id]!.version }) }}
            <NButton v-if="canManage" text :disabled="busy" @click="upgrade(selected)">{{ t('studioPlugins.updateTo', { version: availableUpdates[selected.manifest.id]!.version }) }}</NButton>
          </NAlert>
          <div class="actions">
            <NButton v-if="selected.status === 'active' && pluginPages(selected).length" type="primary" @click="router.push(pluginPageLocation(selected))">{{ t('studioPlugins.open') }}</NButton>
            <NButton v-if="canManage" :disabled="selected.enabled ? busy : activationBusy(selected)" @click="selected.enabled ? update(selected, { enabled: false }) : enablePlugin(selected)">{{ t(selected.enabled ? 'common.disable' : 'common.enable') }}</NButton>
            <NButton v-if="canManage && selected.installed" :disabled="busy" type="error" secondary @click="uninstall(selected)">{{ t('studioPlugins.uninstall') }}</NButton>
          </div>
          <NAlert v-if="selected.error || selected.development?.error || actionError" type="error">{{ actionError || selected.development?.error || selected.error }}</NAlert>
          <NTabs v-model:value="detailTab" type="line" animated>
            <NTabPane name="overview" :tab="t('studioPlugins.overview')">
              <div class="detail-stack">
                <div class="project-metadata">
                  <p v-if="selected.manifest.author"><strong>{{ t('studioPlugins.author') }}:</strong> <a v-if="safePluginLink(selected.manifest.author.url)" :href="safePluginLink(selected.manifest.author.url)" target="_blank" rel="noopener noreferrer">{{ selected.manifest.author.name }}</a><span v-else>{{ selected.manifest.author.name }}</span></p>
                  <p v-if="selected.manifest.license"><strong>{{ t('studioPlugins.license') }}:</strong> {{ selected.manifest.license }}</p>
                  <div class="actions"><a v-for="link in pluginLinks(selected)" :key="link.key" :href="link.url" target="_blank" rel="noopener noreferrer"><span>{{ t('studioPlugins.' + link.key) }}</span><ExternalLinkIcon /></a></div>
                  <div class="capability-list"><NTag v-for="keyword in selected.manifest.keywords || []" :key="keyword" size="small" :bordered="false">{{ keyword }}</NTag></div>
                </div>
                <h4>{{ t('studioPlugins.availableIn') }}</h4>
                <div v-if="pluginPages(selected).length" class="view-list">
                  <RouteLinkItem v-for="view in pluginPages(selected)" :key="view.id" :to="pluginPageLocation(selected, view.id)" class="view-link"><span>{{ view.title }}</span><ChevronRightIcon /></RouteLinkItem>
                </div>
                <p v-else>{{ t('studioPlugins.noPage') }}</p>
                <div class="capability-list"><NTag v-for="slot in [...new Set(pluginPages(selected).map(view => view.slot))]" :key="slot" size="small">{{ t('studioPlugins.slot_' + slot) }}</NTag></div>
                <h4>{{ t('studioPlugins.capabilities') }}</h4>
                <div class="capability-list"><NTag v-for="capability in selected.manifest.permissions" :key="capability" size="small" :bordered="false">{{ capability }}</NTag></div>
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
                <template v-if="selected.status === 'active'"><RouteLinkItem v-for="view in pluginPages(selected).filter(view => view.slot === 'settings')" :key="view.id" :to="pluginPageLocation(selected, view.id)" class="view-link"><span>{{ view.title }}</span><ChevronRightIcon /></RouteLinkItem></template>
              </div>
            </NTabPane>
            <NTabPane name="developer" :tab="t('studioPlugins.developer')" display-directive="if">
              <div class="detail-stack">
                <template v-if="canManage">
                  <h4>{{ t('studioPlugins.maintenance') }}</h4>
                  <p v-if="selected.development" class="development-path">{{ selected.development.directory }}</p>
                  <div v-if="selected.installed" class="actions">
                    <NButton :loading="installing && installingId === selected.manifest.id" :disabled="activationBusy(selected) || !selected.enabled" @click="reloadPlugin(selected)">{{ t('studioPlugins.reload') }}</NButton>
                    <NButton :disabled="busy || !selected.previousVersion" @click="update(selected, { action: 'rollback' })">{{ t('studioPlugins.rollback') }} {{ selected.previousVersion }}</NButton>
                    <NButton :disabled="busy" @click="logs(selected.manifest.id)">{{ t('studioPlugins.logs') }}</NButton>
                  </div>
                  <template v-if="selected.installed && !selected.development">
                    <NInput v-model:value="sources[selected.manifest.id]" :disabled="installing" :placeholder="t('studioPlugins.source')" :aria-label="t('studioPlugins.source')" />
                    <NCheckbox v-model:checked="trusted" :disabled="installing" :aria-disabled="installing">{{ t('studioPlugins.trust') }}</NCheckbox>
                    <NButton type="primary" :loading="installing && installingId === selected.manifest.id" :disabled="!trusted || busy" @click="install(selected.manifest.id)">{{ t('studioPlugins.upgrade') }}</NButton>
                  </template>
                </template>
                <template v-if="selected.status === 'active' && operations(selected).length">
                  <h4>{{ t('studioPlugins.invoke') }}</h4>
                  <NSelect v-model:value="selections[selected.manifest.id]" :options="operations(selected)" />
                  <NInput v-model:value="argumentsText[selected.manifest.id]" type="textarea" :placeholder="t('studioPlugins.arguments')" />
                  <NButton :disabled="busy || !selections[selected.manifest.id]" @click="invoke(selected)">{{ t('studioPlugins.invoke') }}</NButton>
                </template>
                <pre v-if="outputs[selected.manifest.id]">{{ outputs[selected.manifest.id] }}</pre>
                <NButton v-if="canManage && selected.development" :disabled="busy" secondary @click="unlinkDevelopment(selected)">{{ t('studioPlugins.devUnlink') }}</NButton>
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
.center-content { width: 100%; max-width: 1200px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; padding: 24px 8px; }
.developer-banner { display: flex; align-items: center; gap: 16px; padding: 18px 20px; background: $bg-card; border: 1px solid $border-light; border-radius: $radius-lg; }
.developer-icon { flex-shrink: 0; color: $text-secondary; }
.developer-copy { flex: 1; min-width: 0; }
.developer-copy h1 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
.developer-copy p { font-size: 12px; }
.developer-start-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.developer-links { display: flex; align-items: center; flex-wrap: wrap; gap: 12px 18px; font-size: 12px; line-height: 20px; }
.developer-links a { display: inline-flex; align-items: center; gap: 4px; min-height: 24px; color: $text-secondary; text-decoration: none; }
.developer-links a:hover { color: $accent-primary; text-decoration: underline; text-underline-offset: 3px; }
.catalog-heading { display: flex; align-items: center; gap: 24px; }
.catalog-scopes { flex: 1; min-width: 0; }
.catalog-actions { display: flex; align-items: center; flex-shrink: 0; gap: 8px; }
.eyebrow { color: $text-muted; font-size: 12px; }
p { margin: 0; color: $text-secondary; line-height: 1.7; }
.search-row { display: flex; gap: 12px; align-items: center; }
.state-filter { flex: 0 0 140px; }
.catalog-panel { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.scope-count { margin-inline-start: 8px; color: $text-muted; font-size: 12px; }
.catalog-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.category-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.category-tabs button { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 0; background: transparent; border-radius: $radius-sm; color: $text-secondary; cursor: pointer; font: inherit; font-size: 12px; }
.category-tabs button.selected { color: $text-primary; background: rgba(var(--accent-primary-rgb), .1); font-weight: 600; }
.category-tabs button:hover { background: rgba(var(--accent-primary-rgb), .06); }
.category-tabs span, .catalog-count { color: $text-muted; font-size: 12px; }
.catalog-count { white-space: nowrap; }
.plugin-grid { display: flex; flex-direction: column; gap: 10px; }
.plugin-card { display: grid; grid-template-columns: 48px minmax(0, 1fr) auto; align-items: start; gap: 20px; min-width: 0; padding: 20px; background: $bg-card; border: 1px solid $border-light; border-radius: $radius-lg; }
.card-icon { width: 48px; height: 48px; align-self: center; }
.card-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; min-width: 0; }
.status { display: inline-flex; align-items: center; gap: 6px; color: $text-muted; font-size: 12px; line-height: 20px; }
.status i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.status.running { color: $text-secondary; }
.card-copy { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.card-title { padding: 0; margin: 0; border: 0; background: transparent; color: $text-primary; text-align: start; font: inherit; font-size: 15px; font-weight: 600; overflow-wrap: anywhere; cursor: pointer; }
.card-title:hover { text-decoration: underline; text-underline-offset: 4px; }
.card-description { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; font-size: 13px; }
.card-features { display: flex; flex-wrap: wrap; gap: 8px; color: $text-muted; font-size: 11px; }
.card-features span + span::before { content: '·'; margin-inline-end: 8px; }
.card-footer { display: flex; flex-direction: column; align-items: flex-end; justify-content: center; align-self: stretch; gap: 8px; max-width: 240px; }
.card-footer > .actions { justify-content: flex-end; }
.card-footer > .actions:empty { display: none; }
.secondary-actions { gap: 2px; }
.actions, .capability-list { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.catalog-empty { display: grid; place-items: center; min-height: 280px; }
.detail-stack { display: flex; flex-direction: column; gap: 20px; }
.detail-stack h3, .detail-stack h4 { margin: 0; }
.detail-identity { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; }
.identity-copy { flex: 1; min-width: 120px; }
.detail-description { white-space: pre-line; }
.project-metadata { display: flex; flex-direction: column; gap: 12px; overflow-wrap: anywhere; }
.project-metadata a { color: $accent-primary; }
.project-metadata .actions a { display: inline-flex; align-items: center; gap: 4px; line-height: 1.5; }
.development-path { overflow-wrap: anywhere; }
.view-list { display: flex; flex-direction: column; gap: 8px; }
.view-link { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; line-height: 1.5; border-bottom: 1px solid $border-color; text-decoration: none; color: $text-primary; }
.operation-list { display: flex; flex-direction: column; gap: 12px; }
.operation-list strong { display: block; color: $text-primary; font-weight: 500; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow: auto; font-size: 12px; }
@media (max-width: 900px) {
  .developer-banner { flex-wrap: wrap; }
  .developer-links { flex-basis: 100%; margin-inline-start: 40px; }
  .plugin-card { grid-template-columns: 44px minmax(0, 1fr); gap: 12px 16px; }
  .card-icon { width: 44px; height: 44px; }
  .card-footer { grid-column: 2; flex-direction: row; align-items: center; justify-content: space-between; flex-wrap: wrap; max-width: none; }
  .card-footer > .actions { justify-content: flex-start; }
}
@media (max-width: 600px) {
  .center-scroll { padding: 0 16px; }
  .center-content { padding: 16px 0; gap: 16px; }
  .developer-banner { padding: 16px; gap: 12px; }
  .developer-links { margin-inline-start: 0; gap: 10px 16px; }
  .developer-copy h1 { font-size: 14px; }
  .catalog-heading { gap: 12px; flex-wrap: wrap; }
  .catalog-scopes { flex-basis: 220px; }
  .catalog-actions { margin-inline-start: auto; flex-wrap: wrap; }
  .plugin-card { padding: 16px; }
  .card-footer { grid-column: 1 / -1; }
  .catalog-toolbar { align-items: flex-start; flex-direction: column; }
  .category-tabs { gap: 2px; }
  .category-tabs button { padding: 6px 8px; }
  .search-row { flex-wrap: wrap; }
  .state-filter { flex-basis: 100%; }
}
</style>
