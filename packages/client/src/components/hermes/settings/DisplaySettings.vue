<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NSwitch, NInputNumber, NSelect, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/hermes/settings'
import { primeCompletionSound } from '@/utils/completion-sound'
import { requestCompletionNotificationPermission, showCompletionNotification, showSystemNotification, type CompletionNotificationPermissionResult } from '@/utils/completion-notification'
import { clampChatInputHeight, MAX_CHAT_INPUT_HEIGHT, MIN_CHAT_INPUT_HEIGHT } from '@/utils/chat-input-height'
import { isDesktopShell } from '@/utils/desktop-bridge'
import { getLinkOpenTarget, setLinkOpenTarget, type LinkOpenTarget } from '@/utils/desktop-browser'
import SettingRow from './SettingRow.vue'

const settingsStore = useSettingsStore()
const message = useMessage()
const { t } = useI18n()
const chatInputHeight = computed(() => clampChatInputHeight(settingsStore.display.chat_input_height))
const desktopLinkSettingsAvailable = isDesktopShell()
const linkOpenTarget = ref<LinkOpenTarget>(getLinkOpenTarget())
const linkOpenTargetOptions = computed(() => [
  { label: t('settings.display.linkOpenTargetHermesStudio'), value: 'hermes-studio' as const },
  { label: t('settings.display.linkOpenTargetDefaultBrowser'), value: 'default-browser' as const },
])

function handleLinkOpenTargetChange(value: LinkOpenTarget) {
  try {
    linkOpenTarget.value = setLinkOpenTarget(value)
    message.success(t('settings.saved'))
  } catch {
    message.error(t('settings.saveFailed'))
  }
}

// Hermes' own display.busy_input_mode. Studio has always queued, so an unset
// value stays on queue rather than adopting Hermes' interrupt default and
// changing what an existing install does on upgrade.
const busyInputMode = computed(() => {
  const raw = String(settingsStore.display.busy_input_mode || '').trim().toLowerCase()
  return raw === 'steer' || raw === 'interrupt' ? raw : 'queue'
})
const busyInputModeOptions = computed(() => [
  { label: t('settings.display.busyInputModeQueue'), value: 'queue' },
  { label: t('settings.display.busyInputModeSteer'), value: 'steer' },
  { label: t('settings.display.busyInputModeInterrupt'), value: 'interrupt' },
])

async function save(values: Record<string, any>) {
  try {
    await settingsStore.saveSection('display', values)
    message.success(t('settings.saved'))
  } catch (err: any) {
    message.error(t('settings.saveFailed'))
  }
}

function handleChatInputHeightChange(value: number | null) {
  return save({ chat_input_height: clampChatInputHeight(value) })
}

function resetChatInputHeight() {
  return save({ chat_input_height: null })
}

function notificationPermissionErrorKey(result: CompletionNotificationPermissionResult): string {
  if (result.reason === 'insecure') return 'settings.display.notifyOnCompleteInsecure'
  if (result.reason === 'unsupported') return 'settings.display.notifyOnCompleteUnsupported'
  return 'settings.display.notifyOnCompleteDenied'
}

function handleApprovalBellChange(value: boolean) {
  if (value) primeCompletionSound()
  return save({ approval_bell: value })
}

async function handleNotifyOnApprovalChange(value: boolean) {
  if (value) {
    const result = await requestCompletionNotificationPermission()
    if (!result.granted) {
      message.error(t(notificationPermissionErrorKey(result)))
      return
    }
    const shown = await showSystemNotification({
      title: 'Hermes',
      body: t('settings.display.notifyOnApprovalTest'),
      icon: '/coding-agents/hermes.png',
      tag: `hermes-approval-test-${Date.now()}`,
    }, { requireBackground: false, deduplicate: false })
    if (!shown) {
      message.error(t('settings.display.notifyOnApprovalTestFailed'))
      return
    }
  }
  await save({ notify_on_approval: value })
}

async function testApprovalNotification() {
  const result = await requestCompletionNotificationPermission()
  if (!result.granted) {
    message.error(t(notificationPermissionErrorKey(result)))
    return
  }
  const shown = await showSystemNotification({
    title: 'Hermes',
    body: t('settings.display.notifyOnApprovalTest'),
    icon: '/coding-agents/hermes.png',
    tag: `hermes-approval-test-${Date.now()}`,
  }, { requireBackground: false, deduplicate: false })
  if (!shown) {
    message.error(t('settings.display.notifyOnApprovalTestFailed'))
    return
  }
  message.success(t('settings.display.notifyOnApprovalTestSent'))
}

async function handleNotifyOnCompleteChange(value: boolean) {
  if (value) {
    const result = await requestCompletionNotificationPermission()
    if (!result.granted) {
      message.error(t(notificationPermissionErrorKey(result)))
      return
    }
  }
  await save({ notify_on_complete: value })
  if (value) {
    void showCompletionNotification({
      title: 'Hermes',
      body: t('settings.display.notifyOnCompleteTest'),
      icon: '/coding-agents/hermes.png',
      tag: `hermes-complete-test-${Date.now()}`,
    })
  }
}

