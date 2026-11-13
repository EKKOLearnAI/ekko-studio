<script setup lang="ts">
import type { SkillTarget } from '@/api/hermes/skills'
import SkillsView from '@/views/hermes/SkillsView.vue'

defineProps<{
  target: SkillTarget
}>()
</script>

<template>
  <SkillsView :target="target" embedded />
</template>
