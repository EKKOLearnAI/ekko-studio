<script setup lang="ts">
defineProps<{ kind?: 'file' | 'folder' | 'open' | 'close' | 'link' }>()
</script>
<template>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path v-if="kind === 'folder'" d="M3 7h7l2 2h9v11H3V7Zm0 0V4h7l2 3h7v2" />
    <path v-else-if="kind === 'open'" d="M14 3h7v7m0-7L10 14m0-10H4v16h16v-6" />
    <path v-else-if="kind === 'close'" d="m6 6 12 12M6 18 18 6" />
    <path v-else-if="kind === 'link'" d="m10 13 4-2m-5 5H7a4 4 0 0 1 0-8h3m4 0h3a4 4 0 0 1 0 8h-3" />
    <path v-else d="M5 3h9l5 5v13H5V3Zm9 0v6h5M8 13h8m-8 4h6" />
  </svg>
</template>
