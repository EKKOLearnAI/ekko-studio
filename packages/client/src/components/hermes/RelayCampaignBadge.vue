<script setup lang="ts">
import { useI18n } from 'vue-i18n'

defineProps<{ compact?: boolean }>()
const { t } = useI18n()
</script>

<template>
  <span class="relay-campaign-badge" :class="{ 'relay-campaign-badge--compact': compact }" :aria-hidden="compact ? true : undefined">
    <svg v-if="!compact" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="8" width="18" height="4" rx="1" />
      <path d="M5 12v8h14v-8M12 8v12M12 8H7.5A2.5 2.5 0 1 1 10 5.5L12 8Zm0 0h4.5A2.5 2.5 0 1 0 14 5.5L12 8Z" />
    </svg>
    {{ t(compact ? 'apiRelay.campaignBadge' : 'apiRelay.campaignLabel') }}
  </span>
</template>

<style scoped lang="scss">
.relay-campaign-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  gap: 6px;
  width: fit-content;
  padding: 5px 10px;
  /* theme-exception: artwork -- The campaign seal keeps its gold paper and dark ink across themes. */
  background: linear-gradient(110deg, #fff0b8, #edbf72);
  /* theme-exception: artwork -- Dark lettering on the gold campaign seal retains readable contrast. */
  color: #543212;
  /* theme-exception: artwork -- A gold rim defines the campaign seal independently of card opacity. */
  border: 1px solid #f4d99a;
  border-radius: 999px;
  font-size: calc(var(--font-size-base, 14px) * 11 / 14);
  font-weight: 750;
  line-height: 1.3;
  white-space: nowrap;

  &--compact {
    gap: 0;
    padding: 1px 4px;
    border-radius: 4px;
    font-size: calc(var(--font-size-base, 14px) * 9 / 14);
    letter-spacing: -0.02em;
    line-height: 1.2;
  }
}
</style>
