<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NCheckbox, NCheckboxGroup, NInput, NModal, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { AvailableModelGroup } from '@/api/hermes/system'
import { useModelsStore } from '@/stores/hermes/models'
import { useAppStore } from '@/stores/hermes/app'

const props = defineProps<{ provider: AvailableModelGroup }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const message = useMessage()
const modelsStore = useModelsStore()
const appStore = useAppStore()
const allModels = ref<string[]>([])
const catalogAliases = ref<Record<string, string>>({})
const catalogLoading = ref(true)
const catalogLoaded = ref(false)
const catalogError = ref('')
const selectedVisibleModels = ref([...props.provider.models])
const visibilitySaving = ref(false)
const modelAlias = (model: string) => catalogAliases.value[model] || appStore.getModelAlias(model, props.provider.provider)
const modelDisplayName = (model: string) => modelAlias(model) || model
const search = ref('')
const filteredModels = computed(() => {
  const query = search.value.trim().toLowerCase()
  if (!query) return allModels.value
  return allModels.value.filter(model => model.toLowerCase().includes(query)
    || modelDisplayName(model).toLowerCase().includes(query))
})

let catalogRequest = 0
async function loadCatalog() {
  const request = ++catalogRequest
  catalogLoading.value = true
  catalogLoaded.value = false
  catalogError.value = ''
  allModels.value = []
  catalogAliases.value = {}
  try {
    const catalog = await modelsStore.fetchProviderCatalog(props.provider.provider)
    if (request !== catalogRequest) return
    allModels.value = catalog.models
    catalogAliases.value = catalog.model_aliases
    selectedVisibleModels.value = [...catalog.visible_models]
    catalogLoaded.value = true
  } catch (error: any) {
    if (request === catalogRequest) catalogError.value = error?.message || t('models.providerEditorLoadFailed')
  } finally {
    if (request === catalogRequest) catalogLoading.value = false
  }
}
watch(() => props.provider, () => { if (!visibilitySaving.value) void loadCatalog() }, { immediate: true })

async function handleVisibilitySave() {
  if (!catalogLoaded.value || catalogLoading.value || visibilitySaving.value) return
  if (selectedVisibleModels.value.length === 0) {
    message.error(t('models.visibilitySelectOne'))
    return
  }
  visibilitySaving.value = true
  try {
    const selected = selectedVisibleModels.value.filter(m => allModels.value.includes(m))
    const mode = selected.length === allModels.value.length ? 'all' : 'include'
    await appStore.setModelVisibility(props.provider.provider, { mode, models: selected })
    await modelsStore.fetchProviders()
    emit('close')
    message.success(t('models.visibilitySaved'))
  } catch (e: any) {
    message.error(e.message || t('models.visibilitySaveFailed'))
  } finally {
    visibilitySaving.value = false
  }
}

function resetVisibility() {
  selectedVisibleModels.value = [...allModels.value]
}

function clearVisibility() {
  selectedVisibleModels.value = []
}
</script>

<template>
  <NModal
    :show="true"
    @update:show="value => { if (!value && !visibilitySaving) emit('close') }"
    preset="card"
    :title="t('models.manageVisibleModelsFor', { name: provider.label })"
    :style="{ width: 'min(560px, calc(100vw - 32px))' }"
    :mask-closable="!visibilitySaving"
  >
    <p class="visibility-hint">{{ t('models.visibilityHint') }}</p>
    <div class="visibility-count">
      {{ t('models.visibilitySelectedCount', { selected: selectedVisibleModels.length, total: allModels.length }) }}
    </div>
    <NInput
      v-model:value="search"
      class="visibility-search"
      :placeholder="t('models.searchPlaceholder')"
      :input-props="{ 'aria-label': t('models.searchPlaceholder') }"
      clearable
    />
    <p v-if="catalogError" role="alert">{{ catalogError }} <NButton size="small" @click="loadCatalog">{{ t('common.retry') }}</NButton></p>
    <NSpin :show="catalogLoading">
      <div class="visibility-list" :aria-busy="catalogLoading">
        <p v-if="catalogLoaded && filteredModels.length === 0" class="visibility-empty" role="status">{{ t('models.noResults') }}</p>
        <NCheckboxGroup v-model:value="selectedVisibleModels" :disabled="!catalogLoaded || visibilitySaving">
          <NCheckbox
            v-for="model in filteredModels"
            :key="model"
            :value="model"
            class="visibility-model"
          >
            <code>{{ modelDisplayName(model) }}</code>
            <code v-if="modelAlias(model)" class="visibility-model-id">{{ model }}</code>
          </NCheckbox>
        </NCheckboxGroup>
      </div>
    </NSpin>
    <div class="visibility-actions">
      <NButton size="small" quaternary :disabled="visibilitySaving || !catalogLoaded" @click="resetVisibility">
        {{ t('models.showAllModels') }}
      </NButton>
      <NButton size="small" quaternary :disabled="visibilitySaving || !catalogLoaded" @click="clearVisibility">
        {{ t('models.clearVisibleModels') }}
      </NButton>
      <div class="visibility-action-spacer" />
      <NButton size="small" :disabled="visibilitySaving" @click="emit('close')">
        {{ t('common.cancel') }}
      </NButton>
      <NButton size="small" type="primary" :loading="visibilitySaving" :disabled="!catalogLoaded" @click="handleVisibilitySave">
        {{ t('common.save') }}
      </NButton>
    </div>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.visibility-hint {
  margin: 0 0 10px;
  color: $text-secondary;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  line-height: var(--line-height, 1.5);
}

.visibility-count {
  color: $text-muted;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  margin-bottom: 10px;
}

.visibility-list {
  max-height: 360px;
  overflow-y: auto;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: $radius-sm;
  padding: calc(8px * var(--spacing-scale, 1));
}

.visibility-search {
  margin-bottom: 10px;
}

.visibility-empty {
  margin: 16px 0;
  color: $text-muted;
  text-align: center;
}

.visibility-model {
  display: flex;
  width: 100%;
  padding: calc(4px * var(--spacing-scale, 1)) calc(2px * var(--spacing-scale, 1));

  code {
    font-family: var(--font-code, $font-code);
    font-size: calc(var(--font-size-base, 14px) * 12 / 14);
    color: $text-secondary;
  }
}

.visibility-model-id {
  margin-inline-start: 6px;
  color: $text-muted !important;
  font-size: calc(var(--font-size-base, 14px) * 11 / 14) !important;
}

.visibility-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: calc(8px * var(--spacing-scale, 1));
  margin-top: 14px;
}

.visibility-action-spacer {
  flex: 1;
}
</style>
