<script setup lang="ts">
/**
 * UsbDetailDrawer - 右侧抽屉
 * 折叠 4 个 section：设备详情 / 运行状态 / 最近活动 / 最近错误
 * 持久化"上次展开的 section" 到 localStorage
 */
import { computed, watch } from 'vue'
import { NButton, NDrawer, NDrawerContent, NEmpty, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { USBDeviceRecord, USBEventRecord, USBServiceRuntimeStatus } from '@/api/studio/usb-socket'
import USBEventHistory from './USBEventHistory.vue'

export type UsbDetailSection = 'details' | 'runtime' | 'activity' | 'errors'

const STORAGE_KEY = 'hermes.usb.detailDrawerSection'

const props = defineProps<{
  show: boolean
  section: UsbDetailSection
  device: USBDeviceRecord | null
  runtime: USBServiceRuntimeStatus | null
  events: USBEventRecord[]
  runtimeState: string
  formatTime: (value: string | null | undefined) => string
  formatBytes: (value: number | null | undefined) => string
  deviceTitle: (device: USBDeviceRecord) => string
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  'update:section': [value: UsbDetailSection]
  pickDevice: [uuid: string]
}>()

const { t } = useI18n()

const sectionList = computed(() => [
  { key: 'details' as UsbDetailSection, label: t('usb.page.details') },
  { key: 'runtime' as UsbDetailSection, label: t('usb.page.runtimeTitle') },
  {
    key: 'activity' as UsbDetailSection,
    label: t('usb.page.history.title'),
    badge: props.events.length,
  },
  { key: 'errors' as UsbDetailSection, label: t('usb.page.lastError') },
])

const lastError = computed(() => {
  return props.runtime?.lastError || props.device?.error || ''
})

watch(
  () => props.section,
  (next) => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(STORAGE_KEY, next)
      }
    } catch {
      // ignore quota / privacy errors
    }
  },
)

function loadPersistedSection(): UsbDetailSection | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    const value = window.localStorage.getItem(STORAGE_KEY)
    if (!value) return null
    if (['details', 'runtime', 'activity', 'errors'].includes(value)) {
      return value as UsbDetailSection
    }
    return null
  } catch {
    return null
  }
}

function setSection(next: UsbDetailSection) {
  emit('update:section', next)
}

function close() {
  emit('update:show', false)
}

function initSection() {
  const persisted = loadPersistedSection()
  if (persisted) emit('update:section', persisted)
}

initSection()
</script>

