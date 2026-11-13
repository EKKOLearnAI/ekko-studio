<script setup lang="ts">
/**
 * USBView - USB 设备中心
 * 结构：page-header (含设备徽章 + 高级抽屉触发器) + 文件浏览器主体 + 状态栏
 * 重设计 v2：文件资源页面占主体 80%+，详情/活动/心跳全部折叠到右侧抽屉
 */
import { computed, onMounted, ref, watch } from 'vue'
import { NButton, NEmpty, NSpin, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { copyUSBFileToWorkspace, fetchUSBDevices, fetchUSBHistory } from '@/api/studio/usb'
import USBExplorer from '@/components/hermes/usb/explorer/USBExplorer.vue'
import UsbHeaderBadge from '@/components/hermes/usb/UsbHeaderBadge.vue'
import UsbDetailDrawer, { type UsbDetailSection } from '@/components/hermes/usb/UsbDetailDrawer.vue'
import { useUSBStream } from '@/composables/useUSBStream'
import { useChatStore } from '@/stores/hermes/chat'
import { useMessage } from '@/composables/useAppMessage'

const { t } = useI18n()
const message = useMessage()
const usbStore = useUSBStream()
const chatStore = useChatStore()

const refreshing = ref(false)
const selectedUuid = ref('')
const agentReadBusy = ref(false)
const agentStatusTone = ref<'info' | 'success' | 'error'>('info')
const agentStatusMessage = ref('')

const drawerOpen = ref(false)
const drawerSection = ref<UsbDetailSection>('details')

const devices = computed(() => usbStore.devices)
const selectedDevice = computed(() =>
  devices.value.find(device => device.uuid === selectedUuid.value)
  || devices.value[0]
  || null,
)
const runtimeState = computed(() => usbStore.runtime?.state || 'idle')
const activeChatSession = computed(() => chatStore.activeSession)
const activeChatSessionName = computed(
  () => activeChatSession.value?.title?.trim() || activeChatSession.value?.id || '',
)
const canUseActiveChatSession = computed(() => {
  const session = activeChatSession.value
  if (!session) return false
  return session.source !== 'coding_agent'
    && session.source !== 'global_agent'
    && session.source !== 'workflow'
})
const agentReadHint = computed(() => {
  if (!activeChatSession.value) return t('usb.page.agent.noActiveSession')
  if (!canUseActiveChatSession.value) return t('usb.page.agent.unsupportedSession')
  return t('usb.page.agent.usingSession', { session: activeChatSessionName.value })
})

function runtimeTagType() {
  if (runtimeState.value === 'running') return 'success'
  if (runtimeState.value === 'error') return 'error'
  if (runtimeState.value === 'unsupported') return 'warning'
  return 'default'
}

function deviceTitle(device: typeof devices.value[number]): string {
  return device.label?.trim() || device.uuid
}

function formatTime(value: string | null | undefined): string {
  if (!value) return t('usb.page.unknown')
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return t('usb.page.unknown')
  if (value === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = value
  let unitIndex = 0
  while (n >= 1024 && unitIndex < units.length - 1) {
    n /= 1024
    unitIndex += 1
  }
  return `${n.toFixed(n >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

async function refreshSnapshot() {
  refreshing.value = true
  try {
    const [deviceResponse, historyResponse] = await Promise.all([
      fetchUSBDevices(),
      fetchUSBHistory('24h'),
    ])
    usbStore.hydrate({
      runtime: deviceResponse.runtime,
      devices: deviceResponse.devices,
      events: historyResponse.events,
    })
  } catch (error: any) {
    message.error(error?.message || t('usb.page.loadFailed'))
  } finally {
    refreshing.value = false
  }
}

function setAgentStatus(tone: 'info' | 'success' | 'error', text: string) {
  agentStatusTone.value = tone
  agentStatusMessage.value = text
}

async function handleReadWithAgent(payload: { path: string, name: string }) {
  const session = activeChatSession.value
  const device = selectedDevice.value
  if (!device || !session || !canUseActiveChatSession.value) {
    const fallback = !session
      ? t('usb.page.agent.noActiveSession')
      : t('usb.page.agent.unsupportedSession')
    setAgentStatus('error', fallback)
    message.error(fallback)
    return
  }

  agentReadBusy.value = true
  try {
    setAgentStatus('info', t('usb.page.agent.copying'))
    const copied = await copyUSBFileToWorkspace(device.uuid, payload.path, session.id)
    if (activeChatSession.value?.id === session.id) {
      activeChatSession.value.workspace = copied.workspace
    }
    setAgentStatus('info', t('usb.page.agent.starting'))
    const promptPath = copied.relativeWorkspacePath.replace(/\\/g, '/')
    await chatStore.sendMessage(t('usb.page.agent.readPrompt', { path: promptPath }))
    const successText = t('usb.page.agent.started', { session: activeChatSessionName.value })
    setAgentStatus('success', successText)
    message.success(successText)
  } catch (error: any) {
    const failureText = error?.message || t('usb.page.agent.failed')
    setAgentStatus('error', failureText)
    message.error(failureText)
  } finally {
    agentReadBusy.value = false
  }
}

function pickDevice(uuid: string) {
  selectedUuid.value = uuid
}

function openDrawer(section: UsbDetailSection = 'details') {
  drawerSection.value = section
  drawerOpen.value = true
}

watch(
  devices,
  (nextDevices) => {
    if (nextDevices.length === 0) {
      selectedUuid.value = ''
      return
    }
    if (!nextDevices.some(device => device.uuid === selectedUuid.value)) {
      selectedUuid.value = nextDevices[0]?.uuid || ''
    }
  },
  { immediate: true },
)

onMounted(() => {
  usbStore.clearUnread()
})
</script>

<template>
  <div class="usb-view">
    <header class="page-header">
      <div class="header-title-block">
        <div class="title-row">
          <h2 class="header-title">{{ t('usb.page.title') }}</h2>
          <NTag round :type="runtimeTagType()" size="small">
            {{ t(`usb.page.runtime.${runtimeState}`) }}
          </NTag>
        </div>
        <span class="header-subtitle">{{ t('usb.page.subtitle') }}</span>
        <span class="header-session">
          <span class="session-dot" />
          <span>{{ agentReadHint }}</span>
        </span>
      </div>
      <div class="header-actions">
        <UsbHeaderBadge
          v-if="selectedDevice"
          :device="selectedDevice"
          :devices="devices"
          @pick="pickDevice"
          @open-drawer="openDrawer"
        />
        <NButton size="small" :loading="refreshing" @click="refreshSnapshot">
          {{ t('usb.page.refresh') }}
        </NButton>
        <NButton
          size="small"
          type="primary"
          ghost
          :title="t('usb.page.advanced')"
          data-testid="usb-advanced-header"
          @click="openDrawer('details')"
        >
          {{ t('usb.page.advanced') }}
        </NButton>
      </div>
    </header>

    <div class="usb-content">
      <NSpin :show="refreshing && devices.length === 0">
        <div v-if="agentStatusMessage" class="agent-status" :class="`is-${agentStatusTone}`">
          {{ agentStatusMessage }}
        </div>

        <section v-if="devices.length === 0" class="page-empty">
          <NEmpty :description="t('usb.page.empty')">
            <template #extra>
              <NButton size="small" type="primary" :loading="refreshing" @click="refreshSnapshot">
                {{ t('usb.page.refresh') }}
              </NButton>
            </template>
          </NEmpty>
        </section>

        <USBExplorer
          v-else
          :device="selectedDevice"
          :agent-read-enabled="canUseActiveChatSession"
          :agent-read-busy="agentReadBusy"
          :agent-read-hint="agentReadHint"
          @read-with-agent="handleReadWithAgent"
        />
      </NSpin>
    </div>

    <UsbDetailDrawer
      v-model:show="drawerOpen"
      v-model:section="drawerSection"
      :device="selectedDevice"
      :runtime="usbStore.runtime"
      :events="usbStore.history"
      :format-time="formatTime"
      :format-bytes="formatBytes"
      :device-title="deviceTitle"
      :runtime-state="runtimeState"
      @pick-device="pickDevice"
    />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.usb-view {
  display: flex;
  flex-direction: column;
  height: calc(100 * var(--vh));
}

/* ── Page header ──────────────────────────────────────────────────────*/
.header-title-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.header-subtitle {
  font-size: 12px;
  color: $text-muted;
  line-height: 1.4;
}

.header-session {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: $text-muted;
  margin-top: 2px;
}

.session-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--accent-info);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* ── 内容区 ────────────────────────────────────────────────────────────*/
.usb-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ── Agent status banner ────────────────────────────────────────────*/
.agent-status {
  padding: 10px 14px;
  border: 1px solid $border-light;
  border-radius: $radius-sm;
  background: var(--theme-card-bg, var(--bg-card));
  font-size: 12.5px;
  color: $text-secondary;
}

.agent-status.is-info {
  border-color: rgba(var(--accent-info-rgb), 0.4);
  color: var(--accent-info);
}

.agent-status.is-success {
  border-color: rgba(var(--success-rgb), 0.4);
  color: $success;
}

.agent-status.is-error {
  border-color: rgba(var(--error-rgb), 0.4);
  color: $error;
}

/* ── Empty state ──────────────────────────────────────────────────────*/
.page-empty {
  flex: 1;
  min-height: 320px;
  display: flex;
  align-items: center;
  justify-content: center;
}

@media (max-width: $breakpoint-mobile) {
  .header-session,
  .header-subtitle {
    display: none;
  }
}
</style>