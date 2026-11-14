<script setup lang="ts">
import type { NavigationEntry } from '@/utils/navigation-entries'
import { deploymentUrl } from '@/utils/deployment-url'
import PluginNavigationIcon from '@/components/plugins/PluginNavigationIcon.vue'
import PluginSymbol from '@/components/common/PluginIcon.vue'
withDefaults(defineProps<{ entry: NavigationEntry; size?: number }>(), { size: 22 })
</script>

<template>
  <PluginSymbol v-if="entry.id === 'studioPlugins'" :size="size" />
  <PluginNavigationIcon v-else-if="entry.icon" :icon="entry.icon" :size="size" />
  <img v-else-if="entry.avatar" class="navigation-entry-avatar" :src="deploymentUrl(entry.avatar)" :width="entry.id === 'person' ? size + 8 : size" :height="entry.id === 'person' ? size + 8 : size" alt="" aria-hidden="true" />
  <svg v-else :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="entry.path" /></svg>
</template>

<style scoped lang="scss">
.navigation-entry-avatar { aspect-ratio: 1; flex-shrink: 0; border-radius: var(--radius-component, 4px); object-fit: contain; }
</style>
