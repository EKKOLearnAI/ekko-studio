<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 48 })
</script>

<template>
  <span class="studio-loading-logo" :style="{ '--studio-loading-size': `${size}px` }" aria-hidden="true">
    <img src="/logo.png" alt="" draggable="false" />
  </span>
</template>
