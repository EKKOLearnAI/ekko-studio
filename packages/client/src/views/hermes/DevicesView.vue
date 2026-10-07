<script setup lang="ts">
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { computed, onMounted, ref } from 'vue'
import { NButton, NDrawer, NDrawerContent, NInput, NModal, NPopconfirm, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { copyToClipboard } from '@/utils/clipboard'
import {
  approveDevice,
  blockDevice,
  deleteDeviceRequestHistory,
  fetchDevicePairingLink,
  fetchLanDevices,
  rejectDevice,
  requestDevicePairing,
  requestDevicePairingByUrl,
  scanLanDevices,
  unblockDevice,
  type DeviceInboundStatus,
  type DeviceOutboundStatus,
  type LanDeviceInfo,
  type LanDiscoveryState,
  type LanEndpointKind,
} from '@/api/studio/devices'

const { t } = useI18n()
const message = useMessage()

withDefaults(defineProps<{
  embedded?: boolean
}>(), {
  embedded: false,
})

const loading = ref(true)
const scanning = ref(false)
const manualPairing = ref(false)
const manualPairingUrl = ref('')
const updatingDeviceId = ref('')
const showRequests = ref(false)
const copyingPairingLink = ref(false)
const showPairingCodeModal = ref(false)
const pairingCodeInput = ref('')
const pendingPairingDevice = ref<LanDeviceInfo | null>(null)
const state = ref<LanDiscoveryState>({
  scanning: false,
  last_scanned_at: null,
  devices: [],
  requests: [],
})

const devices = computed(() =>
  [...state.value.devices].sort((a, b) => {
    const onlineOrder = Number(Boolean(b.online)) - Number(Boolean(a.online))
    if (onlineOrder !== 0) return onlineOrder
    const kindOrder = endpointOrder(a.endpoint_kind) - endpointOrder(b.endpoint_kind)
    if (kindOrder !== 0) return kindOrder
    return a.id.localeCompare(b.id)
  }),
)

const pairingRequesting = computed(() =>
  Boolean(pendingPairingDevice.value && updatingDeviceId.value === pendingPairingDevice.value.id),
)

function endpointOrder(kind: LanEndpointKind): number {
  if (kind === 'web') return 0
  if (kind === 'desktop') return 1
  return 2
}

function endpointLabel(kind: LanEndpointKind): string {
  return t(`devices.endpoint.${kind}`)
}

function endpointTagType(kind: LanEndpointKind) {
  if (kind === 'desktop') return 'success'
  if (kind === 'web') return 'info'
  return 'default'
}

function inboundStatusLabel(status: DeviceInboundStatus): string {
  return t(`devices.inboundStatus.${status}`)
}

function outboundStatusLabel(status: DeviceOutboundStatus): string {
  return t(`devices.outboundStatus.${status}`)
}

function pairedLabel(device: LanDeviceInfo): string {
  return device.outbound_status === 'approved' ? t('devices.paired') : outboundStatusLabel(device.outbound_status)
}

function pairedTagType(device: LanDeviceInfo) {
  if (device.outbound_status === 'approved') return 'success'
  if (device.outbound_status === 'pending') return 'info'
  if (device.outbound_status === 'blocked') return 'error'
  if (device.outbound_status === 'rejected') return 'warning'
  return 'default'
}

function onlineLabel(device: LanDeviceInfo): string {
  return device.online ? t('devices.online') : t('devices.offline')
}

function onlineTagType(device: LanDeviceInfo) {
  return device.online ? 'success' : 'default'
}

function canRequestPairing(device: LanDeviceInfo): boolean {
  return Boolean(device.online) && (device.outbound_status === 'none' || device.outbound_status === 'rejected')
}

function canBlock(device: LanDeviceInfo): boolean {
  return device.inbound_status !== 'blocked'
}

function requestCountLabel(): string {
  return state.value.requests.length > 0
    ? t('devices.requestsWithCount', { count: state.value.requests.length })
    : t('devices.requests')
}

function requestProcessed(device: LanDeviceInfo): boolean {
  return device.inbound_status !== 'pending'
}

function requestProcessLabel(device: LanDeviceInfo): string {
  return requestProcessed(device) ? t('devices.processed') : t('devices.unprocessed')
}

function requestProcessTagType(device: LanDeviceInfo) {
  return requestProcessed(device) ? 'success' : 'warning'
}

function formatOs(device: LanDeviceInfo): string {
  const parts = [device.os.type || device.os.platform, device.os.release, device.os.arch]
    .filter(Boolean)
  return parts.join(' ')
}

function formatTime(value: string | number | null): string {
  if (!value) return t('devices.never')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString()
}

function formatVersion(value: string): string {
  return value || t('devices.unknown')
}

function safeDeviceUrl(value: string): string {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : ''
  } catch {
    return ''
  }
}

