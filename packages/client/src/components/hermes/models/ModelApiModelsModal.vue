<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NEmpty, NInput, NModal, NTree, type TreeOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ApiModel } from '@/api/studio/model-api'

const props = defineProps<{ visible: boolean; models: ApiModel[]; selected: string[] }>()
const emit = defineEmits<{ confirm: [models: string[]]; cancel: [] }>()
const { t } = useI18n()
const query = ref('')
const draft = ref<string[]>([])
const expanded = ref<Array<string | number>>([])
const callable = computed(() => props.models.filter(model => model.responses_supported))
const groups = computed<TreeOption[]>(() => {
  const providers = new Map<string, ApiModel[]>()
  for (const model of callable.value) {
    const list = providers.get(model.owned_by) || []
    list.push(model)
    providers.set(model.owned_by, list)
  }
  return [...providers].map(([provider, models]) => ({
    key: `provider:${provider}`, label: `${provider} (${models.length})`, providerId: provider,
    children: models.map(model => ({
      key: `model:${model.id}`, modelId: model.id, label: model.id.slice(model.id.indexOf('/') + 1),
      searchText: `${provider} ${model.id}`,
    })),
  }))
})
const checkedKeys = computed(() => draft.value.map(id => `model:${id}`))
watch(() => props.visible, visible => {
  if (!visible) return
  query.value = ''
  const available = new Set(callable.value.map(model => model.id))
  draft.value = props.selected.filter(id => available.has(id))
  expanded.value = groups.value.length === 1 ? [groups.value[0].key!] : []
}, { immediate: true })

function updateChecked(keys: Array<string | number>) {
  draft.value = keys.filter((key): key is string => typeof key === 'string' && key.startsWith('model:')).map(key => key.slice(6))
}
function filter(pattern: string, option: TreeOption) {
  return String(option.searchText || option.label || '').toLowerCase().includes(pattern.trim().toLowerCase())
}
function nodeProps({ option }: { option: TreeOption }) {
  return { 'data-api-model': option.modelId as string | undefined, 'data-api-provider': option.providerId as string | undefined }
}
function confirm() {
  const selected = new Set(draft.value)
  emit('confirm', callable.value.filter(model => selected.has(model.id)).map(model => model.id))
}
</script>

<template>
  <NModal :show="visible" preset="card" :title="t('modelApi.selectModels')" :aria-label="t('modelApi.selectModels')" class="model-api-models-modal" :style="{ width: 'min(620px, calc(100vw - 32px))' }" @update:show="value => !value && emit('cancel')">
    <div class="model-picker-body">
      <NInput v-model:value="query" clearable :placeholder="t('modelApi.searchModels')" :input-props="{ 'aria-label': t('modelApi.searchModels') }" />
      <div class="model-picker-toolbar"><span>{{ t('modelApi.selectedModels', { count: draft.length }) }}</span><NButton size="small" @click="draft = callable.map(model => model.id)">{{ t('modelApi.selectAll') }}</NButton><NButton size="small" @click="draft = []">{{ t('modelApi.clearSelection') }}</NButton></div>
      <div class="model-picker-tree">
        <NTree :data="groups" :checked-keys="checkedKeys" v-model:expanded-keys="expanded" :pattern="query" :filter="filter" :node-props="nodeProps" checkable cascade check-strategy="child" block-line :selectable="false" :virtual-scroll="false" :show-irrelevant-nodes="false" :override-default-node-click-behavior="({ option }) => option.children ? 'toggleExpand' : 'toggleCheck'" @update:checked-keys="updateChecked">
          <template #empty><NEmpty :description="t('modelApi.noMatchingModels')" size="small" /></template>
        </NTree>
      </div>
    </div>
    <template #footer><div class="model-picker-footer"><NButton @click="emit('cancel')">{{ t('common.cancel') }}</NButton><NButton type="primary" @click="confirm">{{ t('common.confirm') }}</NButton></div></template>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.model-picker-body { display: flex; min-width: 0; flex-direction: column; gap: calc(12px * var(--spacing-scale, 1)); }
.model-picker-toolbar { display: flex; align-items: center; gap: calc(8px * var(--spacing-scale, 1)); flex-wrap: wrap; }
.model-picker-toolbar span { flex: 1; color: $text-secondary; font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
.model-picker-tree { height: clamp(120px, 45vh, 420px); max-height: calc(100dvh - 280px); overflow: auto; }
.model-picker-tree :deep(.n-tree-node-content__text) { white-space: normal; overflow-wrap: anywhere; }
.model-picker-footer { display: flex; justify-content: flex-end; gap: calc(8px * var(--spacing-scale, 1)); }
</style>
