<script setup lang="ts">
import ProfileCard from './ProfileCard.vue'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useI18n } from 'vue-i18n'

defineEmits<{ rename: [name: string] }>()

const { t } = useI18n()
const profilesStore = useProfilesStore()
</script>

<template>
  <div v-if="profilesStore.profiles.length === 0" class="empty-state">
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" class="empty-icon">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
    <p>{{ t('profiles.noProfiles') }}</p>
  </div>
  <div v-else class="profiles-grid">
    <ProfileCard
      v-for="p in profilesStore.profiles"
      :key="p.name"
      :profile="p"
      @rename="$emit('rename', $event)"
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
  gap: calc(12px * var(--spacing-scale, 1));

  .empty-icon {
    opacity: 0.3;
  }

  p {
    font-size: calc(var(--font-size-base, 14px) * 14 / 14);
  }
}

.profiles-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr));
  gap: calc(14px * var(--spacing-scale, 1));
}
</style>
