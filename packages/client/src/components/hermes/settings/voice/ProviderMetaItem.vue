<script setup lang="ts">
defineProps<{
  label: string
  value?: string | number | null
}>()
</script>

<template>
  <div class="provider-meta-item">
    <dt>{{ label }}</dt>
    <dd :title="String(value || '—')">{{ value || '—' }}</dd>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.provider-meta-item {
  display: grid;
  grid-template-columns: 68px minmax(0, 1fr);
  align-items: baseline;
  gap: calc(8px * var(--spacing-scale, 1));
  min-width: 0;
}

dt {
  color: $text-muted;
  font-size: calc(var(--font-size-base, 14px) * 11 / 14);
  line-height: var(--line-height, 1.4);
  white-space: nowrap;
}

dd {
  min-width: 0;
  margin: 0;
  color: $text-secondary;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  line-height: var(--line-height, 1.45);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
