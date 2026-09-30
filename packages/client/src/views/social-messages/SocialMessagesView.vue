<script setup lang="ts">
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { computed, onMounted, onUnmounted, ref, unref, watch } from 'vue'
import QRCode from 'qrcode'
import {
  NSpin,
  NAlert,
  NButton,
  NCard,
  NForm,
  NFormItem,
  NInput,
  NSelect,
  NTag,
  useMessage,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { languageOptions, normalizeSupportedLocale } from '@/i18n/language-options'
import type { SupportedLocale } from '@/i18n/messages'
import {
  clearSocialMessageCredentials,
  fetchFeishuQrCode,
  fetchFeishuRecipients,
  fetchSocialMessagePlatforms,
  fetchTelegramRecipients,
  fetchWeixinQrCode,
  fetchWeixinRecipients,
  pollFeishuQrStatus,
  pollWeixinQrStatus,
  saveSocialMessageCredentials,
  saveWeixinCredentials,
  sendSocialMessage,
  setActiveSocialMessagePlatform,
  updateSocialMessageNotificationLocale,
  type SocialMessagePlatform,
  type SocialMessagePlatformCapability,
  type SocialMessageRecipientType,
  type SocialMessageSendResult,
  type FeishuRecipient,
  type TelegramRecipient,
  type WeixinRecipient,
} from '@/api/studio/social-messages'

withDefaults(defineProps<{
  embedded?: boolean
}>(), {
  embedded: false,
})

const { t, locale } = useI18n()
const message = useMessage()
const notificationLocale = ref<SupportedLocale>(normalizeSupportedLocale(unref(locale)))
const notificationLocaleBusy = ref(false)

function selectedLocale(): string {
  return notificationLocale.value
}

const loading = ref(true)
const loadError = ref('')
const platforms = ref<SocialMessagePlatformCapability[]>([])
const selectedPlatform = ref<SocialMessagePlatform | null>(null)
const selectedRecipientType = ref<SocialMessageRecipientType>('chat_id')
const recipient = ref('')
const content = ref('')
const sending = ref(false)
const latestResult = ref<SocialMessageSendResult | null>(null)

const telegramBotToken = ref('')
const telegramRecipients = ref<TelegramRecipient[]>([])
const telegramRecipientsLoaded = ref(false)
const telegramRuntimeError = ref('')
const telegramRecipientLoading = ref(false)
const selectedTelegramRecipient = ref('')
const credentialBusy = ref(false)

const feishuQrImage = ref('')
const feishuQrSessionId = ref('')
const feishuQrError = ref('')
const feishuQrBusy = ref(false)
const feishuQrStatus = ref<'idle' | 'loading' | 'waiting' | 'confirmed' | 'error' | 'expired' | 'denied'>('idle')
const feishuRecipients = ref<FeishuRecipient[]>([])
const feishuRecipientsLoaded = ref(false)
const feishuRuntimeError = ref('')
const feishuRecipientLoading = ref(false)
const selectedFeishuRecipient = ref('')

const weixinRecipients = ref<WeixinRecipient[]>([])
const weixinRecipientsLoaded = ref(false)
const weixinRuntimeError = ref('')
const weixinRecipientLoading = ref(false)
const selectedWeixinRecipient = ref('')
const qrImage = ref('')
const qrId = ref('')
const qrError = ref('')
const qrBusy = ref(false)
const qrStatus = ref<'idle' | 'loading' | 'waiting' | 'scanned' | 'confirmed' | 'error' | 'expired'>('idle')

let qrPollTimer: ReturnType<typeof setTimeout> | null = null
let feishuQrPollTimer: ReturnType<typeof setTimeout> | null = null
let feishuQrPollIntervalMs = 5_000
let recipientPollTimer: ReturnType<typeof setInterval> | null = null
let weixinQrAttempt = 0
let feishuQrAttempt = 0
let selectionReady = false
const WEIXIN_POLL_INTERVAL_MS = 2_000
const PLATFORM_ORDER: SocialMessagePlatform[] = ['weixin', 'feishu', 'telegram']

const selectedCapability = computed(() => (
  platforms.value.find(platform => platform.id === selectedPlatform.value) || null
))

const platformOptions = computed(() => [...platforms.value]
  .sort((left, right) => PLATFORM_ORDER.indexOf(left.id) - PLATFORM_ORDER.indexOf(right.id))
  .map(platform => ({
    label: t(`socialMessages.platforms.${platform.id}`),
    value: platform.id,
  })))

const maxContentLength = computed(() => selectedCapability.value?.maxContentLength || 0)
const charactersRemaining = computed(() => Math.max(0, maxContentLength.value - content.value.length))
const isWeixinSelected = computed(() => selectedPlatform.value === 'weixin')
const isFeishuSelected = computed(() => selectedPlatform.value === 'feishu')
const isTelegramSelected = computed(() => selectedPlatform.value === 'telegram')
const telegramConfigured = computed(() => Boolean(
  platforms.value.find(platform => platform.id === 'telegram')?.configured,
))
const weixinConfigured = computed(() => Boolean(
  platforms.value.find(platform => platform.id === 'weixin')?.configured,
))
const feishuConfigured = computed(() => Boolean(
  platforms.value.find(platform => platform.id === 'feishu')?.configured,
))
const readyWeixinRecipients = computed(() => (
  weixinRecipients.value.filter(item => item.hasContextToken)
))
const weixinPushReady = computed(() => !weixinRuntimeError.value && readyWeixinRecipients.value.length > 0)
const feishuPushReady = computed(() => !feishuRuntimeError.value && feishuRecipients.value.length > 0)
const telegramPushReady = computed(() => !telegramRuntimeError.value && telegramRecipients.value.length > 0)
const showQrCode = computed(() => Boolean(qrImage.value) && qrStatus.value === 'waiting')
const showFeishuQrCode = computed(() => (
  Boolean(feishuQrImage.value) && feishuQrStatus.value === 'waiting'
))
const canSaveCredentials = computed(() => (
  selectedPlatform.value === 'telegram' && Boolean(telegramBotToken.value.trim())
))
const messageTargetReady = computed(() => {
  if (!selectedCapability.value?.configured) return false
  if (isWeixinSelected.value) return Boolean(selectedWeixinRecipient.value && weixinPushReady.value)
  if (isFeishuSelected.value) return Boolean(selectedFeishuRecipient.value && feishuPushReady.value)
  if (isTelegramSelected.value) return Boolean(selectedTelegramRecipient.value && telegramPushReady.value)
  return Boolean(recipient.value.trim())
})
const showComposer = computed(() => {
  if (!selectedCapability.value?.configured) return false
  if (isWeixinSelected.value) return Boolean(selectedWeixinRecipient.value && weixinPushReady.value)
  if (isFeishuSelected.value) return Boolean(selectedFeishuRecipient.value && feishuPushReady.value)
  if (isTelegramSelected.value) return Boolean(selectedTelegramRecipient.value && telegramPushReady.value)
  return true
})
const canSend = computed(() => Boolean(
  messageTargetReady.value && content.value.trim() && !sending.value,
))

function markPlatformActive(platform: SocialMessagePlatform): void {
  platforms.value = platforms.value.map(item => ({
    ...item,
    active: item.id === platform,
  }))
}

function syncNotificationLocale(): void {
  const storedLocale = selectedCapability.value?.notificationLocale
  if (storedLocale) notificationLocale.value = normalizeSupportedLocale(storedLocale)
}

async function changeNotificationLocale(value: string): Promise<void> {
  const nextLocale = normalizeSupportedLocale(value)
  const previousLocale = notificationLocale.value
  notificationLocale.value = nextLocale
  const capability = selectedCapability.value
  if (!capability?.configured) return

  notificationLocaleBusy.value = true
  try {
    await updateSocialMessageNotificationLocale(capability.id, nextLocale)
    platforms.value = platforms.value.map(item => (
      item.id === capability.id ? { ...item, notificationLocale: nextLocale } : item
    ))
  } catch (error) {
    notificationLocale.value = previousLocale
    message.error(error instanceof Error ? error.message : t('socialMessages.credentialsSaveFailed'))
  } finally {
    notificationLocaleBusy.value = false
  }
}

function stopQrPoll(): void {
  if (!qrPollTimer) return
  clearTimeout(qrPollTimer)
  qrPollTimer = null
}

function stopFeishuQrPoll(): void {
  if (!feishuQrPollTimer) return
  clearTimeout(feishuQrPollTimer)
  feishuQrPollTimer = null
}

function stopRecipientPoll(): void {
  if (!recipientPollTimer) return
  clearInterval(recipientPollTimer)
  recipientPollTimer = null
}

function syncWeixinRecipient(): void {
  const available = readyWeixinRecipients.value.map(item => item.userId)
  if (!available.includes(selectedWeixinRecipient.value)) {
    selectedWeixinRecipient.value = available[0] || ''
  }
}

function syncFeishuRecipient(): void {
  const available = feishuRecipients.value.map(item => item.chatId)
  if (!available.includes(selectedFeishuRecipient.value)) {
    selectedFeishuRecipient.value = available[0] || ''
  }
}

function syncTelegramRecipient(): void {
  const available = telegramRecipients.value.map(item => item.chatId)
  if (!available.includes(selectedTelegramRecipient.value)) {
    selectedTelegramRecipient.value = available[0] || ''
  }
}

function friendlyWeixinRuntimeError(error?: string): string {
  const message = error?.trim() || ''
  if (/session timeout/i.test(message) || /\b(?:ret|errcode)=-14\b/i.test(message)) {
    return t('socialMessages.weixinSessionExpired')
  }
  return message || t('socialMessages.weixinRuntimeError')
}

async function loadWeixinRecipients(): Promise<void> {
  if (!isWeixinSelected.value || !weixinConfigured.value || weixinRecipientLoading.value) return
  weixinRecipientLoading.value = true
  try {
    const response = await fetchWeixinRecipients()
    if (!isWeixinSelected.value) return
    weixinRecipients.value = response.recipients
    weixinRecipientsLoaded.value = true
    weixinRuntimeError.value = response.runtimeStatus === 'error'
      ? friendlyWeixinRuntimeError(response.runtimeError)
      : ''
    syncWeixinRecipient()
    if (weixinPushReady.value) stopRecipientPoll()
  } catch (error) {
    weixinRecipientsLoaded.value = true
    weixinRuntimeError.value = error instanceof Error ? error.message : String(error)
  } finally {
    weixinRecipientLoading.value = false
  }
}

async function loadFeishuRecipients(): Promise<void> {
  if (!isFeishuSelected.value || !feishuConfigured.value || feishuRecipientLoading.value) return
  feishuRecipientLoading.value = true
  try {
    const response = await fetchFeishuRecipients()
    if (!isFeishuSelected.value) return
    feishuRecipients.value = response.recipients
    feishuRecipientsLoaded.value = true
    feishuRuntimeError.value = response.runtimeStatus === 'error'
      ? response.runtimeError?.trim() || t('socialMessages.feishuRuntimeError')
      : ''
    syncFeishuRecipient()
    if (feishuPushReady.value) stopRecipientPoll()
  } catch (error) {
    feishuRecipientsLoaded.value = true
    feishuRuntimeError.value = error instanceof Error ? error.message : String(error)
  } finally {
    feishuRecipientLoading.value = false
  }
}

async function loadTelegramRecipients(): Promise<void> {
  if (!isTelegramSelected.value || !telegramConfigured.value || telegramRecipientLoading.value) return
  telegramRecipientLoading.value = true
  try {
    const response = await fetchTelegramRecipients()
    if (!isTelegramSelected.value) return
    telegramRecipients.value = response.recipients
    telegramRecipientsLoaded.value = true
    telegramRuntimeError.value = response.runtimeStatus === 'error'
      ? response.runtimeError?.trim() || t('socialMessages.telegramRuntimeError')
      : ''
    syncTelegramRecipient()
    if (telegramPushReady.value) stopRecipientPoll()
  } catch (error) {
    telegramRecipientsLoaded.value = true
    telegramRuntimeError.value = error instanceof Error ? error.message : String(error)
  } finally {
    telegramRecipientLoading.value = false
  }
}

function startRecipientPoll(): void {
  stopRecipientPoll()
  const shouldPollWeixin = isWeixinSelected.value && weixinConfigured.value && !weixinPushReady.value
  const shouldPollFeishu = isFeishuSelected.value && feishuConfigured.value && !feishuPushReady.value
  const shouldPollTelegram = isTelegramSelected.value && telegramConfigured.value && !telegramPushReady.value
  if (!shouldPollWeixin && !shouldPollFeishu && !shouldPollTelegram) return
  recipientPollTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') return
    if (isWeixinSelected.value) void loadWeixinRecipients()
    else if (isFeishuSelected.value) void loadFeishuRecipients()
    else if (isTelegramSelected.value) void loadTelegramRecipients()
  }, WEIXIN_POLL_INTERVAL_MS)
}

