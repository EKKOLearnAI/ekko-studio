<script setup lang="ts">
import { usePageLoadingTask } from '@/composables/usePageLoading'
import { computed, h, onMounted, ref } from 'vue'
import { NButton, NDataTable, NForm, NFormItem, NInput, NModal, NSpace, NTag, useDialog, useMessage } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  connectMcuDeviceRemote,
  createMcuDevice,
  deleteMcuDevice,
  disconnectMcuDeviceRemote,
  fetchMcuDevices,
  updateMcuDeviceName,
  type McuDevice,
} from '@/api/studio/mcu-devices'

const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()
const purchaseUrl = 'https://ekkostudio.xyz/docs/hermes-esp32-intro/index.html'
const showAddModal = ref(false)
const loading = ref(false)
const saving = ref(false)
const connectingDeviceId = ref(0)
const editing = ref(false)
const devices = ref<McuDevice[]>([])
const form = ref({ name: '', device_code: '' })
const editForm = ref({ id: 0, name: '' })

function renderConnectionStatus(connected: boolean | undefined) {
  return h(NTag, {
    size: 'small',
    type: connected ? 'success' : 'default',
    bordered: false,
  }, { default: () => connected ? t('mcuDevices.connected') : t('mcuDevices.disconnected') })
}

const columns = computed<DataTableColumns<McuDevice>>(() => [
  {
    title: t('mcuDevices.name'),
    key: 'name',
    minWidth: 120,
    ellipsis: { tooltip: true },
  },
  {
    title: t('mcuDevices.deviceCode'),
    key: 'device_code',
    minWidth: 160,
    ellipsis: { tooltip: true },
  },
  {
    title: t('mcuDevices.channel'),
    key: 'is_official',
    width: 96,
    render(row) {
      return h(NTag, {
        size: 'small',
        type: row.is_official ? 'success' : 'warning',
        bordered: false,
      }, { default: () => row.is_official ? t('mcuDevices.official') : t('mcuDevices.unofficial') })
    },
  },
  {
    title: t('mcuDevices.lanStatus'),
    key: 'lan_connected',
    width: 96,
    render(row) {
      return renderConnectionStatus(row.lan_connected)
    },
  },
  {
    title: t('mcuDevices.remoteStatus'),
    key: 'remote_connected',
    width: 96,
    render(row) {
      return renderConnectionStatus(row.remote_connected)
    },
  },
  {
    title: t('mcuDevices.actions'),
    key: 'actions',
    width: 220,
    render(row) {
      return h(NSpace, { size: 4, wrap: false }, {
        default: () => [
          h(NButton, {
            size: 'tiny',
            quaternary: true,
            disabled: saving.value,
            onClick: () => openEditModal(row),
          }, { default: () => t('mcuDevices.edit') }),
          h(NButton, {
            size: 'tiny',
            quaternary: true,
            type: row.remote_connected ? 'warning' : 'primary',
            loading: connectingDeviceId.value === row.id,
            disabled: connectingDeviceId.value !== 0 || saving.value || (!row.is_official && !row.remote_connected),
            onClick: () => toggleRemoteDevice(row),
          }, { default: () => row.remote_connected ? t('mcuDevices.remoteDisconnect') : t('mcuDevices.remoteConnect') }),
          h(NButton, {
            size: 'tiny',
            quaternary: true,
            type: 'error',
            disabled: saving.value,
            onClick: () => confirmDeleteDevice(row),
          }, { default: () => t('mcuDevices.delete') }),
        ],
      })
    },
  },
])

async function loadDevices() {
  if (loading.value) return
  loading.value = true
  try {
    const response = await fetchMcuDevices()
    devices.value = response.devices
  } catch (error: any) {
    message.error(error?.message || t('mcuDevices.loadFailed'))
  } finally {
    loading.value = false
  }
}

function openAddModal() {
  form.value = { name: '', device_code: '' }
  showAddModal.value = true
}

function openPurchasePage() {
  window.open(purchaseUrl, '_blank', 'noopener,noreferrer')
}

async function submitDevice(): Promise<boolean | void> {
  if (saving.value) return false
  const deviceCode = form.value.device_code.trim()
  if (!deviceCode) {
    message.warning(t('mcuDevices.deviceCodeRequired'))
    return false
  }

  saving.value = true
  try {
    const response = await createMcuDevice({
      name: form.value.name.trim(),
      device_code: deviceCode,
    })
    devices.value = response.devices
    form.value = { name: '', device_code: '' }
    showAddModal.value = false
    message.success(t('mcuDevices.added'))
  } catch (error: any) {
    message.error(error?.message || t('mcuDevices.addFailed'))
    return false
  } finally {
    saving.value = false
  }
}

function openEditModal(device: McuDevice) {
  editForm.value = { id: device.id, name: device.name }
  editing.value = true
}

async function submitEdit(): Promise<boolean | void> {
  if (!editForm.value.id || saving.value) return false
  saving.value = true
  try {
    const response = await updateMcuDeviceName(editForm.value.id, editForm.value.name.trim())
    devices.value = response.devices
    editing.value = false
    message.success(t('mcuDevices.nameUpdated'))
  } catch (error: any) {
    message.error(error?.message || t('mcuDevices.nameUpdateFailed'))
    return false
  } finally {
    saving.value = false
  }
}

