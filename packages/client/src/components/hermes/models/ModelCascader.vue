<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { NButton, NInput, NPopover, NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { AvailableModelGroup } from '@/api/hermes/system'
import type { ProviderApiMode } from '@/api/studio/provider-api-mode'
import { useAppStore } from '@/stores/hermes/app'
import { modelCascaderGroups } from '@/utils/model-cascader'

const props = withDefaults(defineProps<{
  groups: AvailableModelGroup[]
  provider?: string
  model?: string
  show?: boolean
  anchor?: HTMLElement | null
  x?: number
  y?: number
  disabled?: boolean
  loading?: boolean
  allowCustom?: boolean
  removableCustom?: boolean
  closeOnSelect?: boolean
  title?: string
  placement?: 'top-start' | 'bottom-start' | 'right-start'
}>(), { provider: '', model: '', show: undefined, anchor: null, allowCustom: true, closeOnSelect: true, placement: 'bottom-start', title: '' })
const emit = defineEmits<{
  'update:show': [show: boolean]
  select: [value: { provider: string; model: string; apiMode?: ProviderApiMode }]
}>()
const { t } = useI18n()
const appStore = useAppStore()
const menuId = useId()
const internalShow = ref(false)
const shown = computed(() => !props.disabled && (props.show ?? internalShow.value))
const search = ref('')
const customInput = ref('')
const activeProvider = ref('')
const panel = ref<HTMLElement | null>(null)
const position = ref({ x: 0, y: 0 })
let returnFocus: HTMLElement | null = null
const manual = computed(() => Boolean(props.anchor) || props.x !== undefined)
const groups = computed(() => modelCascaderGroups(props.groups, appStore.customModels, search.value, appStore.displayModelName))
const activeGroup = computed(() => groups.value.find(group => group.provider === activeProvider.value) || groups.value[0])
const canAddCustom = computed(() => props.allowCustom && activeGroup.value && activeGroup.value.provider !== 'moa')

function setShow(show: boolean) {
  if (props.loading || (show && props.disabled)) return
  internalShow.value = show
  emit('update:show', show)
}
function syncPosition() {
  const menuWidth = Math.min(500, window.innerWidth - 24)
  const clampX = (x: number) => Math.max(12, Math.min(x, window.innerWidth - menuWidth - 12))
  if (!props.anchor) {
    position.value = { x: clampX(props.x ?? 12), y: props.y ?? 0 }
    return
  }
  if (!props.anchor.isConnected) { setShow(false); return }
  const rect = props.anchor.getBoundingClientRect()
  position.value = { x: clampX(rect.left), y: props.placement === 'top-start' ? rect.top : rect.bottom }
}
function handleScroll(event: Event) {
  if (panel.value?.contains(event.target as Node)) return
  syncPosition()
}
function removeListeners() {
  window.removeEventListener('resize', syncPosition)
  window.removeEventListener('scroll', handleScroll, true)
}
onBeforeUnmount(removeListeners)
watch(shown, async show => {
  removeListeners()
  if (!show) {
    if (panel.value?.contains(document.activeElement)) returnFocus?.focus()
    return
  }
  returnFocus = props.anchor || (document.activeElement instanceof HTMLElement ? document.activeElement : null)
  search.value = ''
  customInput.value = ''
  activeProvider.value = props.provider || props.groups[0]?.provider || ''
  syncPosition()
  window.addEventListener('resize', syncPosition)
  window.addEventListener('scroll', handleScroll, true)
  await nextTick()
  if (!shown.value) return
  if (window.matchMedia('(max-width: 600px)').matches) panel.value?.focus()
  else panel.value?.querySelector<HTMLInputElement>('.model-cascader-search input')?.focus()
  panel.value?.querySelector('.model-cascader-item.active')?.scrollIntoView({ block: 'nearest' })
})
watch(groups, value => {
  if (!value.some(group => group.provider === activeProvider.value)) activeProvider.value = value[0]?.provider || ''
})
watch(() => props.anchor, syncPosition)

function selectProvider(provider: string) {
  if (props.loading) return
  activeProvider.value = provider
  customInput.value = ''
}
function selectModel(model: string) {
  const group = activeGroup.value
  if (!group || props.loading || group.model_meta?.[model]?.disabled) return
  emit('select', { model, provider: group.provider, apiMode: group.api_mode })
  if (props.closeOnSelect) setShow(false)
}
function submitCustom() {
  const model = customInput.value.trim()
  if (model && canAddCustom.value) selectModel(model)
}
function isCustom(model: string) {
  return (appStore.customModels[activeGroup.value?.provider || ''] || []).includes(model)
}
function handleOutside(event: MouseEvent) {
  if (props.anchor?.contains(event.target as Node)) return
  setShow(false)
}
function dismiss(event: KeyboardEvent) {
  event.preventDefault()
  event.stopPropagation()
  if (props.loading) return
  setShow(false)
  returnFocus?.focus()
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
  <NPopover
    :show="shown" :trigger="manual ? 'manual' : 'click'" :placement="placement"
    :x="manual ? position.x : undefined" :y="manual ? position.y : undefined"
    :disabled="disabled" :show-arrow="false" :style="{ padding: '0', maxWidth: 'calc(100vw - 24px)' }"
    @update:show="setShow" @clickoutside="handleOutside"
  >
    <template v-if="$slots.trigger" #trigger>
      <slot name="trigger" :show="shown" :open-with-keyboard="openWithKeyboard" />
    </template>
    <div ref="panel" class="model-cascader" role="group" :aria-label="title || t('models.title')" tabindex="-1" @keydown.esc="dismiss">
      <div class="model-cascader-search">
        <NInput v-model:value="search" :placeholder="t('models.searchPlaceholder')" :disabled="loading" clearable size="small" @keydown.down.prevent="focusColumn('providers')" />
      </div>
      <NSpin :show="loading" :description="t('chat.modelSwitching')">
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
      </NSpin>
      <div v-if="canAddCustom" class="model-cascader-custom">
        <div class="model-cascader-custom-row">
          <NInput v-model:value="customInput" size="small" :placeholder="t('models.customModelPlaceholder')" :disabled="loading" @keydown.enter.stop.prevent="submitCustom" />
          <NButton size="small" :disabled="loading || !customInput.trim()" @click="submitCustom">{{ t('common.confirm') }}</NButton>
        </div>
        <div class="model-cascader-hint">{{ t('models.customModelHint') }}</div>
      </div>
    </div>
  </NPopover>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.model-cascader { width: min(500px, calc(100vw - 24px)); max-height: calc(100dvh - 24px); color: $text-primary; outline: none; }
.model-cascader-search { padding: 10px; }
.model-cascader-columns { display: grid; grid-template-columns: minmax(0, 38%) minmax(0, 1fr); border-top: 1px solid $border-color; }
.model-cascader-column { max-height: min(320px, 40dvh); min-height: 120px; overflow-y: auto; scrollbar-width: thin; padding: 4px; min-width: 0; }
.model-cascader-providers { border-inline-end: 1px solid $border-color; }
.model-cascader-heading { padding: 6px 8px; color: $text-muted; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
.model-cascader-custom { padding: 10px; border-top: 1px solid $border-color; }
.model-cascader-custom-row { display: flex; gap: 8px; }
.model-cascader-hint { margin-top: 6px; font-size: 10px; color: $text-muted; }
@media (max-width: 600px) {
  .model-cascader-provider > span:first-child { white-space: normal; overflow-wrap: anywhere; }
  .model-cascader-provider small { display: none; }
}
</style>