function pollWeixinStatus(): void {
  if (!qrId.value || !isWeixinSelected.value) return
  const pollingQrId = qrId.value
  qrPollTimer = setTimeout(async () => {
    try {
      const data = await pollWeixinQrStatus(pollingQrId)
      if (!isWeixinSelected.value || qrId.value !== pollingQrId) return
      if (data.status === 'wait') {
        pollWeixinStatus()
        return
      }
      if (data.status === 'scaned_but_redirect') {
        pollWeixinStatus()
        return
      }
      if (data.status === 'scaned') {
        qrStatus.value = 'scanned'
        pollWeixinStatus()
        return
      }
      if (data.status === 'expired') {
        qrStatus.value = 'expired'
        qrImage.value = ''
        return
      }
      if (!data.account_id || !data.token) {
        throw new Error(t('socialMessages.weixinQrInvalidResponse'))
      }
      await saveWeixinCredentials({
        account_id: data.account_id,
        token: data.token,
        base_url: data.base_url,
        user_id: data.user_id,
        locale: selectedLocale(),
      })
      platforms.value = platforms.value.map(platform => (
        platform.id === 'weixin'
          ? { ...platform, configured: true, notificationLocale: selectedLocale() }
          : platform
      ))
      markPlatformActive('weixin')
      qrStatus.value = 'confirmed'
      qrImage.value = ''
      weixinRuntimeError.value = ''
      weixinRecipients.value = []
      weixinRecipientsLoaded.value = false
      await loadWeixinRecipients()
      startRecipientPoll()
      message.success(t('socialMessages.weixinQrSaved'))
    } catch (error) {
      if (!isWeixinSelected.value || qrId.value !== pollingQrId) return
      qrStatus.value = 'error'
      qrImage.value = ''
      qrError.value = error instanceof Error ? error.message : String(error)
    }
  }, WEIXIN_POLL_INTERVAL_MS)
}

