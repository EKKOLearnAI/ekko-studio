<script setup lang="ts">
import { ref, computed } from 'vue'
import { NButton, NModal, NInput, NSelect, useMessage, useDialog } from 'naive-ui'
import type { AvailableModelGroup } from '@/api/hermes/system'
import { useModelsStore } from '@/stores/hermes/models'
import { useAppStore } from '@/stores/hermes/app'
import { useChatStore } from '@/stores/hermes/chat'
import { checkCopilotToken, disableCopilot } from '@/api/hermes/copilot-auth'
import { getStoredUserRole } from '@/api/client'
import ProviderEditorModal from './ProviderEditorModal.vue'
import ProviderVisibilityModal from './ProviderVisibilityModal.vue'
import { useI18n } from 'vue-i18n'
import { useModelCatalogNotice } from '@/composables/useModelCatalogNotice'

const props = defineProps<{ provider: AvailableModelGroup }>()

const { t } = useI18n()
const modelsStore = useModelsStore()
const appStore = useAppStore()
const chatStore = useChatStore()
const message = useMessage()
const dialog = useDialog()

const isCustomProviderKey = computed(() => props.provider.provider.startsWith('custom:'))
const isCustom = computed(() => !props.provider.builtin && isCustomProviderKey.value)
const isConfigBackedProvider = computed(() => isCustomProviderKey.value || (!props.provider.builtin && !!props.provider.provider_source))
const isCopilot = computed(() => props.provider.provider === 'copilot')
const displayName = computed(() => props.provider.label)
const userRole = getStoredUserRole()
const canEditProvider = computed(() => (
  props.provider.provider_editable === true && (userRole === 'super_admin' || userRole === 'admin')
))
const canRefreshModels = computed(() => (
  props.provider.model_refreshable === true && (userRole === 'super_admin' || userRole === 'admin')
))
const showEditorModal = ref(false)
const deleting = ref(false)
const refreshingModels = ref(false)
const restoringModels = ref(false)
const destructiveActionLabel = computed(() => {
  if (isConfigBackedProvider.value) return t('common.delete')
  if (isCopilot.value) return t('models.disableProvider')
  return t('models.clearProviderCredentials')
})
const destructiveActionTitle = computed(() => {
  if (isConfigBackedProvider.value) return t('models.deleteProvider')
  if (isCopilot.value) return t('models.disableProvider')
  return t('models.clearProviderCredentials')
})

function destructiveConfirmContent(copilotMsg: string) {
  if (isConfigBackedProvider.value) return t('models.deleteConfirm', { name: displayName.value })
  if (isCopilot.value) {
    const base = t('models.disableProviderConfirm', { name: displayName.value })
    return copilotMsg ? `${base}\n\n${copilotMsg}` : base
  }
  return t('models.clearCredentialsConfirm', { name: displayName.value })
}

const showAliasListModal = ref(false)
const showAliasModal = ref(false)
const aliasProvider = ref('')
const aliasModel = ref('')
const aliasInput = ref('')

const showVisibilityModal = ref(false)
const defaultingProvider = ref(false)
const defaultingModel = ref<string | null>(null)
const catalogChanged = useModelCatalogNotice(() => showEditorModal.value || showAliasListModal.value || showAliasModal.value || showVisibilityModal.value || deleting.value || refreshingModels.value || restoringModels.value || defaultingProvider.value || defaultingModel.value !== null)

const visibilityRule = computed(() => appStore.getProviderVisibility(props.provider.provider))
const isFiltered = computed(() => visibilityRule.value.mode === 'include')
const visibleCountLabel = computed(() => `${props.provider.models.length}/${props.provider.model_count ?? props.provider.available_models?.length ?? props.provider.models.length}`)
const isDefaultProvider = computed(() => modelsStore.defaultProvider === props.provider.provider)
const defaultModelOptions = computed(() => props.provider.models.map(model => ({
  label: modelDisplayName(model),
  value: model,
})))
const defaultModelSelectValue = computed(() => isDefaultProvider.value ? modelsStore.defaultModel || null : null)
const previewModels = computed(() => {
  const firstModels = props.provider.models.slice(0, 20)
  const currentDefault = modelsStore.defaultModel
  if (isDefaultProvider.value && currentDefault && props.provider.models.includes(currentDefault) && !firstModels.includes(currentDefault)) {
    return [currentDefault, ...firstModels.slice(0, 19)]
  }
  return firstModels
})
const hiddenModelCount = computed(() => Math.max(props.provider.models.length - previewModels.value.length, 0))

