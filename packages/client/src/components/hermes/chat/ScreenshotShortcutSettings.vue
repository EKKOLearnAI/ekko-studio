<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { NButton, NModal, NRadio, NRadioGroup } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { DesktopScreenshotShortcutBridge } from '@/utils/desktop-bridge'
import { screenshotAccelerator } from '@/utils/screenshot-shortcut'

const props = defineProps<{ bridge: DesktopScreenshotShortcutBridge; targetId: string; platform: string; canHide: boolean }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const accelerator = ref('')
const hideWindows = ref(false)
const loading = ref(true)
const saving = ref(false)
const error = ref('')
let disposed = false

function errorMessage(key: string) {
  return t(key === 'hideUnavailable' ? 'chat.screenshot.hideUnavailable' : `chat.screenshot.shortcut.${key}`)
}

onMounted(async () => {
  try {
    await props.bridge.setEditing(props.targetId, true)
    const state = await props.bridge.getState()
    if (disposed) return
    accelerator.value = state.accelerator
    hideWindows.value = state.hideWindows && props.canHide
    if (state.error) error.value = errorMessage(state.error)
  } catch { error.value = t('chat.screenshot.shortcut.saveFailed') }
  finally { loading.value = false }
})

function record(event: KeyboardEvent) {
  if (loading.value || saving.value || event.repeat || event.isComposing) return
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return
  if (!event.ctrlKey && !event.altKey && !event.metaKey) {
    if (event.key === 'Escape') { event.preventDefault(); emit('close'); return }
    if (event.key === 'Tab') return
  }
  event.preventDefault()
  const value = screenshotAccelerator(event, props.platform)
  if (!value) { error.value = t('chat.screenshot.shortcut.invalid'); return }
  accelerator.value = value
  error.value = ''
}

async function save() {
  if (loading.value || saving.value) return
  saving.value = true
  error.value = ''
  try {
    const state = await props.bridge.save({ accelerator: accelerator.value, hideWindows: hideWindows.value })
    if (disposed) return
    if (state.error) error.value = errorMessage(state.error)
    else emit('close')
  } catch { if (!disposed) error.value = t('chat.screenshot.shortcut.saveFailed') }
  finally { saving.value = false }
}

onUnmounted(() => {
  disposed = true
  void props.bridge.setEditing(props.targetId, false).catch(() => undefined)
})
</script>

<template>
  <NModal :show="true" preset="card" class="screenshot-shortcut-dialog" style="width: min(460px, calc(100vw - 32px))" :title="t('chat.screenshot.shortcut.settings')" :mask-closable="!saving" :close-on-esc="!saving" :closable="!saving" @close="emit('close')" @update:show="value => { if (!value && !saving) emit('close') }">
    <p class="shortcut-description">{{ t('chat.screenshot.shortcut.description') }}</p>
    <label class="shortcut-label" :for="`screenshot-shortcut-${targetId}`">{{ t('chat.screenshot.shortcut.key') }}</label>
    <div class="shortcut-recorder">
      <input :id="`screenshot-shortcut-${targetId}`" class="shortcut-key" readonly :value="accelerator.replace('Control', 'Ctrl').replace('Command', 'Cmd').replace(/\+/g, ' + ')" :placeholder="t('chat.screenshot.shortcut.record')" :disabled="loading || saving" @keydown.stop="record" @keyup.stop>
      <NButton :disabled="loading || saving || !accelerator" @click="accelerator = ''; error = ''">{{ t('chat.screenshot.shortcut.clear') }}</NButton>
    </div>
    <p class="shortcut-hint">{{ t('chat.screenshot.shortcut.hint') }}</p>
    <NRadioGroup v-model:value="hideWindows" :disabled="loading || saving" :aria-label="t('chat.screenshot.shortcut.mode')">
      <div class="shortcut-modes">
        <NRadio :value="false">{{ t('chat.screenshot.action') }}</NRadio>
        <NRadio :value="true" :disabled="!canHide">{{ t('chat.screenshot.hideWindow') }}</NRadio>
      </div>
    </NRadioGroup>
    <p v-if="!canHide" class="shortcut-hint">{{ t('chat.screenshot.hideUnavailable') }}</p>
    <p v-if="error" class="shortcut-error" role="alert">{{ error }}</p>
    <template #footer>
      <div class="shortcut-actions">
        <NButton :disabled="saving" @click="emit('close')">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :disabled="loading" :loading="saving" @click="save">{{ t('common.save') }}</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.shortcut-description, .shortcut-hint { color: var(--text-secondary); }
.shortcut-label { display: block; margin-bottom: 8px; }
.shortcut-recorder { display: flex; gap: 8px; }
.shortcut-key {
  min-width: 0;
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-input);
  color: inherit;
  font: inherit;
  &:focus { outline: 2px solid var(--accent-primary); outline-offset: 1px; }
}
.shortcut-hint { font-size: 12px; }
.shortcut-modes { display: flex; flex-direction: column; gap: 8px; }
.shortcut-error { color: var(--error); }
.shortcut-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