function pollFeishuStatus(delayMs = feishuQrPollIntervalMs): void {
  if (!feishuQrSessionId.value || !isFeishuSelected.value) return
  stopFeishuQrPoll()
  const pollingSessionId = feishuQrSessionId.value
  feishuQrPollTimer = setTimeout(async () => {
    try {
      const data = await pollFeishuQrStatus(pollingSessionId, selectedLocale())
      if (!isFeishuSelected.value || feishuQrSessionId.value !== pollingSessionId) return
      if (data.status === 'pending') {
        pollFeishuStatus(data.retry_after_ms || feishuQrPollIntervalMs)
        return
      }
      if (data.status === 'expired' || data.status === 'denied') {
        feishuQrStatus.value = data.status
        feishuQrImage.value = ''
        return
      }

      platforms.value = platforms.value.map(platform => (
        platform.id === 'feishu'
          ? { ...platform, configured: true, notificationLocale: selectedLocale() }
          : platform
      ))
      markPlatformActive('feishu')
      feishuQrStatus.value = 'confirmed'
      feishuQrImage.value = ''
      feishuRuntimeError.value = ''
      feishuRecipients.value = []
      feishuRecipientsLoaded.value = false
      selectedFeishuRecipient.value = ''
      await loadFeishuRecipients()
      startRecipientPoll()
      message.success(t('socialMessages.feishuQrSaved'))
    } catch (error) {
      if (!isFeishuSelected.value || feishuQrSessionId.value !== pollingSessionId) return
      feishuQrStatus.value = 'error'
      feishuQrImage.value = ''
      feishuQrError.value = error instanceof Error ? error.message : String(error)
    }
  }, Math.max(0, delayMs))
}

