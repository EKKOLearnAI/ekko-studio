<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/hermes/app'
import type { AvailableModelGroup } from '@/api/hermes/system'
import type { ProviderApiMode } from '@/api/studio/provider-api-mode'
import ModelCascader from '@/components/hermes/models/ModelCascader.vue'

const props = defineProps<{
  provider: string
  model: string
  groups: AvailableModelGroup[]
  disabled?: boolean
}>()

const emit = defineEmits<{
  select: [value: { provider: string; model: string; apiMode?: ProviderApiMode }]
}>()

const { t } = useI18n()
const appStore = useAppStore()

const groupsWithCustom = computed(() =>
  props.groups.map(group => ({
    ...group,
    models: [...new Set([
      ...group.models,
      ...(appStore.customModels[group.provider] || []),
      ...(group.provider === props.provider && props.model ? [props.model] : []),
    ])],
  })),
)

const selectedGroup = computed(() =>
  groupsWithCustom.value.find(group => group.provider === props.provider && group.models.includes(props.model)),
)

const selectedDisplayName = computed(() => {
  if (!props.model) return ''
  return selectedGroup.value
    ? appStore.displayModelName(props.model, props.provider)
    : props.model
})

function handleSelect(selection: { provider: string; model: string; apiMode?: ProviderApiMode }) {
  emit('select', selection)
}
</script>

<template>
  <div class="workflow-model-selector">
    <ModelCascader
      :groups="groupsWithCustom"
      :provider="props.provider"
      :model="props.model"
      :disabled="props.disabled"
      @select="handleSelect"
    >
      <template #trigger="{ show, open, openWithKeyboard }">
        <button class="model-trigger" type="button" :disabled="props.disabled" aria-haspopup="dialog" :aria-expanded="show" @click="open" @keydown.down="openWithKeyboard">
          <span class="model-name" :title="props.model">{{ selectedDisplayName || t('models.selectModel') }}</span>
          <svg class="model-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </template>
    </ModelCascader>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.workflow-model-selector {
  min-width: 0;
}

.model-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  background: $bg-input;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  color: $text-primary;
  font-size: 13px;
  cursor: pointer;
  transition: border-color $transition-fast;

  &:hover {
    border-color: $accent-muted;
  }

  &:focus-visible {
    outline: 2px solid $accent-primary;
    outline-offset: 2px;
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
}

.model-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: start;
}

.model-arrow {
  flex-shrink: 0;
  color: $text-muted;
}
</style>
