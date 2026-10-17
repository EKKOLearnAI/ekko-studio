<script setup lang="ts">
import { h, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { NButton, NInput, useMessage, useNotification, type NotificationReactive } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useChatStore, type PendingApproval, type PendingClarify } from '@/stores/hermes/chat'
import { useGroupChatStore, type GroupPendingApproval, type GroupPendingClarify } from '@/stores/hermes/group-chat'
import PendingInteractionCountdown from '@/components/hermes/chat/PendingInteractionCountdown.vue'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSettingsStore } from '@/stores/hermes/settings'
import { copyToClipboard } from '@/utils/clipboard'
import { playCompletionSound } from '@/utils/completion-sound'
import { showSystemNotification } from '@/utils/completion-notification'
import { workflowApprovalKey } from '@/utils/workflow-approval-key'
import { PENDING_INTERACTION_EXPIRED_EVENT } from '@/utils/pending-interaction'
import { approveWorkflowNode, type WorkflowRecord } from '@/api/studio/workflows'
import { listWorkflowsSocket, onWorkflowStatusUpdated, subscribeWorkflowStatuses, disconnectWorkflowSocket, type WorkflowRuntimeStatus } from '@/api/studio/workflow-socket'

const chatStore = useChatStore()
const groupChatStore = useGroupChatStore()
const profilesStore = useProfilesStore()
const settingsStore = useSettingsStore()
const notification = useNotification()
const message = useMessage()
const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const handles = new Map<string, NotificationReactive>()
const announcedKeys = new Set<string>()
const pendingSoundKeys = new Set<string>()
const pendingNotificationKeys = new Set<string>()
const clarifyDrafts = reactive<Record<string, string>>({})
const submitting = reactive<Record<string, boolean>>({})
const copiedCommandKey = ref<string | null>(null)
const workflows = ref<WorkflowRecord[]>([])
const workflowStatuses = reactive<Record<string, WorkflowRuntimeStatus>>({})
const visibleWorkflowApprovalKeys = reactive(new Set<string>())
let stopWorkflowStatus: (() => void) | null = null
let workflowSubscriptionGeneration = 0
let pendingBaselineEstablished = false
let approvalSoundArmed = false
let settingsLoadGeneration = 0

function loadApprovalSoundSetting() {
  const generation = ++settingsLoadGeneration
  approvalSoundArmed = false
  pendingSoundKeys.clear()
  pendingNotificationKeys.clear()
  void settingsStore.fetchSettings({
    shouldCommit: () => generation === settingsLoadGeneration,
  }).then(loaded => {
    if (generation !== settingsLoadGeneration) return
    if (!loaded) {
      approvalSoundArmed = false
      pendingSoundKeys.clear()
      pendingNotificationKeys.clear()
      return
    }
    approvalSoundArmed = true
    if (pendingSoundKeys.size > 0 && settingsStore.display.approval_bell) void playCompletionSound()
    if (settingsStore.display.notify_on_approval) {
      for (const action of pendingActions(false)) {
        if (pendingNotificationKeys.has(action.key)) notifyPendingAction(action)
      }
    }
    pendingSoundKeys.clear()
    pendingNotificationKeys.clear()
  }).catch(() => {
    if (generation !== settingsLoadGeneration) return
    approvalSoundArmed = false
    pendingSoundKeys.clear()
    pendingNotificationKeys.clear()
  })
}

function resetWorkflowSubscriptions(profile?: string | null) {
  const generation = ++workflowSubscriptionGeneration
  stopWorkflowStatus?.()
  stopWorkflowStatus = onWorkflowStatusUpdated(status => {
    if (generation === workflowSubscriptionGeneration) workflowStatuses[status.workflowId] = status
  }, profile)
  workflows.value = []
  for (const key of Object.keys(workflowStatuses)) delete workflowStatuses[key]
  void listWorkflowsSocket(profile).then(records => {
    if (generation === workflowSubscriptionGeneration) workflows.value = records
  }).catch(() => undefined)
  void subscribeWorkflowStatuses(undefined, profile).then(statuses => {
    if (generation !== workflowSubscriptionGeneration) return
    for (const status of statuses) {
      if (status.runId) {
        for (const { nodeId, executionId } of status.pendingApprovals || []) {
          announcedKeys.add(workflowApprovalKey(status.workflowId, status.runId, nodeId, executionId))
        }
      }
      workflowStatuses[status.workflowId] = status
    }
  }).catch(() => undefined)
}

