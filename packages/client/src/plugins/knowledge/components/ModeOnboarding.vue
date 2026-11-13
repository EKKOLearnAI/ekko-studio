<script setup lang="ts">
/**
 * First-run mode picker. Skippable — skipping persists the default
 * (tasks) mode and never shows this screen again.
 */
import { useI18n } from 'vue-i18n'
import { NButton } from 'naive-ui'
import { KNOWLEDGE_MODES, type KnowledgeMode } from '../modes'

const emit = defineEmits<{
  (e: 'select', mode: KnowledgeMode): void
  (e: 'skip'): void
}>()

const { t } = useI18n()
</script>

<template>
  <div class="mode-onboarding">
    <h2 class="onboarding-title">{{ t('knowledge.onboarding.title') }}</h2>
    <p class="onboarding-subtitle">{{ t('knowledge.onboarding.subtitle') }}</p>

    <div class="mode-grid">
      <button
        v-for="m in KNOWLEDGE_MODES"
        :key="m.id"
        type="button"
        class="mode-card"
        @click="emit('select', m.id)"
      >
        <svg class="mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path :d="m.iconPath" />
        </svg>
        <span class="mode-label">{{ t(`knowledge.modes.${m.id}.label`) }}</span>
        <span class="mode-desc">{{ t(`knowledge.modes.${m.id}.desc`) }}</span>
      </button>
    </div>

    <NButton quaternary size="small" class="skip-button" @click="emit('skip')">
      {{ t('knowledge.onboarding.skip') }}
    </NButton>
  </div>
</template>

<style scoped>
.mode-onboarding {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px 24px;
}
.onboarding-title {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
}
.onboarding-subtitle {
  margin: 0 0 24px;
  opacity: 0.65;
  font-size: 13px;
  text-align: center;
  max-width: 480px;
}
.mode-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  width: 100%;
  max-width: 860px;
}
.mode-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 20px 16px;
  border: 1px solid var(--border-color, rgba(var(--text-primary-rgb), 0.08));
  border-radius: 10px;
  background: var(--card-color, rgba(var(--text-primary-rgb), 0.02));
  color: inherit;
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s ease, transform 0.15s ease, background 0.15s ease;
}
.mode-card:hover {
  border-color: var(--primary-color, var(--success));
  transform: translateY(-2px);
  background: var(--hover-color, rgba(var(--text-primary-rgb), 0.05));
}
.mode-icon {
  width: 26px;
  height: 26px;
  opacity: 0.85;
}
.mode-label {
  font-size: 15px;
  font-weight: 600;
}
.mode-desc {
  font-size: 12px;
  opacity: 0.6;
  line-height: 1.5;
}
.skip-button {
  margin-top: 20px;
  opacity: 0.7;
}
</style>