function isDefaultModel(model: string) {
  return isDefaultProvider.value && modelsStore.defaultModel === model
}

function modelAlias(model: string) {
  return appStore.getModelAlias(model, props.provider.provider)
}

function modelDisplayName(model: string) {
  return appStore.displayModelName(model, props.provider.provider)
}

function openAliasEditor(model: string) {
  aliasProvider.value = props.provider.provider
  aliasModel.value = model
  aliasInput.value = appStore.getModelAlias(model, props.provider.provider)
  showAliasModal.value = true
}

async function handleSetDefaultProvider() {
  if (isDefaultProvider.value) return

  defaultingProvider.value = true
  try {
    await modelsStore.setDefaultProvider(props.provider.provider)
    message.success(t('models.defaultProviderUpdated'))
  } catch (e: any) {
    message.error(e?.message || t('models.defaultProviderUpdateFailed'))
  } finally {
    defaultingProvider.value = false
  }
}

async function handleSetDefaultModel(model: string | null) {
  if (!model) return
  if (isDefaultModel(model)) return

  defaultingModel.value = model
  try {
    await modelsStore.setDefaultModel(model, props.provider.provider)
    message.success(t('models.defaultModelUpdated'))
  } catch (e: any) {
    message.error(e?.message || t('models.defaultModelUpdateFailed'))
  } finally {
    if (defaultingModel.value === model) defaultingModel.value = null
  }
}

async function saveAlias() {
  if (!aliasModel.value || !aliasProvider.value) return
  try {
    await appStore.setModelAlias(aliasModel.value, aliasProvider.value, aliasInput.value)
    catalogChanged()
    showAliasModal.value = false
  } catch (e: any) {
    message.error(e.message || t('models.aliasSaveFailed'))
  }
}

async function clearAlias() {
  aliasInput.value = ''
  await saveAlias()
}

function openVisibilityModal() {
  showVisibilityModal.value = true
}

async function handleDelete() {
  let copilotMsg = ''
  if (isCopilot.value) {
    // 提前查 source，让用户清楚移除会不会影响 VS Code/gh CLI 等其他工具的登录态
    try {
      const status = await checkCopilotToken()
      if (status.source === 'env') copilotMsg = t('models.copilotDeleteHintEnv')
      else if (status.source === 'gh-cli') copilotMsg = t('models.copilotDeleteHintGhCli')
      else if (status.source === 'apps-json') copilotMsg = t('models.copilotDeleteHintAppsJson')
    } catch { /* ignore — fall back to generic confirm copy */ }
  }
  dialog.warning({
    title: destructiveActionTitle.value,
    content: destructiveConfirmContent(copilotMsg),
    positiveText: destructiveActionLabel.value,
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      deleting.value = true
      try {
        if (isCopilot.value) {
          // Copilot 走显式 opt-in 模型：disable 把 enabled 置 false，
          // 仅当 token 来自 ~/.hermes/.env 时才清掉，gh-cli / apps.json 不动。
          await disableCopilot()
          // 服务端会在默认模型属于 copilot 时清掉 model.default，这里再清理本地
          // 会话级 model/provider，避免 Chat 页继续显示已下架的 copilot 模型。
          chatStore.clearProviderFromSessions('copilot')
          await modelsStore.fetchProviders()
        } else {
          await modelsStore.removeProvider(props.provider.provider, {
            source: props.provider.provider_source,
            providerKey: props.provider.provider_key,
          })
        }
        // 删完之后若已没有默认模型，自动从剩余 provider 里挑一个，避免 chat 页
        // "无默认模型"的尴尬态。与 hermes CLI `model` 子命令的隐含行为对齐。
        if (!appStore.selectedModel && appStore.modelGroups.length > 0) {
          const first = appStore.modelGroups.find(g => g.models.length > 0)
          if (first) {
            await appStore.switchModel(first.models[0], first.provider)
          }
        }
        message.success(isConfigBackedProvider.value
          ? t('models.providerDeleted')
          : isCopilot.value
            ? t('models.providerDisabled')
            : t('models.providerCredentialsCleared'))
      } catch (e: any) {
        message.error(e.message)
      } finally {
        deleting.value = false
      }
    },
  })
}

