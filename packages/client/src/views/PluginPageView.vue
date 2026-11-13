<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NEmpty, NSpin } from 'naive-ui'
import { pluginPages, usePluginCatalog } from '@/composables/usePluginCatalog'
import PageHeader from '@/components/layout/PageHeader.vue'
import PluginFrame from '@/components/plugins/PluginFrame.vue'
import RouteLinkItem from '@/components/common/RouteLinkItem.vue'

const route = useRoute(), router = useRouter(), { t } = useI18n()
const { profile, snapshot, loading, error, refresh } = usePluginCatalog()
const plugin = computed(() => snapshot.value.plugins.find(item => item.manifest.id === route.params.pluginId))
const agentSettings = computed(() => route.name === 'studio.pluginAgentSettings')
const pages = computed(() => plugin.value ? pluginPages(plugin.value).filter(view => agentSettings.value ? view.slot === 'agent-settings' : route.name === 'studio.pluginSettings' ? view.slot === 'settings' : ['page', 'workspace'].includes(view.slot)) : [])
const view = computed(() => route.params.viewId ? pages.value.find(item => item.id === route.params.viewId) : pages.value[0])
const available = computed(() => plugin.value?.status === 'active' && Boolean(view.value))
</script>

<template>
  <main class="plugin-workspace">
    <PageHeader>
      <header class="page-header workspace-header">
        <div class="workspace-heading">
          <RouteLinkItem :to="{ name: agentSettings ? 'hermes.agentManager' : 'studio.plugins' }" class="back-link">{{ t(agentSettings ? 'sidebar.agentManager' : 'studioPlugins.title') }}</RouteLinkItem>
          <span aria-hidden="true">/</span><h2>{{ plugin?.manifest.name || t('studioPlugins.workspace') }}</h2>
        </div>
        <NButton v-if="plugin" size="small" @click="router.push({ name: 'studio.plugins', query: { manage: plugin.manifest.id } })">{{ t('studioPlugins.manage') }}</NButton>
      </header>
    </PageHeader>
    <div class="workspace-content">
    <NAlert v-if="error" type="error">{{ error }} <NButton text @click="refresh(true)">{{ t('mcp.refresh') }}</NButton></NAlert>
    <PluginFrame v-if="available && plugin && view" :key="`${profile}/${plugin.manifest.id}/${view.id}`" :plugin="plugin" :profile="profile" :view="view.id" :slot="view.slot" expanded />
    <div v-else class="workspace-empty">
      <NSpin v-if="loading" />
      <NEmpty v-else :description="t(plugin?.status === 'disabled' ? 'studioPlugins.pageDisabled' : 'studioPlugins.pageUnavailable')">
        <template #extra><NButton @click="router.push({ name: 'studio.plugins' })">{{ t('studioPlugins.backToCenter') }}</NButton></template>
      </NEmpty>
    </div>
    </div>
  </main>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.plugin-workspace { display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; min-width: 0; overflow: hidden; color: $text-primary; }
.workspace-content { display: flex; flex-direction: column; flex: 1; gap: 16px; padding: 20px; min-height: 0; overflow-y: auto; }
.workspace-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; min-width: 0; }
.workspace-heading { display: flex; align-items: center; gap: 12px; min-width: 0; color: $text-muted; }
.workspace-heading h2 { font-size: 16px; color: $text-primary; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin: 0; }
.back-link { color: $text-secondary; text-decoration: none; white-space: nowrap; }
.back-link:hover { color: $text-primary; }
.workspace-empty { flex: 1; display: grid; place-items: center; }
@media (max-width: 600px) { .workspace-content { padding: 12px; gap: 12px; } .workspace-heading { gap: 8px; } }
</style>