type ApprovalChoice = PendingApproval['choices'][number]
type GlobalPendingAction =
  | { key: string; profile: string; kind: 'chat-approval'; title: string; pending: PendingApproval }
  | { key: string; profile: string; kind: 'chat-clarify'; title: string; pending: PendingClarify }
  | { key: string; profile: string; kind: 'group-approval'; title: string; pending: GroupPendingApproval }
  | { key: string; profile: string; kind: 'group-clarify'; title: string; pending: GroupPendingClarify }
  | { key: string; profile: string; kind: 'workflow-approval'; title: string; workflowId: string; runId: string; nodeId: string; executionId?: string }

function normalizePendingSourceTitle(title: string): string {
  return title.replace(/^(?:\s*branch:\s*)+/i, 'branch: ').trim()
}

function sessionTitle(sessionId: string): string {
  return normalizePendingSourceTitle(chatStore.sessions.find(session => session.id === sessionId)?.title || sessionId)
}

function roomTitle(roomId: string): string {
  return groupChatStore.rooms.find(room => room.id === roomId)?.name || roomId
}

function handleVisibleWorkflowApproval(event: Event) {
  const detail = (event as CustomEvent<{ key?: string; visible?: boolean }>).detail
  const key = detail?.key
  if (!key) return
  if (detail.visible === false) visibleWorkflowApprovalKeys.delete(key)
  else visibleWorkflowApprovalKeys.add(key)
}

function pendingSoundActionKeys(): string[] {
  const keys: string[] = []
  for (const pending of chatStore.pendingApprovals.values()) {
    keys.push(`chat-approval:${pending.sessionId}:${pending.approvalId}`)
  }
  for (const pending of chatStore.pendingClarifies.values()) {
    keys.push(`chat-clarify:${pending.sessionId}:${pending.clarifyId}`)
  }
  for (const pending of groupChatStore.pendingApprovals.values()) {
    keys.push(`group-approval:${pending.roomId}:${pending.approvalId}`)
  }
  for (const pending of groupChatStore.pendingClarifies.values()) {
    keys.push(`group-clarify:${pending.roomId}:${pending.clarifyId}`)
  }
  for (const status of Object.values(workflowStatuses)) {
    if (!status.runId) continue
    for (const { nodeId, executionId } of status.pendingApprovals || []) {
      keys.push(workflowApprovalKey(status.workflowId, status.runId, nodeId, executionId))
    }
  }
  return keys
}

function pendingActions(suppressVisibleSources = true): GlobalPendingAction[] {
  const actions: GlobalPendingAction[] = []
  const profile = profilesStore.activeProfileName || 'default'
  const visibleChatSessionId = suppressVisibleSources && ['hermes.chat', 'hermes.session', 'hermes.globalAgent', 'hermes.globalAgentSession'].includes(String(route.name || ''))
    ? chatStore.activeSessionId
    : null
  const visibleGroupRoomId = suppressVisibleSources && route.name === 'hermes.groupChatRoom' ? groupChatStore.currentRoomId : null
  for (const pending of chatStore.pendingApprovals.values()) {
    if (pending.sessionId === visibleChatSessionId) continue
    actions.push({ key: `chat-approval:${pending.sessionId}:${pending.approvalId}`, profile, kind: 'chat-approval', title: sessionTitle(pending.sessionId), pending })
  }
  for (const pending of chatStore.pendingClarifies.values()) {
    if (pending.sessionId === visibleChatSessionId) continue
    actions.push({ key: `chat-clarify:${pending.sessionId}:${pending.clarifyId}`, profile, kind: 'chat-clarify', title: sessionTitle(pending.sessionId), pending })
  }
  for (const pending of groupChatStore.pendingApprovals.values()) {
    if (pending.roomId === visibleGroupRoomId) continue
    actions.push({ key: `group-approval:${pending.roomId}:${pending.approvalId}`, profile, kind: 'group-approval', title: roomTitle(pending.roomId), pending })
  }
  for (const pending of groupChatStore.pendingClarifies.values()) {
    if (pending.roomId === visibleGroupRoomId) continue
    actions.push({ key: `group-clarify:${pending.roomId}:${pending.clarifyId}`, profile, kind: 'group-clarify', title: roomTitle(pending.roomId), pending })
  }
  for (const status of Object.values(workflowStatuses)) {
    if (!status.runId) continue
    for (const { nodeId, executionId } of status.pendingApprovals || []) {
      const key = workflowApprovalKey(status.workflowId, status.runId, nodeId, executionId)
      if (visibleWorkflowApprovalKeys.has(key)) continue
      actions.push({
        key,
        profile,
        kind: 'workflow-approval',
        title: workflows.value.find(workflow => workflow.id === status.workflowId)?.name || status.workflowId,
        workflowId: status.workflowId,
        runId: status.runId,
        nodeId,
        executionId,
      })
    }
  }
  return actions
}

