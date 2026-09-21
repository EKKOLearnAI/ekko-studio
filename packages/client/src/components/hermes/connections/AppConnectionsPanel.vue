<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, ref, watch } from 'vue'
import { NAlert, NButton, NDataTable, NEmpty, NModal, NPopconfirm, NSpin, NSwitch, NTabPane, NTabs, NTag, useMessage } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import QRCode from 'qrcode'
import {
  createLanAppAuthorization,
  createCloudAppAuthorization,
  deleteAppConnection,
  fetchAppConnections,
  updateAppConnectionPush,
  type AppConnection,
  type AppConnectionAccessFailure,
  type CloudAppAuthorizationResponse,
  type LanAppAuthorizationResponse,
} from '@/api/studio/app-connections'
import {
  fetchAppRelayStatus,
  updateAppRelayRoute,
  type AppRelayRoute,
} from '@/api/studio/app-relay'
import { fetchStudioVersionManifest, type AppAccessMode, type StudioMobileRelease } from '@/api/studio/versions'
import SocialMessagesView from '@/views/social-messages/SocialMessagesView.vue'

type AppPanelView = 'list' | 'download' | 'messages'

function normalizePanelView(value: unknown): AppPanelView {
  if (value === 'list' || value === 'messages') return value
  return 'download'
}

const DISMISSED_ACCESS_FAILURE_KEY = 'hermes:app-access-failure-dismissed-at'
const APP_ACCESS_PURCHASE_URL = 'https://ekkostudio.xyz/pricing/'
const PURCHASE_REQUIRED_FAILURE_CODES = new Set([
  'cloud_subscription_required',
  'paid_account_required',
  'app_access_expired',
])
const DEFAULT_MOBILE_RELEASE: StudioMobileRelease = {
  version: '1.0.0',
  channels: {
    androidApk: {
      version: '1.0.0',
      githubUrl: 'https://github.com/EKKOLearnAI/hermes-studio/releases/download/v1.0.0/Ekko Studio.apk',
      cloudflareUrl: 'https://download.ekkolearnai.com/v1.0.0/Ekko Studio.apk',
      online: true,
    },
    googlePlay: { version: '1.0.0', url: '', online: false },
    apple: { version: '1.0.0', testFlightUrl: '', appStoreUrl: '', online: false },
    harmony: { url: '', online: false },
  },
}

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const message = useMessage()
const loading = ref(false)
const panelView = ref<AppPanelView>(normalizePanelView(route.query.view))
const downloadSource = ref<'github' | 'cloudflare'>('cloudflare')
const mobileRelease = ref<StudioMobileRelease>(DEFAULT_MOBILE_RELEASE)
const connections = ref<AppConnection[]>([])
const accessFailure = ref<AppConnectionAccessFailure | null>(null)
const dismissedAccessFailureAt = ref(readDismissedAccessFailureAt())
const showScanModal = ref(false)
const connectionTab = ref<'lan' | 'cloud'>('lan')
const cloudRelayRoute = ref<AppRelayRoute>('official')
const appAccessMode = ref<AppAccessMode | null>(null)
const cloudRelayRouteLoading = ref(false)
const authorizationLoading = ref<Record<'lan' | 'cloud', boolean>>({ lan: false, cloud: false })
const deletingConnectionId = ref<number | null>(null)
const updatingPushIds = ref(new Set<number>())
let pushPreferenceRevision = 0
const lanAuthorization = ref<LanAppAuthorizationResponse | null>(null)
const cloudAuthorization = ref<CloudAppAuthorizationResponse | null>(null)
const qrCodeDataUrls = ref<Record<'lan' | 'cloud', string>>({ lan: '', cloud: '' })
type DownloadQrChannel = 'androidApk' | 'googlePlay' | 'apple'
const downloadQrCodeDataUrls = ref<Record<DownloadQrChannel, string>>({
  androidApk: '',
  googlePlay: '',
  apple: '',
})
const currentTimestamp = ref(Math.floor(Date.now() / 1000))
let countdownTimer: ReturnType<typeof setInterval> | null = null
let connectionPollTimer: ReturnType<typeof setInterval> | null = null
let scanConnectionVersions = new Map<string, number>()
let connectionsRequestInFlight = false

const CONNECTION_POLL_INTERVAL_MS = 3_000
const APP_RELAY_ROUTE_OPTIONS = [
  { value: 'official' as const, label: 'connections.app.officialRoute' },
  { value: 'cloudflare' as const, label: 'connections.app.cloudflareRoute' },
]

const androidVersionLabel = computed(() => formatMobileVersion(mobileRelease.value.channels.androidApk.version))
const googlePlayVersionLabel = computed(() => formatMobileVersion(mobileRelease.value.channels.googlePlay.version))
const iosVersionLabel = computed(() => formatMobileVersion(mobileRelease.value.channels.apple.version))
const appPurchaseEnabled = computed(() => appAccessMode.value === 'paid')
const androidDownloadUrl = computed(() => {
  const channel = mobileRelease.value.channels.androidApk
  const selectedUrl = downloadSource.value === 'cloudflare' ? channel.cloudflareUrl : channel.githubUrl
  return selectedUrl || channel.cloudflareUrl || channel.githubUrl
})
const googlePlayDownloadUrl = computed(() => {
  const channel = mobileRelease.value.channels.googlePlay
  return channel.url
})
const appleUsesOfficialRelease = computed(() => Boolean(
  mobileRelease.value.channels.apple.online
  && mobileRelease.value.channels.apple.appStoreUrl,
))
const appleDownloadUrl = computed(() => {
  const channel = mobileRelease.value.channels.apple
  return appleUsesOfficialRelease.value
    ? channel.appStoreUrl
    : channel.testFlightUrl || channel.appStoreUrl
})
const appleReleaseLabel = computed(() => {
  const channel = mobileRelease.value.channels.apple
  if (appleUsesOfficialRelease.value && channel.appStoreUrl) return 'App Store'
  if (channel.testFlightUrl) return 'TestFlight'
  if (channel.appStoreUrl) return 'App Store'
  return t('connections.app.iosPending')
})

