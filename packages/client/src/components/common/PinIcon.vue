<script setup lang="ts">
defineProps<{ filled?: boolean }>()
</script>

<template>
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <g transform="rotate(35 12 12)">
      <path d="M9 3h6v6l3 4v2H6v-2l3-4V3Z" :fill="filled ? 'currentColor' : 'none'" />
      <path d="M12 15v6" />
    </g>
  </svg>
</template>
