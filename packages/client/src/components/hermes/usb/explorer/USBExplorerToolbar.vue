<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NInput, NInputGroup, NTooltip, NIcon } from 'naive-ui'
import { useI18n } from 'vue-i18n'

export type ExplorerViewMode = 'icons' | 'list'

const props = defineProps<{
  canBack: boolean
  canForward: boolean
  canUp: boolean
  searchValue: string
  addressValue: string
  addressEditing: boolean
  viewMode: ExplorerViewMode
  onAdvanced: () => void
}>()

const emit = defineEmits<{
  back: []
  forward: []
  up: []
  refresh: []
  updateSearch: [value: string]
  updateAddress: [value: string]
  submitAddress: []
  toggleView: [mode: ExplorerViewMode]
  startEditAddress: []
  cancelEditAddress: []
}>()

const { t } = useI18n()

const addressPlaceholder = computed(() => t('usb.explorer.toolbar.addressBarPlaceholder'))
const searchPlaceholder = computed(() => t('usb.explorer.toolbar.searchPlaceholder'))

function handleAddressKey(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    event.preventDefault()
    emit('submitAddress')
  } else if (event.key === 'Escape') {
    event.preventDefault()
    emit('cancelEditAddress')
  }
}

function openAdvanced() {
  if (typeof props.onAdvanced === 'function') {
    props.onAdvanced()
  }
}
</script>

<template>
  <div class="usb-explorer-toolbar">
    <div class="toolbar-nav">
      <NTooltip :disabled="props.canBack" placement="bottom">
        <template #trigger>
          <NButton
            size="small"
            quaternary
            :disabled="!props.canBack"
            :title="t('usb.explorer.toolbar.back')"
            @click="emit('back')"
          >
            <NIcon>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </NIcon>
          </NButton>
        </template>
        {{ t('usb.explorer.nav.backDisabledHint') }}
      </NTooltip>

      <NTooltip :disabled="props.canForward" placement="bottom">
        <template #trigger>
          <NButton
            size="small"
            quaternary
            :disabled="!props.canForward"
            :title="t('usb.explorer.toolbar.forward')"
            @click="emit('forward')"
          >
            <NIcon>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </NIcon>
          </NButton>
        </template>
        {{ t('usb.explorer.nav.forwardDisabledHint') }}
      </NTooltip>

      <NTooltip :disabled="props.canUp" placement="bottom">
        <template #trigger>
          <NButton
            size="small"
            quaternary
            :disabled="!props.canUp"
            :title="t('usb.explorer.toolbar.up')"
            @click="emit('up')"
          >
            <NIcon>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="18 15 12 9 6 15" />
              </svg>
            </NIcon>
          </NButton>
        </template>
        {{ t('usb.explorer.nav.upDisabledHint') }}
      </NTooltip>

      <NButton
        size="small"
        quaternary
        :title="t('usb.explorer.toolbar.refresh')"
        @click="emit('refresh')"
      >
        <NIcon>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </NIcon>
      </NButton>
    </div>

    <div class="toolbar-address">
      <NInputGroup>
        <NInput
          v-if="props.addressEditing"
          :value="props.addressValue"
          :placeholder="addressPlaceholder"
          size="small"
          autofocus
          @update:value="emit('updateAddress', $event)"
          @blur="emit('cancelEditAddress')"
          @keydown="handleAddressKey"
        />
        <NInput
          v-else
          :value="props.addressValue"
          readonly
          size="small"
          @click="emit('startEditAddress')"
        />
      </NInputGroup>
    </div>

    <div class="toolbar-search">
      <NInput
        :value="props.searchValue"
        :placeholder="searchPlaceholder"
        size="small"
        clearable
        @update:value="emit('updateSearch', $event)"
      >
        <template #prefix>
          <NIcon>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </NIcon>
        </template>
      </NInput>
    </div>

    <div class="toolbar-view">
      <NButton
        size="small"
        quaternary
        :type="props.viewMode === 'icons' ? 'primary' : 'default'"
        :title="t('usb.explorer.toolbar.viewIcons')"
        @click="emit('toggleView', 'icons')"
      >
        <NIcon>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
        </NIcon>
      </NButton>
      <NButton
        size="small"
        quaternary
        :type="props.viewMode === 'list' ? 'primary' : 'default'"
        :title="t('usb.explorer.toolbar.viewList')"
        @click="emit('toggleView', 'list')"
      >
        <NIcon>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="8" y1="6" x2="21" y2="6" />
            <line x1="8" y1="12" x2="21" y2="12" />
            <line x1="8" y1="18" x2="21" y2="18" />
            <line x1="3" y1="6" x2="3.01" y2="6" />
            <line x1="3" y1="12" x2="3.01" y2="12" />
            <line x1="3" y1="18" x2="3.01" y2="18" />
          </svg>
        </NIcon>
      </NButton>

      <NButton
        size="small"
        ghost
        type="primary"
        :title="t('usb.page.advanced')"
        class="toolbar-advanced"
        data-testid="usb-advanced"
        @click.stop="openAdvanced"
      >
        <template #icon>
          <NIcon>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </NIcon>
        </template>
        {{ t('usb.page.advanced') }}
      </NButton>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.usb-explorer-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: var(--theme-card-bg, var(--bg-card));
}

.toolbar-nav {
  flex: 0 0 auto;
}

.toolbar-address {
  flex: 1 1 auto;
  min-width: 200px;
}

.toolbar-search {
  flex: 0 1 260px;
  min-width: 160px;
}

.toolbar-view {
  flex: 0 0 auto;
}

.toolbar-nav,
.toolbar-view {
  display: flex;
  align-items: center;
  gap: 4px;
}

.toolbar-advanced {
  border-color: rgba(var(--accent-info-rgb), 0.4);
}

.toolbar-address :deep(.n-input) {
  font-family: $font-code;
}

@media (max-width: $breakpoint-mobile) {
  .usb-explorer-toolbar {
    flex-wrap: wrap;
  }
  .toolbar-search {
    flex: 1 1 100%;
    order: 5;
  }
}
</style>