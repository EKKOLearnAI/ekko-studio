<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { NButton, NDropdown, NModal, NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { desktopBridge } from '@/utils/desktop-bridge'
import ScreenshotShortcutSettings from './ScreenshotShortcutSettings.vue'

const props = defineProps<{ disabled?: boolean; mobile?: boolean }>()
const emit = defineEmits<{ capture: [file: File] }>()
const { t } = useI18n()
const desktop = desktopBridge()
const screenshot = desktop?.isDesktop ? desktop.screenshot : undefined
const shortcut = screenshot?.shortcut
const targetId = shortcut ? crypto.randomUUID() : ''
const controls = ref<HTMLElement | null>(null)
const settingsOpen = ref(false)
const shortcutKey = ref('')
const available = typeof screenshot?.captureRegion === 'function' && typeof screenshot.cancel === 'function'
const busy = ref(false)
const error = ref('')
const capabilities = ref<{ capture: string; hideWindows: boolean } | null>(null)
const checking = ref(typeof screenshot?.getCapabilities === 'function')
const supported = computed(() => capabilities.value?.capture !== 'unavailable')
const canHide = computed(() => capabilities.value?.hideWindows ?? !checking.value)
const options = computed(() => [{
  key: 'hide-window',
  label: t(capabilities.value?.hideWindows === false ? 'chat.screenshot.hideUnavailable' : 'chat.screenshot.hideWindow'),
  disabled: busy.value || props.disabled || checking.value || !canHide.value || !supported.value,
}, ...(shortcut ? [{ key: 'shortcut-settings', label: t('chat.screenshot.shortcut.settings'), disabled: busy.value || checking.value }] : [])])
let requestId: string | null = null
let disposed = false
let composer: Element | null = null
let removeTrigger: (() => void) | undefined
let removeStateChange: (() => void) | undefined

function activateTarget() {
  void shortcut?.setTarget(targetId, true).catch(() => undefined)
}

onMounted(() => {
  if (!available || !shortcut) return
  removeTrigger = shortcut.onTrigger(request => {
    if (request.targetId === targetId && !disposed && !settingsOpen.value) void start(request.hideWindows)
  })
  removeStateChange = shortcut.onStateChange(state => { shortcutKey.value = state.accelerator })
  void shortcut.getState().then(state => { if (!disposed) shortcutKey.value = state.accelerator }).catch(() => undefined)
  void shortcut.setTarget(targetId, false).catch(() => undefined)
  composer = controls.value?.closest('.chat-input-area') ?? controls.value
  composer?.addEventListener('focusin', activateTarget)
  composer?.addEventListener('pointerdown', activateTarget)
})

onMounted(async () => {
  if (!screenshot?.getCapabilities) return
  try { capabilities.value = await screenshot.getCapabilities() }
  catch { capabilities.value = { capture: 'unavailable', hideWindows: false } }
  finally { checking.value = false }
})

async function start(hideWindows = false) {
  if (!available || !screenshot || busy.value || props.disabled || checking.value || !supported.value) return
  if (hideWindows && !canHide.value) { error.value = t('chat.screenshot.hideUnavailable'); return }
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
        tools: Object.fromEntries(['select', 'rectangle', 'ellipse', 'arrow', 'pen', 'text', 'mosaic', 'undo', 'redo', 'color', 'lineWidth', 'textPlaceholder', 'zoomIn', 'zoomOut', 'fit', 'source'].map(key => [key, t(`chat.screenshot.tools.${key}`)])),
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
      : detail.includes('SCREENSHOT_HIDE_UNAVAILABLE') ? 'hideUnavailable'
      : detail.includes('SCREENSHOT_PORTAL_UNAVAILABLE') ? 'systemUnavailable'
      : detail.includes('SCREENSHOT_TIMEOUT') ? 'timedOut'
      : 'failed'
    error.value = t(`chat.screenshot.${key}`)
  } finally {
    requestId = null
    busy.value = false
  }
}

function selectOption(key: string | number) {
  if (key === 'hide-window') void start(true)
  if (key === 'shortcut-settings' && shortcut && !busy.value) { activateTarget(); settingsOpen.value = true }
}

function cancelCurrent() {
  if (requestId) void screenshot?.cancel(requestId).catch(() => undefined)
}

onUnmounted(() => {
  disposed = true
  removeTrigger?.()
  removeStateChange?.()
  composer?.removeEventListener('focusin', activateTarget)
  composer?.removeEventListener('pointerdown', activateTarget)
  void shortcut?.setTarget(targetId, null).catch(() => undefined)
  if (requestId) void screenshot?.cancel(requestId).catch(() => undefined)
})
</script>

<template>
  <span v-if="available" ref="controls" class="screenshot-controls">
    <NTooltip trigger="hover" :disabled="mobile || busy">
      <template #trigger>
        <span class="screenshot-trigger">
        <NButton
          quaternary size="tiny" circle class="toolbar-icon-button screenshot-button"
          :aria-label="t(supported ? 'chat.screenshot.action' : 'chat.screenshot.systemUnavailable')"
          :disabled="disabled || busy || checking || !supported"
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
        </span>
      </template>
      {{ t(supported ? 'chat.screenshot.action' : 'chat.screenshot.systemUnavailable') }}
      <span v-if="shortcutKey"> ({{ shortcutKey }})</span>
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
    <span v-if="busy && capabilities?.capture === 'portal-screenshot'" class="system-wait" role="status">
      {{ t('chat.screenshot.systemWaiting') }}
      <NButton size="tiny" quaternary @click="cancelCurrent">{{ t('common.cancel') }}</NButton>
    </span>
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
  <ScreenshotShortcutSettings v-if="available && shortcut && settingsOpen" :bridge="shortcut" :target-id="targetId" :platform="desktop?.platform || ''" :can-hide="canHide" @close="settingsOpen = false" />
</template>

<style scoped lang="scss">
.screenshot-controls {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 1px;
}

.screenshot-trigger { display: inline-flex; }

.screenshot-options-button {
  width: 16px;
  min-width: 16px;
  height: 24px;
  padding: 0;
}

.system-wait {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}
</style>