async function handleRefreshModels(confirm = false) {
  refreshingModels.value = true
  try {
    const result = await modelsStore.refreshProviderModels(props.provider.provider, { confirm })
    if (result.requires_confirmation && !confirm) {
      dialog.warning({
        title: t('models.refreshModelsConfirmTitle'),
        content: t('models.refreshModelsConfirmContent', {
          removed: result.diff.removed.length,
          added: result.diff.added.length,
          removedList: result.diff.removed.slice(0, 8).join(', ') || '-',
        }),
        positiveText: t('models.refreshModelsConfirmAction'),
        negativeText: t('common.cancel'),
        onPositiveClick: async () => {
          await handleRefreshModels(true)
        },
      })
      return
    }
    if (result.applied) {
      message.success(t('models.refreshModelsSuccess', {
        count: result.models.length,
        unavailable: result.unavailable_models.length,
      }))
    } else {
      message.error(t('models.refreshModelsFailed'))
    }
  } catch {
    message.error(t('models.refreshModelsFailed'))
  } finally {
    refreshingModels.value = false
  }
}

async function handleRestoreModels() {
  restoringModels.value = true
  try {
    const result = await modelsStore.restoreProviderModels(props.provider.provider)
    if (result.applied) {
      message.success(t('models.restoreModelsSuccess', { count: result.models.length }))
    } else {
      message.error(t('models.restoreModelsFailed'))
    }
  } catch {
    message.error(t('models.restoreModelsFailed'))
  } finally {
    restoringModels.value = false
  }
}
</script>

