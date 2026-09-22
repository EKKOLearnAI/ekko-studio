<script setup lang="ts">
import { ref, computed } from 'vue'
import { NModal, NInput, NSelect } from 'naive-ui'
import { useAppStore } from '@/stores/hermes/app'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useCollapsedProviderGroups } from '@/composables/useCollapsedProviderGroups'
import { capabilityCatalogStatus, modelsForCapability, type CapabilityCatalogGroup } from '@/utils/modelCapabilities'
import { useI18n } from 'vue-i18n'

const emit = defineEmits<{
  'modal-show-change': [show: boolean]
}>()

const { t } = useI18n()
const appStore = useAppStore()
const profilesStore = useProfilesStore()

const showModal = ref(false)
const searchQuery = ref('')
const { isGroupCollapsed, toggleGroup } = useCollapsedProviderGroups()
const customInput = ref('')
const customProvider = ref('')

const activeProfileName = computed(() => profilesStore.activeProfileName || 'default')
const activeModelGroups = computed(() => {
  const profileModels = appStore.profileModelGroups.find(entry => entry.profile === activeProfileName.value)
  return profileModels?.groups || []
})

const providerOptions = computed(() => {
  const current = appStore.selectedProvider
  customProvider.value = current
  return activeModelGroups.value.map(g => ({ label: g.label, value: g.provider }))
})

const modelGroupsWithCustom = computed(() =>
  activeModelGroups.value.map(g => ({
    ...g,
    // OrcaRouter groups are replaced by the server's capability-filtered chat
    // list: a gateway catalog cannot be extended with a locally typed model id,
    // because the gateway is not known to route it.
    models: isOrcaRouterGroup(g)
      ? modelsForCapability(g as CapabilityCatalogGroup, 'chat')
      : [
        ...g.models,
        ...(appStore.customModels[g.provider] || []).filter(m => !g.models.includes(m)),
      ],
  }))
)

function isOrcaRouterGroup(group: { provider: string }): boolean {
  const id = String(group?.provider || '').trim().toLowerCase()
  return id === 'orcarouter' || id === 'orcarouter-oauth'
}

/**
 * Only surfaced when the backend had to fall back to the verified cold-start
 * seed: the user must know the list is degraded rather than believe it is the
 * whole live catalog.
 */
const orcaRouterDegradedGroups = computed(() =>
  activeModelGroups.value.filter(
    group => isOrcaRouterGroup(group) && capabilityCatalogStatus(group as CapabilityCatalogGroup).degraded,
  ),
)

const selectedModelInActiveProfile = computed(() =>
  modelGroupsWithCustom.value.some(group =>
    group.provider === appStore.selectedProvider && group.models.includes(appStore.selectedModel),
  ),
)

const selectedDisplayName = computed(() =>
  selectedModelInActiveProfile.value
    ? appStore.displayModelName(appStore.selectedModel, appStore.selectedProvider)
    : '',
)

function isCustomModel(model: string, provider: string) {
  return (appStore.customModels[provider] || []).includes(model)
}

async function removeCustomModel(model: string, provider: string) {
  await appStore.removeCustomModel(model, provider)
}

function safeLower(value: unknown) {
  return typeof value === 'string' ? value.toLowerCase() : ''
}

const filteredGroups = computed(() => {
  const q = safeLower(searchQuery.value).trim()
  if (!q) return modelGroupsWithCustom.value
  return modelGroupsWithCustom.value
    .map(g => ({
      ...g,
      models: g.models.filter(m => {
        const displayName = appStore.displayModelName(m, g.provider)
        return safeLower(m).includes(q) || safeLower(displayName).includes(q)
      }),
    }))
    .filter(g => g.models.length > 0 || safeLower(g.label).includes(q))
})

function handleSelect(model: string, provider: string) {
  const meta = activeModelGroups.value.find(g => g.provider === provider)?.model_meta?.[model]
  if (meta?.disabled) return
  appStore.switchModel(model, provider)
  setModalShow(false)
  searchQuery.value = ''
}

function modelDisplayName(model: string, provider: string) {
  return appStore.displayModelName(model, provider)
}

function modelAlias(model: string, provider: string) {
  return appStore.getModelAlias(model, provider)
}

