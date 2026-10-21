<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NAlert, NButton, NEmpty, NForm, NFormItem, NInput, NModal, NTag, useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { usePageLoadingTask } from '@/composables/usePageLoading'
import { desktopBridge, type DesktopRemoteDevice, type DesktopRemoteDevicesState } from '@/utils/desktop-bridge'

const { t } = useI18n()
const dialog = useDialog()
const message = useMessage()
const bridge = desktopBridge()!.remoteDevices!
const state = ref<DesktopRemoteDevicesState | null>(null)
const loading = ref(true)
const busy = ref(false)
const switching = ref(false)
const showAdd = ref(false)
const error = ref('')
const formError = ref('')
const form = ref({ name: '', serverUrl: '' })
const disabled = computed(() => loading.value || busy.value || switching.value)
usePageLoadingTask(() => loading.value)

function errorMessage(cause: unknown): string {
  const code = (cause instanceof Error ? cause.message : String(cause)).match(/REMOTE_DEVICE_([A-Z_]+)/)?.[1]
  const keys: Record<string, string> = {
    INVALID_NAME: 'invalidName', INVALID_URL: 'invalidUrl', DUPLICATE: 'duplicate',
    ACTIVE: 'activeHint', UNREACHABLE: 'unreachable', LIMIT: 'limit',
    UNSUPPORTED_PATH: 'unsupportedPath',
  }
  return t(`remoteDevices.${keys[code || ''] || 'failed'}`)
}

async function load() {
  loading.value = true
  error.value = ''
  try { state.value = await bridge.list() } catch (cause) { error.value = errorMessage(cause) }
  finally { loading.value = false }
}

function openAdd() {
  form.value = { name: '', serverUrl: '' }
  formError.value = ''
  showAdd.value = true
}

async function add() {
  formError.value = ''
  if (!form.value.name.trim()) { formError.value = t('remoteDevices.invalidName'); return }
  busy.value = true
  try {
    state.value = await bridge.add({ ...form.value })
    showAdd.value = false
    message.success(t('remoteDevices.saved'))
  } catch (cause) { formError.value = errorMessage(cause) }
  finally { busy.value = false }
}

function remove(device: DesktopRemoteDevice) {
  dialog.warning({
    title: t('remoteDevices.deleteTitle'),
    content: t('remoteDevices.deleteConfirm', { name: device.name }),
    positiveText: t('common.delete'), negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      busy.value = true
      error.value = ''
      try { state.value = await bridge.remove(device.id) }
      catch (cause) { error.value = errorMessage(cause) }
      finally { busy.value = false }
    },
  })
}

function switchTo(device: DesktopRemoteDevice | null) {
  dialog.warning({
    title: t('remoteDevices.switchTitle', { name: device?.name || t('remoteDevices.local') }),
    content: t('remoteDevices.switchHint'),
    positiveText: t('remoteDevices.restart'), negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      switching.value = true
      error.value = ''
      try { await bridge.switchTo(device?.id ?? null) }
      catch (cause) {
        error.value = errorMessage(cause)
        switching.value = false
      }
    },
  })
}

onMounted(load)
</script>