async function loadDevices() {
  loading.value = true
  try {
    state.value = await fetchLanDevices()
  } catch (err: any) {
    message.error(err?.message || t('devices.loadFailed'))
  } finally {
    loading.value = false
  }
}

async function refreshDevices() {
  scanning.value = true
  try {
    state.value = await scanLanDevices()
  } catch (err: any) {
    message.error(err?.message || t('devices.scanFailed'))
  } finally {
    scanning.value = false
  }
}

async function copyPairingLink() {
  copyingPairingLink.value = true
  try {
    const response = await fetchDevicePairingLink()
    const copied = await copyToClipboard(response.link)
    if (copied) {
      message.success(t('devices.pairingLinkCopied'))
    } else {
      message.error(t('devices.pairingLinkCopyFailed'))
    }
  } catch (err: any) {
    message.error(err?.message || t('devices.pairingLinkCopyFailed'))
  } finally {
    copyingPairingLink.value = false
  }
}

function openPairingCodeModal(device: LanDeviceInfo) {
  pendingPairingDevice.value = device
  pairingCodeInput.value = ''
  showPairingCodeModal.value = true
}

function resetPairingCodeModal() {
  showPairingCodeModal.value = false
  pairingCodeInput.value = ''
  pendingPairingDevice.value = null
}

function closePairingCodeModal() {
  if (pairingRequesting.value) return
  resetPairingCodeModal()
}

async function confirmPairingRequest() {
  const device = pendingPairingDevice.value
  if (!device || pairingRequesting.value) return

  const pairingCode = pairingCodeInput.value.trim()
  if (!pairingCode) {
    message.warning(t('devices.pairingCodeRequired'))
    return
  }

  updatingDeviceId.value = device.id
  try {
    state.value = await requestDevicePairing(device.id, pairingCode)
    resetPairingCodeModal()
  } catch (err: any) {
    if (String(err?.message || '').includes('Duplicate pairing request')) {
      message.warning(t('devices.duplicateRequest'))
      return
    }
    message.error(err?.message || t('devices.updateFailed'))
  } finally {
    updatingDeviceId.value = ''
  }
}

async function updateDevice(device: LanDeviceInfo, action: 'approve' | 'reject' | 'block' | 'unblock' | 'deleteHistory') {
  updatingDeviceId.value = device.id
  try {
    const next = action === 'approve'
      ? await approveDevice(device.id)
      : action === 'reject'
      ? await rejectDevice(device.id)
      : action === 'block'
      ? await blockDevice(device.id)
      : action === 'deleteHistory'
      ? await deleteDeviceRequestHistory(device.id)
      : await unblockDevice(device.id)
    state.value = next
  } catch (err: any) {
    message.error(err?.message || t('devices.updateFailed'))
  } finally {
    updatingDeviceId.value = ''
  }
}

async function requestManualPairing() {
  const url = manualPairingUrl.value.trim()
  if (!url) {
    message.warning(t('devices.manualUrlRequired'))
    return
  }
  manualPairing.value = true
  try {
    state.value = await requestDevicePairingByUrl(url)
    manualPairingUrl.value = ''
    message.success(t('devices.manualRequestSent'))
  } catch (err: any) {
    message.error(err?.message || t('devices.manualRequestFailed'))
  } finally {
    manualPairing.value = false
  }
}

onMounted(() => {
  void loadDevices()
})
</script>

