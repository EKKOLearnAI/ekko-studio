<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  getDeviceLoginStatus,
  startDeviceLogin,
  weChatQrConnectUrl,
  type DeviceLoginPayload,
} from '@/api/studio/device-login'

const props = defineProps<{ baseUrl: string }>()
const emit = defineEmits<{ approved: [payload: DeviceLoginPayload] }>()
const { t } = useI18n()

const HARDWARE_ID_KEY = 'hermes_device_hardware_id'
const phase = ref<'loading' | 'waiting' | 'approved' | 'expired' | 'error'>('loading')
const qrUrl = ref('')
let controller: AbortController | null = null
let timer: ReturnType<typeof setTimeout> | undefined

function hardwareId(): string {
  let id = localStorage.getItem(HARDWARE_ID_KEY)
  if (!id) {
    id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
    localStorage.setItem(HARDWARE_ID_KEY, id)
  }
  return id
}

function cancel() {
  controller?.abort()
  clearTimeout(timer)
}

async function start() {
  cancel()
  const next = new AbortController()
  const base = props.baseUrl
  controller = next
  qrUrl.value = ''
  phase.value = 'loading'
  try {
    const params = await startDeviceLogin(base, hardwareId(), next.signal)
    if (next.signal.aborted) return
    qrUrl.value = weChatQrConnectUrl(params)
    phase.value = 'waiting'
    const poll = async () => {
      try {
        const status = await getDeviceLoginStatus(base, params.login_id, next.signal)
        if (next.signal.aborted) return
        if (status.status === 'approved') {
          qrUrl.value = ''
          phase.value = 'approved'
          emit('approved', {
            api_base: status.api.api_base,
            api_key: status.api.api_key,
            models: status.api.models,
            device_id: status.device.device_id,
            device_name: status.device.name,
          })
        } else if (status.status === 'expired') {
          qrUrl.value = ''
          phase.value = 'expired'
        } else {
          timer = setTimeout(poll, 3000)
        }
      } catch {
        if (!next.signal.aborted) {
          qrUrl.value = ''
          phase.value = 'error'
        }
      }
    }
    timer = setTimeout(poll, 3000)
  } catch {
    if (!next.signal.aborted) phase.value = 'error'
  }
}

onMounted(start)
onBeforeUnmount(cancel)
</script>

<template>
  <div class="wechat-qr-panel" aria-live="polite">
    <NSpin v-if="phase === 'loading'" size="small" :description="t('login.wechatQrLoading')" />
    <template v-else-if="phase === 'waiting'">
      <NButton tag="a" :href="qrUrl" target="_blank" rel="noopener noreferrer">
        {{ t('login.wechatQrOpenPage') }}
      </NButton>
      <span>{{ t('login.wechatQrWaiting') }}</span>
    </template>
    <template v-else-if="phase === 'expired' || phase === 'error'">
      <span>{{ t(phase === 'expired' ? 'login.wechatQrExpired' : 'login.wechatQrFailed') }}</span>
      <NButton @click="start">{{ t('login.wechatQrRefresh') }}</NButton>
    </template>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.wechat-qr-panel {
  display: grid;
  justify-items: start;
  gap: 8px;
  color: $text-secondary;
}
</style>