async function testCompletionNotification() {
  const result = await requestCompletionNotificationPermission()
  if (!result.granted) {
    message.error(t(notificationPermissionErrorKey(result)))
    return
  }
  const shown = await showCompletionNotification({
    title: 'Hermes',
    body: t('settings.display.notifyOnCompleteTest'),
    icon: '/coding-agents/hermes.png',
    tag: `hermes-complete-test-${Date.now()}`,
  })
  if (!shown) {
    message.error(t('settings.display.notifyOnCompleteTestFailed'))
    return
  }
  message.success(t('settings.display.notifyOnCompleteTestSent'))
}
</script>

<template>
  <section class="settings-section">
    <SettingRow :label="t('settings.display.busyInputMode')" :hint="t('settings.display.busyInputModeHint')">
      <NSelect
        :value="busyInputMode"
        :options="busyInputModeOptions"
        style="width: 220px"
        @update:value="v => save({ busy_input_mode: v })"
      />
    </SettingRow>
    <SettingRow :label="t('settings.display.streaming')" :hint="t('settings.display.streamingHint')">
      <NSwitch :value="settingsStore.display.streaming" @update:value="v => save({ streaming: v })" />
    </SettingRow>
    <SettingRow :label="t('settings.display.compact')" :hint="t('settings.display.compactHint')">
      <NSwitch :value="settingsStore.display.compact" @update:value="v => save({ compact: v })" />
    </SettingRow>
    <SettingRow :label="t('settings.display.showReasoning')" :hint="t('settings.display.showReasoningHint')">
      <NSwitch :value="settingsStore.display.show_reasoning" @update:value="v => save({ show_reasoning: v })" />
    </SettingRow>
    <SettingRow :label="t('settings.display.showCost')" :hint="t('settings.display.showCostHint')">
      <NSwitch :value="settingsStore.display.show_cost" @update:value="v => save({ show_cost: v })" />
    </SettingRow>
    <SettingRow :label="t('settings.display.inlineDiffs')" :hint="t('settings.display.inlineDiffsHint')">
      <NSwitch :value="settingsStore.display.inline_diffs" @update:value="v => save({ inline_diffs: v })" />
    </SettingRow>
    <SettingRow
      v-if="desktopLinkSettingsAvailable"
      :label="t('settings.display.linkOpenTarget')"
      :hint="t('settings.display.linkOpenTargetHint')"
    >
      <NSelect
        :value="linkOpenTarget"
        :options="linkOpenTargetOptions"
        :aria-label="t('settings.display.linkOpenTarget')"
        class="link-open-target-select"
        data-testid="link-open-target-select"
        @update:value="handleLinkOpenTargetChange"
      />
    </SettingRow>
    <SettingRow :label="t('settings.display.bellOnComplete')" :hint="t('settings.display.bellOnCompleteHint')">
      <NSwitch :value="settingsStore.display.bell_on_complete" @update:value="v => save({ bell_on_complete: v })" />
    </SettingRow>
    <SettingRow :label="t('settings.display.approvalBell')" :hint="t('settings.display.approvalBellHint')">
      <NSwitch :value="settingsStore.display.approval_bell" @update:value="handleApprovalBellChange" />
    </SettingRow>
    <SettingRow :label="t('settings.display.notifyOnApproval')" :hint="`${t('settings.display.notifyOnApprovalHint')} ${t('settings.display.notifyOnCompleteMacHint')}`">
      <div class="notify-controls">
        <NSwitch :value="settingsStore.display.notify_on_approval" @update:value="handleNotifyOnApprovalChange" />
        <NButton size="tiny" secondary @click="testApprovalNotification">
          {{ t('settings.display.notifyOnApprovalTestButton') }}
        </NButton>
      </div>
    </SettingRow>
    <SettingRow :label="t('settings.display.notifyOnComplete')" :hint="`${t('settings.display.notifyOnCompleteHint')} ${t('settings.display.notifyOnCompleteMacHint')}`">
      <div class="notify-controls">
        <NSwitch :value="settingsStore.display.notify_on_complete" @update:value="handleNotifyOnCompleteChange" />
        <NButton size="tiny" secondary @click="testCompletionNotification">
          {{ t('settings.display.notifyOnCompleteTestButton') }}
        </NButton>
      </div>
    </SettingRow>
    <SettingRow :label="t('settings.display.chatInputHeight')" :hint="t('settings.display.chatInputHeightHint')">
      <div class="chat-input-height-controls">
        <NInputNumber
          :value="chatInputHeight"
          :min="MIN_CHAT_INPUT_HEIGHT"
          :max="MAX_CHAT_INPUT_HEIGHT"
          :step="8"
          :show-button="false"
          size="small"
          class="input-sm"
          @update:value="handleChatInputHeightChange"
        >
          <template #suffix>px</template>
        </NInputNumber>
        <NButton size="tiny" secondary @click="resetChatInputHeight">
          {{ t('common.reset') }}
        </NButton>
      </div>
    </SettingRow>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.settings-section {
  margin-top: 16px;
}

.notify-controls {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.link-open-target-select {
  width: 180px;
}

.chat-input-height-controls {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
</style>
