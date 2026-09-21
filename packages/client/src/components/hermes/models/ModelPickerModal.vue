<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NInput, NModal } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { AvailableModelGroup } from '@/api/hermes/system'
import type { ProviderApiMode } from '@/api/studio/provider-api-mode'
import { useCollapsedProviderGroups } from '@/composables/useCollapsedProviderGroups'
import { useAppStore } from '@/stores/hermes/app'

type ModelSelection = {
  provider: string
  model: string
}

const props = withDefaults(defineProps<{
  show: boolean
  groups: AvailableModelGroup[]
  title?: string
  selected?: ModelSelection[]
  closeOnSelect?: boolean
  disableSelected?: boolean
}>(), {
  title: '',
  selected: () => [],
  closeOnSelect: true,
  disableSelected: false,
})

const emit = defineEmits<{
  'update:show': [show: boolean]
  select: [value: ModelSelection & { apiMode?: ProviderApiMode }]
}>()

const { t } = useI18n()
const appStore = useAppStore()
const searchQuery = ref('')
const { isGroupCollapsed, toggleGroup } = useCollapsedProviderGroups()

const groupsWithCustom = computed(() => props.groups.map(group => ({
  ...group,
  models: [
    ...group.models,
    ...(appStore.customModels[group.provider] || []).filter(model => !group.models.includes(model)),
  ],
})))

const selectedKeys = computed(() => new Set(
  props.selected.map(selection => `${selection.provider}\u0000${selection.model}`),
))

const filteredGroups = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return groupsWithCustom.value
  return groupsWithCustom.value
    .map(group => ({
      ...group,
      models: group.models.filter(model => {
        const displayName = appStore.displayModelName(model, group.provider)
        return model.toLowerCase().includes(query) || displayName.toLowerCase().includes(query)
      }),
    }))
    .filter(group => group.models.length > 0 || String(group.label || group.provider).toLowerCase().includes(query))
})

function isSelected(provider: string, model: string): boolean {
  return selectedKeys.value.has(`${provider}\u0000${model}`)
}

function isDisabled(group: AvailableModelGroup, model: string): boolean {
  return !!group.model_meta?.[model]?.disabled || (props.disableSelected && isSelected(group.provider, model))
}

function isCustomModel(model: string, provider: string): boolean {
  return (appStore.customModels[provider] || []).includes(model)
}

function modelAlias(model: string, provider: string): string {
  return appStore.getModelAlias(model, provider)
}

function handleSelect(group: AvailableModelGroup, model: string) {
  if (isDisabled(group, model)) return
  emit('select', { provider: group.provider, model, apiMode: group.api_mode })
  if (props.closeOnSelect) emit('update:show', false)
}

function handleShowChange(show: boolean) {
  emit('update:show', show)
}

watch(() => props.show, (show) => {
  if (show) searchQuery.value = ''
})
</script>

<template>
  <NModal
    :show="props.show"
    preset="card"
    :title="props.title || t('models.title')"
    :style="{ width: 'min(480px, calc(100vw - 32px))' }"
    :mask-closable="true"
    @update:show="handleShowChange"
  >
    <NInput
      v-model:value="searchQuery"
      :placeholder="t('models.searchPlaceholder')"
      clearable
      size="small"
      class="model-search"
    />

    <div class="model-list">
      <div v-for="group in filteredGroups" :key="group.provider" class="model-group">
        <div class="model-group-header" @click="toggleGroup(group.provider)">
          <svg
            class="model-group-arrow"
            :class="{ collapsed: isGroupCollapsed(group.provider) }"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
          <span class="model-group-label">{{ group.label || group.provider }}</span>
          <span class="model-group-count">{{ group.models.length }}</span>
        </div>

        <div v-show="!isGroupCollapsed(group.provider)" class="model-group-items">
          <div
            v-for="model in group.models"
            :key="`${group.provider}:${model}`"
            class="model-item"
            :class="{
              active: isSelected(group.provider, model),
              disabled: isDisabled(group, model),
            }"
            :title="group.model_meta?.[model]?.disabled ? t('models.disabledTooltip') : ''"
            @click="handleSelect(group, model)"
          >
            <span class="model-item-label">
              <span class="model-item-name">{{ appStore.displayModelName(model, group.provider) }}</span>
              <span v-if="modelAlias(model, group.provider)" class="model-item-id">
                {{ t('models.aliasCanonical', { model }) }}
              </span>
            </span>
            <span v-if="group.model_meta?.[model]?.preview" class="model-badge-preview">{{ t('models.previewBadge') }}</span>
            <span v-if="group.model_meta?.[model]?.disabled" class="model-badge-disabled">{{ t('models.disabledBadge') }}</span>
            <span v-if="isCustomModel(model, group.provider)" class="model-badge-custom">{{ t('models.customBadge') }}</span>
            <svg v-if="isSelected(group.provider, model)" class="model-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
        </div>
      </div>

      <div v-if="filteredGroups.length === 0" class="model-empty">
        {{ searchQuery ? t('models.noResults') : t('models.noModels') }}
      </div>
    </div>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.model-search {
  margin-bottom: 12px;
}

.model-list {
  max-height: 50vh;
  overflow-y: auto;
  scrollbar-width: thin;
}

.model-group {
  margin-bottom: 4px;
}

.model-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px;
  color: $text-secondary;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  border-radius: $radius-sm;
  user-select: none;
  transition: background-color $transition-fast;

  &:hover {
    background-color: $bg-secondary;
  }
}

.model-group-arrow {
  flex-shrink: 0;
  transition: transform $transition-fast;

  &.collapsed {
    transform: rotate(-90deg);
  }
}

.model-group-label {
  flex: 1;
}

.model-group-count {
  color: $text-muted;
  font-size: 11px;
  font-weight: 400;
}

.model-group-items {
  padding-inline-start: 8px;
}

.model-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  color: $text-secondary;
  font-size: 13px;
  border-radius: $radius-sm;
  cursor: pointer;
  transition: all $transition-fast;

  &:hover {
    color: $text-primary;
    background-color: rgba(var(--accent-primary-rgb), 0.06);
  }

  &.active {
    color: $accent-primary;
    font-weight: 500;
  }

  &.disabled {
    opacity: 0.45;
    cursor: not-allowed;

    &:hover {
      color: $text-secondary;
      background-color: transparent;
    }
  }
}

.model-item-label {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.model-item-name,
.model-item-id {
  overflow: hidden;
  font-family: $font-code;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-item-name {
  font-size: 12px;
}

.model-item-id {
  color: $text-muted;
  font-size: 10px;
  font-weight: 400;
}

.model-check {
  flex-shrink: 0;
  color: $accent-primary;
}

.model-badge-preview,
.model-badge-custom,
.model-badge-disabled {
  flex-shrink: 0;
  padding: 1px 5px;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.03em;
  border-radius: 3px;
}

.model-badge-preview {
  color: #fff;
  background: #d97706;
}

.model-badge-custom {
  color: #fff;
  background: $accent-primary;
}

.model-badge-disabled {
  color: $text-muted;
  background: transparent;
  border: 1px solid $border-color;
}

.model-empty {
  padding: 24px 0;
  color: $text-muted;
  font-size: 13px;
  text-align: center;
}
</style>
