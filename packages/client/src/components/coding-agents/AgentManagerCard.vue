<script setup lang="ts">
defineProps<{ name: string; logo: string; version?: string; description?: string }>()
</script>

<template>
  <section class="agent-card coding-agent-card" data-theme-surface="card">
    <header class="agent-card-header">
      <div class="agent-identity">
        <img :src="logo" alt="" class="agent-logo" />
        <div>
          <div class="agent-name-row">
            <h3>{{ name }}</h3>
            <slot name="badges" />
          </div>
          <p v-if="version" class="agent-version">{{ version }}</p>
          <p v-else-if="description">{{ description }}</p>
        </div>
      </div>
    </header>
    <div class="agent-actions"><slot name="actions" /></div>
    <slot />
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.agent-card {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: calc(15px * var(--spacing-scale, 1));
  padding: calc(18px * var(--spacing-scale, 1));
  border: var(--border-width, 1px) solid $border-color;
  border-radius: var(--radius-component, 14px);
  background: $bg-card;
  color: $text-primary;
  box-shadow: 0 5px 18px rgba(var(--text-primary-rgb), 0.05);
}

.agent-card-header { display: flex; align-items: center; }
.agent-identity {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: calc(12px * var(--spacing-scale, 1));

  h3 { margin: 0; font-size: calc(var(--font-size-base, 14px) * 17 / 14); }
  p {
    max-width: 720px;
    margin: 5px 0 0;
    color: $text-secondary;
    font-size: calc(var(--font-size-base, 14px) * 12 / 14);
    line-height: var(--line-height, 1.55);
  }
  .agent-version {
    color: $text-primary;
    font-size: calc(var(--font-size-base, 14px) * 13 / 14);
    font-weight: 650;
    letter-spacing: 0.01em;
  }
}
.agent-name-row { display: flex; align-items: center; flex-wrap: wrap; gap: calc(8px * var(--spacing-scale, 1)); }
.agent-logo {
  width: 42px;
  height: 42px;
  flex: 0 0 auto;
  padding: calc(4px * var(--spacing-scale, 1));
  border: var(--border-width, 1px) solid $border-color;
  border-radius: var(--radius-component, 11px);
  /* theme-exception: artwork -- A light backplate preserves the existing Agent logos in both brightness presets. */
  background: rgba(255, 255, 255, 0.92);
  object-fit: contain;
}
.agent-actions { display: flex; align-items: center; flex-wrap: wrap; gap: calc(8px * var(--spacing-scale, 1)); margin-top: auto; }
</style>