function formatMobileVersion(version: string): string {
  return version ? `v${version.replace(/^v/i, '')}` : ''
}
const activeAuthorization = computed(() => connectionTab.value === 'lan'
  ? lanAuthorization.value
  : cloudAuthorization.value)
const activeQrCodeDataUrl = computed(() => qrCodeDataUrls.value[connectionTab.value])
const remainingSeconds = computed(() => Math.max(
  0,
  (activeAuthorization.value?.expires_at || 0) - currentTimestamp.value,
))
const authorizationExpired = computed(() => Boolean(activeAuthorization.value) && remainingSeconds.value === 0)
const remainingTime = computed(() => {
  const minutes = Math.floor(remainingSeconds.value / 60).toString().padStart(2, '0')
  const seconds = (remainingSeconds.value % 60).toString().padStart(2, '0')
  return `${minutes}:${seconds}`
})
const accessFailureReason = computed(() => {
  const failure = accessFailure.value
  if (!failure) return ''
  if (failure.code === 'cloud_subscription_required') {
    return t('connections.app.accessFailures.cloudSubscriptionRequired')
  }
  if (failure.code === 'paid_account_required') {
    return t('connections.app.accessFailures.paidAccountRequired')
  }
  if (failure.code === 'app_access_expired') {
    return t('connections.app.accessFailures.appAccessExpired')
  }
  if (failure.plan === 'internal' || failure.plan === 'public_beta') {
    return t('connections.app.accessFailures.tokenExpired')
  }
  if (failure.plan === 'paid' && failure.code === 'app_entitlement_expired') {
    if (failure.tokenTtlSeconds === 0) {
      return t('connections.app.accessFailures.paidAccountRequired')
    }
    return t('connections.app.accessFailures.tokenExpired')
  }
  const reasonKeys: Record<string, string> = {
    app_entitlement_required: 'required',
    app_entitlement_invalid: 'invalid',
    app_entitlement_expired: 'expired',
    app_entitlement_account_mismatch: 'accountMismatch',
    app_entitlement_device_mismatch: 'deviceMismatch',
  }
  return t(`connections.app.accessFailures.${reasonKeys[failure.code] || 'unknown'}`)
})
const accessFailureMode = computed(() => {
  const plan = accessFailure.value?.plan || 'unknown'
  const knownPlan = plan === 'internal' || plan === 'public_beta' || plan === 'paid' ? plan : 'unknown'
  return t(`connections.app.accessModes.${knownPlan}`)
})
const accessFailureTime = computed(() => {
  const occurredAt = Number(accessFailure.value?.occurredAt || 0)
  if (!occurredAt) return ''
  return new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(occurredAt))
})
const accessFailureRequiresPurchase = computed(() => {
  const failure = accessFailure.value
  if (!failure) return false
  if (PURCHASE_REQUIRED_FAILURE_CODES.has(failure.code)) return true
  return failure.plan === 'paid'
    && failure.code === 'app_entitlement_expired'
    && failure.tokenTtlSeconds === 0
})

const columns = computed<DataTableColumns<AppConnection>>(() => [
  {
    title: t('connections.app.deviceName'),
    key: 'device_name',
    minWidth: 160,
    ellipsis: { tooltip: true },
  },
  {
    title: t('connections.app.deviceCode'),
    key: 'device_code',
    minWidth: 200,
    ellipsis: { tooltip: true },
  },
  {
    title: t('connections.app.deviceBrand'),
    key: 'device_brand',
    minWidth: 120,
    ellipsis: { tooltip: true },
    render(row) {
      return row.device_brand || '-'
    },
  },
  {
    title: t('connections.app.deviceModel'),
    key: 'device_model',
    minWidth: 160,
    ellipsis: { tooltip: true },
    render(row) {
      return row.device_model || '-'
    },
  },
  {
    title: t('connections.app.connectionType'),
    key: 'connection_type',
    width: 140,
    render(row) {
      return t(`connections.app.connectionTypes.${row.connection_type}`)
    },
  },
  {
    title: t('connections.app.authorizedUser'),
    key: 'username',
    minWidth: 140,
    ellipsis: { tooltip: true },
    render(row) {
      return row.username || '-'
    },
  },
  {
    title: t('connections.app.connectionStatus'),
    key: 'online',
    width: 120,
    render(row) {
      if (row.online == null) return '-'
      return h(NTag, {
        size: 'small',
        type: row.online ? 'success' : 'default',
        bordered: false,
      }, { default: () => t(row.online ? 'connections.app.online' : 'connections.app.offline') })
    },
  },
  {
    title: t('connections.app.authorizationStatus'),
    key: 'active',
    width: 110,
    render(row) {
      return h(NTag, {
        size: 'small',
        type: row.active ? 'success' : 'default',
        bordered: false,
      }, { default: () => t(row.active ? 'connections.app.active' : 'connections.app.expired') })
    },
  },
  {
    title: t('connections.app.pushNotifications'),
    key: 'push_enabled',
    width: 120,
    fixed: 'right',
    render(row) {
      return h(NSwitch, {
        value: row.push_enabled !== false,
        loading: updatingPushIds.value.has(row.id),
        disabled: row.can_manage_push === false || updatingPushIds.value.has(row.id),
        'aria-disabled': row.can_manage_push === false || updatingPushIds.value.has(row.id),
        'aria-label': t('connections.app.pushForDevice', { name: row.device_name || row.device_code }),
        onUpdateValue: (value: boolean) => updatePushPreference(row, value),
      })
    },
  },
  {
    title: t('connections.app.actions'),
    key: 'actions',
    width: 100,
    fixed: 'right',
    render(row) {
      return h(NPopconfirm, {
        positiveText: t('connections.app.delete'),
        negativeText: t('common.cancel'),
        onPositiveClick: () => deleteConnection(row),
      }, {
        default: () => t('connections.app.deleteConfirm', { name: row.device_name || row.device_code }),
        trigger: () => h(NButton, {
          size: 'small',
          type: 'error',
          quaternary: true,
          loading: deletingConnectionId.value === row.id,
        }, { default: () => t('connections.app.delete') }),
      })
    },
  },
])

function connectionIdentity(connection: AppConnection): string {
  return `${connection.device_code}:${connection.connection_type}:${connection.cloud_user_id}`
}

