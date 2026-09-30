<script setup lang="ts">
import { useMobileNavigation } from '@/composables/usePageSidebar'

const navigation = useMobileNavigation()
</script>

<template>
  <Teleport :to="navigation?.target.value || 'body'" :disabled="!navigation?.target.value">
    <slot />
  </Teleport>
</template>