async function startFeishuQrRegistration(): Promise<void> {
  stopFeishuQrPoll()
  const attempt = ++feishuQrAttempt
  feishuQrBusy.value = true
  feishuQrStatus.value = 'loading'
  feishuQrImage.value = ''
  feishuQrSessionId.value = ''
  feishuQrError.value = ''
  try {
    const data = await fetchFeishuQrCode(selectedLocale())
    if (attempt !== feishuQrAttempt || !isFeishuSelected.value) return
    feishuQrSessionId.value = data.session_id
    feishuQrPollIntervalMs = Number.isFinite(data.poll_interval_ms)
      ? Math.max(1_000, data.poll_interval_ms)
      : 5_000
    const image = await QRCode.toDataURL(data.qrcode_url, {
      width: 280,
      margin: 1,
      errorCorrectionLevel: 'M',
    })
    if (attempt !== feishuQrAttempt || !isFeishuSelected.value) return
    feishuQrImage.value = image
    feishuQrStatus.value = 'waiting'
    pollFeishuStatus()
  } catch (error) {
    if (attempt !== feishuQrAttempt) return
    feishuQrStatus.value = 'error'
    feishuQrError.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (attempt === feishuQrAttempt) feishuQrBusy.value = false
  }
}

async function startWeixinQrLogin(): Promise<void> {
  stopQrPoll()
  stopRecipientPoll()
  const attempt = ++weixinQrAttempt
  qrBusy.value = true
  qrStatus.value = 'loading'
  qrImage.value = ''
  qrId.value = ''
  qrError.value = ''
  weixinRuntimeError.value = ''
  weixinRecipients.value = []
  weixinRecipientsLoaded.value = false
  selectedWeixinRecipient.value = ''
  try {
    const data = await fetchWeixinQrCode()
    if (attempt !== weixinQrAttempt || !isWeixinSelected.value) return
    qrId.value = data.qrcode
    const image = await QRCode.toDataURL(data.qrcode_url, {
      width: 280,
      margin: 1,
      errorCorrectionLevel: 'M',
    })
    if (attempt !== weixinQrAttempt || !isWeixinSelected.value) return
    qrImage.value = image
    qrStatus.value = 'waiting'
    pollWeixinStatus()
  } catch (error) {
    if (attempt !== weixinQrAttempt) return
    qrStatus.value = 'error'
    qrError.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (attempt === weixinQrAttempt) qrBusy.value = false
  }
}