async function loadConnections(options: { silent?: boolean; detectScanConnection?: boolean } = {}) {
  if (connectionsRequestInFlight) return
  connectionsRequestInFlight = true
  if (!options.silent) loading.value = true
  const preferenceRevision = pushPreferenceRevision
  try {
    const response = await fetchAppConnections()
    connections.value = response.connections.map(row => {
      // A polling response begun before a toggle must not undo its saved value.
      const current = connections.value.find(item => item.id === row.id)
      return current && (preferenceRevision !== pushPreferenceRevision || updatingPushIds.value.has(row.id))
        ? { ...row, push_enabled: current.push_enabled } : row
    })
    const nextFailure = response.access_failure || null
    const previousFailureAt = Number(accessFailure.value?.occurredAt || 0)
    const visibleFailure = nextFailure && nextFailure.occurredAt > dismissedAccessFailureAt.value
      ? nextFailure
      : null
    accessFailure.value = visibleFailure
    if (visibleFailure && visibleFailure.occurredAt > previousFailureAt && showScanModal.value) {
      showScanModal.value = false
      lanAuthorization.value = null
      cloudAuthorization.value = null
      qrCodeDataUrls.value = { lan: '', cloud: '' }
    }
    if (options.detectScanConnection && showScanModal.value) {
      const connected = response.connections.some(connection => (
        connection.active
        && connection.updated_at > (scanConnectionVersions.get(connectionIdentity(connection)) || 0)
      ))
      if (connected) {
        showScanModal.value = false
        lanAuthorization.value = null
        cloudAuthorization.value = null
        qrCodeDataUrls.value = { lan: '', cloud: '' }
        message.success(t('connections.app.connectionDetected'))
      }
    }
  } catch (error: any) {
    if (!options.silent) message.error(error?.message || t('connections.app.loadFailed'))
  } finally {
    connectionsRequestInFlight = false
    if (!options.silent) loading.value = false
  }
}

function readDismissedAccessFailureAt(): number {
  try {
    const value = Number(localStorage.getItem(DISMISSED_ACCESS_FAILURE_KEY) || 0)
    return Number.isFinite(value) && value > 0 ? value : 0
  } catch {
    return 0
  }
}

function dismissAccessFailure(): void {
  const occurredAt = Number(accessFailure.value?.occurredAt || 0)
  if (occurredAt > dismissedAccessFailureAt.value) {
    dismissedAccessFailureAt.value = occurredAt
    try {
      localStorage.setItem(DISMISSED_ACCESS_FAILURE_KEY, String(occurredAt))
    } catch {
      // The in-memory dismissal still prevents the polling loop from reopening it.
    }
  }
  accessFailure.value = null
}

function authorizationErrorMessage(error: any): string {
  const code = String(error?.message || '')
  if (code === 'preconnection_refresh_rate_limited') return t('connections.app.refreshTooSoon')
  if (code === 'preconnection_refresh_limit_reached') return t('connections.app.refreshLimitReached')
  if (code === 'preconnection_expired') return t('connections.app.preconnectionExpired')
  if (code === 'app_relay_unavailable') return t('connections.app.cloudUnavailable')
  return error?.message || t('connections.app.authorizationFailed')
}

async function generateAuthorization(type: 'lan' | 'cloud', refresh = false) {
  if (authorizationLoading.value[type]) return
  authorizationLoading.value = { ...authorizationLoading.value, [type]: true }
  try {
    const response = type === 'lan'
      ? await createLanAppAuthorization()
      : await createCloudAppAuthorization(refresh, cloudRelayRoute.value)
    const dataUrl = await QRCode.toDataURL(response.qr_payload, {
      width: 320,
      margin: 4,
      errorCorrectionLevel: 'L',
      color: { dark: '#111111', light: '#ffffff' },
    })
    currentTimestamp.value = Math.floor(Date.now() / 1000)
    if (type === 'lan') lanAuthorization.value = response as LanAppAuthorizationResponse
    else {
      cloudAuthorization.value = response as CloudAppAuthorizationResponse
      cloudRelayRoute.value = (response as CloudAppAuthorizationResponse).relay_route
    }
    qrCodeDataUrls.value = { ...qrCodeDataUrls.value, [type]: dataUrl }
  } catch (error: any) {
    message.error(authorizationErrorMessage(error))
  } finally {
    authorizationLoading.value = { ...authorizationLoading.value, [type]: false }
  }
}

async function loadCloudRelayRoute(): Promise<void> {
  try {
    const status = await fetchAppRelayStatus()
    cloudRelayRoute.value = status.route || 'official'
  } catch {
    cloudRelayRoute.value = 'official'
  }
}

async function selectCloudRelayRoute(route: AppRelayRoute): Promise<void> {
  if (cloudRelayRouteLoading.value || route === cloudRelayRoute.value) return
  cloudRelayRoute.value = route
  cloudAuthorization.value = null
  qrCodeDataUrls.value = { ...qrCodeDataUrls.value, cloud: '' }
  cloudRelayRouteLoading.value = true
  try {
    const status = await updateAppRelayRoute(route)
    cloudRelayRoute.value = status.route
    message.success(t('connections.app.routeSwitched'))
    if (showScanModal.value && connectionTab.value === 'cloud') {
      await generateAuthorization('cloud')
    }
  } catch (error: any) {
    message.error(error?.message || t('connections.app.routeSwitchFailed'))
    await loadCloudRelayRoute()
  } finally {
    cloudRelayRouteLoading.value = false
  }
}

function ensureCurrentAuthorization(type: 'lan' | 'cloud', verifyRelaySession = false): void {
  const authorization = type === 'lan' ? lanAuthorization.value : cloudAuthorization.value
  const now = Math.floor(Date.now() / 1000)
  currentTimestamp.value = now
  if (type === 'cloud' && verifyRelaySession) {
    cloudAuthorization.value = null
    qrCodeDataUrls.value = { ...qrCodeDataUrls.value, cloud: '' }
    void generateAuthorization('cloud')
    return
  }
  if (!authorization || authorization.expires_at <= now) {
    void generateAuthorization(type)
  }
}

