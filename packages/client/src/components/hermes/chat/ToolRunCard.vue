<script setup lang="ts">
import type { Message } from '@/stores/hermes/chat'
import MessageItem from './MessageItem.vue'
import ToolRunSummary from './ToolRunSummary.vue'

defineProps<{
  runId: string
  tools: Message[]
}>()
</script>

<template>
  <ToolRunSummary :run-id="runId" :tools="tools">
    <div class="tool-run-items">
      <MessageItem v-for="tool in tools" :key="tool.id" :message="tool" />
    </div>
  </ToolRunSummary>
</template>

<style scoped lang="scss">
.tool-run-items {
  display: flex;
  flex-direction: column;
  gap: calc(2px * var(--spacing-scale, 1));
  margin-block-start: 4px;
  margin-inline-start: 11px;
  padding: calc(3px * var(--spacing-scale, 1)) calc(4px * var(--spacing-scale, 1)) calc(3px * var(--spacing-scale, 1)) calc(14px * var(--spacing-scale, 1));
  border-inline-start: var(--border-width, 1px) solid rgba(var(--text-primary-rgb), 0.12);
}

</style>
