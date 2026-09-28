<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton } from 'naive-ui'
import DshNativePluginsPanel from './DshNativePluginsPanel.vue'
import DshPluginSettingsPanel from './DshPluginSettingsPanel.vue'
const { t } = useI18n()
const tab = ref('configuration')
const visitedList = ref(false)
const configurationStale = ref(false)
const tabsElement = ref<HTMLElement>()
function select(value: string) {
  tab.value = value
  if (value === 'list') visitedList.value = true
  else if (configurationStale.value) { configurationStale.value = false; void settings.value?.refresh() }
}
function keydown(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  select(event.key === 'Home' ? 'configuration' : event.key === 'End' ? 'list' : tab.value === 'list' ? 'configuration' : 'list')
  tabsElement.value?.querySelector<HTMLButtonElement>(`[data-tab="${tab.value}"]`)?.focus()
}
const list = ref<InstanceType<typeof DshNativePluginsPanel>>()
const settings = ref<InstanceType<typeof DshPluginSettingsPanel>>()
</script>
<template>
  <div class="plugins-view dsh-plugins" data-testid="dsh-plugins">
    <header class="page-header"><h2 class="header-title">{{ t('dshPlugins.title') }}</h2><NButton size="small" quaternary @click="tab === 'configuration' ? settings?.refresh() : list?.refresh()">{{ t('mcp.refresh') }}</NButton></header>
    <div class="plugins-content">
      <div ref="tabsElement" class="plugin-tabs" role="tablist" :aria-label="t('dshPlugins.title')" @keydown="keydown">
        <button id="dsh-config-tab" role="tab" data-tab="configuration" :aria-selected="tab === 'configuration'" aria-controls="dsh-config-panel" :tabindex="tab === 'configuration' ? 0 : -1" @click="select('configuration')">{{ t('dshPlugins.configurationTab') }}</button>
        <button id="dsh-list-tab" role="tab" data-tab="list" :aria-selected="tab === 'list'" aria-controls="dsh-list-panel" :tabindex="tab === 'list' ? 0 : -1" @click="select('list')">{{ t('dshPlugins.listTab') }}</button>
      </div>
      <div id="dsh-config-panel" v-show="tab === 'configuration'" role="tabpanel" aria-labelledby="dsh-config-tab"><DshPluginSettingsPanel ref="settings" /></div>
      <div id="dsh-list-panel" v-show="tab === 'list'" role="tabpanel" aria-labelledby="dsh-list-tab"><DshNativePluginsPanel v-if="visitedList" ref="list" @changed="configurationStale = true" /></div>
    </div>
  </div>
</template>
<style scoped lang="scss">
@use '@/styles/variables' as *;
@use '@/styles/plugins-page' as plugins-page;
@include plugins-page.layout(100%);
.dsh-plugins { min-height: 0; }
.plugins-content { display: flex; flex-direction: column; padding: 0; overflow: hidden; }
#dsh-config-panel, #dsh-list-panel { flex: 1; min-height: 0; min-width: 0; }
#dsh-config-panel { display: flex; overflow: hidden; }
#dsh-list-panel { padding: 20px; overflow: auto; }
.plugin-tabs { display: flex; flex-shrink: 0; gap: 24px; padding-inline: 20px; border-bottom: 1px solid $border-color; }
.plugin-tabs button { padding: 10px 0; border: 0; border-bottom: 2px solid transparent; background: transparent; color: $text-secondary; cursor: pointer; font: inherit; }
.plugin-tabs button[aria-selected="true"] { color: $accent-primary; border-bottom-color: $accent-primary; }
.plugin-tabs button:focus-visible { outline: 2px solid $accent-primary; outline-offset: 3px; }
</style>
