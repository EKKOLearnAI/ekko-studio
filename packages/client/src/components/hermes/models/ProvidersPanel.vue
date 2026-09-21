<script setup lang="ts">
import ProviderCard from './ProviderCard.vue'
import { useModelsStore } from '@/stores/hermes/models'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const modelsStore = useModelsStore()
</script>

<template>
  <div v-if="modelsStore.providers.length === 0" class="empty-state">
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" class="empty-icon">
      <path d="M12 2L2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </svg>
    <p>{{ t('models.noProviders') }}</p>
  </div>
  <div v-else class="providers-grid">
    <ProviderCard
      v-for="g in modelsStore.providers"
      :key="g.provider"
      :provider="g"
    />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: $text-muted;
  gap: 12px;

  .empty-icon {
    opacity: 0.3;
  }

  p {
    font-size: 14px;
  }
}

.providers-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr));
  gap: 14px;
}
</style>