async function copyApprovalCommand(action: Extract<GlobalPendingAction, { kind: 'chat-approval' | 'group-approval' }>) {
  const copied = await copyToClipboard(action.pending.command)
  if (!copied) {
    message.error(t('chat.copyFailed'))
    return
  }
  copiedCommandKey.value = action.key
}

function approvalCommand(action: Extract<GlobalPendingAction, { kind: 'chat-approval' | 'group-approval' }>) {
  if (!action.pending.command) return null
  return h('div', { class: 'global-approval-command studio-surface' }, [
    h('div', { class: 'global-approval-command-header' }, [
      h('span', { class: 'global-approval-command-label' }, t('chat.approvalCommand')),
      h(NButton, {
        size: 'tiny',
        quaternary: true,
        onClick: () => void copyApprovalCommand(action),
      }, { default: () => copiedCommandKey.value === action.key ? t('common.copied') : t('common.copy') }),
    ]),
    h('pre', { tabindex: 0 }, [h('code', action.pending.command)]),
  ])
}

function interactionCountdown(action: Extract<GlobalPendingAction, { kind: 'chat-approval' | 'chat-clarify' | 'group-approval' | 'group-clarify' }>) {
  return h(PendingInteractionCountdown, { deadline: action.pending.countdownDeadline })
}

function approvalButtons(action: Extract<GlobalPendingAction, { kind: 'chat-approval' | 'group-approval' }>) {
  const pending = action.pending
  const choices: ApprovalChoice[] = pending.isMemoryWrite ? ['once', 'deny'] : pending.choices
  const labels: Record<ApprovalChoice, string> = {
    once: pending.isMemoryWrite ? t('chat.approvalAgree') : t('chat.approvalAllowOnce'),
    session: t('chat.approvalAllowSession'),
    always: t('chat.approvalAlways'),
    deny: t('chat.approvalDeny'),
  }
  return h('div', { class: 'global-pending-actions' }, choices.map(choice => h(NButton, {
    size: 'small',
    type: choice === 'deny' ? 'error' : choice === 'once' ? 'primary' : 'default',
    secondary: choice !== 'once',
    loading: submitting[action.key],
    onClick: () => void submitApproval(action, choice),
  }, { default: () => labels[choice] })))
}

async function submitApproval(action: Extract<GlobalPendingAction, { kind: 'chat-approval' | 'group-approval' }>, choice: ApprovalChoice) {
  if (submitting[action.key]) return
  submitting[action.key] = true
  try {
    if (action.kind === 'chat-approval') chatStore.respondApprovalFor(action.pending.sessionId, action.pending.approvalId, choice)
    else await groupChatStore.respondApprovalFor(action.pending.roomId, action.pending.approvalId, choice)
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    submitting[action.key] = false
  }
}

