<script setup lang="ts">
/**
 * UsbHeaderBadge - 顶部设备状态徽章
 * 单行展示当前选中设备 + 多设备下拉切换 + 状态徽章
 */
import { computed } from 'vue'
import { NDropdown, NTag, type DropdownOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { USBDeviceRecord } from '@/api/studio/usb-socket'
import { formatExplorerBytes } from '@/utils/usb-format'
import type { UsbDetailSection } from './UsbDetailDrawer.vue'

const props = defineProps<{
  device: USBDeviceRecord
  devices: USBDeviceRecord[]
}>()

const emit = defineEmits<{
  pick: [uuid: string]
  openDrawer: [section: UsbDetailSection]
}>()

const { t } = useI18n()

const statusTone = computed(() => {
  if (props.device.status === 'mount_failed') return 'error' as const
  if (props.device.status === 'removed') return 'warning' as const
  return 'success' as const
})

const statusLabel = computed(() => t(`usb.page.status.${props.device.status}`))

const sizeLabel = computed(() => formatExplorerBytes(props.device.sizeBytes) || '—')

const dropdownOptions = computed<DropdownOption[]>(() => {
  return props.devices.map((d) => ({
    key: d.uuid,
    label: (d.label?.trim() || d.uuid) + (d.uuid === props.device.uuid ? ` · ${t('usb.page.currentDevice')}` : ''),
  }))
})

function handleDropdown(key: string) {
  if (key !== props.device.uuid) emit('pick', key)
}
</script>

<template>
  <div class="usb-header-badge">
    <NDropdown
      trigger="click"
      :options="dropdownOptions"
      @select="handleDropdown"
    >
      <button class="badge-trigger" type="button">
        <span class="badge-dot" :class="`is-${props.device.status}`" />
        <span class="badge-name">{{ props.device.label?.trim() || props.device.uuid }}</span>
        <span class="badge-meta">{{ props.device.fsType || '·' }} · {{ sizeLabel }}</span>
        <span class="badge-caret">▾</span>
      </button>
    </NDropdown>
    <NTag size="tiny" round :type="statusTone">{{ statusLabel }}</NTag>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.usb-header-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.badge-trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--bg-card, rgba(var(--text-primary-rgb), 0.04));
  border: 1px solid $border-light;
  border-radius: 999px;
  font-family: inherit;
  font-size: 12.5px;
  color: $text-primary;
  cursor: pointer;
  transition: border-color $transition-fast, background $transition-fast;

  &:hover {
    border-color: $border-color;
    background: var(--theme-card-bg, var(--bg-card));
  }
}

.badge-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: $text-muted;
  flex: 0 0 auto;

  &.is-mounted { background: $success; }
  &.is-mount_failed { background: $error; }
  &.is-ejecting,
  &.is-removing,
  &.is-removed { background: $warning; }
}

.badge-name {
  font-weight: 600;
}

.badge-meta {
  color: $text-muted;
  font-variant-numeric: tabular-nums;
  font-size: 11.5px;
}

.badge-caret {
  color: $text-muted;
  font-size: 11px;
}
</style>