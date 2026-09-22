<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { NInput, NButton, NSpin, NEmpty, NTabs, NTabPane, useMessage } from 'naive-ui'
import { useModelsStore } from '@/stores/hermes/models'
import { updateProvider } from '@/api/hermes/system'
import { useI18n } from 'vue-i18n'
import ModelDivisionSettings from '@/components/hermes/settings/ModelDivisionSettings.vue'

const { t } = useI18n()
const modelsStore = useModelsStore()
const message = useMessage()

const savingKey = ref<string | null>(null)
const editKeys = ref<Record<string, string>>({})
const activeTab = ref<'apiKeys' | 'division'>('apiKeys')

onMounted(() => {
  if (modelsStore.providers.length === 0) {
    modelsStore.fetchProviders()
  }
})

const isCustom = (provider: string) => {
  const g = modelsStore.providers.find(p => p.provider === provider)
  return !g?.builtin && provider.startsWith('custom:')
}

function getEditKey(provider: string): string {
  if (!(provider in editKeys.value)) {
    const g = modelsStore.providers.find(p => p.provider === provider)
    editKeys.value[provider] = g?.api_key || ''
  }
  return editKeys.value[provider]
}

async function handleSaveApiKey(providerKey: string) {
  const key = getEditKey(providerKey)
  if (!key.trim()) {
    message.warning(t('settings.models.apiKeyPlaceholder'))
    return
  }
  savingKey.value = providerKey
  try {
    await updateProvider(providerKey, { api_key: key.trim() })
    message.success(t('settings.models.saved'))
    await modelsStore.fetchProviders()
  } catch (e: any) {
    message.error(e.message || t('settings.models.saveFailed'))
  } finally {
    savingKey.value = null
  }
}

async function handleSaveCustom(providerKey: string) {
  const key = getEditKey(providerKey)
  savingKey.value = providerKey
  try {
    await updateProvider(providerKey, { api_key: key.trim() })
    message.success(t('settings.models.saved'))
    await modelsStore.fetchProviders()
  } catch (e: any) {
    message.error(e.message || t('settings.models.saveFailed'))
  } finally {
    savingKey.value = null
  }
}
</script>

<template>
  <section class="settings-section">
    <NTabs v-model:value="activeTab" type="line" animated>
      <NTabPane name="apiKeys" :tab="t('settings.models.apiKeysTab')">
        <NSpin :show="modelsStore.loading">
          <div v-if="modelsStore.providers.length === 0" class="empty-hint">
            <NEmpty :description="t('settings.models.noProviders')" />
          </div>

          <div v-for="g in modelsStore.providers" :key="g.provider" class="provider-section">
            <div class="provider-header">
              <h4 class="provider-name">{{ g.label }}</h4>
              <span class="type-badge" :class="isCustom(g.provider) ? 'custom' : 'builtin'">
                {{ isCustom(g.provider) ? t('models.customType') : t('models.builtIn') }}
              </span>
            </div>

            <!-- Built-in provider: only API key -->
            <div v-if="!isCustom(g.provider)" class="provider-fields">
              <div class="field-row">
                <NInput
                  :value="getEditKey(g.provider)"
                  type="password"
                  show-password-on="click"
                  :placeholder="t('settings.models.apiKeyPlaceholder')"
                  autocomplete="off"
                  @update:value="v => editKeys[g.provider] = v"
                />
                <NButton
                  type="primary"
                  size="small"
                  :loading="savingKey === g.provider"
                  @click="handleSaveApiKey(g.provider)"
                >
                  {{ t('settings.models.save') }}
                </NButton>
              </div>
            </div>

            <!-- Custom provider: API key -->
            <div v-else class="provider-fields">
              <div class="field-row">
                <NInput
                  :value="getEditKey(g.provider)"
                  type="password"
                  show-password-on="click"
                  :placeholder="t('settings.models.apiKeyPlaceholder')"
                  autocomplete="off"
                  @update:value="v => editKeys[g.provider] = v"
                />
                <NButton
                  type="primary"
                  size="small"
                  :loading="savingKey === g.provider"
                  @click="handleSaveCustom(g.provider)"
                >
                  {{ t('settings.models.save') }}
                </NButton>
              </div>
            </div>
          </div>
        </NSpin>
      </NTabPane>
      <NTabPane name="division" :tab="t('settings.models.divisionTab')">
        <ModelDivisionSettings />
      </NTabPane>
    </NTabs>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.settings-section {
  margin-top: 16px;
}

.empty-hint {
  padding: 40px 0;
}

.provider-section {
  border: 1px solid $border-color;
  border-radius: $radius-md;
  padding: 16px;
  margin-bottom: 14px;
  background: $bg-card;
}

.provider-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.provider-name {
  font-size: 14px;
  font-weight: 600;
  color: $text-primary;
  margin: 0;
}

.type-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 500;

  &.builtin {
    background: rgba(var(--accent-primary-rgb), 0.12);
    color: $accent-primary;
  }

  &.custom {
    background: rgba(var(--success-rgb), 0.12);
    color: $success;
  }
}

.provider-fields {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.field-row {
  display: flex;
  align-items: center;
  gap: 10px;

  .n-input {
    flex: 1;
  }
}
</style>
