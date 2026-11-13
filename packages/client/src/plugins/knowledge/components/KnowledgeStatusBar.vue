<script setup lang="ts">
/**
 * Slim top bar shown in every mode: readiness dot, headline counts,
 * mode switcher and the settings entry point. Settings live behind the
 * gear after first configuration — the bar never grows into a card.
 */
import { computed, h } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NDropdown } from 'naive-ui'
import type { KnowledgeHealth, KnowledgeSettings } from '../api'
import { KNOWLEDGE_MODES, isKnowledgeMode, type KnowledgeMode } from '../modes'

const props = defineProps<{
  health: KnowledgeHealth | null
  settings: KnowledgeSettings | null
  mode: KnowledgeMode
}>()

const emit = defineEmits<{
  (e: 'set-mode', mode: KnowledgeMode): void
  (e: 'open-settings'): void
  (e: 'refresh'): void
}>()

const { t } = useI18n()

const readyState = computed<'ready' | 'needsKey' | 'disabled'>(() => {
  if (props.settings && props.settings.enabled === false) return 'disabled'
  if (props.settings && !props.settings.keyConfigured) return 'needsKey'
  return 'ready'
})

const modeOptions = computed(() =>
  KNOWLEDGE_MODES.map(m => ({
    label: t(`knowledge.modes.${m.id}.label`),
    key: m.id,
    // naive-ui DropdownOption has no `checked` prop — mark the active
    // mode with an icon render instead, or the menu shows no state.
    icon: m.id === props.mode
      ? () => h('span', { style: 'color: var(--primary-color, #63e2b7); font-weight: 700' }, '✓')
      : undefined,
  })),
)

const queueCount = computed(() => {
  const ing = props.health?.ingestion
  return (ing?.inFlight ?? 0) + (ing?.queued ?? 0)
})
</script>

<template>
  <div class="status-bar">
    <span class="state" :class="readyState">
      <span class="dot" />
      {{ t(`knowledge.statusBar.${readyState}`) }}
    </span>

    <span v-if="health" class="count">
      {{ t('knowledge.statusBar.documents', { n: health.documents.total }) }}
    </span>
    <span v-if="health && health.documents.indexed" class="count">
      {{ t('knowledge.statusBar.indexed', { n: health.documents.indexed }) }}
    </span>
    <span v-if="queueCount > 0" class="count busy">
      {{ t('knowledge.statusBar.queue', { n: queueCount }) }}
    </span>
    <span v-if="health && health.documents.failed" class="count bad">
      {{ t('knowledge.statusBar.failed', { n: health.documents.failed }) }}
    </span>

    <div class="spacer" />

    <NButton quaternary size="tiny" @click="emit('refresh')">
      {{ t('knowledge.actions.refresh') }}
    </NButton>

    <NDropdown
      :options="modeOptions"
      trigger="click"
      @select="(key: string) => { if (isKnowledgeMode(key)) emit('set-mode', key) }"
    >
      <NButton quaternary size="tiny">
        <template #icon>
          <svg class="mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path :d="KNOWLEDGE_MODES.find(m => m.id === mode)?.iconPath" />
          </svg>
        </template>
        {{ t(`knowledge.modes.${mode}.label`) }}
      </NButton>
    </NDropdown>

    <NButton
      quaternary
      circle
      size="tiny"
      :title="t('knowledge.statusBar.settings')"
      @click="emit('open-settings')"
    >
      <template #icon>
        <svg class="gear-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </template>
    </NButton>
  </div>
</template>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  border: 1px solid var(--border-color, rgba(var(--text-primary-rgb), 0.06));
  border-radius: 8px;
  background: var(--card-color, rgba(var(--text-primary-rgb), 0.02));
  font-size: 12px;
}
.state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--success);
}
.state.needsKey .dot { background: var(--warning); }
.state.disabled .dot { background: var(--warning); }
.count { opacity: 0.7; white-space: nowrap; }
.count.busy { color: var(--warning); opacity: 1; }
.count.bad { color: var(--warning); opacity: 1; }
.spacer { flex: 1; }
.mode-icon,
.gear-icon {
  width: 14px;
  height: 14px;
}
</style>