<template>
  <section class="remote-devices-panel" data-testid="remote-devices-panel" :aria-busy="disabled">
    <div class="remote-toolbar">
      <div>
        <h3>{{ t('remoteDevices.title') }}</h3>
        <p class="remote-hint">{{ t('remoteDevices.description') }}</p>
      </div>
      <div class="remote-actions">
        <NButton :disabled="disabled" @click="load">{{ t('remoteDevices.refresh') }}</NButton>
        <NButton type="primary" :disabled="disabled || !state" @click="openAdd">{{ t('remoteDevices.add') }}</NButton>
      </div>
    </div>

    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <NAlert v-if="switching" type="info" role="status">{{ t('remoteDevices.switching') }}</NAlert>

    <template v-if="state">
      <article class="remote-device" data-theme-surface="card" data-testid="remote-device-local">
        <div class="remote-device-info">
          <strong>{{ t('remoteDevices.local') }}</strong>
          <p class="remote-hint">{{ t('remoteDevices.localHint') }}</p>
        </div>
        <NTag v-if="!state.activeServerUrl" type="success" :bordered="false">{{ t('remoteDevices.current') }}</NTag>
        <NButton v-else :disabled="disabled" @click="switchTo(null)">{{ t('remoteDevices.connect') }}</NButton>
      </article>

      <NEmpty v-if="!state.devices.length" :description="t('remoteDevices.empty')" class="remote-empty" />

      <article v-for="device in state.devices" :key="device.id" class="remote-device" data-theme-surface="card" :data-testid="`remote-device-${device.id}`">
        <div class="remote-device-info">
          <strong>{{ device.name }}</strong>
          <p class="remote-url">{{ device.serverUrl }}</p>
          <p v-if="state.activeDeviceId === device.id" class="remote-hint">{{ t('remoteDevices.activeHint') }}</p>
        </div>
        <div class="remote-actions">
          <NTag v-if="state.activeDeviceId === device.id" type="success" :bordered="false">{{ t('remoteDevices.current') }}</NTag>
          <NButton v-else :disabled="disabled" @click="switchTo(device)">{{ t('remoteDevices.connect') }}</NButton>
          <NButton :disabled="disabled || state.activeDeviceId === device.id" :aria-label="t('remoteDevices.deleteTitle') + ' ' + device.name" @click="remove(device)">{{ t('common.delete') }}</NButton>
        </div>
      </article>
    </template>

    <NModal v-model:show="showAdd" preset="card" :title="t('remoteDevices.add')" class="remote-device-modal" :mask-closable="!busy" :close-on-esc="!busy" :closable="!busy">
      <NForm @submit.prevent="add">
        <NFormItem :label="t('remoteDevices.name')" :label-props="{ for: 'remote-device-name' }">
          <NInput v-model:value="form.name" :input-props="{ id: 'remote-device-name' }" :placeholder="t('remoteDevices.namePlaceholder')" :maxlength="80" :disabled="busy" autofocus />
        </NFormItem>
        <NFormItem :label="t('remoteDevices.url')" :label-props="{ for: 'remote-device-url' }">
          <NInput v-model:value="form.serverUrl" :input-props="{ id: 'remote-device-url' }" placeholder="http://192.168.1.20:6060" :maxlength="2048" :disabled="busy" />
        </NFormItem>
        <p class="remote-hint">{{ t('remoteDevices.urlHint') }}</p>
        <NAlert v-if="formError" type="error" role="alert">{{ formError }}</NAlert>
        <div class="remote-form-actions">
          <NButton :disabled="busy" @click="showAdd = false">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" attr-type="submit" :loading="busy" :disabled="busy">{{ t('common.save') }}</NButton>
        </div>
      </NForm>
    </NModal>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.remote-devices-panel {
  height: 100%;
  box-sizing: border-box;
  overflow-y: auto;
  padding: calc(20px * var(--spacing-scale, 1));
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.remote-toolbar, .remote-device, .remote-actions, .remote-form-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.remote-toolbar, .remote-device { justify-content: space-between; }
.remote-toolbar h3 { margin: 0; font-size: 16px; }
.remote-device {
  padding: 16px;
  flex-shrink: 0;
  background: $bg-card;
  color: $text-primary;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
}
.remote-device-info { min-width: 0; flex: 1; }
.remote-hint, .remote-url { margin: 6px 0 0; color: $text-secondary; line-height: 1.6; overflow-wrap: anywhere; }
.remote-actions { flex-shrink: 0; flex-wrap: wrap; }
.remote-empty { padding: 32px 0; }
.remote-device-modal { width: min(480px, calc(100vw - 32px)); }
.remote-form-actions { justify-content: flex-end; margin-top: 20px; }

@media (max-width: $breakpoint-mobile) {
  .remote-devices-panel { padding: 12px; }
  .remote-toolbar, .remote-device { align-items: flex-start; flex-direction: column; }
}
</style>