function handleCustomSubmit() {
  const model = customInput.value.trim()
  if (!model || !customProvider.value) return
  // 拦截 disabled 模型，避免 custom input 绕过列表里的灰显限制
  const meta = activeModelGroups.value.find(g => g.provider === customProvider.value)?.model_meta?.[model]
  if (meta?.disabled) return
  appStore.switchModel(model, customProvider.value)
  setModalShow(false)
  searchQuery.value = ''
  customInput.value = ''
}

function setModalShow(show: boolean) {
  showModal.value = show
  emit('modal-show-change', show)
}

function openModal() {
  searchQuery.value = ''
  customInput.value = ''
  customProvider.value = appStore.selectedProvider
  setModalShow(true)
}

function handleModalShowChange(show: boolean) {
  setModalShow(show)
}

const refreshing = ref(false)

async function handleRefresh() {
  if (refreshing.value) return
  refreshing.value = true
  const startedAt = Date.now()
  try {
    await appStore.reloadModels({ preserveSelection: true })
  } finally {
    // 保证旋转动画至少可见一圈，避免请求太快图标闪一下
    const elapsed = Date.now() - startedAt
    const minSpin = 600
    if (elapsed < minSpin) await new Promise(resolve => setTimeout(resolve, minSpin - elapsed))
    refreshing.value = false
  }
}
</script>

<template>
  <div class="model-selector">
    <div class="model-label-row">
      <div class="model-label">{{ t('models.title') }}</div>
      <button
        class="model-refresh"
        type="button"
        :disabled="refreshing"
        :title="t('models.refresh')"
        :aria-label="t('models.refresh')"
        @click="handleRefresh"
      >
        <svg
          :class="{ spinning: refreshing }"
          width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        >
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
      </button>
    </div>
    <button class="model-trigger" @click="openModal">
      <span class="model-name" :title="appStore.selectedModel">{{ selectedDisplayName || '—' }}</span>
      <svg class="model-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>

    <NModal
      :show="showModal"
      preset="card"
      :title="t('models.title')"
      :style="{ width: 'min(480px, calc(100vw - 32px))' }"
      :mask-closable="true"
      @update:show="handleModalShowChange"
    >
      <NInput
        v-model:value="searchQuery"
        :placeholder="t('models.searchPlaceholder')"
        clearable
        size="small"
        class="model-search"
      />
      <div
        v-if="orcaRouterDegradedGroups.length > 0"
        class="model-degraded"
        data-testid="orca-router-catalog-degraded"
      >
        {{ t('models.orcaRouterCatalogDegraded') }}
      </div>
      <div class="model-list">
        <div v-for="group in filteredGroups" :key="group.provider" class="model-group">
          <div class="model-group-header" @click="toggleGroup(group.provider)">
            <svg
              class="model-group-arrow"
              :class="{ collapsed: isGroupCollapsed(group.provider) }"
              width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
            <span class="model-group-label">{{ group.label }}</span>
            <span class="model-group-count">{{ group.models.length }}</span>
          </div>
          <div v-show="!isGroupCollapsed(group.provider)" class="model-group-items">
            <div
              v-for="model in group.models"
              :key="model"
              class="model-item"
              :class="{
                active: model === appStore.selectedModel && group.provider === appStore.selectedProvider,
                disabled: !!group.model_meta?.[model]?.disabled,
              }"
              :title="group.model_meta?.[model]?.disabled ? t('models.disabledTooltip') : ''"
              @click="handleSelect(model, group.provider)"
            >
              <span class="model-item-label">
                <span class="model-item-name">{{ modelDisplayName(model, group.provider) }}</span>
                <span v-if="modelAlias(model, group.provider)" class="model-item-id">
                  {{ t('models.aliasCanonical', { model }) }}
                </span>
              </span>
              <span v-if="group.model_meta?.[model]?.preview" class="model-badge-preview">{{ t('models.previewBadge') }}</span>
              <span v-if="group.model_meta?.[model]?.disabled" class="model-badge-disabled">{{ t('models.disabledBadge') }}</span>
              <span v-if="isCustomModel(model, group.provider)" class="model-badge-custom">{{ t('models.customBadge') }}</span>
              <button
                v-if="isCustomModel(model, group.provider)"
                class="model-custom-remove"
                type="button"
                :title="t('models.removeCustomModel')"
                @click.stop="removeCustomModel(model, group.provider)"
              >
                ×
              </button>
              <svg v-if="model === appStore.selectedModel && group.provider === appStore.selectedProvider" class="model-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          </div>
        </div>
        <div v-if="filteredGroups.length === 0" class="model-empty">
          {{ searchQuery ? 'No results' : 'No models' }}
        </div>
      </div>
      <div class="model-custom">
        <div class="model-custom-row">
          <NSelect
            v-model:value="customProvider"
            :options="providerOptions"
            size="small"
            class="model-custom-provider"
          />
          <NInput
            v-model:value="customInput"
            :placeholder="t('models.customModelPlaceholder')"
            size="small"
            class="model-custom-input"
            @keydown.enter="handleCustomSubmit"
          />
        </div>
        <div class="model-custom-hint">
          {{ t('models.customModelHint') }}
        </div>
      </div>
    </NModal>

  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.model-selector {
  padding: 0 12px;
  margin-bottom: 8px;
}