<template>
  <div class="provider-card">
    <div class="card-header">
      <h3 class="provider-name">{{ displayName }}</h3>
      <div class="provider-badges">
        <span v-if="isDefaultProvider" class="type-badge default">{{ t('models.currentDefault') }}</span>
        <span class="type-badge" :class="isCustom ? 'custom' : 'builtin'">
          {{ isCustom ? t('models.customType') : t('models.builtIn') }}
        </span>
      </div>
    </div>

    <div class="card-body">
      <div class="info-row">
        <span class="info-label">{{ t('models.provider') }}</span>
        <code class="info-value mono">{{ provider.provider }}</code>
      </div>
      <div class="info-row">
        <span class="info-label">{{ t('models.baseUrl') }}</span>
        <code class="info-value mono">{{ provider.base_url }}</code>
      </div>
      <div class="info-row models-row">
        <span class="info-label">{{ t('models.models') }}</span>
        <span class="info-value models-count">
          {{ isFiltered ? visibleCountLabel : provider.models.length }} {{ t('models.count') }}
        </span>
      </div>
      <div class="default-model-row">
        <span class="info-label">{{ t('models.defaultModel') }}</span>
        <NSelect
          class="default-model-select"
          size="tiny"
          filterable
          :value="defaultModelSelectValue"
          :options="defaultModelOptions"
          :placeholder="t('models.selectModel')"
          :disabled="provider.models.length === 0"
          :loading="defaultingModel !== null"
          @update:value="handleSetDefaultModel"
        />
      </div>
      <div class="models-list">
        <button
          v-for="model in previewModels"
          :key="model"
          class="model-tag model-tag-button"
          :class="{ default: isDefaultModel(model) }"
          type="button"
          :title="t('models.aliasTitleFor', { model })"
          @click="openAliasEditor(model)"
        >
          <span class="model-tag-name">{{ modelDisplayName(model) }}</span>
          <span v-if="isDefaultModel(model)" class="model-tag-default">{{ t('models.defaultShort') }}</span>
          <span v-if="modelAlias(model)" class="model-tag-id">{{ model }}</span>
        </button>
        <span v-if="hiddenModelCount > 0" class="model-tag model-tag-more">
          +{{ hiddenModelCount }} {{ t('models.more') }}
        </span>
      </div>
    </div>

    <div class="card-actions">
      <NButton
        size="tiny"
        quaternary
        :disabled="isDefaultProvider || provider.models.length === 0"
        :loading="defaultingProvider"
        @click="handleSetDefaultProvider"
      >
        {{ isDefaultProvider ? t('models.currentDefault') : t('models.setDefaultProvider') }}
      </NButton>
      <NButton size="tiny" quaternary @click="showAliasListModal = true">{{ t('models.aliasManage') }}</NButton>
      <NButton size="tiny" quaternary @click="openVisibilityModal">{{ t('models.manageVisibleModels') }}</NButton>
      <NButton
        v-if="canRefreshModels"
        size="tiny"
        quaternary
        :loading="refreshingModels"
        :title="t('models.refreshModels')"
        @click="handleRefreshModels(false)"
      >
        {{ t('models.refreshModels') }}
      </NButton>
      <NButton
        v-if="canRefreshModels && provider.model_restore_available"
        size="tiny"
        quaternary
        :loading="restoringModels"
        @click="handleRestoreModels"
      >
        {{ t('models.restoreModels') }}
      </NButton>
      <NButton v-if="canEditProvider" size="tiny" quaternary @click="showEditorModal = true">{{ t('common.edit') }}</NButton>
      <NButton size="tiny" quaternary type="error" :loading="deleting" @click="handleDelete">{{ destructiveActionLabel }}</NButton>
    </div>

    <ProviderEditorModal
      v-if="canEditProvider"
      v-model:show="showEditorModal"
      :provider="provider"
    />

    <NModal
      v-model:show="showAliasListModal"
      preset="card"
      :title="t('models.aliasManageFor', { provider: displayName })"
      :style="{ width: 'min(560px, calc(100vw - 32px))' }"
      :mask-closable="true"
    >
      <div class="alias-list-hint">{{ t('models.aliasHint') }}</div>
      <div class="alias-list">
        <div v-for="model in provider.models" :key="model" class="alias-row">
          <div class="alias-row-text">
            <span class="alias-row-name">{{ modelDisplayName(model) }}</span>
            <span v-if="isDefaultModel(model)" class="alias-row-default">{{ t('models.defaultShort') }}</span>
            <code class="alias-row-id">{{ model }}</code>
          </div>
          <NButton size="tiny" quaternary @click="openAliasEditor(model)">{{ t('models.aliasEdit') }}</NButton>
        </div>
      </div>
    </NModal>

    <NModal
      v-model:show="showAliasModal"
      preset="card"
      :title="aliasModel ? t('models.aliasTitleFor', { model: aliasModel }) : t('models.aliasTitle')"
      :style="{ width: 'min(420px, calc(100vw - 32px))' }"
      :mask-closable="true"
    >
      <NInput
        v-model:value="aliasInput"
        :placeholder="t('models.aliasPlaceholder')"
        clearable
        @keydown.enter="saveAlias"
      />
      <div v-if="aliasModel" class="model-alias-canonical">
        {{ t('models.aliasCanonical', { model: aliasModel }) }}
      </div>
      <div class="model-alias-hint">{{ t('models.aliasHint') }}</div>
      <template #footer>
        <div class="model-alias-actions">
          <NButton quaternary :disabled="!appStore.getModelAlias(aliasModel, aliasProvider)" @click="clearAlias">
            {{ t('models.aliasUseOriginal') }}
          </NButton>
          <div class="model-alias-spacer" />
          <NButton @click="showAliasModal = false">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" @click="saveAlias">{{ t('common.save') }}</NButton>
        </div>
      </template>
    </NModal>

    <ProviderVisibilityModal
      v-if="showVisibilityModal"
      :provider="provider"
      @close="showVisibilityModal = false"
    />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.provider-card {
  background-color: var(--theme-card-bg, $bg-card);
  border: var(--border-width, 1px) solid $border-color;
  border-radius: $radius-md;
  padding: calc(16px * var(--spacing-scale, 1));
  transition: border-color $transition-fast;

  &:hover {
    border-color: rgba(var(--accent-primary-rgb), 0.3);
  }
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: calc(12px * var(--spacing-scale, 1));
  margin-bottom: 12px;
}

.provider-name {
  font-size: calc(var(--font-size-base, 14px) * 15 / 14);
  font-weight: 600;
  color: $text-primary;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 70%;
}

.provider-badges {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: calc(6px * var(--spacing-scale, 1));
  min-width: 0;
}