async function prepareSelectedPlatform(): Promise<void> {
  stopQrPoll()
  stopFeishuQrPoll()
  stopRecipientPoll()
  weixinQrAttempt += 1
  feishuQrAttempt += 1
  qrBusy.value = false
  feishuQrBusy.value = false
  latestResult.value = null
  recipient.value = ''
  selectedTelegramRecipient.value = ''
  telegramRecipients.value = []
  telegramRecipientsLoaded.value = false
  telegramRuntimeError.value = ''
  selectedWeixinRecipient.value = ''
  weixinRecipients.value = []
  weixinRecipientsLoaded.value = false
  weixinRuntimeError.value = ''
  qrImage.value = ''
  qrError.value = ''
  qrStatus.value = 'idle'
  feishuQrImage.value = ''
  feishuQrSessionId.value = ''
  feishuQrError.value = ''
  feishuQrStatus.value = 'idle'
  feishuRecipients.value = []
  feishuRecipientsLoaded.value = false
  feishuRuntimeError.value = ''
  selectedFeishuRecipient.value = ''

  const capability = selectedCapability.value
  if (!capability) return
  selectedRecipientType.value = capability.defaultRecipientType
  if (capability.id === 'telegram') {
    if (!capability.configured) return
    await loadTelegramRecipients()
    startRecipientPoll()
    return
  }
  if (capability.id === 'feishu' && !capability.configured) {
    await startFeishuQrRegistration()
    return
  }
  if (capability.id === 'feishu') {
    await loadFeishuRecipients()
    startRecipientPoll()
    return
  }
  if (capability.id !== 'weixin') return
  if (!capability.configured) {
    await startWeixinQrLogin()
    return
  }
  await loadWeixinRecipients()
  startRecipientPoll()
}

async function loadPushState(): Promise<void> {
  stopQrPoll()
  stopFeishuQrPoll()
  stopRecipientPoll()
  loading.value = true
  loadError.value = ''
  selectionReady = false
  try {
    platforms.value = await fetchSocialMessagePlatforms()
    const retained = platforms.value.find(platform => platform.id === selectedPlatform.value)
    const active = platforms.value.find(platform => platform.active)
    const configured = platforms.value.find(platform => platform.configured)
    selectedPlatform.value = retained?.id || active?.id || configured?.id || platforms.value[0]?.id || null
    syncNotificationLocale()
    await prepareSelectedPlatform()
    selectionReady = true
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    loading.value = false
  }
}

async function saveSelectedCredentials(): Promise<void> {
  const platform = selectedPlatform.value
  if (platform !== 'telegram' || !canSaveCredentials.value) return
  credentialBusy.value = true
  try {
    await saveSocialMessageCredentials(platform, {
      botToken: telegramBotToken.value.trim(),
      locale: selectedLocale(),
    })
    telegramBotToken.value = ''
    platforms.value = platforms.value.map(item => (
      item.id === platform
        ? { ...item, configured: true, notificationLocale: selectedLocale() }
        : item
    ))
    markPlatformActive(platform)
    telegramRecipients.value = []
    telegramRecipientsLoaded.value = false
    telegramRuntimeError.value = ''
    selectedTelegramRecipient.value = ''
    await loadTelegramRecipients()
    startRecipientPoll()
    message.success(t('socialMessages.credentialsSaved'))
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('socialMessages.credentialsSaveFailed'))
  } finally {
    credentialBusy.value = false
  }
}

async function disconnectSelectedAccount(): Promise<void> {
  const platform = selectedPlatform.value
  if (!platform) return
  credentialBusy.value = true
  try {
    await clearSocialMessageCredentials(platform)
    platforms.value = platforms.value.map(item => (
      item.id === platform ? { ...item, configured: false, active: false } : item
    ))
    recipient.value = ''
    latestResult.value = null
    if (platform === 'weixin') {
      stopRecipientPoll()
      weixinRecipients.value = []
      weixinRecipientsLoaded.value = false
      weixinRuntimeError.value = ''
      selectedWeixinRecipient.value = ''
      content.value = ''
      message.success(t('socialMessages.weixinCredentialsCleared'))
      await startWeixinQrLogin()
    } else if (platform === 'feishu') {
      stopRecipientPoll()
      feishuRecipients.value = []
      feishuRecipientsLoaded.value = false
      feishuRuntimeError.value = ''
      selectedFeishuRecipient.value = ''
      content.value = ''
      message.success(t('socialMessages.credentialsCleared'))
      await startFeishuQrRegistration()
    } else if (platform === 'telegram') {
      stopRecipientPoll()
      telegramRecipients.value = []
      telegramRecipientsLoaded.value = false
      telegramRuntimeError.value = ''
      selectedTelegramRecipient.value = ''
      content.value = ''
      message.success(t('socialMessages.credentialsCleared'))
    } else {
      message.success(t('socialMessages.credentialsCleared'))
    }
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('socialMessages.credentialsClearFailed'))
  } finally {
    credentialBusy.value = false
  }
}

