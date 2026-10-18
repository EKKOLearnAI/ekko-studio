<script setup lang="ts">
defineProps<{ open?: boolean }>()
</script>

<template>
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <template v-if="open">
      <path d="M3 12V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v3" />
      <path d="M3 12h18l-3 8H5l-2-8Z" />
    </template>
    <path v-else d="M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z" />
  </svg>
</template>