.type-badge {
  font-size: calc(var(--font-size-base, 14px) * 11 / 14);
  padding: calc(2px * var(--spacing-scale, 1)) calc(8px * var(--spacing-scale, 1));
  border-radius: var(--radius-component, 10px);
  font-weight: 500;
  white-space: nowrap;

  &.builtin {
    background: rgba(var(--accent-primary-rgb), 0.12);
    color: $accent-primary;
  }

  &.custom {
    background: rgba(var(--success-rgb), 0.12);
    color: $success;
  }

  &.default {
    background: rgba(var(--warning-rgb), 0.14);
    color: $warning;
  }
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: calc(6px * var(--spacing-scale, 1));
  margin-bottom: 14px;
}

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.info-label {
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  color: $text-muted;
}

.info-value {
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  color: $text-secondary;
}

.mono {
  font-family: var(--font-code, $font-code);
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
}

.models-row {
  margin-top: 4px;
}

.models-count {
  color: $text-muted;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
}

.models-list {
  display: flex;
  flex-wrap: wrap;
  gap: calc(4px * var(--spacing-scale, 1)) calc(6px * var(--spacing-scale, 1));
  margin-top: 6px;
  height: 100px;
  overflow-y: auto;
  align-content: flex-start;
}

.default-model-row {
  display: flex;
  align-items: center;
  gap: calc(10px * var(--spacing-scale, 1));
  margin-top: 2px;
  min-width: 0;
}

.default-model-select {
  flex: 1;
  min-width: 0;
}

.model-tag {
  display: inline-flex;
  align-items: center;
  gap: calc(5px * var(--spacing-scale, 1));
  min-height: 22px;
  font-size: calc(var(--font-size-base, 14px) * 10 / 14);
  font-family: var(--font-code, $font-code);
  padding: calc(2px * var(--spacing-scale, 1)) calc(6px * var(--spacing-scale, 1));
  border-radius: var(--radius-component, 3px);
  background: rgba(var(--accent-primary-rgb), 0.08);
  color: $text-secondary;
  white-space: nowrap;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;

  &-more {
    background: rgba(var(--accent-primary-rgb), 0.15);
    color: $accent-primary;
    font-weight: 500;
  }

  &.default {
    background: rgba(var(--warning-rgb), 0.14);
    color: $text-primary;
  }
}

.model-tag-button {
  border: 0;
  cursor: pointer;
  text-align: start;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.16);
    color: $text-primary;
  }
}

.model-tag-name,
.model-tag-id {
  overflow: hidden;
  text-overflow: ellipsis;
}

.model-tag-id {
  color: $text-muted;
  font-size: calc(var(--font-size-base, 14px) * 9 / 14);
}

.model-tag-default,
.alias-row-default {
  color: $warning;
  font-family: $font-ui;
  font-size: calc(var(--font-size-base, 14px) * 10 / 14);
  font-weight: 600;
}

.card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: calc(8px * var(--spacing-scale, 1));
  border-top: var(--border-width, 1px) solid $border-light;
  padding-top: calc(10px * var(--spacing-scale, 1));
}

.alias-list-hint,
.model-alias-hint {
  color: $text-muted;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
}

.alias-list-hint {
  margin-bottom: 12px;
}

.alias-list {
  display: flex;
  flex-direction: column;
  gap: calc(6px * var(--spacing-scale, 1));
  max-height: 45vh;
  overflow-y: auto;
}

.alias-row {
  display: flex;
  align-items: center;
  gap: calc(12px * var(--spacing-scale, 1));
  padding: calc(8px * var(--spacing-scale, 1));
  border: var(--border-width, 1px) solid $border-light;
  border-radius: $radius-sm;
}

.alias-row-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: calc(2px * var(--spacing-scale, 1));
}

.alias-row-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: $text-primary;
  font-family: var(--font-code, $font-code);
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
}

.alias-row-id,
.model-alias-canonical {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: $text-muted;
  font-family: var(--font-code, $font-code);
  font-size: calc(var(--font-size-base, 14px) * 11 / 14);
}

.model-alias-canonical {
  margin-top: 8px;
}

.model-alias-hint {
  margin-top: 6px;
}

.model-alias-actions {
  display: flex;
  align-items: center;
  gap: calc(8px * var(--spacing-scale, 1));
}

.model-alias-spacer {
  flex: 1;
}

</style>
