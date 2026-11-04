<script setup lang="ts">
withDefaults(defineProps<{
  name?: 'tasks' | 'search' | 'chevron-down' | 'arrow-up' | 'arrow-down' | 'open' | 'circle' | 'completed' | 'closed'
  size?: number
}>(), { name: 'tasks', size: 18 })
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <template v-if="name === 'tasks'">
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 12h6M9 16h6" />
    </template>
    <template v-else-if="name === 'search'"><circle cx="10.5" cy="10.5" r="7" /><path d="m16 16 4 4" /></template>
    <path v-else-if="name === 'chevron-down'" d="m6 9 6 6 6-6" />
    <path v-else-if="name === 'arrow-up'" d="M12 19V5m-6 6 6-6 6 6" />
    <path v-else-if="name === 'arrow-down'" d="M12 5v14m-6-6 6 6 6-6" />
    <path v-else-if="name === 'open'" d="M7 17 17 7M7 7h10v10" />
    <template v-else><circle cx="12" cy="12" r="9" /><path v-if="name === 'completed'" d="m8 12 3 3 5-6" /><path v-else-if="name === 'closed'" d="m9 9 6 6m0-6-6 6" /></template>
  </svg>
</template>