async function submitMessage(): Promise<void> {
  const capability = selectedCapability.value
  if (!capability || !canSend.value) return
  sending.value = true
  try {
    latestResult.value = await sendSocialMessage({
      platform: capability.id,
      recipient: capability.id === 'weixin'
        ? selectedWeixinRecipient.value
        : capability.id === 'feishu'
          ? selectedFeishuRecipient.value
          : capability.id === 'telegram'
            ? selectedTelegramRecipient.value
            : recipient.value.trim(),
      recipientType: capability.id === 'feishu' ? 'chat_id' : selectedRecipientType.value,
      content: content.value.trim(),
      contextToken: undefined,
    })
    markPlatformActive(capability.id)
    content.value = ''
    message.success(t('socialMessages.sent'))
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('socialMessages.sendFailed'))
  } finally {
    sending.value = false
  }
}

watch(selectedPlatform, () => {
  if (!selectionReady) return
  syncNotificationLocale()
  const capability = selectedCapability.value
  if (!capability?.configured) {
    void prepareSelectedPlatform()
    return
  }
  void (async () => {
    try {
      await setActiveSocialMessagePlatform(capability.id)
      markPlatformActive(capability.id)
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    }
    await prepareSelectedPlatform()
  })()
})

onMounted(() => void loadPushState())
onUnmounted(() => {
  stopQrPoll()
  stopFeishuQrPoll()
  stopRecipientPoll()
})
</script>

