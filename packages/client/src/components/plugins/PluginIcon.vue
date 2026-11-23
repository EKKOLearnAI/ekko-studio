<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { pluginIcon, safePluginLink } from '@/plugins/navigation'
const props = defineProps<{ plugin: { manifest: { name: string; icon?: string } }; compact?: boolean; icon?: string; iconUrl?: string; title?: string }>()
const failed = ref(false)
const source = computed(() => pluginIcon(props.icon || props.plugin.manifest.icon) || pluginIcon(props.iconUrl) || safePluginLink(props.iconUrl))
watch(source, () => { failed.value = false })
</script>

<template>
  <span class="plugin-icon" :class="{ compact }" aria-hidden="true"><img v-if="source && !failed" :src="source" alt="" crossorigin="anonymous" referrerpolicy="no-referrer" loading="lazy" @error="failed = true" /><template v-else>{{ Array.from((title || plugin.manifest.name).trim())[0]?.toLocaleUpperCase() || '+' }}</template></span>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.plugin-icon { display: inline-grid; place-items: center; flex-shrink: 0; width: 52px; height: 52px; border: 1px solid $border-color; border-radius: $radius-md; color: $text-primary; font-size: 24px; font-weight: 600; }
.compact { width: 28px; height: 28px; border: 0; font-size: 17px; }
.plugin-icon img { width: 100%; height: 100%; object-fit: contain; border-radius: inherit; }
</style>