.model-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.model-label {
  font-size: 11px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.model-refresh {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: $radius-sm;
  background: transparent;
  color: $text-muted;
  cursor: pointer;
  transition: color $transition-fast, background-color $transition-fast;

  &:hover:not(:disabled) {
    background: $bg-secondary;
    color: $text-primary;
  }

  &:disabled {
    cursor: default;
    opacity: 0.7;
  }

  svg.spinning {
    animation: model-refresh-spin 0.8s linear infinite;
  }
}

@keyframes model-refresh-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
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
}

.model-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: start;
}

.model-arrow {
  flex-shrink: 0;
  color: $text-muted;
}

.model-search {
  margin-bottom: 12px;
}

.model-degraded {
  margin-bottom: 8px;
  padding: 6px 8px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  background: $bg-secondary;
  color: $text-muted;
  font-size: 11px;
  line-height: 1.4;
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
  padding: 8px 8px;
  font-size: 12px;
  font-weight: 600;
  color: $text-secondary;
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
  font-size: 11px;
  color: $text-muted;
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
  font-size: 13px;
  color: $text-secondary;
  border-radius: $radius-sm;
  cursor: pointer;
  transition: all $transition-fast;

  &:hover {
    background-color: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;
  }

  &.active {
    color: $accent-primary;
    font-weight: 500;
  }

  &.disabled {
    opacity: 0.45;
    cursor: not-allowed;

    &:hover {
      background-color: transparent;
      color: $text-secondary;
    }
  }
}

.model-item-label {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.model-item-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: $font-code;
  font-size: 12px;
}

.model-item-id {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: $text-muted;
  font-family: $font-code;
  font-size: 10px;
  font-weight: 400;
}


.model-check {
  flex-shrink: 0;
  color: $accent-primary;
}

.model-badge-custom {
  flex-shrink: 0;
  font-size: 9px;
  font-weight: 600;
  color: #fff;
  background: $accent-primary;
  padding: 1px 5px;
  border-radius: 3px;
  margin-inline-end: 4px;
  letter-spacing: 0.03em;
}


.model-custom-remove {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: $text-muted;
  cursor: pointer;
  line-height: 18px;
  padding: 0;

  &:hover {
    background: rgba(var(--error-rgb), 0.12);
    color: $error;
  }
}

.model-badge-preview {
  flex-shrink: 0;
  font-size: 9px;
  font-weight: 600;
  color: #fff;
  background: #d97706;
  padding: 1px 5px;
  border-radius: 3px;
  margin-inline-end: 4px;
  letter-spacing: 0.03em;
}

.model-badge-disabled {
  flex-shrink: 0;
  font-size: 9px;
  font-weight: 600;
  color: $text-muted;
  background: transparent;
  border: 1px solid $border-color;
  padding: 0 5px;
  border-radius: 3px;
  margin-inline-end: 4px;
  letter-spacing: 0.03em;
}

.model-empty {
  padding: 24px 0;
  text-align: center;
  font-size: 13px;
  color: $text-muted;
}

.model-custom {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid $border-color;
}

.model-custom-row {
  display: flex;
  gap: 8px;
}

.model-custom-provider {
  width: 160px;
  flex-shrink: 0;
}

.model-custom-input {
  flex: 1;
}

.model-custom-hint {
  margin-top: 6px;
  font-size: 11px;
  color: $text-muted;
}
</style>
