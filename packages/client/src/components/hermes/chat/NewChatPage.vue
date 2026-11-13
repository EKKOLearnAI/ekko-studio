<script setup lang="ts">
defineProps<{ title: string; subtitle: string }>()
</script>

<template>
  <section class="new-chat-page" :aria-label="title">
    <div class="new-chat-intro"><h1>{{ title }}</h1><p>{{ subtitle }}</p></div>
    <slot name="cards" />
    <div class="new-chat-compose"><slot /></div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.new-chat-page {
  flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column;
  justify-content: center; padding: clamp(12px, 2vh, 24px) 0;
}
.new-chat-intro {
  flex: none; text-align: center; padding: 0 calc(20px * var(--spacing-scale, 1));
  h1 { margin: 0 0 8px; font-size: clamp(22px, 2.4vw, 30px); font-weight: 600; letter-spacing: -.6px; }
  p { margin: 0; color: $text-secondary; font-size: calc(var(--font-size-base, 14px) * 13 / 14); }
}
.new-chat-page > :deep(.agent-cards) {
  flex: 1; min-height: 0; max-height: calc(176px * 1.4 + 84px); max-width: 1040px; margin: 8px auto 0;
}
.new-chat-compose { flex: none; width: min(760px, calc(100% - 48px)); margin: 12px auto 0; }
.new-chat-compose :deep(.chat-input-area) { padding: 0; border-top: 0; background: transparent; }
@media (max-width: $breakpoint-mobile) {
  .new-chat-page { justify-content: flex-start; padding: calc(16px * var(--spacing-scale, 1)) 0; }
  .new-chat-intro {
    margin-top: auto; padding: 0 calc(24px * var(--spacing-scale, 1));
    h1 { margin-bottom: 6px; font-size: clamp(19px, 5.1vw, 24px); line-height: var(--line-height, 1.35); }
    p { font-size: calc(var(--font-size-base, 14px) * 12 / 14); line-height: var(--line-height, 1.5); }
  }
  .new-chat-page > :deep(.agent-cards) { flex: none; max-height: none; }
  .new-chat-compose { width: calc(100% - 32px); margin-top: 8px; margin-bottom: auto; }
}
@media (max-width: $breakpoint-mobile) and (max-height: 640px) {
  .new-chat-page { padding: calc(8px * var(--spacing-scale, 1)) 0; }
}
</style>