<template>
  <PageLoading :show="loading" class="devices-view" :class="{ 'devices-view--embedded': embedded }">
    <PageHeader :disabled="embedded">
    <header class="page-header">
      <div class="header-heading">
        <h2 class="header-title">{{ t('devices.title') }}</h2>
        <p>{{ t('devices.subtitle') }}</p>
      </div>
      <div class="header-actions">
        <NInput
          v-model:value="manualPairingUrl"
          class="manual-pairing-input"
          size="small"
          clearable
          :placeholder="t('devices.manualUrlPlaceholder')"
          :disabled="manualPairing"
          @keyup.enter="requestManualPairing"
        />
        <NButton size="small" :loading="manualPairing" @click="requestManualPairing">
          {{ t('devices.manualPairing') }}
        </NButton>
        <NButton size="small" :loading="copyingPairingLink" @click="copyPairingLink">
          {{ t('devices.copyPairingLink') }}
        </NButton>
        <div class="header-meta">
          <span>{{ t('devices.count', { count: devices.length }) }}</span>
          <span>{{ t('devices.lastScanned', { time: formatTime(state.last_scanned_at) }) }}</span>
        </div>
        <NButton size="small" @click="showRequests = true">
          {{ requestCountLabel() }}
        </NButton>
        <NButton size="small" type="primary" :loading="scanning || state.scanning" @click="refreshDevices">
          {{ t('devices.refresh') }}
        </NButton>
      </div>
    </header>
    </PageHeader>

    <div class="devices-spin">
      <div class="devices-content">
        <div v-if="devices.length === 0 && !loading" class="empty-state">
          <div class="empty-title">{{ t('devices.empty') }}</div>
          <NButton size="small" :loading="scanning || state.scanning" @click="refreshDevices">
            {{ t('devices.refresh') }}
          </NButton>
        </div>

        <div v-else class="device-grid">
          <article v-for="device in devices" :key="device.id" class="device-card">
            <div class="device-card-header">
              <div class="device-title-block">
                <div class="device-name">{{ device.computer_name || device.ip }}</div>
                <a v-if="safeDeviceUrl(device.url)" class="device-link" :href="safeDeviceUrl(device.url)" target="_blank" rel="noopener noreferrer">
                  {{ device.ip }}:{{ device.http_port }}
                </a>
                <span v-else class="device-link">{{ device.ip }}:{{ device.http_port }}</span>
              </div>
              <NTag size="small" :type="endpointTagType(device.endpoint_kind)" round>
                    {{ endpointLabel(device.endpoint_kind) }}
              </NTag>
            </div>

            <div class="device-status-row">
              <NTag size="small" :type="onlineTagType(device)" round>
                {{ onlineLabel(device) }}
              </NTag>
              <NTag size="small" :type="pairedTagType(device)" round>
                {{ pairedLabel(device) }}
              </NTag>
              <NTag v-if="device.inbound_status === 'blocked'" size="small" type="error" round>
                {{ inboundStatusLabel(device.inbound_status) }}
              </NTag>
            </div>

            <dl class="device-meta-list">
              <div>
                <dt>{{ t('devices.os') }}</dt>
                <dd>{{ formatOs(device) || t('devices.unknown') }}</dd>
              </div>
              <div>
                <dt>{{ t('devices.agentVersion') }}</dt>
                <dd>{{ formatVersion(device.hermes_agent_version) }}</dd>
              </div>
              <div>
                <dt>{{ t('devices.webUiVersion') }}</dt>
                <dd>{{ formatVersion(device.hermes_web_ui_version) }}</dd>
              </div>
              <div>
                <dt>{{ t('devices.responseMs') }}</dt>
                <dd>{{ device.response_ms }}ms</dd>
              </div>
            </dl>

            <div class="device-actions">
              <NButton v-if="canRequestPairing(device)" size="tiny" type="primary" :loading="updatingDeviceId === device.id" @click="openPairingCodeModal(device)">
                {{ t('devices.requestPairing') }}
              </NButton>
              <NButton
                v-if="canBlock(device)"
                size="tiny"
                quaternary
                type="error"
                :loading="updatingDeviceId === device.id"
                @click="updateDevice(device, 'block')"
              >
                {{ t('devices.block') }}
              </NButton>
              <NButton
                v-else
                size="tiny"
                quaternary
                :loading="updatingDeviceId === device.id"
                @click="updateDevice(device, 'unblock')"
              >
                {{ t('devices.unblock') }}
              </NButton>
            </div>
          </article>
        </div>
      </div>
    </div>

    <NDrawer v-model:show="showRequests" width="var(--studio-drawer-width)" placement="right">
      <NDrawerContent :title="t('devices.requests')" closable>
        <div v-if="state.requests.length === 0" class="request-empty">
          {{ t('devices.noRequests') }}
        </div>
        <div v-else class="request-list">
          <article v-for="requestDevice in state.requests" :key="requestDevice.id" class="request-item">
            <div>
              <div class="request-name">{{ requestDevice.computer_name || requestDevice.ip }}</div>
              <div class="request-meta">{{ requestDevice.ip }}:{{ requestDevice.http_port }}</div>
              <div class="request-status-row">
                <NTag size="small" :type="requestProcessTagType(requestDevice)" round>
                  {{ requestProcessLabel(requestDevice) }}
                </NTag>
                <NTag size="small" :type="requestDevice.inbound_status === 'blocked' ? 'error' : requestDevice.inbound_status === 'rejected' ? 'warning' : requestDevice.inbound_status === 'approved' ? 'success' : 'info'" round>
                  {{ inboundStatusLabel(requestDevice.inbound_status) }}
                </NTag>
              </div>
            </div>
            <div class="request-actions">
              <NButton v-if="requestDevice.inbound_status === 'pending'" size="tiny" type="success" :loading="updatingDeviceId === requestDevice.id" @click="updateDevice(requestDevice, 'approve')">
                {{ t('devices.approve') }}
              </NButton>
              <NButton v-if="requestDevice.inbound_status === 'pending'" size="tiny" quaternary type="warning" :loading="updatingDeviceId === requestDevice.id" @click="updateDevice(requestDevice, 'reject')">
                {{ t('devices.reject') }}
              </NButton>
              <NButton v-if="requestDevice.inbound_status === 'pending'" size="tiny" quaternary type="error" :loading="updatingDeviceId === requestDevice.id" @click="updateDevice(requestDevice, 'block')">
                {{ t('devices.block') }}
              </NButton>
              <NPopconfirm @positive-click="updateDevice(requestDevice, 'deleteHistory')">
                <template #trigger>
                  <NButton size="tiny" quaternary type="error" :loading="updatingDeviceId === requestDevice.id">
                    {{ t('devices.deleteHistory') }}
                  </NButton>
                </template>
                {{ t('devices.deleteHistoryConfirm') }}
              </NPopconfirm>
            </div>
          </article>
        </div>
      </NDrawerContent>
    </NDrawer>

    <NModal v-model:show="showPairingCodeModal" :mask-closable="!pairingRequesting" @esc="closePairingCodeModal">
      <div class="pairing-code-dialog">
        <div class="pairing-code-title">{{ t('devices.pairingCodeTitle') }}</div>
        <NInput
          v-model:value="pairingCodeInput"
          clearable
          :placeholder="t('devices.pairingCodePlaceholder')"
          :disabled="pairingRequesting"
          @keyup.enter="confirmPairingRequest"
        />
        <div class="pairing-code-actions">
          <NButton :disabled="pairingRequesting" @click="closePairingCodeModal">
            {{ t('common.cancel') }}
          </NButton>
          <NButton
            type="primary"
            :loading="pairingRequesting"
            :disabled="!pairingCodeInput.trim()"
            @click="confirmPairingRequest"
          >
            {{ t('devices.submitPairingRequest') }}
          </NButton>
        </div>
      </div>
    </NModal>
  </PageLoading>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.devices-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.devices-view--embedded {
  .page-header {
    min-height: 68px;
    padding: 12px 20px;
  }
}