function clarifyContent(action: Extract<GlobalPendingAction, { kind: 'chat-clarify' | 'group-clarify' }>) {
  return h('div', { class: 'global-clarify-content' }, [
    interactionCountdown(action),
    h('div', { class: 'global-clarify-question' }, action.pending.question),
    action.pending.choices?.length
      ? h('div', { class: 'global-clarify-choices' }, action.pending.choices.map(choice => h(NButton, {
          size: 'small', secondary: clarifyDrafts[action.key] !== choice,
          type: clarifyDrafts[action.key] === choice ? 'primary' : 'default',
          onClick: () => { clarifyDrafts[action.key] = choice },
        }, { default: () => choice })))
      : null,
    h(NInput, {
      value: clarifyDrafts[action.key] || '',
      placeholder: t('chat.clarifyPlaceholder'),
      'onUpdate:value': (value: string) => { clarifyDrafts[action.key] = value },
      onKeydown: (event: KeyboardEvent) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          void submitClarify(action)
        }
      },
    }),
  ])
}

async function submitClarify(action: Extract<GlobalPendingAction, { kind: 'chat-clarify' | 'group-clarify' }>) {
  const response = (clarifyDrafts[action.key] || '').trim()
  if (!response || submitting[action.key]) return
  submitting[action.key] = true
  try {
    if (action.kind === 'chat-clarify') chatStore.respondToClarifyFor(action.pending.sessionId, action.pending.clarifyId, response)
    else await groupChatStore.respondClarifyFor(action.pending.roomId, action.pending.clarifyId, response)
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    submitting[action.key] = false
  }
}

async function submitWorkflowApproval(action: Extract<GlobalPendingAction, { kind: 'workflow-approval' }>, approved: boolean) {
  if (submitting[action.key]) return
  submitting[action.key] = true
  try {
    await approveWorkflowNode(action.workflowId, action.runId, action.nodeId, approved, action.executionId)
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    submitting[action.key] = false
  }
}

function openPendingSource(action: GlobalPendingAction) {
  if (action.kind === 'chat-approval' || action.kind === 'chat-clarify') {
    const sessionId = action.pending.sessionId
    const session = chatStore.sessions.find(item => item.id === sessionId)
    void router.push({
      name: session?.source === 'global_agent' ? 'hermes.globalAgentSession' : 'hermes.session',
      params: { sessionId },
    })
    return
  }
  if (action.kind === 'group-approval' || action.kind === 'group-clarify') {
    void router.push({ name: 'hermes.groupChatRoom', params: { roomId: action.pending.roomId } })
    return
  }
  void router.push({
    name: 'hermes.workflow',
    query: { workflowId: action.workflowId, runId: action.runId, nodeId: action.nodeId, executionId: action.executionId },
  })
}

function systemNotificationCopy(action: GlobalPendingAction): { title: string; body: string } {
  const clarify = action.kind === 'chat-clarify' || action.kind === 'group-clarify'
  return {
    title: t(clarify ? 'settings.display.approvalNotificationClarifyTitle' : 'settings.display.approvalNotificationTitle'),
    body: t('settings.display.approvalNotificationBody'),
  }
}

function pendingSourceClickUrl(action: GlobalPendingAction): string {
  const profileQuery = `?profile=${encodeURIComponent(action.profile)}`
  if (action.kind === 'chat-approval' || action.kind === 'chat-clarify') {
    const sessionId = encodeURIComponent(action.pending.sessionId)
    const session = chatStore.sessions.find(item => item.id === action.pending.sessionId)
    return session?.source === 'global_agent'
      ? `/hermes/global-agent/session/${sessionId}${profileQuery}`
      : `/hermes/session/${sessionId}${profileQuery}`
  }
  if (action.kind === 'group-approval' || action.kind === 'group-clarify') {
    return `/hermes/group-chat/room/${encodeURIComponent(action.pending.roomId)}${profileQuery}`
  }
  const query = new URLSearchParams({
    profile: action.profile,
    workflowId: action.workflowId,
    runId: action.runId,
    nodeId: action.nodeId,
    ...(action.executionId ? { executionId: action.executionId } : {}),
  })
  return `/hermes/workflow?${query.toString()}`
}

function notifyPendingAction(action: GlobalPendingAction) {
  const copy = systemNotificationCopy(action)
  void showSystemNotification({
    ...copy,
    icon: '/coding-agents/hermes.png',
    tag: `hermes-pending-${encodeURIComponent(action.profile)}:${action.key}`,
    clickUrl: pendingSourceClickUrl(action),
  })
}