async function toggleRemoteDevice(device: McuDevice) {
  if (connectingDeviceId.value !== 0) return
  connectingDeviceId.value = device.id
  try {
    const response = device.remote_connected
      ? await disconnectMcuDeviceRemote(device.id)
      : await connectMcuDeviceRemote(device.id)
    devices.value = response.devices
    message.success(t(device.remote_connected ? 'mcuDevices.remoteDisconnected' : 'mcuDevices.remoteConnected'))
  } catch (error: any) {
    message.error(error?.message || t(device.remote_connected ? 'mcuDevices.remoteDisconnectFailed' : 'mcuDevices.remoteConnectFailed'))
  } finally {
    connectingDeviceId.value = 0
  }
}

function confirmDeleteDevice(device: McuDevice) {
  dialog.warning({
    title: t('mcuDevices.deleteTitle'),
    content: t('mcuDevices.deleteConfirm', { name: device.name || device.device_code }),
    positiveText: t('mcuDevices.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      if (saving.value) return false
      saving.value = true
      try {
        const response = await deleteMcuDevice(device.id)
        devices.value = response.devices
        message.success(t('mcuDevices.deleted'))
      } catch (error: any) {
        message.error(error?.message || t('mcuDevices.deleteFailed'))
        return false
      } finally {
        saving.value = false
      }
    },
  })
}

const initializing = ref(true)
usePageLoadingTask(() => initializing.value)

onMounted(() => {
  void loadDevices().finally(() => { initializing.value = false })
})
</script>

<template>
  <section class="mcu-devices-panel">
    <header class="panel-header">
      <div class="panel-heading">
        <h2>{{ t('mcuDevices.title') }}</h2>
        <p>{{ t('mcuDevices.subtitle') }}</p>
      </div>
      <div class="panel-actions">
        <NButton size="small" :loading="loading" @click="loadDevices">
          {{ t('mcuDevices.refresh') }}
        </NButton>
        <NButton size="small" secondary @click="openPurchasePage">
          {{ t('mcuDevices.purchase') }}
        </NButton>
        <NButton size="small" type="primary" @click="openAddModal">
          {{ t('mcuDevices.add') }}
        </NButton>
      </div>
    </header>

    <div class="mcu-device-table">
      <NDataTable
        size="small"
        :columns="columns"
        :data="devices"
        :loading="loading"
        bordered
        :single-line="false"
        :row-key="(row: McuDevice) => row.id"
        :scroll-x="788"
        flex-height
      />
    </div>
  </section>

  <NModal
    v-model:show="showAddModal"
    preset="dialog"
    :title="t('mcuDevices.addTitle')"
    :positive-text="t('mcuDevices.add')"
    :negative-text="t('common.cancel')"
    :positive-button-props="{ loading: saving }"
    @positive-click="submitDevice"
  >
    <NForm label-placement="top">
      <NFormItem :label="t('mcuDevices.name')">
        <NInput v-model:value="form.name" :placeholder="t('mcuDevices.nameOptional')" :disabled="saving" />
      </NFormItem>
      <NFormItem :label="t('mcuDevices.deviceCode')" required>
        <NInput
          v-model:value="form.device_code"
          :placeholder="t('mcuDevices.deviceCodePlaceholder')"
          :disabled="saving"
          @keydown.enter.prevent="submitDevice"
        />
      </NFormItem>
    </NForm>
  </NModal>

  <NModal
    v-model:show="editing"
    preset="dialog"
    :title="t('mcuDevices.editNameTitle')"
    :positive-text="t('common.save')"
    :negative-text="t('common.cancel')"
    :positive-button-props="{ loading: saving }"
    @positive-click="submitEdit"
  >
    <NInput
      v-model:value="editForm.name"
      :placeholder="t('mcuDevices.nameOptional')"
      :disabled="saving"
      @keydown.enter.prevent="submitEdit"
    />
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.mcu-devices-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.panel-header {
  flex: 0 0 auto;
  min-height: 68px;
  padding: 12px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid $border-color;
}

.panel-heading {
  min-width: 0;

  h2 {
    margin: 0;
    color: $text-primary;
    font-size: 16px;
    font-weight: 650;
    line-height: 22px;
  }

  p {
    margin: 2px 0 0;
    color: $text-muted;
    font-size: 12px;
    line-height: 18px;
  }
}

.panel-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.mcu-device-table {
  flex: 1 1 auto;
  height: 0;
  min-height: 0;
  padding: 16px 20px 20px;
  overflow: hidden;

  :deep(.n-data-table) {
    height: 100%;
    --n-td-color: var(--bg-card);
    --n-th-color: var(--bg-secondary);
    --n-border-color: var(--border-color);
    --n-td-text-color: var(--text-primary);
    --n-th-text-color: var(--text-secondary);
  }

  :deep(.n-data-table-base-table),
  :deep(.n-data-table-base-table-body) {
    height: 100%;
  }
}

@media (max-width: $breakpoint-mobile) {
  .panel-header {
    align-items: flex-start;
    flex-direction: column;
    padding: 12px;
  }

  .panel-actions {
    width: 100%;
    justify-content: flex-start;
  }

  .mcu-device-table {
    padding: 12px;
  }
}
</style>
