<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'

defineProps<{
  src: string
  alt: string
}>()

const emit = defineEmits<{
  close: []
}>()

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', handleKeydown))
onUnmounted(() => window.removeEventListener('keydown', handleKeydown))
</script>

<template>
  <Teleport to="body">
    <div
      class="image-preview-overlay"
      role="dialog"
      aria-modal="true"
      :aria-label="alt"
      @click.self="emit('close')"
    >
      <img :src="src" :alt="alt" class="image-preview-img" @click="emit('close')" />
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
.image-preview-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 5vh 5vw;
  background: rgba(0, 0, 0, 0.85);
  cursor: zoom-out;
}

.image-preview-img {
  display: block;
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
  border-radius: var(--radius-component, 6px);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
}
</style>