<template>
  <PageLoading :show="loading" class="social-messages-view" :class="{ 'social-messages-view--embedded': embedded }">
    <PageHeader>
    <header v-if="!embedded" class="page-header">
      <h1>{{ t('socialMessages.title') }}</h1>
      <p>{{ t('socialMessages.description') }}</p>
    </header>
    </PageHeader>

    <main class="push-content">
      <div>
        <div v-if="loadError" class="load-error">
          <NAlert type="error" class="push-alert">{{ loadError }}</NAlert>
          <NButton size="small" @click="loadPushState">{{ t('common.retry') }}</NButton>
        </div>

        <NCard v-else class="push-card" :bordered="false">
          <NForm @submit.prevent="submitMessage">
            <NFormItem :label="t('socialMessages.pushLanguage')">
              <NSelect
                :value="notificationLocale"
                :options="languageOptions"
                :loading="notificationLocaleBusy"
                :disabled="notificationLocaleBusy"
                class="social-messages-language"
                data-testid="social-messages-language"
                size="medium"
                :consistent-menu-width="false"
                @update:value="changeNotificationLocale"
              />
            </NFormItem>

            <NFormItem :label="t('socialMessages.platform')">
              <NSelect
                v-model:value="selectedPlatform"
                :options="platformOptions"
                :placeholder="t('socialMessages.platform')"
                data-testid="social-messages-platform"
              />
            </NFormItem>

            <template v-if="selectedCapability?.id === 'weixin'">
              <div class="weixin-panel">
                <div v-if="showQrCode" class="push-qr">
                  <img :src="qrImage" :alt="t('socialMessages.weixinQrAlt')" width="280" height="280">
                  <NTag type="info" :bordered="false">
                    {{ t('socialMessages.weixinQrScan') }}
                  </NTag>
                </div>

                <div v-else-if="qrStatus === 'scanned'" class="push-loading">
                  <NSpin size="medium" />
                  <NTag type="warning" :bordered="false">
                    {{ t('socialMessages.weixinQrScanned') }}
                  </NTag>
                </div>

                <div v-else-if="qrBusy" class="push-loading">
                  <NSpin size="medium" />
                </div>

                <template v-else-if="qrStatus === 'expired' || qrStatus === 'error'">
                  <NAlert type="warning" class="push-alert">
                    {{ qrStatus === 'expired'
                      ? t('socialMessages.weixinQrExpired')
                      : qrError || t('socialMessages.weixinQrFailed') }}
                  </NAlert>
                  <div class="push-actions">
                    <NButton type="primary" attr-type="button" @click="startWeixinQrLogin">
                      {{ t('socialMessages.weixinQrLogin') }}
                    </NButton>
                  </div>
                </template>

                <template v-else-if="weixinConfigured">
                  <div class="weixin-toolbar">
                    <div
                      v-if="weixinRuntimeError"
                      class="weixin-status-line weixin-status-line--error"
                      role="alert"
                    >
                      <span class="weixin-status-dot" aria-hidden="true" />
                      <span>{{ weixinRuntimeError }}</span>
                    </div>
                    <div
                      v-else-if="weixinRecipientsLoaded"
                      class="weixin-status-line"
                      :class="weixinPushReady
                        ? 'weixin-status-line--success'
                        : 'weixin-status-line--warning'"
                      role="status"
                    >
                      <span class="weixin-status-dot" aria-hidden="true" />
                      <span>{{ weixinPushReady
                        ? t('socialMessages.weixinPushReady')
                        : t('socialMessages.weixinPushAwaitingFirstMessage') }}</span>
                    </div>
                    <div v-else class="weixin-status-line" role="status">
                      <NSpin size="small" />
                    </div>

                    <div class="weixin-actions">
                      <NButton
                        size="small"
                        secondary
                        attr-type="button"
                        :disabled="credentialBusy"
                        @click="startWeixinQrLogin"
                      >
                        {{ t('socialMessages.weixinQrRelogin') }}
                      </NButton>
                      <NButton
                        size="small"
                        quaternary
                        type="error"
                        attr-type="button"
                        :loading="credentialBusy"
                        @click="disconnectSelectedAccount"
                      >
                        {{ t('socialMessages.weixinClearCredentials') }}
                      </NButton>
                    </div>
                  </div>

                </template>
              </div>
            </template>

            <template v-else-if="selectedCapability?.id === 'feishu'">
              <div class="feishu-panel">
                <template v-if="!feishuConfigured">
                  <div v-if="showFeishuQrCode" class="push-qr">
                    <img :src="feishuQrImage" :alt="t('socialMessages.feishuQrAlt')" width="280" height="280">
                    <NTag type="info" :bordered="false">
                      {{ t('socialMessages.feishuQrScan') }}
                    </NTag>
                  </div>

                  <div v-else-if="feishuQrBusy" class="push-loading">
                    <NSpin size="medium" />
                  </div>

                  <template v-else-if="[
                    'expired',
                    'denied',
                    'error',
                  ].includes(feishuQrStatus)">
                    <NAlert type="warning" class="push-alert">
                      {{ feishuQrStatus === 'expired'
                        ? t('socialMessages.feishuQrExpired')
                        : feishuQrStatus === 'denied'
                          ? t('socialMessages.feishuQrDenied')
                          : feishuQrError || t('socialMessages.feishuQrFailed') }}
                    </NAlert>
                    <div class="push-actions">
                      <NButton type="primary" attr-type="button" @click="startFeishuQrRegistration">
                        {{ t('socialMessages.feishuQrRetry') }}
                      </NButton>
                    </div>
                  </template>
                </template>

                <div v-else class="weixin-toolbar">
                  <div
                    v-if="feishuRuntimeError"
                    class="weixin-status-line weixin-status-line--error"
                    role="alert"
                  >
                    <span class="weixin-status-dot" aria-hidden="true" />
                    <span>{{ feishuRuntimeError }}</span>
                  </div>
                  <div
                    v-else-if="feishuRecipientsLoaded"
                    class="weixin-status-line"
                    :class="feishuPushReady
                      ? 'weixin-status-line--success'
                      : 'weixin-status-line--warning'"
                    role="status"
                  >
                    <span class="weixin-status-dot" aria-hidden="true" />
                    <span>{{ feishuPushReady
                      ? t('socialMessages.feishuPushReady')
                      : t('socialMessages.feishuPushAwaitingFirstMessage') }}</span>
                  </div>
                  <div v-else class="weixin-status-line" role="status">
                    <NSpin size="small" />
                  </div>

                  <div class="weixin-actions">
                    <NButton
                      size="small"
                      quaternary
                      type="error"
                      attr-type="button"
                      :loading="credentialBusy"
                      @click="disconnectSelectedAccount"
                    >
                      {{ t('socialMessages.clearCredentials') }}
                    </NButton>
                  </div>
                </div>
              </div>
            </template>

            <template v-else-if="selectedCapability?.id === 'telegram'">
              <div class="telegram-panel">
                <template v-if="!telegramConfigured">
                  <div class="credential-fields">
                    <NFormItem :label="t('socialMessages.telegramBotToken')">
                      <NInput
                        v-model:value="telegramBotToken"
                        type="password"
                        :placeholder="t('socialMessages.secretReplacementPlaceholder')"
                      />
                    </NFormItem>
                    <NButton
                      type="primary"
                      attr-type="button"
                      :loading="credentialBusy"
                      :disabled="!canSaveCredentials"
                      @click="saveSelectedCredentials"
                    >
                      {{ t('socialMessages.saveCredentials') }}
                    </NButton>
                  </div>
                </template>

                <div v-else class="weixin-toolbar">
                  <div
                    v-if="telegramRuntimeError"
                    class="weixin-status-line weixin-status-line--error"
                    role="alert"
                  >
                    <span class="weixin-status-dot" aria-hidden="true" />
                    <span>{{ telegramRuntimeError }}</span>
                  </div>
                  <div
                    v-else-if="telegramRecipientsLoaded"
                    class="weixin-status-line"
                    :class="telegramPushReady
                      ? 'weixin-status-line--success'
                      : 'weixin-status-line--warning'"
                    role="status"
                  >
                    <span class="weixin-status-dot" aria-hidden="true" />
                    <span>{{ telegramPushReady
                      ? t('socialMessages.telegramPushReady')
                      : t('socialMessages.telegramPushAwaitingFirstMessage') }}</span>
                  </div>
                  <div v-else class="weixin-status-line" role="status">
                    <NSpin size="small" />
                  </div>

                  <NButton
                    size="small"
                    quaternary
                    type="error"
                    attr-type="button"
                    :loading="credentialBusy"
                    @click="disconnectSelectedAccount"
                  >
                    {{ t('socialMessages.clearCredentials') }}
                  </NButton>
                </div>
              </div>
            </template>

            <template v-if="showComposer">
              <NFormItem :label="t('socialMessages.content')">
                <NInput
                  v-model:value="content"
                  type="textarea"
                  :maxlength="maxContentLength"
                  :autosize="{ minRows: 4, maxRows: 10 }"
                  :placeholder="t('socialMessages.contentPlaceholder')"
                />
              </NFormItem>
              <div class="composer-footer">
                <span>{{ t('socialMessages.charactersRemaining', { count: charactersRemaining }) }}</span>
                <NButton type="primary" attr-type="submit" :loading="sending" :disabled="!canSend">
                  {{ t('socialMessages.send') }}
                </NButton>
              </div>
            </template>

            <NAlert v-if="latestResult" type="success" class="delivery-result">
              <strong>{{ t('socialMessages.delivered') }}</strong>
              <span v-if="latestResult.messageId">
                {{ t('socialMessages.messageId') }}:
                <span class="message-id-value">{{ latestResult.messageId }}</span>
              </span>
            </NAlert>
          </NForm>
        </NCard>
      </div>
    </main>
  </PageLoading>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.social-messages-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.social-messages-view--embedded {
  height: 100%;
  min-height: 0;
}

