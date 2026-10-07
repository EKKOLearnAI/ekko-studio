<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { NButton, NDropdown, NModal, NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { desktopBridge } from '@/utils/desktop-bridge'

const props = defineProps<{ disabled?: boolean; mobile?: boolean }>()
const emit = defineEmits<{ capture: [file: File] }>()
const { t } = useI18n()
const desktop = desktopBridge()
const screenshot = desktop?.isDesktop ? desktop.screenshot : undefined
const available = typeof screenshot?.captureRegion === 'function' && typeof screenshot.cancel === 'function'
const busy = ref(false)
const error = ref('')
const options = computed(() => [{ key: 'hide-window', label: t('chat.screenshot.hideWindow'), disabled: busy.value || props.disabled }])
let requestId: string | null = null
let disposed = false

async function start(hideWindows = false) {
  if (!available || !screenshot || busy.value || props.disabled) return
  const id = crypto.randomUUID()
  requestId = id
  busy.value = true
  error.value = ''
  try {
    const result = await screenshot.captureRegion({
      requestId: id,
      hideWindows,
      labels: {
        hint: t('chat.screenshot.regionHint'),
        confirm: t('chat.screenshot.done'),
        cancel: t('common.cancel'),
        reset: t('chat.screenshot.reset'),
        tools: Object.fromEntries(['select', 'rectangle', 'ellipse', 'arrow', 'pen', 'text', 'mosaic', 'undo', 'redo', 'color', 'lineWidth', 'textPlaceholder'].map(key => [key, t(`chat.screenshot.tools.${key}`)])),
      },
    })
    if (disposed || !result) return
    if (!result.dataUrl.startsWith('data:image/png;base64,')) throw new Error('SCREENSHOT_CAPTURE_FAILED')
    const bytes = Uint8Array.from(atob(result.dataUrl.slice('data:image/png;base64,'.length)), char => char.charCodeAt(0))
    const file = new File([bytes], `screenshot-${Date.now()}-${id.slice(0, 8)}.png`, { type: 'image/png' })
    emit('capture', file)
  } catch (reason) {
    if (disposed) return
    const detail = reason instanceof Error ? reason.message : String(reason)
    const key = detail.includes('SCREENSHOT_PERMISSION_DENIED') ? 'permissionDenied'
      : detail.includes('SCREENSHOT_SOURCE_UNAVAILABLE') ? 'sourceUnavailable'
      : 'failed'
    error.value = t(`chat.screenshot.${key}`)
  } finally {
    requestId = null
    busy.value = false
  }
}

function selectOption(key: string | number) {
  if (key === 'hide-window') void start(true)
}

onUnmounted(() => {
  disposed = true
  if (requestId) void screenshot?.cancel(requestId).catch(() => undefined)
})
</script>

<template>
  <span v-if="available" class="screenshot-controls">
    <NTooltip trigger="hover" :disabled="mobile || busy">
      <template #trigger>
        <NButton
          quaternary size="tiny" circle class="toolbar-icon-button screenshot-button"
          :aria-label="t('chat.screenshot.action')"
          :disabled="disabled || busy"
          :loading="busy"
          @click="start(false)"
        >
          <template #icon>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/>
              <rect x="7" y="7" width="10" height="10" rx="1"/>
            </svg>
          </template>
        </NButton>
      </template>
      {{ t('chat.screenshot.action') }}
    </NTooltip>
    <NDropdown trigger="click" placement="top-start" :options="options" :disabled="disabled || busy" @select="selectOption">
      <NButton
        quaternary size="tiny" class="screenshot-options-button"
        :aria-label="t('chat.screenshot.options')" aria-haspopup="menu"
        :disabled="disabled || busy"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </NButton>
    </NDropdown>
  </span>
  <NModal
    v-if="available"
    :show="!!error"
    preset="dialog"
    :title="t('chat.screenshot.title')"
    :positive-text="t('common.ok')"
    @positive-click="error = ''"
    @update:show="value => { if (!value) error = '' }"
  >
    <p role="alert">{{ error }}</p>
  </NModal>
</template>

<style scoped lang="scss">
.screenshot-controls {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 1px;
}

.screenshot-options-button {
  width: 16px;
  min-width: 16px;
  height: 24px;
  padding: 0;
}
</style>
