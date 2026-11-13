<script setup lang="ts">
import WebPet from '@/components/hermes/pets/WebPet.vue'
</script>

<template>
  <main class="desktop-pet-view">
    <WebPet desktop-window />
  </main>
</template>

<style scoped lang="scss">
:global(html.hermes-desktop-pet-window),
:global(html.hermes-desktop-pet-window body),
:global(html.hermes-desktop-pet-window #app) {
  background: transparent !important;
  background-color: transparent !important;
  border: 0 !important;
  box-shadow: none !important;
  outline: 0 !important;
}

.desktop-pet-view {
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: transparent !important;
  background-color: transparent !important;
  border: 0 !important;
  box-shadow: none !important;
  outline: 0 !important;
}
</style>
