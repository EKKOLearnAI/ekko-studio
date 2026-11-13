<script setup lang="ts">
import { computed } from 'vue'
import boring from 'boring-avatars-vanilla'
import type { ProfileAvatar } from '@/api/hermes/profiles'

const props = withDefaults(defineProps<{
  name: string
  avatar?: ProfileAvatar | null
  size?: number
}>(), {
  size: 24,
})

const fallbackSeed = computed(() => props.name || 'default')
const generatedSvg = computed(() => boring({
  name: props.avatar?.seed || fallbackSeed.value,
  variant: 'beam',
  size: props.size,
}))
const style = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
  flexBasis: `${props.size}px`,
}))
</script>

<template>
  <span class="profile-avatar-view" :style="style">
    <img
      v-if="avatar?.type === 'image' && avatar.dataUrl"
      class="profile-avatar-image"
      :src="avatar.dataUrl"
      alt=""
      draggable="false"
    >
    <span v-else class="profile-avatar-svg" v-html="generatedSvg" />
  </span>
</template>

<style scoped>
.profile-avatar-view {
  display: inline-flex;
  flex: 0 0 auto;
  border-radius: 50%;
  overflow: hidden;
  background: var(--bg-secondary);
}

.profile-avatar-image,
.profile-avatar-svg,
.profile-avatar-svg :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}

.profile-avatar-image {
  object-fit: cover;
}
</style>