async function loadMobileRelease() {
  try {
    const manifest = await fetchStudioVersionManifest()
    appAccessMode.value = manifest.accessMode || null
    mobileRelease.value = manifest.mobile
    const android = manifest.mobile.channels.androidApk
    if (!android.cloudflareUrl && android.githubUrl) downloadSource.value = 'github'
    else if (!android.githubUrl && android.cloudflareUrl) downloadSource.value = 'cloudflare'
  } catch {
    appAccessMode.value = null
    mobileRelease.value = DEFAULT_MOBILE_RELEASE
  }
}

async function generateDownloadQrCode(channel: DownloadQrChannel, requestedUrl: string) {
  if (!requestedUrl) {
    downloadQrCodeDataUrls.value = { ...downloadQrCodeDataUrls.value, [channel]: '' }
    return
  }
  try {
    const dataUrl = await QRCode.toDataURL(requestedUrl, {
      width: 220,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#111111', light: '#ffffff' },
    })
    if (requestedUrl === downloadUrlFor(channel)) {
      downloadQrCodeDataUrls.value = { ...downloadQrCodeDataUrls.value, [channel]: dataUrl }
    }
  } catch {
    if (requestedUrl === downloadUrlFor(channel)) {
      downloadQrCodeDataUrls.value = { ...downloadQrCodeDataUrls.value, [channel]: '' }
    }
  }
}

function downloadUrlFor(channel: DownloadQrChannel): string {
  if (channel === 'androidApk') return androidDownloadUrl.value
  if (channel === 'googlePlay') return googlePlayDownloadUrl.value
  return appleDownloadUrl.value
}

function generateDownloadQrCodes(): void {
  const channels: DownloadQrChannel[] = ['androidApk', 'googlePlay', 'apple']
  for (const channel of channels) void generateDownloadQrCode(channel, downloadUrlFor(channel))
}

async function updatePushPreference(connection: AppConnection, enabled: boolean) {
  if (updatingPushIds.value.has(connection.id)) return
  updatingPushIds.value.add(connection.id)
  pushPreferenceRevision++
  try {
    const response = await updateAppConnectionPush(connection.id, enabled)
    connections.value = connections.value.map(row => row.id === connection.id ? { ...row, push_enabled: response.push_enabled } : row)
  } catch (error: any) {
    message.error(error?.message || t('connections.app.pushUpdateFailed'))
  } finally {
    pushPreferenceRevision++
    updatingPushIds.value.delete(connection.id)
  }
}

async function deleteConnection(connection: AppConnection) {
  if (deletingConnectionId.value != null) return
  deletingConnectionId.value = connection.id
  try {
    await deleteAppConnection(connection.id)
    connections.value = connections.value.filter(item => item.id !== connection.id)
    message.success(t('connections.app.deleted'))
  } catch (error: any) {
    message.error(error?.message || t('connections.app.deleteFailed'))
  } finally {
    deletingConnectionId.value = null
  }
}

function openScanModal() {
  connectionTab.value = 'lan'
  scanConnectionVersions = new Map(
    connections.value.map(connection => [connectionIdentity(connection), connection.updated_at]),
  )
  showScanModal.value = true
  ensureCurrentAuthorization('lan')
}

function updatePanelView(view: AppPanelView): void {
  panelView.value = view
  void router.replace({
    query: {
      ...route.query,
      view: view === 'download' ? undefined : view,
    },
  })
}

watch(
  () => route.query.view,
  value => {
    panelView.value = normalizePanelView(value)
  },
)

watch(connectionTab, (type) => {
  ensureCurrentAuthorization(type, type === 'cloud')
})

watch(
  [androidDownloadUrl, googlePlayDownloadUrl, appleDownloadUrl],
  generateDownloadQrCodes,
)

onMounted(() => {
  void loadConnections()
  void loadCloudRelayRoute()
  void loadMobileRelease()
  generateDownloadQrCodes()
  countdownTimer = setInterval(() => {
    currentTimestamp.value = Math.floor(Date.now() / 1000)
  }, 1000)
  connectionPollTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') return
    void loadConnections({ silent: true, detectScanConnection: true })
  }, CONNECTION_POLL_INTERVAL_MS)
})

onUnmounted(() => {
  if (countdownTimer) clearInterval(countdownTimer)
  if (connectionPollTimer) clearInterval(connectionPollTimer)
})
</script>

