<script setup lang="ts">
defineProps<{
  href: string
  label: string
}>()
</script>

<template>
  <div class="history-archive-link-wrap">
    <a class="history-archive-link" :href="href">{{ label }}</a>
  </div>
</template>

<style scoped lang="scss">
.history-archive-link-wrap {
  display: flex;
  justify-content: center;
  padding-bottom: calc(8px * var(--spacing-scale, 1));
}

.history-archive-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  max-width: 100%;
  min-height: 28px;
  padding: calc(5px * var(--spacing-scale, 1)) calc(10px * var(--spacing-scale, 1));
  border: var(--border-width, 1px) solid rgba(var(--accent-primary-rgb), 0.22);
  border-radius: 999px;
  background: rgba(var(--accent-primary-rgb), 0.08);
  color: var(--accent-primary);
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  font-weight: 600;
  line-height: var(--line-height, 1.3);
  text-align: center;
  text-decoration: none;
  white-space: normal;
}

.history-archive-link:hover {
  background: rgba(var(--accent-primary-rgb), 0.14);
}
</style>
