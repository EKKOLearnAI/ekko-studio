<script setup lang="ts">
defineProps<{
  label: string
  hint?: string
}>()
</script>

<template>
  <div class="setting-row">
    <div class="setting-info">
      <label class="setting-label">{{ label }}</label>
      <p v-if="hint" class="setting-hint">{{ hint }}</p>
    </div>
    <div class="setting-control">
      <slot />
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: calc(10px * var(--spacing-scale, 1)) 0;
  border-bottom: var(--border-width, 1px) solid $border-light;

  &:last-child {
    border-bottom: none;
  }
}

.setting-info {
  flex: 1;
  margin-inline-end: 16px;
}

.setting-label {
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  color: $text-primary;
  display: block;
}

.setting-hint {
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  color: $text-muted;
  margin-top: 2px;
}

.setting-control {
  flex-shrink: 0;
}

@media (max-width: $breakpoint-mobile) {
  .setting-row {
    flex-direction: column;
    align-items: flex-start;
    gap: calc(8px * var(--spacing-scale, 1));
  }

  .setting-info {
    margin-inline-end: 0;
  }

  .setting-control {
    width: 100%;
  }
}
</style>