<template>
  <section class="app-connections-panel">
    <header class="panel-header">
      <div class="panel-heading">
        <h2>{{ t('connections.tabs.app') }}</h2>
        <p>{{ t('connections.app.subtitle') }}</p>
      </div>
      <div class="panel-actions">
        <div class="view-switch" role="tablist">
          <button
            type="button"
            class="view-switch-button"
            :class="{ 'view-switch-button--active': panelView === 'list' }"
            :aria-selected="panelView === 'list'"
            @click="updatePanelView('list')"
          >
            {{ t('connections.app.viewList') }}
          </button>
          <button
            type="button"
            class="view-switch-button"
            :class="{ 'view-switch-button--active': panelView === 'download' }"
            :aria-selected="panelView === 'download'"
            @click="updatePanelView('download')"
          >
            {{ t('connections.app.viewDownload') }}
          </button>
        </div>
        <NButton size="small" type="primary" @click="openScanModal">
          {{ t('connections.app.scanToAdd') }}
        </NButton>
      </div>
    </header>

    <NAlert
      v-if="accessFailure"
      class="app-access-failure"
      type="error"
      :title="t('connections.app.accessFailureTitle')"
      :bordered="false"
      closable
      @close="dismissAccessFailure"
    >
      <div class="app-access-failure__reason">{{ accessFailureReason }}</div>
      <div class="app-access-failure__meta">
        <span>{{ t('connections.app.accessFailureMode', { mode: accessFailureMode }) }}</span>
        <span v-if="accessFailure.deviceName">
          {{ t('connections.app.accessFailureDeviceName', { deviceName: accessFailure.deviceName }) }}
        </span>
        <span>{{ t('connections.app.accessFailureTime', { time: accessFailureTime }) }}</span>
      </div>
      <div v-if="accessFailureRequiresPurchase" class="app-access-failure__actions">
        <NButton
          tag="a"
          :href="APP_ACCESS_PURCHASE_URL"
          target="_blank"
          rel="noopener noreferrer"
          size="small"
          type="primary"
        >
          {{ t('connections.app.purchaseAccess') }}
        </NButton>
      </div>
    </NAlert>

    <template v-if="panelView === 'list'">
      <div class="cloud-route-setting">
        <div class="cloud-route-copy">
          <strong>{{ t('connections.app.routeTitle') }}</strong>
          <span>{{ t('connections.app.routeDescription') }}</span>
        </div>
        <div class="cloud-route-options" role="radiogroup" :aria-label="t('connections.app.routeTitle')">
          <button
            v-for="option in APP_RELAY_ROUTE_OPTIONS"
            :key="option.value"
            type="button"
            class="cloud-route-option"
            :class="{ 'cloud-route-option--active': cloudRelayRoute === option.value }"
            :disabled="cloudRelayRouteLoading"
            :aria-checked="cloudRelayRoute === option.value"
            role="radio"
            @click="selectCloudRelayRoute(option.value)"
          >
            <span>{{ t(option.label) }}</span>
          </button>
        </div>
      </div>

      <div class="app-connections-table">
        <NDataTable
          size="small"
          :columns="columns"
          :data="connections"
          :loading="loading"
          bordered
          :single-line="false"
          :row-key="(row: AppConnection) => row.id"
          :scroll-x="1490"
          flex-height
        >
          <template #empty>
            <NEmpty size="small" :description="t('connections.app.empty')" />
          </template>
        </NDataTable>
      </div>
    </template>

    <div v-else-if="panelView === 'download'" class="app-downloads">
      <div class="app-download-layout">
        <section class="app-download-hero">
          <div class="app-download-intro">
            <div class="app-download-brand">
              <div class="app-download-logo">
                <img src="/logo.png" alt="">
              </div>
              <div>
                <span>Ekko Studio Mobile</span>
                <h3>{{ t('connections.app.downloadTitle') }}</h3>
              </div>
            </div>
            <p>{{ t(appPurchaseEnabled ? 'connections.app.downloadPaidDescription' : 'connections.app.downloadDescription') }}</p>
            <NButton
              v-if="appPurchaseEnabled"
              class="app-download-purchase"
              tag="a"
              :href="APP_ACCESS_PURCHASE_URL"
              target="_blank"
              rel="noopener noreferrer"
              size="small"
              type="primary"
            >
              {{ t('connections.app.purchaseAccess') }}
            </NButton>
            <div class="app-download-meta">
              <span>APK {{ androidVersionLabel }}</span>
              <span>Google Play {{ googlePlayVersionLabel }}</span>
              <span>iOS {{ iosVersionLabel }}</span>
            </div>
          </div>

        </section>

        <div class="app-platform-grid">
          <article
            class="app-platform-card app-platform-card--apk"
            :class="androidDownloadUrl ? 'app-platform-card--available' : 'app-platform-card--pending'"
          >
            <div class="app-platform-card-header">
              <div class="app-platform-icon" aria-hidden="true">
                <svg data-platform-icon="android-apk" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M7.2 8.2 5.7 5.6a.7.7 0 0 1 1.2-.7l1.6 2.7a9.7 9.7 0 0 1 7 0l1.6-2.7a.7.7 0 0 1 1.2.7l-1.5 2.6A7.2 7.2 0 0 1 20 13H4a7.2 7.2 0 0 1 3.2-4.8ZM8 11a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm8 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM4 14h16v5a2 2 0 0 1-2 2h-1v1.3a.7.7 0 0 1-1.4 0V21H8.4v1.3a.7.7 0 0 1-1.4 0V21H6a2 2 0 0 1-2-2v-5Z" />
                </svg>
              </div>
              <NTag v-if="androidDownloadUrl && !mobileRelease.channels.androidApk.online" class="download-test-status" size="small" type="warning" :bordered="false">
                {{ t('connections.app.testVersion') }}
              </NTag>
              <div v-if="androidDownloadUrl" class="download-tag-qr">
                <img v-if="downloadQrCodeDataUrls.androidApk" :src="downloadQrCodeDataUrls.androidApk" :alt="t('connections.app.downloadScan')">
                <NSpin v-else size="small" />
              </div>
              <NTag v-else size="small" :bordered="false">{{ t('connections.app.notReleased') }}</NTag>
            </div>
            <div class="app-platform-copy">
              <h4>Android APK</h4>
              <p>Android</p>
            </div>
            <div class="app-platform-download-controls">
              <div class="view-switch download-source-switch" role="tablist" aria-label="GitHub / Cloudflare">
                <button
                  type="button"
                  role="tab"
                  class="view-switch-button"
                  :class="{ 'view-switch-button--active': downloadSource === 'github' }"
                  :aria-selected="downloadSource === 'github'"
                  @click="downloadSource = 'github'"
                >GitHub</button>
                <button
                  type="button"
                  role="tab"
                  class="view-switch-button"
                  :class="{ 'view-switch-button--active': downloadSource === 'cloudflare' }"
                  :aria-selected="downloadSource === 'cloudflare'"
                  @click="downloadSource = 'cloudflare'"
                >Cloudflare</button>
              </div>
              <NButton
                v-if="androidDownloadUrl"
                class="app-platform-action"
                tag="a"
                type="primary"
                :href="androidDownloadUrl"
                target="_blank"
                rel="noopener noreferrer"
              >{{ t('connections.app.downloadApk') }}</NButton>
              <NButton v-else class="app-platform-action" disabled>{{ t('connections.app.notReleased') }}</NButton>
            </div>
          </article>

          <article
            class="app-platform-card"
            :class="googlePlayDownloadUrl ? 'app-platform-card--available' : 'app-platform-card--pending'"
          >
            <div class="app-platform-card-header">
              <div class="app-platform-icon" aria-hidden="true">
                <svg data-platform-icon="google-play" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M3 20.5v-17c0-.59.34-1.11.84-1.35L13.69 12l-9.85 9.85A1.5 1.5 0 0 1 3 20.5Zm13.81-5.38L6.05 21.34l8.49-8.49 2.27 2.27Zm3.35-4.31c.37.22.59.63.59 1.19s-.22.97-.57 1.18l-2.29 1.32-2.5-2.5 2.5-2.5 2.27 1.31ZM6.05 2.66l10.76 6.22-2.27 2.27-8.49-8.49Z" />
                </svg>
              </div>
              <NTag v-if="googlePlayDownloadUrl && !mobileRelease.channels.googlePlay.online" class="download-test-status" size="small" type="warning" :bordered="false">
                {{ t('connections.app.testVersion') }}
              </NTag>
              <div v-if="googlePlayDownloadUrl" class="download-tag-qr">
                <img v-if="downloadQrCodeDataUrls.googlePlay" :src="downloadQrCodeDataUrls.googlePlay" :alt="t('connections.app.downloadScan')">
                <NSpin v-else size="small" />
              </div>
              <NTag v-else size="small" :bordered="false">{{ t('connections.app.notReleased') }}</NTag>
            </div>
            <div class="app-platform-copy">
              <h4>Google Play</h4>
              <p>Android</p>
            </div>
            <NButton
              v-if="googlePlayDownloadUrl"
              class="app-platform-action"
              tag="a"
              type="primary"
              :href="mobileRelease.channels.googlePlay.url"
              target="_blank"
              rel="noopener noreferrer"
            >Google Play</NButton>
            <NButton v-else class="app-platform-action" disabled>{{ t('connections.app.notReleased') }}</NButton>
          </article>

          <article
            class="app-platform-card"
            :class="appleDownloadUrl ? 'app-platform-card--available' : 'app-platform-card--pending'"
          >
            <div class="app-platform-card-header">
              <div class="app-platform-icon" aria-hidden="true">
                <svg data-platform-icon="apple" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M16.8 12.7c0-2.4 2-3.6 2.1-3.7a4.5 4.5 0 0 0-3.5-1.9c-1.5-.2-2.9.9-3.6.9-.7 0-1.8-.9-3-.9A4.8 4.8 0 0 0 4.7 9.6c-1.7 3-.4 7.4 1.2 9.8.8 1.2 1.8 2.5 3.1 2.4 1.2 0 1.7-.8 3.2-.8s1.9.8 3.2.8c1.3 0 2.2-1.2 3-2.4a10.7 10.7 0 0 0 1.4-2.9 4.2 4.2 0 0 1-3-3.8ZM14.4 5.5A4.2 4.2 0 0 0 15.5 2a4.3 4.3 0 0 0-3 1.7 4 4 0 0 0-1.1 3.4 3.6 3.6 0 0 0 3-1.6Z" />
                </svg>
              </div>
              <NTag v-if="appleDownloadUrl && !mobileRelease.channels.apple.online" class="download-test-status" size="small" type="warning" :bordered="false">
                {{ t('connections.app.testVersion') }}
              </NTag>
              <div v-if="appleDownloadUrl" class="download-tag-qr">
                <img v-if="downloadQrCodeDataUrls.apple" :src="downloadQrCodeDataUrls.apple" :alt="t('connections.app.downloadScan')">
                <NSpin v-else size="small" />
              </div>
              <NTag v-else size="small" :bordered="false">{{ t('connections.app.notReleased') }}</NTag>
            </div>
            <div class="app-platform-copy">
              <h4>Apple</h4>
              <p>{{ appleReleaseLabel }}</p>
            </div>
            <div v-if="appleDownloadUrl" class="app-platform-actions">
              <NButton
                v-if="appleUsesOfficialRelease"
                class="app-platform-action"
                tag="a"
                type="primary"
                :href="mobileRelease.channels.apple.appStoreUrl"
                target="_blank"
                rel="noopener noreferrer"
              >App Store</NButton>
              <NButton
                v-if="mobileRelease.channels.apple.testFlightUrl"
                class="app-platform-action"
                tag="a"
                :type="appleUsesOfficialRelease ? 'default' : 'primary'"
                :secondary="appleUsesOfficialRelease"
                :href="mobileRelease.channels.apple.testFlightUrl"
                target="_blank"
                rel="noopener noreferrer"
              >TestFlight</NButton>
              <NButton
                v-if="mobileRelease.channels.apple.appStoreUrl && !appleUsesOfficialRelease"
                class="app-platform-action"
                tag="a"
                :type="mobileRelease.channels.apple.testFlightUrl ? 'default' : 'primary'"
                :secondary="Boolean(mobileRelease.channels.apple.testFlightUrl)"
                :href="mobileRelease.channels.apple.appStoreUrl"
                target="_blank"
                rel="noopener noreferrer"
              >App Store</NButton>
            </div>
            <NButton v-else class="app-platform-action" disabled>{{ t('connections.app.notReleased') }}</NButton>
          </article>

        </div>
      </div>
    </div>

    <SocialMessagesView v-else embedded class="app-message-push" />
  </section>

  <NModal
    v-model:show="showScanModal"
    preset="card"
    style="width: 560px; max-width: calc(100vw - 32px)"
    :title="t('connections.app.scanModalTitle')"
    :bordered="false"
  >
    <NTabs v-model:value="connectionTab" type="line" animated>
      <NTabPane name="lan" :tab="t('connections.app.lanConnection')">
        <div class="connection-pane">
          <NSpin v-if="authorizationLoading.lan && !lanAuthorization" size="small" />

          <template v-else-if="lanAuthorization">
            <div class="connection-qr" :class="{ 'connection-qr--expired': authorizationExpired }">
              <img :src="activeQrCodeDataUrl" :alt="t('connections.app.scanModalTitle')">
              <div v-if="authorizationExpired" class="connection-qr-expired">
                {{ t('connections.app.authorizationExpired') }}
              </div>
            </div>

            <div class="connection-meta">
              <div class="connection-countdown" :class="{ expired: authorizationExpired }">
                {{ authorizationExpired
                  ? t('connections.app.authorizationExpired')
                  : t('connections.app.remainingTime', { time: remainingTime }) }}
              </div>
              <NButton
                class="refresh-qr-button"
                size="small"
                quaternary
                :loading="authorizationLoading.lan"
                @click="generateAuthorization('lan')"
              >
                <template #icon>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
                    <path d="M20 6v5h-5" />
                    <path d="M4 18v-5h5" />
                    <path d="M6.1 9a7 7 0 0 1 11.6-2.6L20 9" />
                    <path d="M17.9 15a7 7 0 0 1-11.6 2.6L4 15" />
                  </svg>
                </template>
                {{ t('connections.app.refreshQr') }}
              </NButton>
            </div>
          </template>
        </div>
      </NTabPane>

      <NTabPane name="cloud" :tab="t('connections.app.cloudConnection')">
        <div class="connection-pane">
          <div class="cloud-route-setting cloud-route-setting--qr">
            <div class="cloud-route-copy">
              <strong>{{ t('connections.app.routeTitle') }}</strong>
              <span>{{ t('connections.app.qrRouteDescription') }}</span>
            </div>
            <div class="cloud-route-options" role="radiogroup" :aria-label="t('connections.app.routeTitle')">
              <button
                v-for="option in APP_RELAY_ROUTE_OPTIONS"
                :key="option.value"
                type="button"
                class="cloud-route-option"
                :class="{ 'cloud-route-option--active': cloudRelayRoute === option.value }"
                :disabled="cloudRelayRouteLoading || authorizationLoading.cloud"
                :aria-checked="cloudRelayRoute === option.value"
                role="radio"
                @click="selectCloudRelayRoute(option.value)"
              >
                <span>{{ t(option.label) }}</span>
              </button>
            </div>
          </div>
          <NSpin v-if="authorizationLoading.cloud && !cloudAuthorization" size="small" />

          <template v-else-if="cloudAuthorization">
            <div class="connection-qr" :class="{ 'connection-qr--expired': authorizationExpired }">
              <img :src="activeQrCodeDataUrl" :alt="t('connections.app.scanModalTitle')">
              <div v-if="authorizationExpired" class="connection-qr-expired">
                {{ t('connections.app.authorizationExpired') }}
              </div>
            </div>

            <div class="connection-meta">
              <div class="connection-countdown" :class="{ expired: authorizationExpired }">
                {{ authorizationExpired
                  ? t('connections.app.authorizationExpired')
                  : t('connections.app.remainingTime', { time: remainingTime }) }}
              </div>
              <NButton
                class="refresh-qr-button"
                size="small"
                quaternary
                :loading="authorizationLoading.cloud"
                @click="generateAuthorization('cloud', true)"
              >
                <template #icon>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
                    <path d="M20 6v5h-5" />
                    <path d="M4 18v-5h5" />
                    <path d="M6.1 9a7 7 0 0 1 11.6-2.6L20 9" />
                    <path d="M17.9 15a7 7 0 0 1-11.6 2.6L4 15" />
                  </svg>
                </template>
                {{ t('connections.app.refreshQr') }}
              </NButton>
            </div>
          </template>
        </div>
      </NTabPane>
    </NTabs>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.app-connections-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.cloud-route-setting {
  flex: 0 0 auto;
  margin: 12px 20px 0;
  padding: 12px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border: 1px solid $border-light;
  border-radius: 10px;
  background: rgba(var(--bg-card-rgb), 0.7);
}