<template>
  <NDrawer
    :show="props.show"
    :width="380"
    placement="right"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <NDrawerContent
      :title="t('usb.page.drawer.title')"
      :native-scrollbar="false"
      closable
    >
      <template #header>
        <div class="drawer-header">
          <span class="drawer-kicker">{{ t('usb.page.drawer.kicker') }}</span>
          <h3 class="drawer-title">{{ t('usb.page.drawer.title') }}</h3>
          <span v-if="props.device" class="drawer-subtitle">
            {{ props.deviceTitle(props.device) }}
          </span>
        </div>
      </template>

      <nav class="drawer-nav">
        <button
          v-for="section in sectionList"
          :key="section.key"
          type="button"
          class="drawer-nav-item"
          :class="{ active: props.section === section.key }"
          @click="setSection(section.key)"
        >
          <span class="drawer-nav-label">{{ section.label }}</span>
          <span v-if="section.badge !== undefined" class="drawer-nav-badge">{{ section.badge }}</span>
        </button>
      </nav>

      <div v-if="props.section === 'details'" class="drawer-pane">
        <div v-if="!props.device" class="drawer-empty">
          <NEmpty :description="t('usb.page.selectDevice')" size="small" />
        </div>
        <dl v-else class="drawer-list">
          <div><dt>{{ t('usb.page.name') }}</dt><dd>{{ props.deviceTitle(props.device) }}</dd></div>
          <div><dt>{{ t('usb.page.mountPoint') }}</dt><dd>{{ props.device.mountPoint || t('usb.page.unknown') }}</dd></div>
          <div><dt>{{ t('usb.page.fsType') }}</dt><dd>{{ props.device.fsType || t('usb.page.unknown') }}</dd></div>
          <div><dt>{{ t('usb.page.size') }}</dt><dd>{{ props.formatBytes(props.device.sizeBytes) }}</dd></div>
          <div><dt>{{ t('usb.page.vendor') }}</dt><dd>{{ props.device.vendor || t('usb.page.unknown') }}</dd></div>
          <div><dt>{{ t('usb.page.model') }}</dt><dd>{{ props.device.model || t('usb.page.unknown') }}</dd></div>
          <div><dt>{{ t('usb.page.serial') }}</dt><dd>{{ props.device.serial || t('usb.page.unknown') }}</dd></div>
          <div><dt>{{ t('usb.page.deviceNode') }}</dt><dd>{{ props.device.deviceNode }}</dd></div>
          <div><dt>{{ t('usb.page.lastUpdated') }}</dt><dd>{{ props.formatTime(props.device.ts) }}</dd></div>
        </dl>
      </div>

      <div v-else-if="props.section === 'runtime'" class="drawer-pane">
        <dl class="drawer-list">
          <div>
            <dt>{{ t('usb.page.runtimeLabel') }}</dt>
            <dd>
              <NTag size="small" round :type="props.runtimeState === 'running' ? 'success' : props.runtimeState === 'error' ? 'error' : 'default'">
                {{ t(`usb.page.runtime.${props.runtimeState}`) }}
              </NTag>
            </dd>
          </div>
          <div><dt>{{ t('usb.page.lastReadyAt') }}</dt><dd>{{ props.formatTime(props.runtime?.lastReadyAt || null) }}</dd></div>
          <div><dt>{{ t('usb.page.lastHeartbeatAt') }}</dt><dd>{{ props.formatTime(props.runtime?.lastHeartbeatAt || null) }}</dd></div>
        </dl>
      </div>

      <div v-else-if="props.section === 'activity'" class="drawer-pane">
        <USBEventHistory :events="props.events" @pick-device="emit('pickDevice', $event)" />
      </div>

      <div v-else-if="props.section === 'errors'" class="drawer-pane">
        <div v-if="!lastError" class="drawer-empty">
          <NEmpty :description="t('usb.page.none')" size="small" />
        </div>
        <pre v-else class="drawer-error">{{ lastError }}</pre>
      </div>

      <template #footer>
        <NButton size="small" @click="close">{{ t('usb.page.drawer.close') }}</NButton>
      </template>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.drawer-header {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.drawer-kicker {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: $text-muted;
}

.drawer-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: $text-primary;
}

.drawer-subtitle {
  font-size: 11.5px;
  color: $text-muted;
  word-break: break-word;
}

.drawer-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 0 12px;
  border-bottom: 1px solid $border-light;
  margin-bottom: 12px;
}

.drawer-nav-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  background: transparent;
  border: none;
  border-radius: $radius-sm;
  color: $text-secondary;
  font-family: inherit;
  font-size: 12.5px;
  cursor: pointer;
  text-align: start;
  transition: background $transition-fast, color $transition-fast;

  &:hover {
    background: var(--theme-card-bg, var(--bg-card));
    color: $text-primary;
  }

  &.active {
    background: rgba(var(--accent-info-rgb), 0.12);
    color: var(--accent-info);
  }
}

.drawer-nav-label {
  flex: 1;
}

.drawer-nav-badge {
  background: var(--theme-card-bg, var(--bg-card));
  color: $text-muted;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.drawer-nav-item.active .drawer-nav-badge {
  background: rgba(var(--accent-info-rgb), 0.2);
  color: var(--accent-info);
}

.drawer-pane {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.drawer-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;

  div {
    display: flex;
    align-items: baseline;
    gap: 10px;
    font-size: 12.5px;
  }

  dt {
    flex: 0 0 96px;
    color: $text-muted;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  dd {
    flex: 1;
    min-width: 0;
    margin: 0;
    color: $text-primary;
    word-break: break-word;
  }
}

.drawer-empty {
  padding: 24px 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.drawer-error {
  margin: 0;
  padding: 12px;
  background: var(--theme-input-bg, var(--bg-input));
  border: 1px solid rgba(var(--error-rgb), 0.3);
  border-radius: $radius-sm;
  color: $error;
  font-family: $font-code;
  font-size: 11.5px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 360px;
  overflow: auto;
}
</style>