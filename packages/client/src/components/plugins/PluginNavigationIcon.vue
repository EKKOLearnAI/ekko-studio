<script setup lang="ts">
import { computed } from 'vue'
import { PLUGIN_ICON_PATHS, type PluginIconName } from '../../../../plugin-sdk/src'
import { pluginIcon } from '@/plugins/navigation'

const props = withDefaults(defineProps<{ icon: string; size?: number }>(), { size: 17 })
const path = computed(() => Object.hasOwn(PLUGIN_ICON_PATHS, props.icon) ? PLUGIN_ICON_PATHS[props.icon as PluginIconName] : undefined)
const source = computed(() => pluginIcon(props.icon))
</script>

<template>
  <svg v-if="path" class="plugin-navigation-icon" :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="path" /></svg>
  <img v-else-if="source" class="plugin-navigation-icon" :src="source" :width="size" :height="size" alt="" aria-hidden="true" />
</template>

<style scoped>
.plugin-navigation-icon { flex-shrink: 0; object-fit: contain; }
</style>
