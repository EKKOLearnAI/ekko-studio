<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NCheckbox, NEmpty, NInput, NSelect, NTag, NDrawer, NDrawerContent, NModal, NTabs, NTabPane, NSpin, useDialog, useMessage } from 'naive-ui'
import { isStoredSuperAdmin } from '@/api/client'
import { pluginRequest, pluginInvoke, type InstalledPlugin, type Json } from '@/api/studio/plugins'
import { pluginPages, pluginPageLocation, usePluginCatalog } from '@/composables/usePluginCatalog'
import PageHeader from '@/components/layout/PageHeader.vue'
import PluginIcon from '@/components/plugins/PluginIcon.vue'
import PluginConfigFields from '@/components/plugins/PluginConfigFields.vue'
import RouteLinkItem from '@/components/common/RouteLinkItem.vue'
import { pluginLinks, safePluginLink } from '@/plugins/navigation'

const { t } = useI18n(), dialog = useDialog(), message = useMessage(), router = useRouter(), route = useRoute()
const { profile, snapshot, loading, error, refresh } = usePluginCatalog()
const busy = ref(false), actionError = ref(''), source = ref(''), trusted = ref(false), showInstall = ref(false)
const search = ref(''), category = ref('all'), state = ref('all')
const selectedId = ref(''), detailTab = ref('overview')
const configs = ref<Record<string, Record<string, Json>>>({}), sources = ref<Record<string, string>>({})
const configValid = ref<Record<string, boolean>>({})
const configDirty = ref<Record<string, boolean>>({}), configRevisions = ref<Record<string, number>>({})
const selections = ref<Record<string, string>>({}), argumentsText = ref<Record<string, string>>({}), outputs = ref<Record<string, string>>({})
const canManage = computed(isStoredSuperAdmin)
const selected = computed(() => snapshot.value.plugins.find(plugin => plugin.manifest.id === selectedId.value))
const activeCount = computed(() => snapshot.value.plugins.filter(plugin => plugin.status === 'active').length)
const categories = ['all', 'pages', 'chat', 'tools', 'automation'] as const
function matchesCategory(plugin: InstalledPlugin, value: string) {
  if (value === 'pages') return pluginPages(plugin).length > 0
  if (value === 'chat') return plugin.commands.length > 0
  if (value === 'tools') return plugin.tools.length > 0 || plugin.manifest.capabilities.includes('tools')
  if (value === 'automation') return plugin.actions.length > 0 || plugin.manifest.capabilities.includes('automation')
  return true
}
const filtered = computed(() => snapshot.value.plugins.filter(plugin => {
  const query = search.value.trim().toLocaleLowerCase()
  return matchesCategory(plugin, category.value) && (state.value === 'all' || plugin.status === state.value)
    && (!query || [plugin.manifest.name, plugin.manifest.id, plugin.manifest.description || '', plugin.manifest.author?.name || '', ...(plugin.manifest.keywords || [])].some(value => value.toLocaleLowerCase().includes(query)))
}))
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
async function reloadCatalog() { await refresh(true); configDirty.value = {}; actionError.value = ''; syncDrafts() }
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
    await refresh(true)
    return true
  } catch (cause) {
    if (bound === profile.value) actionError.value = cause instanceof Error ? cause.message : String(cause)
    await refresh(true)
    return false
  } finally { busy.value = false }
}
async function install(id?: string) {
  const success = await perform(() => pluginRequest(undefined, '/install', { source: id ? sources.value[id] : source.value, pluginId: id, revision: snapshot.value.revision, trusted: trusted.value }))
  if (success && !id) { showInstall.value = false; source.value = ''; trusted.value = false }
}
async function update(plugin: InstalledPlugin, input: object) {
  const revision = 'config' in input ? configRevisions.value[plugin.manifest.id] : snapshot.value.revision
  const success = await perform(() => pluginRequest(undefined, '/' + plugin.manifest.id, { ...input, revision }, 'PATCH'))
  if (success) { configDirty.value[plugin.manifest.id] = false; syncDrafts() }
  return success
}
function uninstall(plugin: InstalledPlugin) {
  dialog.warning({ title: t('studioPlugins.uninstall'), content: t('studioPlugins.uninstallConfirm', { name: plugin.manifest.name }), positiveText: t('common.confirm'), negativeText: t('common.cancel'), onPositiveClick: async () => {
    if (await update(plugin, { action: 'uninstall' })) { delete configs.value[plugin.manifest.id]; delete sources.value[plugin.manifest.id]; closeDetails() }
  } })
}
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
    <PageHeader><div class="center-header"><h2>{{ t('studioPlugins.title') }}</h2><NButton quaternary size="small" :loading="loading" @click="reloadCatalog">{{ t('mcp.refresh') }}</NButton></div></PageHeader>
    <div class="center-content">
      <header class="center-intro">
        <div>
          <span class="eyebrow">{{ t('studioPlugins.globalScope') }}</span>
          <h1>{{ t('studioPlugins.hero') }}</h1>
          <p>{{ t('studioPlugins.description') }}</p>
        </div>
        <NButton v-if="canManage" type="primary" size="large" @click="showInstall = true">{{ t('studioPlugins.installTitle') }}</NButton>
      </header>
      <NAlert v-if="error || actionError" type="error" closable @close="error = ''; actionError = ''">{{ actionError || error }}</NAlert>
      <div class="search-row">
        <NInput v-model:value="search" clearable size="large" :placeholder="t('studioPlugins.search')" :aria-label="t('studioPlugins.search')">
          <template #prefix><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg></template>
        </NInput>
        <NSelect v-model:value="state" class="state-filter" :options="stateOptions" :aria-label="t('studioPlugins.allStates')" />
      </div>
      <div class="catalog-toolbar">
        <nav class="category-tabs" :aria-label="t('studioPlugins.categories')">
          <button v-for="item in categories" :key="item" type="button" :class="{ selected: category === item }" :aria-pressed="category === item" @click="category = item">
            {{ t('studioPlugins.' + item) }}<span>{{ snapshot.plugins.filter(plugin => matchesCategory(plugin, item)).length }}</span>
          </button>
        </nav>
        <span class="catalog-count">{{ t('studioPlugins.activeCount', { count: activeCount }) }}</span>
      </div>
      <div v-if="loading && !snapshot.plugins.length" class="catalog-empty"><NSpin /></div>
      <div v-else-if="!filtered.length" class="catalog-empty"><NEmpty :description="t(snapshot.plugins.length ? 'studioPlugins.noResults' : 'studioPlugins.empty')" /></div>
      <div v-else class="plugin-grid">
        <article v-for="plugin in filtered" :key="plugin.manifest.id" class="plugin-card" data-theme-surface="card">
          <div class="card-top"><PluginIcon :plugin="plugin" /><span class="status" :class="{ running: plugin.status === 'active' }"><i aria-hidden="true" />{{ t('studioPlugins.' + plugin.status) }}</span></div>
          <div class="card-copy">
            <button type="button" class="card-title" @click="details(plugin)">{{ plugin.manifest.name }}</button>
            <p>{{ plugin.manifest.description || plugin.manifest.id }}</p>
          </div>
          <div class="card-features"><span v-for="item in categories.slice(1).filter(value => matchesCategory(plugin, value))" :key="item">{{ t('studioPlugins.' + item) }}</span></div>
          <footer class="card-footer">
            <span class="version">v{{ plugin.manifest.version }}</span>
            <div class="actions">
              <NButton size="small" quaternary @click="details(plugin)">{{ t('studioPlugins.details') }}</NButton>
              <NButton v-if="plugin.status === 'active' && pluginPages(plugin).length" size="small" secondary @click="router.push(pluginPageLocation(plugin))">{{ t('studioPlugins.open') }} <span aria-hidden="true">&nbsp;↗</span></NButton>
              <NButton v-else-if="canManage && !plugin.enabled" size="small" secondary :disabled="busy" @click="update(plugin, { enabled: true })">{{ t('common.enable') }}</NButton>
            </div>
          </footer>
        </article>
      </div>
    </div>

    <NModal v-model:show="showInstall" preset="card" :title="t('studioPlugins.installTitle')" class="plugin-install-modal" style="width: min(540px, calc(100vw - 32px))">
      <div class="detail-stack">
        <p>{{ t('studioPlugins.installHint') }}</p>
        <NInput v-model:value="source" :placeholder="t('studioPlugins.source')" :aria-label="t('studioPlugins.source')" />
        <NCheckbox v-model:checked="trusted">{{ t('studioPlugins.trust') }}</NCheckbox>
        <NAlert v-if="actionError" type="error">{{ actionError }}</NAlert>
        <NButton type="primary" :disabled="!trusted || !source.trim() || busy" :loading="busy" @click="install()">{{ t('studioPlugins.install') }}</NButton>
      </div>
    </NModal>

    <NDrawer :show="Boolean(selected)" :width="'min(560px, 100vw)'" @update:show="value => { if (!value) closeDetails() }">
      <NDrawerContent v-if="selected" :title="selected.manifest.name" closable>
        <div class="detail-stack">
          <div class="detail-identity"><PluginIcon :plugin="selected" /><div class="identity-copy"><h3>{{ selected.manifest.name }}</h3><span class="eyebrow">{{ selected.manifest.id }} · v{{ selected.manifest.version }}</span></div><NTag size="small" :bordered="false">{{ t('studioPlugins.' + selected.status) }}</NTag></div>
          <p class="detail-description">{{ selected.manifest.description }}</p>
          <div class="actions">
            <NButton v-if="selected.status === 'active' && pluginPages(selected).length" type="primary" @click="router.push(pluginPageLocation(selected))">{{ t('studioPlugins.open') }}</NButton>
            <NButton v-if="canManage" :disabled="busy" @click="update(selected, { enabled: !selected.enabled })">{{ t(selected.enabled ? 'common.disable' : 'common.enable') }}</NButton>
          </div>
          <NAlert v-if="selected.error || actionError" type="error">{{ actionError || selected.error }}</NAlert>
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
                <template v-if="canManage && selected.manifest.configSchema">
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
                  <div class="actions">
                    <NButton :disabled="busy || !selected.enabled" @click="update(selected, { action: 'reload' })">{{ t('studioPlugins.reload') }}</NButton>
                    <NButton :disabled="busy || !selected.previousVersion" @click="update(selected, { action: 'rollback' })">{{ t('studioPlugins.rollback') }} {{ selected.previousVersion }}</NButton>
                    <NButton :disabled="busy" @click="logs(selected.manifest.id)">{{ t('studioPlugins.logs') }}</NButton>
                  </div>
                  <NInput v-model:value="sources[selected.manifest.id]" :placeholder="t('studioPlugins.source')" :aria-label="t('studioPlugins.source')" />
                  <NCheckbox v-model:checked="trusted">{{ t('studioPlugins.trust') }}</NCheckbox>
                  <NButton :disabled="!trusted || busy" @click="install(selected.manifest.id)">{{ t('studioPlugins.upgrade') }}</NButton>
                </template>
                <template v-if="selected.status === 'active' && operations(selected).length">
                  <h4>{{ t('studioPlugins.invoke') }}</h4>
                  <NSelect v-model:value="selections[selected.manifest.id]" :options="operations(selected)" />
                  <NInput v-model:value="argumentsText[selected.manifest.id]" type="textarea" :placeholder="t('studioPlugins.arguments')" />
                  <NButton :disabled="busy || !selections[selected.manifest.id]" @click="invoke(selected)">{{ t('studioPlugins.invoke') }}</NButton>
                </template>
                <pre v-if="outputs[selected.manifest.id]">{{ outputs[selected.manifest.id] }}</pre>
                <NButton v-if="canManage" :disabled="busy" type="error" secondary @click="uninstall(selected)">{{ t('studioPlugins.uninstall') }}</NButton>
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
.studio-plugins { width: 100%; min-width: 0; overflow: auto; color: $text-primary; padding: 24px; }
.center-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; width: 100%; }
.center-header h2 { margin: 0; font-size: 16px; }
.center-content { max-width: 1200px; margin: 0 auto; display: flex; flex-direction: column; gap: 24px; padding: 28px 8px; }
.center-intro { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding-bottom: 12px; }
.center-intro h1 { margin: 10px 0; font-size: clamp(24px, 3vw, 32px); font-weight: 650; letter-spacing: -.5px; line-height: 1.35; }
.eyebrow { color: $text-muted; font-size: 12px; }
p { margin: 0; color: $text-secondary; line-height: 1.7; }
.search-row { display: flex; gap: 12px; align-items: center; }
.state-filter { flex: 0 0 140px; }
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
.version { color: $text-muted; font-size: 12px; }
.actions, .capability-list { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.catalog-empty { display: grid; place-items: center; min-height: 280px; }
.detail-stack { display: flex; flex-direction: column; gap: 20px; }
.detail-stack h3, .detail-stack h4 { margin: 0; }
.detail-identity { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; }
.identity-copy { flex: 1; min-width: 120px; }
.detail-description { white-space: pre-line; }
.project-metadata { display: flex; flex-direction: column; gap: 12px; overflow-wrap: anywhere; }
.project-metadata a { color: $accent-primary; }
.view-list { display: flex; flex-direction: column; gap: 8px; }
.view-link { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid $border-color; text-decoration: none; color: $text-primary; }
.operation-list { display: flex; flex-direction: column; gap: 12px; }
.operation-list strong { display: block; color: $text-primary; font-weight: 500; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow: auto; font-size: 12px; }
@media (max-width: 600px) {
  .studio-plugins { padding: 16px; }
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
