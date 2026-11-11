<script setup lang="ts">
import type { InstalledPlugin } from '@/api/studio/plugins'
import { pluginIcon } from '@/plugins/navigation'
defineProps<{ plugin: InstalledPlugin; compact?: boolean; icon?: string; title?: string }>()
</script>

<template>
  <span class="plugin-icon" :class="{ compact }" aria-hidden="true"><img v-if="pluginIcon(icon || plugin.manifest.icon)" :src="pluginIcon(icon || plugin.manifest.icon)" alt="" /><template v-else>{{ Array.from((title || plugin.manifest.name).trim())[0]?.toLocaleUpperCase() || '+' }}</template></span>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.plugin-icon { display: inline-grid; place-items: center; flex-shrink: 0; width: 52px; height: 52px; border: 1px solid $border-color; border-radius: $radius-md; color: $text-primary; font-size: 24px; font-weight: 600; }
.compact { width: 28px; height: 28px; border: 0; font-size: 17px; }
.plugin-icon img { width: 100%; height: 100%; object-fit: contain; border-radius: inherit; }
</style>