.page-header {
  padding: 24px 24px 0;

  h1,
  p {
    margin: 0;
  }

  p {
    margin-top: 6px;
    color: $text-secondary;
  }
}

.push-content {
  flex: 1 1 auto;
  min-height: 0;
  padding: 24px;
  overflow-y: auto;
}

.push-card {
  width: min(100%, 620px);
  margin: 0 auto;
  border: 1px solid $border-color;
  border-radius: 16px;
  background: $bg-card;
}

.social-messages-language {
  width: 100%;
}

.load-error {
  width: min(100%, 620px);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 12px;
}

.weixin-panel,
.feishu-panel {
  display: flex;
  flex-direction: column;
}

.push-qr {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;

  img {
    display: block;
    width: min(280px, 100%);
    height: auto;
    padding: 8px;
    border-radius: 12px;
    background: #fff;
  }
}

.push-loading {
  min-height: 280px;
  display: grid;
  place-items: center;
}

.push-alert {
  width: 100%;
}

.push-actions {
  margin-top: 12px;
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 8px;
}

.weixin-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.weixin-status-line {
  flex: 1 1 280px;
  min-width: 0;
  min-height: 28px;
  display: flex;
  align-items: center;
  gap: 8px;
  color: $text-secondary;
  font-size: 13px;
  line-height: 1.45;
}

.weixin-status-dot {
  width: 7px;
  height: 7px;
  flex: 0 0 7px;
  border-radius: 50%;
  background: $text-muted;
}

.weixin-status-line--success .weixin-status-dot {
  background: var(--success);
}

.weixin-status-line--warning .weixin-status-dot {
  background: var(--warning);
}

.weixin-status-line--error {
  color: var(--error);

  .weixin-status-dot {
    background: var(--error);
  }
}

.weixin-actions {
  margin-inline-start: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}

.credential-fields {
  margin-top: 18px;
}

.configured-row,
.composer-footer,
.delivery-result {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.configured-row {
  margin-bottom: 18px;
}

.composer-footer {
  color: $text-secondary;
  font-size: 12px;
}

.delivery-result {
  margin-top: 18px;
}

@media (max-width: $breakpoint-mobile) {
  .push-content {
    padding: 12px;
  }

  .page-header {
    padding: 16px 12px 0;
  }

  .composer-footer,
  .delivery-result {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