.cloud-route-setting--qr {
  width: 100%;
  margin: 0 0 16px;
  box-sizing: border-box;
}

.cloud-route-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;

  strong {
    color: $text-primary;
    font-size: 13px;
    font-weight: 650;
  }

  span {
    color: $text-muted;
    font-size: 11px;
    line-height: 16px;
  }
}

.cloud-route-options {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
}

.cloud-route-option {
  min-width: 138px;
  padding: 7px 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  color: $text-secondary;
  border: 1px solid $border-light;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  transition: border-color $transition-fast, background-color $transition-fast, color $transition-fast;

  span {
    font-size: 12px;
    font-weight: 600;
  }

  &:disabled {
    cursor: wait;
    opacity: 0.6;
  }
}

.cloud-route-option--active {
  color: $accent-primary;
  border-color: rgba(var(--accent-primary-rgb), 0.48);
  background: rgba(var(--accent-primary-rgb), 0.08);
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
  flex: 0 0 auto;
  gap: 10px;
}

.view-switch {
  display: flex;
  padding: 3px;
  flex: 0 0 auto;
  gap: 2px;
  background: $bg-secondary;
  border: 1px solid $border-light;
  border-radius: 10px;
}

.view-switch-button {
  min-width: 56px;
  height: 26px;
  padding: 0 11px;
  color: $text-muted;
  background: transparent;
  border: 0;
  border-radius: 7px;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  line-height: 26px;
  transition: color $transition-fast, background-color $transition-fast, box-shadow $transition-fast;

  &:hover {
    color: $text-primary;
  }

  &--active {
    color: $text-primary;
    background: $bg-card;
    box-shadow: 0 1px 4px rgba(var(--text-primary-rgb), 0.1);
    font-weight: 600;
  }
}

