<script setup lang="ts">
import { computed, shallowRef, onBeforeUnmount } from 'vue'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { pluginCatalog, type InstalledPlugin, type Json } from '@/api/studio/plugins'
import PluginFrame from './PluginFrame.vue'
const props = defineProps<{ slot: 'sidebar' | 'message' | 'settings'; sessionId?: string; profile?: string; data?: Json }>()
const profiles = useProfilesStore()
const profile = computed(() => props.profile || profiles.activeProfileName || 'default')
const plugins = shallowRef<InstalledPlugin[]>([])
let alive = true, generation = 0
async function refresh() {
  const current = ++generation
  try { const result = await pluginCatalog(); if (alive && generation === current) plugins.value = result.plugins.filter(p => p.status === 'active') }
  catch { if (alive && generation === current) plugins.value = [] }
}
void refresh()
window.addEventListener('studio.plugins.changed', refresh)
onBeforeUnmount(() => { alive = false; window.removeEventListener('studio.plugins.changed', refresh) })
const views = computed(() => plugins.value.flatMap(plugin => (plugin.manifest.views || []).filter(view => view.slot === props.slot).map(view => ({ plugin, view }))))
</script>
<template>
  <div v-if="views.length" class="plugin-slots">
    <PluginFrame v-for="entry in views" :key="`${entry.plugin.manifest.id}:${entry.view.id}`" :plugin="entry.plugin" :profile="profile" :view="entry.view.id" :slot="slot" :session-id="sessionId" :data="data" />
  </div>
</template>
<style scoped>.plugin-slots { display: grid; gap: 12px; min-width: 0; }</style>