.header-heading {
  min-width: 0;

  p {
    margin: 2px 0 0;
    color: $text-muted;
    font-size: 12px;
    line-height: 18px;
  }
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.manual-pairing-input {
  width: 280px;
  max-width: min(280px, 100%);
}

.header-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  color: $text-muted;
  font-size: 12px;
  line-height: 1.2;
}

.devices-spin {
  flex: 1;
  min-height: 0;
}

.devices-content {
  height: 100%;
  overflow: auto;
  padding: 20px;
}

.empty-state {
  height: 100%;
  min-height: 280px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: $text-muted;
}

.empty-title {
  font-size: 14px;
}

.device-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}

.device-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 220px;
  padding: 14px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  background: $bg-card;
}

.device-card-header,
.device-status-row,
.device-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.device-card-header {
  justify-content: space-between;
}

.device-title-block {
  min-width: 0;
}

.device-name {
  color: $text-primary;
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.device-link {
  color: $accent-primary;
  font-size: 12px;
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
}

.device-meta-list {
  display: grid;
  gap: 8px;
  margin: 0;

  div {
    display: grid;
    grid-template-columns: 92px minmax(0, 1fr);
    gap: 8px;
  }

  dt {
    color: $text-muted;
    font-size: 12px;
  }

  dd {
    margin: 0;
    color: $text-secondary;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.device-actions {
  flex-wrap: wrap;
  margin-top: auto;
}

.request-empty {
  padding: 40px 0;
  color: $text-muted;
  text-align: center;
}

.request-list {
  display: grid;
  gap: 10px;
}

.request-item {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
}

.request-name {
  color: $text-primary;
  font-weight: 600;
}

.request-meta {
  color: $text-muted;
  font-size: 12px;
}

.request-status-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.request-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.pairing-code-dialog {
  width: min(420px, calc(100vw - 32px));
  display: grid;
  gap: 14px;
  padding: 20px;
  border-radius: $radius-sm;
  background: $bg-card;
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.24);
}

.pairing-code-title {
  color: $text-primary;
  font-size: 16px;
  font-weight: 600;
}

.pairing-code-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

@media (max-width: $breakpoint-mobile) {
  .page-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .devices-content {
    padding: 12px;
  }

  .devices-view--embedded .page-header {
    padding: 12px;
  }

  .header-actions {
    width: 100%;
    flex-wrap: wrap;
    justify-content: flex-start;
  }

  .header-meta {
    flex-basis: 100%;
  }
}
</style>
