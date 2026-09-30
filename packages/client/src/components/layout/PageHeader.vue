<script setup lang="ts">
import { usePageHeaderTarget } from '@/composables/usePageHeader'

defineProps<{ disabled?: boolean }>()

const target = usePageHeaderTarget()
</script>

<template>
  <!-- Keep the page-owned markup, state and handlers when moving between layouts. -->
  <Teleport :to="target || 'body'" :disabled="disabled || !target">
    <slot />
  </Teleport>
</template>