function notificationTitle(action: GlobalPendingAction, clarify: boolean) {
  return h('button', {
    type: 'button',
    class: 'global-pending-title',
    onClick: () => openPendingSource(action),
  }, `${action.title} · ${clarify ? t('chat.clarifyTitle') : t('chat.approvalTitle')}`)
}

function showPendingInteractionExpired() {
  message.warning(t('chat.interactionExpired'))
}

function createGlobalNotification(action: GlobalPendingAction): NotificationReactive {
  const clarify = action.kind === 'chat-clarify' || action.kind === 'group-clarify'
  return notification.create({
    title: () => notificationTitle(action, clarify),
    content: clarify
      ? () => clarifyContent(action)
      : action.kind === 'workflow-approval'
        ? () => h('div', { class: 'global-approval-content' }, t('workflow.status.pending_approval'))
        : () => h('div', { class: 'global-approval-content' }, [
            interactionCountdown(action),
            action.pending.description
              ? h('div', { class: 'global-approval-description' }, action.pending.description)
              : null,
            approvalCommand(action),
          ]),
    action: clarify
      ? () => h(NButton, {
          size: 'small', type: 'primary', disabled: !(clarifyDrafts[action.key] || '').trim(),
          loading: submitting[action.key], onClick: () => void submitClarify(action),
        }, { default: () => t('chat.clarifySubmit') })
      : action.kind === 'workflow-approval'
        ? () => h('div', { class: 'global-pending-actions' }, [
            h(NButton, { size: 'small', type: 'error', secondary: true, loading: submitting[action.key], onClick: () => void submitWorkflowApproval(action, false) }, { default: () => t('chat.approvalDeny') }),
            h(NButton, { size: 'small', type: 'primary', loading: submitting[action.key], onClick: () => void submitWorkflowApproval(action, true) }, { default: () => t('common.confirm') }),
          ])
        : () => approvalButtons(action),
    duration: 0,
    closable: false,
  })
}

watch(pendingSoundActionKeys, keys => {
  const liveKeys = new Set(keys)
  const shouldAnnounce = pendingBaselineEstablished
  let hasNewAction = false
  for (const key of pendingSoundKeys) {
    if (!liveKeys.has(key)) pendingSoundKeys.delete(key)
  }
  for (const key of pendingNotificationKeys) {
    if (!liveKeys.has(key)) pendingNotificationKeys.delete(key)
  }
  for (const key of keys) {
    if (announcedKeys.has(key)) continue
    announcedKeys.add(key)
    if (shouldAnnounce) {
      hasNewAction = true
      if (!approvalSoundArmed) {
        pendingSoundKeys.add(key)
        pendingNotificationKeys.add(key)
      }
      if (approvalSoundArmed && settingsStore.display.notify_on_approval) {
        const action = pendingActions(false).find(candidate => candidate.key === key)
        if (action) notifyPendingAction(action)
      }
    }
  }
  pendingBaselineEstablished = true
  if (hasNewAction && approvalSoundArmed && settingsStore.display.approval_bell) void playCompletionSound()
}, { immediate: true })

watch(pendingActions, actions => {
  const liveKeys = new Set(actions.map(action => action.key))
  for (const [key, handle] of handles) {
    if (liveKeys.has(key)) continue
    handle.destroy()
    handles.delete(key)
    delete clarifyDrafts[key]
    delete submitting[key]
  }
  for (const action of actions) {
    if (handles.has(action.key)) continue
    handles.set(action.key, createGlobalNotification(action))
  }
}, { deep: true, immediate: true })

onMounted(() => {
  window.addEventListener(PENDING_INTERACTION_EXPIRED_EVENT, showPendingInteractionExpired)
  window.addEventListener('hermes:workflow-approval-visible', handleVisibleWorkflowApproval)
  resetWorkflowSubscriptions(profilesStore.activeProfileName)
  void groupChatStore.connect().catch(() => undefined)
  loadApprovalSoundSetting()
})

watch(() => profilesStore.activeProfileName, profile => {
  resetWorkflowSubscriptions(profile)
  loadApprovalSoundSetting()
})