.app-connections-table {
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

.app-downloads {
  flex: 1 1 auto;
  min-height: 0;
  padding: 20px;
  overflow: auto;
  background: linear-gradient(180deg, rgba(var(--accent-primary-rgb), 0.025), transparent 52%);
}

.app-message-push {
  flex: 1 1 auto;
  min-height: 0;
}

.app-download-layout {
  width: 100%;
  max-width: 1180px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.app-download-hero {
  position: relative;
  isolation: isolate;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: center;
  min-height: 230px;
  padding: 28px 30px;
  overflow: hidden;
  border: 1px solid $border-color;
  border-radius: 16px;
  background:
    radial-gradient(circle at 82% 12%, rgba(var(--accent-primary-rgb), 0.09), transparent 32%),
    linear-gradient(135deg, rgba(var(--bg-card-rgb), 0.98), rgba(var(--bg-primary-rgb), 0.92));

  &::after {
    position: absolute;
    z-index: -1;
    right: -72px;
    bottom: -118px;
    width: 280px;
    height: 280px;
    border: 1px solid rgba(var(--accent-primary-rgb), 0.08);
    border-radius: 50%;
    box-shadow:
      0 0 0 34px rgba(var(--accent-primary-rgb), 0.025),
      0 0 0 72px rgba(var(--accent-primary-rgb), 0.018);
    content: '';
  }
}

.app-download-intro {
  position: relative;
  z-index: 1;
  max-width: 600px;

  > p {
    max-width: 560px;
    margin: 18px 0 0;
    color: $text-secondary;
    font-size: 14px;
    line-height: 22px;
  }
}

.app-download-purchase {
  margin-top: 14px;
}

.app-download-brand {
  display: flex;
  align-items: center;
  gap: 14px;

  span {
    display: block;
    margin-bottom: 2px;
    color: $text-muted;
    font-size: 10px;
    font-weight: 650;
    letter-spacing: 0.09em;
    line-height: 16px;
    text-transform: uppercase;
  }

  h3 {
    margin: 0;
    color: $text-primary;
    font-size: clamp(21px, 2.5vw, 28px);
    font-weight: 650;
    letter-spacing: -0.03em;
    line-height: 1.2;
  }
}

.app-download-logo {
  width: 54px;
  height: 54px;
  padding: 6px;
  box-sizing: border-box;
  flex: 0 0 auto;
  overflow: hidden;
  background: $bg-card;
  border: 1px solid $border-light;
  border-radius: 15px;
  box-shadow: 0 8px 24px rgba(var(--text-primary-rgb), 0.08);

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
}

.app-download-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 18px;
  gap: 7px;

  span {
    padding: 5px 9px;
    color: $text-secondary;
    background: $bg-secondary;
    border: 1px solid $border-light;
    border-radius: 999px;
    font-size: 10px;
    line-height: 14px;
  }
}

.download-source-switch {
  width: 100%;
  margin-top: 10px;
  box-sizing: border-box;

  .view-switch-button {
    min-width: 0;
    padding: 0 4px;
    flex: 1 1 0;
    font-size: 10px;
  }
}

.app-platform-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.app-platform-card {
  position: relative;
  min-height: 188px;
  padding: 18px;
  display: flex;
  box-sizing: border-box;
  flex-direction: column;
  background: $bg-card;
  border: 1px solid $border-color;
  border-radius: 14px;
  transition: border-color $transition-fast, box-shadow $transition-fast, transform $transition-fast;

  &--available:hover {
    border-color: rgba(var(--accent-primary-rgb), 0.25);
    box-shadow: 0 10px 28px rgba(var(--text-primary-rgb), 0.065);
    transform: translateY(-1px);
  }

  &--pending {
    background: rgba(var(--bg-card-rgb), 0.64);
  }
}

.app-platform-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.app-platform-icon {
  width: 42px;
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: $text-primary;
  background: $bg-secondary;
  border-radius: 12px;
}

.download-tag-qr {
  position: absolute;
  top: 18px;
  right: 18px;
  z-index: 1;
  width: 112px;
  height: 112px;
  padding: 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  background: #ffffff;
  border: 1px solid $border-light;
  border-radius: 7px;

  img {
    display: block;
    width: 100%;
    height: 100%;
  }
}

.download-test-status {
  align-self: center;
  margin-inline-end: auto;
  white-space: nowrap;
}

.app-platform-copy {
  margin: 14px 0 16px;

  h4 {
    margin: 0;
    color: $text-primary;
    font-size: 16px;
    font-weight: 650;
    line-height: 22px;
  }

  p {
    margin: 4px 0 0;
    color: $text-muted;
    font-size: 11px;
    line-height: 17px;
  }
}

.app-platform-action {
  width: 100%;
  margin-top: auto;
}

.app-platform-actions {
  margin-top: auto;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;

  .app-platform-action {
    margin-top: 0;

    &:only-child {
      grid-column: 1 / -1;
    }
  }
}

.app-platform-download-controls {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;

  .download-source-switch {
    margin-top: 0;
  }

  .app-platform-action {
    margin-top: 0;
  }
}

.app-access-failure {
  flex: 0 0 auto;
  margin: 12px 20px 0;

  &__reason {
    color: $text-primary;
    font-size: 13px;
    font-weight: 600;
  }

  &__meta {
    margin-top: 4px;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    color: $text-muted;
    font-size: 12px;
  }

  &__actions {
    margin-top: 10px;
    display: flex;
  }
}

.connection-pane {
  min-height: 374px;
  padding: 8px 0 4px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
}

.connection-qr {
  position: relative;
  width: 320px;
  height: 320px;
  padding: 8px;
  border-radius: $radius-md;
  background: #ffffff;

  img {
    display: block;
    width: 100%;
    height: 100%;
  }

  &--expired img {
    filter: grayscale(1);
    opacity: 0.2;
  }
}

.connection-qr-expired {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: $text-primary;
  font-size: 14px;
  font-weight: 600;
  background: rgba(255, 255, 255, 0.72);
}

.connection-countdown {
  color: $text-secondary;
  font-size: 13px;

  &.expired {
    color: $error;
  }
}

.connection-meta {
  width: 320px;
  min-height: 28px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.refresh-qr-button {
  flex: 0 0 auto;
}

@media (max-width: 1100px) {
  .app-platform-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: $breakpoint-mobile) {
  .cloud-route-setting {
    margin: 12px 12px 0;
    align-items: stretch;
    flex-direction: column;
    gap: 10px;
  }

  .cloud-route-setting--qr {
    margin: 0 0 12px;
  }

  .cloud-route-option {
    min-width: 0;
    flex: 1 1 0;
  }

  .panel-header {
    align-items: flex-start;
    flex-direction: column;
    padding: 12px;
  }

  .panel-actions {
    width: 100%;
    justify-content: space-between;
  }

  .app-connections-table {
    padding: 12px;
  }

  .app-downloads {
    padding: 12px;
  }

  .app-download-hero {
    grid-template-columns: 1fr;
    padding: 20px;
    gap: 22px;
  }

  .app-platform-grid {
    grid-template-columns: 1fr;
  }

  .app-platform-card {
    min-height: 174px;
  }

  .app-access-failure {
    margin: 12px 12px 0;
  }

  .connection-qr {
    width: 240px;
    height: 240px;
  }

  .connection-pane {
    min-height: 294px;
  }

  .connection-meta {
    width: 240px;
  }

}
</style>
