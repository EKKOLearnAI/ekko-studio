<script setup lang="ts">
import type { ResourceSkillsAdapter } from '@/utils/agent-resource-skills'
import type { SkillTarget } from '@/api/hermes/skills'
import SkillsView from '@/views/hermes/SkillsView.vue'

defineProps<{
  target: SkillTarget
  resourceAdapter?: ResourceSkillsAdapter
}>()
</script>

<template>
  <SkillsView :target="target" :resource-adapter="resourceAdapter" embedded />
</template>