onUnmounted(() => {
  window.removeEventListener(PENDING_INTERACTION_EXPIRED_EVENT, showPendingInteractionExpired)
  window.removeEventListener('hermes:workflow-approval-visible', handleVisibleWorkflowApproval)
  visibleWorkflowApprovalKeys.clear()
  settingsLoadGeneration++
  pendingSoundKeys.clear()
  pendingNotificationKeys.clear()
  stopWorkflowStatus?.()
  disconnectWorkflowSocket()
  groupChatStore.disconnect()
  for (const handle of handles.values()) handle.destroy()
  handles.clear()
})
</script>

<template><span class="global-pending-actions-host" aria-hidden="true" /></template>

<style scoped>.global-pending-actions-host { display: none; }</style>
<style>
.n-notification:has(.global-approval-content, .global-clarify-content) {
  width: min(560px, calc(100vw - 32px));
  border: var(--border-width, 1px) solid var(--border-color);
  border-radius: var(--radius-component, 14px);
  background: var(--theme-content-bg, var(--bg-main-surface));
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.14);
}
.n-notification:has(.global-approval-content, .global-clarify-content) .n-notification-main { margin-inline-start: 0; }
.n-notification:has(.global-approval-content, .global-clarify-content) .n-notification-main__header { color: var(--text-primary); font-size: calc(var(--font-size-base, 14px) * 15 / 14); font-weight: 600; }
.n-notification:has(.global-approval-content, .global-clarify-content) .n-notification-main-footer { padding-top: calc(12px * var(--spacing-scale, 1)); border-top: var(--border-width, 1px) solid var(--border-light); }
.global-pending-title { appearance: none; border: 0; padding: 0; background: transparent; color: inherit; font: inherit; text-align: start; cursor: pointer; text-decoration: underline; text-decoration-color: transparent; text-underline-offset: 3px; }
.global-pending-title:hover { text-decoration-color: currentcolor; }
.global-pending-title:focus-visible { border-radius: var(--radius-component, 2px); outline: 2px solid var(--accent-info); outline-offset: 3px; }
.global-pending-actions, .global-clarify-choices { display: flex; flex-wrap: wrap; gap: calc(8px * var(--spacing-scale, 1)); }
.global-approval-content, .global-clarify-content { display: grid; gap: calc(12px * var(--spacing-scale, 1)); max-width: 520px; max-height: min(420px, calc(100dvh - 190px)); overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; overflow-wrap: anywhere; }
.global-approval-description { padding: calc(10px * var(--spacing-scale, 1)) calc(12px * var(--spacing-scale, 1)); border: var(--border-width, 1px) solid rgba(var(--warning-rgb), 0.28); border-radius: var(--radius-component, 10px); background: rgba(var(--warning-rgb), 0.08); color: var(--text-secondary); font-size: calc(var(--font-size-base, 14px) * 13 / 14); line-height: var(--line-height, 1.55); }
.global-approval-command { min-width: 0; overflow: hidden; border: var(--border-width, 1px) solid rgba(var(--text-primary-rgb), 0.1); border-radius: var(--radius-component, 10px); background: rgba(var(--accent-primary-rgb), 0.055); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.035); }
.global-approval-command-header { display: flex; align-items: center; justify-content: space-between; gap: calc(12px * var(--spacing-scale, 1)); min-height: 36px; padding: calc(4px * var(--spacing-scale, 1)) calc(6px * var(--spacing-scale, 1)) calc(4px * var(--spacing-scale, 1)) calc(12px * var(--spacing-scale, 1)); border-bottom: var(--border-width, 1px) solid rgba(var(--text-primary-rgb), 0.08); }
.global-approval-command-label { color: var(--text-secondary); font-size: calc(var(--font-size-base, 14px) * 12 / 14); font-weight: 600; }
.global-approval-command pre { max-height: 240px; margin: 0; padding: calc(12px * var(--spacing-scale, 1)); overflow: auto; overscroll-behavior: contain; white-space: pre; }
.global-approval-command code { display: block; width: max-content; min-width: 100%; color: var(--text-primary); font-family: "SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace; font-size: calc(var(--font-size-base, 14px) * 12 / 14); line-height: var(--line-height, 1.55); }
.global-clarify-question { font-weight: 600; }

@media (max-width: 600px) {
  .n-notification:has(.global-approval-content, .global-clarify-content) { width: calc(100vw - 24px); }
}
</style>
