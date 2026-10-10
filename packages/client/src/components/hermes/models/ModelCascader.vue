<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { NButton, NInput, NModal, NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { AvailableModelGroup } from '@/api/hermes/system'
import type { ProviderApiMode } from '@/api/studio/provider-api-mode'
import { useAppStore } from '@/stores/hermes/app'
import { modelCascaderGroups } from '@/utils/model-cascader'

const props = withDefaults(defineProps<{
  groups: AvailableModelGroup[]
  allowMoa?: boolean
  provider?: string
  model?: string
  show?: boolean
  triggerElement?: HTMLElement | null
  disabled?: boolean
  loading?: boolean
  removableCustom?: boolean
  closeOnSelect?: boolean
  title?: string
}>(), { provider: '', model: '', show: undefined, triggerElement: null, allowMoa: false, closeOnSelect: true, title: '' })
const emit = defineEmits<{
  'update:show': [show: boolean]
  select: [value: { provider: string; model: string; apiMode?: ProviderApiMode }]
}>()
const { t } = useI18n()
const appStore = useAppStore()
const inputThemeOverrides = {
  color: 'transparent',
  colorFocus: 'transparent',
  border: '1px solid var(--border-color)',
  borderHover: '1px solid var(--border-color)',
  borderFocus: '1px solid rgba(var(--accent-primary-rgb), 0.16)',
  boxShadowFocus: '0 0 0 2px rgba(var(--accent-primary-rgb), 0.08)',
  borderRadius: '8px',
}
const menuId = useId()
const internalShow = ref(false)
const shown = computed(() => !props.disabled && (props.show ?? internalShow.value))
const search = ref('')
const activeProvider = ref('')
const panel = ref<HTMLElement | null>(null)
let returnFocus: HTMLElement | null = null
const groups = computed(() => modelCascaderGroups(
  props.groups.filter(group => group.provider !== 'moa' || props.allowMoa),
  appStore.customModels,
  search.value,
  appStore.displayModelName,
))
const activeGroup = computed(() => groups.value.find(group => group.provider === activeProvider.value) || groups.value[0])

function setShow(show: boolean) {
  if (props.loading || (show && props.disabled)) return
  internalShow.value = show
  emit('update:show', show)
}
watch(shown, async show => {
  if (!show) return
  returnFocus = props.triggerElement || (document.activeElement instanceof HTMLElement ? document.activeElement : null)
  search.value = ''
  activeProvider.value = props.provider || props.groups[0]?.provider || ''
  await nextTick()
  focusPanel()
})
// Capture focus before Escape can reach an underlying mobile drawer.
watch(panel, element => { if (element) focusPanel() }, { flush: 'post' })
function focusPanel() {
  if (!shown.value) return
  panel.value?.focus()
  panel.value?.querySelector('.model-cascader-item.active')?.scrollIntoView({ block: 'nearest' })
}
function restoreFocus() {
  if (!shown.value && document.activeElement === document.body) returnFocus?.focus()
}
watch(groups, value => {
  if (!value.some(group => group.provider === activeProvider.value)) activeProvider.value = value[0]?.provider || ''
})

function selectProvider(provider: string) {
  if (props.loading) return
  activeProvider.value = provider
}
function selectModel(model: string) {
  const group = activeGroup.value
  if (!group || props.loading || group.model_meta?.[model]?.disabled) return
  emit('select', { model, provider: group.provider, apiMode: group.api_mode })
  if (props.closeOnSelect) setShow(false)
}
function isCustom(model: string) {
  return (appStore.customModels[activeGroup.value?.provider || ''] || []).includes(model)
}
function open(event: MouseEvent) {
  returnFocus = event.currentTarget as HTMLElement
  setShow(true)
}
function dismiss(event: KeyboardEvent) {
  event.preventDefault()
  event.stopPropagation()
  if (props.loading) return
  setShow(false)
}
function focusColumn(column: 'providers' | 'models') {
  const className = column === 'providers' ? 'model-cascader-provider' : 'model-cascader-item'
  const root = panel.value?.querySelector(`.model-cascader-${column}`)
  const target = root?.querySelector<HTMLElement>(`.${className}.active:not(:disabled)`) || root?.querySelector<HTMLElement>(`.${className}:not(:disabled)`)
  target?.focus()
}
function navigate(event: KeyboardEvent, column: 'providers' | 'models') {
  if (event.key === 'ArrowRight' && column === 'providers') { event.preventDefault(); focusColumn('models'); return }
  if (event.key === 'ArrowLeft' && column === 'models') { event.preventDefault(); focusColumn('providers'); return }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const className = column === 'providers' ? 'model-cascader-provider' : 'model-cascader-item'
  const buttons = [...(panel.value?.querySelectorAll<HTMLElement>(`.model-cascader-${column} .${className}:not(:disabled)`) || [])]
  const index = buttons.indexOf(event.target as HTMLElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  buttons[next]?.focus()
}
async function openWithKeyboard(event: KeyboardEvent) {
  event.preventDefault()
  returnFocus = event.currentTarget as HTMLElement
  setShow(true)
  await nextTick()
  focusColumn('providers')
}
</script>

<template>
  <slot name="trigger" :show="shown" :open="open" :open-with-keyboard="openWithKeyboard" />
  <NModal
    :show="shown" preset="card" class="model-cascader-modal" :aria-label="title || t('models.title')"
    :style="{ width: 'min(640px, calc(100vw - 24px))', height: 'min(560px, calc(100dvh - 24px))' }"
    :content-style="{ padding: '0', minHeight: '0', display: 'flex', overflow: 'hidden' }"
    :mask-closable="!loading" :close-on-esc="!loading" :closable="false" :bordered="false" :auto-focus="false"
    @update:show="setShow" @after-leave="restoreFocus"
  >
    <div ref="panel" class="model-cascader" role="group" :aria-label="title || t('models.title')" tabindex="-1" @keydown.esc="dismiss">
      <div class="model-cascader-search">
        <NInput v-model:value="search" :theme-overrides="inputThemeOverrides" :placeholder="t('models.searchPlaceholder')" :disabled="loading" clearable size="small" @keydown.down.prevent="focusColumn('providers')">
          <template #prefix>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
          </template>
        </NInput>
        <NButton class="model-cascader-close" size="small" quaternary circle :disabled="loading" :aria-label="t('common.close')" :title="t('common.close')" @click="setShow(false)">
          <template #icon>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </template>
        </NButton>
      </div>
      <NSpin class="model-cascader-lists" content-class="model-cascader-list-content" :show="loading" :description="t('chat.modelSwitching')">
        <div class="model-cascader-columns" :aria-busy="loading">
          <div class="model-cascader-column model-cascader-providers" role="menu" :aria-label="t('models.providerColumn')" @keydown="navigate($event, 'providers')">
            <div class="model-cascader-heading">{{ t('models.providerColumn') }}</div>
            <button v-for="group in groups" :key="group.provider" type="button" role="menuitem"
              class="model-cascader-provider" :class="{ active: group.provider === activeGroup?.provider }"
              :disabled="loading" :aria-expanded="group.provider === activeGroup?.provider" aria-haspopup="menu" :aria-controls="menuId"
              :title="group.label || group.provider" @focus="selectProvider(group.provider)" @click="selectProvider(group.provider)">
              <span>{{ group.provider === 'moa' ? t('chat.moaPresets') : group.label || group.provider }}</span>
              <small>{{ group.models.length }}</small><span aria-hidden="true">›</span>
            </button>
          </div>
          <div class="model-cascader-model-pane">
            <div :id="menuId" class="model-cascader-column model-cascader-models" role="menu" :aria-label="t('models.title')" @keydown="navigate($event, 'models')">
              <div class="model-cascader-heading" :title="activeGroup?.label">{{ activeGroup?.label || t('models.title') }}</div>
              <div v-for="model in activeGroup?.models || []" :key="model" class="model-cascader-model-row">
                <button type="button" role="menuitemradio" class="model-cascader-item"
                  :class="{ active: model === props.model && activeGroup?.provider === props.provider }"
                  :aria-checked="model === props.model && activeGroup?.provider === props.provider"
                  :aria-disabled="loading || !!activeGroup?.model_meta?.[model]?.disabled"
                  :disabled="loading || !!activeGroup?.model_meta?.[model]?.disabled"
                  :title="activeGroup?.model_meta?.[model]?.disabled ? t('models.disabledTooltip') : model" @click="selectModel(model)">
                  <span class="model-cascader-item-label">
                    <span>{{ appStore.displayModelName(model, activeGroup!.provider) }}</span>
                    <small v-if="appStore.getModelAlias(model, activeGroup!.provider)">{{ t('models.aliasCanonical', { model }) }}</small>
                    <span class="model-cascader-badges">
                      <small v-if="activeGroup?.model_meta?.[model]?.preview">{{ t('models.previewBadge') }}</small>
                      <small v-if="activeGroup?.model_meta?.[model]?.disabled">{{ t('models.disabledBadge') }}</small>
                      <small v-if="isCustom(model)">{{ t('models.customBadge') }}</small>
                    </span>
                  </span>
                  <span v-if="model === props.model && activeGroup?.provider === props.provider" aria-hidden="true">✓</span>
                </button>
                <button v-if="removableCustom && isCustom(model)" class="model-cascader-remove" type="button" :disabled="loading"
                  :aria-label="t('models.removeCustomModel')" :title="t('models.removeCustomModel')" @click="appStore.removeCustomModel(model, activeGroup!.provider)">×</button>
              </div>
              <div v-if="!activeGroup?.models.length" class="model-cascader-empty">{{ search ? t('models.noResults') : t('models.noModels') }}<slot name="empty" /></div>
            </div>
          </div>
        </div>
      </NSpin>
    </div>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.model-cascader-modal { background: $bg-card; border-radius: 14px; overflow: hidden; }
.model-cascader { display: flex; flex-direction: column; width: 100%; min-height: 0; color: $text-primary; outline: none; }
.model-cascader-search { display: flex; align-items: center; gap: 8px; padding: 14px; flex-shrink: 0; }
.model-cascader-search :deep(.n-input) { flex: 1; min-width: 0; }
.model-cascader-close { flex-shrink: 0; }
.model-cascader-lists { flex: 1; min-height: 0; margin: 0 12px 12px; border: 1px solid $border-color; border-radius: 10px; overflow: hidden; }
.model-cascader-lists :deep(.model-cascader-list-content) { height: 100%; }
.model-cascader-columns { display: grid; grid-template-columns: minmax(0, 38%) minmax(0, 1fr); height: 100%; min-height: 0; }
.model-cascader-column { overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; padding: 6px; min-width: 0; min-height: 0; }
.model-cascader-model-pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-inline-start: 1px solid $border-color; overflow: hidden; }
.model-cascader-models { flex: 1; }
.model-cascader-heading { padding: 6px 8px 8px; color: $text-muted; font-size: 11px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-cascader-provider, .model-cascader-item { display: flex; align-items: center; gap: 6px; width: 100%; padding: 8px; border: 0; border-radius: $radius-sm; background: transparent; color: $text-secondary; cursor: pointer; text-align: start; font: inherit; font-size: 12px;
  &:hover:not(:disabled) { background: $bg-secondary; color: $text-primary; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: -2px; }
  &.active { color: $accent-primary; background: rgba(var(--accent-primary-rgb), 0.08); }
  &:disabled { opacity: 0.45; cursor: not-allowed; }
}
.model-cascader-provider > span:first-child { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-cascader-provider small { color: $text-muted; }
.model-cascader-model-row { display: flex; align-items: center; }
.model-cascader-item { flex: 1; min-width: 0; }
.model-cascader-item-label { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; overflow-wrap: anywhere;
  > small { color: $text-muted; font-size: 10px; }
}
.model-cascader-badges { display: flex; flex-wrap: wrap; gap: 4px; color: $text-muted; font-size: 10px; &:empty { display: none; } }
.model-cascader-remove { border: 0; border-radius: $radius-sm; background: transparent; color: $text-muted; cursor: pointer; padding: 4px; &:hover { color: $error; } }
.model-cascader-empty { display: flex; flex-direction: column; align-items: center; padding: 24px 8px; font-size: 12px; color: $text-muted; text-align: center; }
@media (max-width: 600px) {
  .model-cascader-provider > span:first-child { white-space: normal; overflow-wrap: anywhere; }
  .model-cascader-provider small { display: none; }
}
@media (max-width: 480px) {
  .model-cascader-search { padding: 10px; }
  .model-cascader-lists { margin: 0 8px 8px; }
  .model-cascader-columns { grid-template-columns: minmax(0, 35%) minmax(0, 1fr); }
}
</style>
