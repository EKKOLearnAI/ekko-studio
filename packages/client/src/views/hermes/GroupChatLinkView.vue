<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { NButton, NInput, NSelect } from 'naive-ui'
import { useAppStore } from '@/stores/hermes/app'
import { useProfilesStore } from '@/stores/hermes/profiles'
import ProfileAvatar from '@/components/hermes/profiles/ProfileAvatar.vue'
import {
  defaultGroupAgentAvatar,
  parseStoredAvatar,
} from '@/utils/group-agent-avatar'
import { canScopedCodingAgentUseProvider } from '@/utils/codingAgentProviders'
import {
  inferCodingAgentApiMode,
  normalizeCodingAgentApiMode,
  type CodingAgentApiMode,
} from '@/api/coding-agents'
import type { ProfileAvatar as ProfileAvatarData } from '@/api/hermes/profiles'
import {
  connectLocalGroupAgent,
  connectLocalGroupAgentHandoff,
  listLocalGroupAgents,
  listLocalGroupAgentConnections,
  updateLocalGroupAgent,
  type LocalGroupAgentConnection,
  type RemoteGroupAgentDescriptor,
} from '@/api/studio/group-chat-agent-link'
import {
  fetchAgentStatusSnapshot,
  isAgentStatusAvailable,
  type AgentStatusSnapshot,
} from '@/api/agent-status'

const { t } = useI18n()
const route = useRoute()
const appStore = useAppStore()
const profilesStore = useProfilesStore()
const profileAgents = ref<RemoteGroupAgentDescriptor[]>([])
const connections = ref<LocalGroupAgentConnection[]>([])
const agentStatusSnapshot = ref<AgentStatusSnapshot | null>(null)
type GroupAgentType = RemoteGroupAgentDescriptor['agent']
const selectedAgentType = ref<GroupAgentType>('hermes')
const selectedProfile = ref('')
const selectedAgentMode = ref<'scoped' | 'global'>('scoped')
const selectedAgentProvider = ref('')
const selectedAgentModel = ref('')
const selectedAgentApiMode = ref<CodingAgentApiMode>('codex_responses')
const selectedAgentReasoningEffort = ref('')
const agentName = ref('')
const agentDescription = ref('')
const agentAvatar = ref<ProfileAvatarData | null>(null)
const agentAvatarFileInput = ref<HTMLInputElement | null>(null)
const loading = ref(true)
const connecting = ref(false)
const connected = ref(false)
const error = ref('')
const manualCode = ref('')
const waitingForApproval = ref(false)
const approvedAgent = ref<RemoteGroupAgentDescriptor | null>(null)
const parentReady = ref(false)
let parentSelectionAckTimer: ReturnType<typeof setTimeout> | null = null
let parentReadyTimers: Array<ReturnType<typeof setTimeout>> = []
let linkViewMounted = false

function queryText(name: string): string {
  const value = route.query[name]
  return typeof value === 'string' ? value.trim() : ''
}

function normalizedOrigin(value: string): string {
  if (!value) return ''
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : ''
  } catch {
    return ''
  }
}

const parentOrigin = computed(() => normalizedOrigin(queryText('parentOrigin')))
const state = computed(() => queryText('state'))
const handoffCloudOrigin = computed(() => normalizedOrigin(queryText('cloudOrigin')))
const handoffInviteCode = computed(() => queryText('inviteCode'))
const handoffRequestId = computed(() => queryText('requestId'))
const handoffRequestSecret = computed(() => queryText('requestSecret'))
const handoffPairingTicket = computed(() => queryText('pairingTicket'))
const editConnectorId = computed(() => queryText('editConnectorId'))
const editingMode = computed(() => Boolean(editConnectorId.value))
const editingConnection = computed(() => (
  connections.value.find(connection => connection.connectorId === editConnectorId.value) || null
))
const hasServerHandoff = computed(() => (
  !!handoffCloudOrigin.value
  && !!handoffInviteCode.value
  && !!handoffRequestId.value
  && !!handoffRequestSecret.value
  && !!handoffPairingTicket.value
))
const groupAgentTypeDefinitions: Array<{ label: string; value: GroupAgentType }> = [
  { label: 'Hermes', value: 'hermes' },
  { label: 'Ekko', value: 'ekko' },
  { label: 'Claude', value: 'claude' },
  { label: 'Codex', value: 'codex' },
  { label: 'Pi', value: 'pi' },
  { label: 'Grok', value: 'grok' },
  { label: 'Cursor', value: 'cursor' },
  { label: 'OpenCode', value: 'opencode' },
  { label: 'DeepSeek Harness', value: 'dsh' },
]
const groupAgentTypeOptions = computed(() => groupAgentTypeDefinitions.map((option) => {
  const disabled = !isAgentStatusAvailable(agentStatusSnapshot.value, option.value)
  return {
    ...option,
    disabled,
    label: disabled ? `${option.label} · ${t('codingAgents.notInstalled')}` : option.label,
  }
}))
const firstAvailableGroupAgentType = computed<GroupAgentType | null>(() =>
  groupAgentTypeOptions.value.find(option => !option.disabled)?.value || null,
)
const profileOptions = computed(() => profileAgents.value.map(agent => ({
  label: agent.profile,
  value: agent.profile,
})))

function getAgentModelGroups(profile: string) {
  return (appStore.profileModelGroups.find(entry => entry.profile === profile)?.groups || [])
    .filter((group) => {
      if (group.provider === 'moa') return selectedAgentType.value === 'hermes'
      if (selectedAgentType.value === 'hermes') return true
      const codingAgentId = selectedAgentType.value === 'ekko'
        ? 'ekko-agent'
        : selectedAgentType.value === 'claude'
          ? 'claude-code'
          : selectedAgentType.value === 'pi'
            ? 'pi'
            : selectedAgentType.value === 'grok'
              ? 'grok'
            : selectedAgentType.value === 'cursor'
              ? 'cursor'
            : selectedAgentType.value === 'dsh' ? 'dsh' : selectedAgentType.value === 'opencode'
              ? 'opencode'
              : 'codex'
      return canScopedCodingAgentUseProvider(codingAgentId, group.provider)
    })
}

function getDefaultAgentModel(profile: string) {
  const groups = getAgentModelGroups(profile)
  const profileModels = appStore.profileModelGroups.find(entry => entry.profile === profile)
  const selectedGroup = groups.find(group => (
    group.provider === appStore.selectedProvider
    && group.models.includes(appStore.selectedModel)
  ))
  const defaultGroup = groups.find(group => group.provider === profileModels?.default_provider)
  const fallbackGroup = selectedGroup || defaultGroup || groups.find(group => group.models.length > 0)
  return {
    provider: fallbackGroup?.provider || '',
    model: fallbackGroup?.models.includes(profileModels?.default || '')
      ? profileModels?.default || ''
      : fallbackGroup?.models[0] || '',
  }
}

const agentProviderOptions = computed(() => getAgentModelGroups(selectedProfile.value).map(group => ({
  label: group.label || group.provider,
  value: group.provider,
})))
const selectedAgentProviderGroup = computed(() => getAgentModelGroups(selectedProfile.value)
  .find(group => group.provider === selectedAgentProvider.value))
const agentModelOptions = computed(() => (selectedAgentProviderGroup.value?.models || []).map(model => ({
  label: appStore.displayModelName(model, selectedAgentProvider.value),
  value: model,
})))
const agentApiModeOptions = computed(() => [
  { label: t('codingAgents.protocolOpenAiChat'), value: 'chat_completions' },
  { label: t('codingAgents.protocolOpenAiResponses'), value: 'codex_responses' },
  { label: t('codingAgents.protocolAnthropicMessages'), value: 'anthropic_messages' },
])
const agentReasoningEffortOptions = computed(() => [
  { label: t('chat.reasoningEffort.options.default'), value: '' },
  { label: t('chat.reasoningEffort.options.none'), value: 'none' },
  { label: t('chat.reasoningEffort.options.minimal'), value: 'minimal' },
  { label: t('chat.reasoningEffort.options.low'), value: 'low' },
  { label: t('chat.reasoningEffort.options.medium'), value: 'medium' },
  { label: t('chat.reasoningEffort.options.high'), value: 'high' },
  { label: t('chat.reasoningEffort.options.xhigh'), value: 'xhigh' },
  { label: t('chat.reasoningEffort.options.max'), value: 'max' },
])
const supportsGlobalAgentMode = computed(() => ['claude', 'codex', 'pi', 'grok', 'opencode', 'dsh', 'cursor'].includes(selectedAgentType.value))
const usesGlobalAgentMode = computed(() => supportsGlobalAgentMode.value && selectedAgentMode.value === 'global')
const agentModeOptions = computed(() => [
  { label: t('codingAgents.launchModeGlobal'), value: 'global' },
  { label: t('codingAgents.launchModeScoped'), value: 'scoped' },
])
const agentAvatarPreview = computed(() => (
  agentAvatar.value || defaultGroupAgentAvatar(selectedAgentType.value)
))
const selectedAgent = computed<RemoteGroupAgentDescriptor | null>(() => {
  if (!isAgentStatusAvailable(agentStatusSnapshot.value, selectedAgentType.value)) return null
  if (!selectedProfile.value || (!usesGlobalAgentMode.value && (!selectedAgentProvider.value || !selectedAgentModel.value))) return null
  return {
    agent: selectedAgentType.value,
    agentMode: usesGlobalAgentMode.value ? 'global' : 'scoped',
    profile: selectedProfile.value,
    provider: usesGlobalAgentMode.value ? '' : selectedAgentProvider.value,
    model: usesGlobalAgentMode.value ? '' : selectedAgentModel.value,
    apiMode: selectedAgentType.value === 'hermes' || usesGlobalAgentMode.value ? '' : selectedAgentApiMode.value,
    reasoningEffort: usesGlobalAgentMode.value ? '' : selectedAgentReasoningEffort.value,
    name: agentName.value.trim() || selectedProfile.value,
    description: agentDescription.value.trim(),
    avatar: agentAvatar.value ? JSON.stringify(agentAvatar.value) : '',
  }
})
const manualPairingOrigin = computed(() => {
  if (!manualCode.value.trim()) return ''
  try {
    return normalizedOrigin(decodePairingCode(manualCode.value).cloudOrigin)
  } catch {
    return ''
  }
})
const manualPairingAgent = computed(() => {
  if (!manualCode.value.trim()) return null
  try {
    return decodePairingCode(manualCode.value).agent
  } catch {
    return null
  }
})

function postToParent(type: string, payload: Record<string, unknown> = {}): boolean {
  if (!window.opener || !parentOrigin.value || !state.value) return false
  try {
    window.opener.postMessage({ type, state: state.value, ...payload }, parentOrigin.value)
    return true
  } catch {
    return false
  }
}

function clearParentSelectionAckTimer(): void {
  if (parentSelectionAckTimer) clearTimeout(parentSelectionAckTimer)
  parentSelectionAckTimer = null
}

function clearParentReadyTimers(): void {
  parentReadyTimers.forEach(timer => clearTimeout(timer))
  parentReadyTimers = []
}

function announceLinkReady(): void {
  postToParent('hermes.group-chat.link-ready', {
    targetOrigin: window.location.origin,
  })
}

function scheduleParentHandshake(): void {
  clearParentReadyTimers()
  parentReady.value = false
  for (const delay of [0, 250, 1_000]) {
    parentReadyTimers.push(setTimeout(() => {
      if (!parentReady.value) announceLinkReady()
    }, delay))
  }
}

function closeWindow(): void {
  window.close()
}

function syncAgentApiMode(): void {
  const group = selectedAgentProviderGroup.value
  selectedAgentApiMode.value = normalizeCodingAgentApiMode(
    group?.api_mode,
    inferCodingAgentApiMode(group?.provider || selectedAgentProvider.value, group?.base_url),
  )
}

function syncAgentModelSelection(profile: string): void {
  const defaults = getDefaultAgentModel(profile)
  selectedAgentProvider.value = defaults.provider
  selectedAgentModel.value = defaults.model
  selectedAgentReasoningEffort.value = ''
  syncAgentApiMode()
}

function handleAgentTypeChange(agent: GroupAgentType): void {
  if (!isAgentStatusAvailable(agentStatusSnapshot.value, agent)) {
    const name = groupAgentTypeDefinitions.find(option => option.value === agent)?.label || agent
    error.value = t('codingAgents.installRequired', { agent: name })
    return
  }
  error.value = ''
  selectedAgentType.value = agent
  if (agent === 'cursor') selectedAgentMode.value = 'global'
  else if (!['claude', 'codex', 'pi', 'grok', 'opencode', 'dsh', 'cursor'].includes(agent)) selectedAgentMode.value = 'scoped'
  syncAgentModelSelection(selectedProfile.value)
}

function handleAgentProfileChange(profile: string): void {
  selectedProfile.value = profile
  syncAgentModelSelection(profile)
}

function handleAgentProviderChange(provider: string): void {
  selectedAgentProvider.value = provider
  selectedAgentModel.value = agentModelOptions.value[0]?.value || ''
  selectedAgentReasoningEffort.value = ''
  syncAgentApiMode()
}

function handleAgentModelChange(model: string): void {
  selectedAgentModel.value = model
  selectedAgentReasoningEffort.value = ''
}

function applyAgentConfiguration(agent: RemoteGroupAgentDescriptor): void {
  selectedAgentType.value = agent.agent
  selectedAgentMode.value = agent.agentMode === 'global' ? 'global' : 'scoped'
  selectedProfile.value = agent.profile
  selectedAgentProvider.value = agent.provider
  selectedAgentModel.value = agent.model
  selectedAgentApiMode.value = normalizeCodingAgentApiMode(
    agent.apiMode,
    inferCodingAgentApiMode(agent.provider),
  )
  selectedAgentReasoningEffort.value = agent.reasoningEffort
  agentName.value = agent.name
  agentDescription.value = agent.description
  agentAvatar.value = parseStoredAvatar(agent.avatar)
}

function handleRandomAgentAvatar(): void {
  agentAvatar.value = {
    type: 'generated',
    seed: `group-agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  }
}

function handleResetAgentAvatar(): void {
  agentAvatar.value = null
}

function triggerAgentAvatarUpload(): void {
  agentAvatarFileInput.value?.click()
}

async function handleAgentAvatarFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    error.value = t('profiles.avatar.invalidType')
    return
  }
  if (file.size > 1024 * 1024) {
    error.value = t('profiles.avatar.tooLarge')
    return
  }
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(reader.error || new Error('Failed to read file'))
      reader.readAsDataURL(file)
    })
    agentAvatar.value = { type: 'image', dataUrl }
    error.value = ''
  } catch {
    error.value = t('profiles.avatar.saveFailed')
  }
}

async function chooseAgent(): Promise<void> {
  if (!selectedAgent.value) {
    error.value = t('groupChat.agentLinkIncompleteConfiguration')
    return
  }
  if (editingMode.value) {
    const connection = editingConnection.value
    if (!connection) {
      error.value = t('groupChat.agentLinkError')
      return
    }
    error.value = ''
    waitingForApproval.value = true
    try {
      await updateLocalGroupAgent(connection.connectorId, selectedAgent.value)
      window.close()
    } catch (err: any) {
      error.value = err?.message || t('common.saveFailed')
      waitingForApproval.value = false
    }
    return
  }
  approvedAgent.value = { ...selectedAgent.value }
  error.value = ''
  waitingForApproval.value = true
  clearParentSelectionAckTimer()
  if (hasServerHandoff.value) {
    try {
      await connectLocalGroupAgentHandoff({
        cloudOrigin: handoffCloudOrigin.value,
        targetOrigin: window.location.origin,
        inviteCode: handoffInviteCode.value,
        requestId: handoffRequestId.value,
        requestSecret: handoffRequestSecret.value,
        pairingTicket: handoffPairingTicket.value,
        agent: approvedAgent.value,
      })
      window.close()
      return
    } catch (err: any) {
      waitingForApproval.value = false
      approvedAgent.value = null
      error.value = err?.message || t('groupChat.agentLinkConnectFailed')
      return
    }
  }
  const posted = postToParent('hermes.group-chat.agent-selected', {
    targetOrigin: window.location.origin,
    agent: approvedAgent.value,
  })
  if (!posted) {
    waitingForApproval.value = false
    approvedAgent.value = null
    error.value = t('groupChat.agentLinkParentUnavailable')
    return
  }
  parentSelectionAckTimer = setTimeout(() => {
    waitingForApproval.value = false
    approvedAgent.value = null
    error.value = t('groupChat.agentLinkParentUnconfirmed')
  }, 5_000)
}

async function connect(input: {
  cloudOrigin: string
  pairingTicket: string
  agent: RemoteGroupAgentDescriptor
}, requireParentApproval = true): Promise<void> {
  if (connecting.value || connected.value) return
  connecting.value = true
  error.value = ''
  try {
    const cloudOrigin = normalizedOrigin(input.cloudOrigin)
    if (
      requireParentApproval
      && (
        !cloudOrigin
        || cloudOrigin !== parentOrigin.value
        || !approvedAgent.value
        || !sameAgentDescriptor(input.agent, approvedAgent.value)
      )
    ) {
      throw new Error(t('groupChat.agentLinkApprovalMismatch'))
    }
    const result = await connectLocalGroupAgent({
      cloudOrigin,
      targetOrigin: window.location.origin,
      pairingTicket: input.pairingTicket,
      agent: input.agent,
    })
    connected.value = result.ok
    waitingForApproval.value = false
    clearParentSelectionAckTimer()
    const localConnections = await listLocalGroupAgentConnections()
    connections.value = localConnections.connections
    postToParent('hermes.group-chat.connected', { connectorId: result.connectorId })
  } catch (err: any) {
    error.value = err?.message || t('groupChat.agentLinkConnectFailed')
    waitingForApproval.value = false
    approvedAgent.value = null
    clearParentSelectionAckTimer()
    postToParent('hermes.group-chat.connect-failed', { error: error.value })
  } finally {
    connecting.value = false
  }
}

function decodePairingCode(value: string): {
  cloudOrigin: string
  pairingTicket: string
  agent: RemoteGroupAgentDescriptor
} {
  const trimmed = value.trim()
  if (!trimmed.startsWith('HGC2.') || trimmed.length > 2_100_000) {
    throw new Error(t('groupChat.agentLinkInvalidPairingCode'))
  }
  const encoded = trimmed.slice(5).replace(/-/g, '+').replace(/_/g, '/')
  const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')
  const bytes = Uint8Array.from(atob(padded), char => char.charCodeAt(0))
  const parsed = JSON.parse(new TextDecoder().decode(bytes))
  if (parsed?.protocolVersion !== 2 || !parsed?.cloudOrigin || !parsed?.pairingTicket || !parsed?.agent) {
    throw new Error(t('groupChat.agentLinkInvalidPairingCode'))
  }
  return parsed
}

async function connectManualCode(): Promise<void> {
  try {
    await connect(decodePairingCode(manualCode.value), false)
  } catch (err: any) {
    error.value = err?.message || t('groupChat.agentLinkInvalidPairingCode')
  }
}

function sameAgentDescriptor(left: unknown, right: RemoteGroupAgentDescriptor): boolean {
  if (!left || typeof left !== 'object' || Array.isArray(left)) return false
  const candidate = left as Record<string, unknown>
  return (
    candidate.agent === right.agent
    && (candidate.agentMode === 'global' ? 'global' : 'scoped') === right.agentMode
    && candidate.profile === right.profile
    && candidate.provider === right.provider
    && candidate.model === right.model
    && candidate.apiMode === right.apiMode
    && candidate.reasoningEffort === right.reasoningEffort
    && candidate.name === right.name
    && candidate.description === right.description
    && candidate.avatar === right.avatar
  )
}

function handleParentMessage(event: MessageEvent): void {
  if (!parentOrigin.value || event.origin !== parentOrigin.value || event.source !== window.opener) return
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return
  const data = event.data as Record<string, unknown>
  if (data.state !== state.value) return
  if (data.type === 'hermes.group-chat.parent-ready') {
    parentReady.value = true
    clearParentReadyTimers()
    return
  }
  if (data.type === 'hermes.group-chat.selection-received') {
    parentReady.value = true
    clearParentSelectionAckTimer()
    return
  }
  if (data.type === 'hermes.group-chat.pairing-failed') {
    waitingForApproval.value = false
    approvedAgent.value = null
    clearParentSelectionAckTimer()
    error.value = String(data.error || t('groupChat.agentLinkError'))
    return
  }
  if (data.type !== 'hermes.group-chat.connect') return
  void connect({
    cloudOrigin: String(data.cloudOrigin || ''),
    pairingTicket: String(data.pairingTicket || ''),
    agent: data.agent as RemoteGroupAgentDescriptor,
  })
}

watch([parentOrigin, state], () => {
  waitingForApproval.value = false
  approvedAgent.value = null
  clearParentSelectionAckTimer()
  if (linkViewMounted) scheduleParentHandshake()
})

onMounted(async () => {
  linkViewMounted = true
  window.addEventListener('message', handleParentMessage)
  scheduleParentHandshake()
  try {
    const [localAgents, localConnections, , , agentStatus] = await Promise.all([
      listLocalGroupAgents(),
      listLocalGroupAgentConnections(),
      profilesStore.fetchProfiles(),
      appStore.loadModels(),
      fetchAgentStatusSnapshot(),
    ])
    profileAgents.value = localAgents.agents
    connections.value = localConnections.connections
    agentStatusSnapshot.value = agentStatus
    if (editingMode.value) {
      const connection = editingConnection.value
      if (!connection) {
        error.value = t('groupChat.agentLinkError')
      } else {
        applyAgentConfiguration(connection.agent)
      }
    } else {
      selectedAgentType.value = firstAvailableGroupAgentType.value || 'hermes'
      selectedProfile.value =
        profilesStore.activeProfileName
        || profilesStore.profiles.find(profile => profile.active)?.name
        || profileAgents.value[0]?.profile
        || ''
      if (
        selectedProfile.value
        && !profileAgents.value.some(agent => agent.profile === selectedProfile.value)
      ) {
        selectedProfile.value = profileAgents.value[0]?.profile || ''
      }
      syncAgentModelSelection(selectedProfile.value)
    }
  } catch (err: any) {
    error.value = err?.message || t('groupChat.agentLinkLoadFailed')
  } finally {
    loading.value = false
  }
})

onUnmounted(() => {
  linkViewMounted = false
  clearParentSelectionAckTimer()
  clearParentReadyTimers()
  window.removeEventListener('message', handleParentMessage)
})
</script>

<template>
  <main class="group-chat-link-view">
    <section class="link-card">
      <img src="/logo.png" alt="" class="link-logo">
      <h1>
        {{ editingConnection
          ? t('groupChat.editAgentTitle', { name: editingConnection.agent.name })
          : t('groupChat.agentLinkAuthorizeTitle') }}
      </h1>
      <p>{{ t('groupChat.agentLinkAuthorizeDescription') }}</p>
      <code v-if="editingConnection || parentOrigin" class="requesting-origin">
        {{ editingConnection?.cloudOrigin || parentOrigin }}
      </code>

      <div v-if="loading" class="link-status">{{ t('common.loading') }}</div>
      <div v-else-if="connected" class="link-success">
        <strong>{{ t('groupChat.agentLinkConnected') }}</strong>
        <NButton type="primary" @click="closeWindow">{{ t('groupChat.agentLinkClose') }}</NButton>
      </div>
      <template v-else>
        <div v-if="profileAgents.length" class="link-form agent-config-form">
          <label>{{ t('groupChat.agentLinkSelectAgent') }}</label>
          <div class="group-agent-avatar-editor">
            <ProfileAvatar
              :name="selectedAgentType"
              :avatar="agentAvatarPreview"
              :size="56"
            />
            <div class="group-agent-avatar-actions">
              <NButton size="tiny" :disabled="waitingForApproval" @click="triggerAgentAvatarUpload">
                {{ t('profiles.avatar.upload') }}
              </NButton>
              <NButton size="tiny" :disabled="waitingForApproval" @click="handleRandomAgentAvatar">
                {{ t('profiles.avatar.random') }}
              </NButton>
              <NButton size="tiny" :disabled="waitingForApproval" @click="handleResetAgentAvatar">
                {{ t('profiles.avatar.reset') }}
              </NButton>
            </div>
            <input
              ref="agentAvatarFileInput"
              class="group-agent-avatar-file"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              @change="handleAgentAvatarFileChange"
            >
          </div>
          <div class="field">
            <label>{{ t('groupChat.agentType') }}</label>
            <NSelect
              :value="selectedAgentType"
              :options="groupAgentTypeOptions"
              :disabled="waitingForApproval"
              @update:value="handleAgentTypeChange"
            />
          </div>
          <div class="field">
            <label>{{ t('sidebar.profiles') }}</label>
            <NSelect
              :value="selectedProfile"
              :options="profileOptions"
              :placeholder="t('groupChat.selectProfile')"
              :disabled="waitingForApproval"
              filterable
              @update:value="handleAgentProfileChange"
            />
          </div>
          <div v-if="supportsGlobalAgentMode && selectedAgentType !== 'cursor'" class="field">
            <label>{{ t('codingAgents.launchModeScope') }}</label>
            <NSelect
              v-model:value="selectedAgentMode"
              :options="agentModeOptions"
              :disabled="waitingForApproval"
            />
          </div>
          <div v-if="!usesGlobalAgentMode" class="field">
            <label>{{ t('models.provider') }}</label>
            <NSelect
              :value="selectedAgentProvider"
              :options="agentProviderOptions"
              :placeholder="t('models.selectProvider')"
              :disabled="waitingForApproval"
              filterable
              @update:value="handleAgentProviderChange"
            />
          </div>
          <div v-if="!usesGlobalAgentMode" class="field">
            <label>{{ t('models.models') }}</label>
            <NSelect
              :value="selectedAgentModel"
              :options="agentModelOptions"
              :placeholder="t('models.selectModel')"
              :disabled="waitingForApproval || !selectedAgentProvider"
              filterable
              @update:value="handleAgentModelChange"
            />
          </div>
          <div v-if="selectedAgentType !== 'hermes' && !usesGlobalAgentMode" class="field">
            <label>{{ t('codingAgents.protocolScope') }}</label>
            <NSelect
              v-model:value="selectedAgentApiMode"
              :options="agentApiModeOptions"
              :disabled="waitingForApproval"
            />
          </div>
          <div v-if="!usesGlobalAgentMode" class="field">
            <label>{{ t('chat.reasoningEffort.tooltip') }}</label>
            <NSelect
              v-model:value="selectedAgentReasoningEffort"
              :options="agentReasoningEffortOptions"
              :disabled="waitingForApproval"
            />
          </div>
          <div class="field">
            <label>{{ t('groupChat.agentName') }}</label>
            <NInput
              v-model:value="agentName"
              :placeholder="t('groupChat.agentNamePlaceholder')"
              :maxlength="120"
              :disabled="waitingForApproval"
            />
          </div>
          <div class="field">
            <label>{{ t('groupChat.agentDesc') }}</label>
            <NInput
              v-model:value="agentDescription"
              type="textarea"
              :rows="2"
              :maxlength="2000"
              :placeholder="t('groupChat.agentDescPlaceholder')"
              :disabled="waitingForApproval"
            />
          </div>
          <NButton
            type="primary"
            :loading="waitingForApproval"
            :disabled="waitingForApproval"
            @click="chooseAgent"
          >
            {{ editingMode
              ? t('common.save')
              : waitingForApproval
                ? t('groupChat.agentLinkWaitingApproval')
                : t('groupChat.agentLinkRequestConnection') }}
          </NButton>
        </div>

        <template v-if="!editingMode">
          <div class="manual-divider"><span>{{ t('groupChat.agentLinkOrPairingCode') }}</span></div>
          <div class="link-form">
            <NInput
              v-model:value="manualCode"
              type="textarea"
              :rows="4"
              :maxlength="2100000"
              :placeholder="t('groupChat.agentLinkPairingCodePlaceholder')"
            />
            <code v-if="manualPairingOrigin" class="requesting-origin">{{ manualPairingOrigin }}</code>
            <div v-if="manualPairingAgent" class="manual-agent-preview">
              <strong>{{ manualPairingAgent.name }}</strong>
              <span>{{ manualPairingAgent.profile }}</span>
              <span v-if="manualPairingAgent.agentMode === 'global'">
                {{ t('codingAgents.launchModeGlobal') }}
              </span>
              <span v-else>{{ manualPairingAgent.provider }} / {{ manualPairingAgent.model }}</span>
            </div>
            <NButton
              secondary
              :loading="connecting"
              :disabled="!manualCode.trim()"
              @click="connectManualCode"
            >
              {{ t('groupChat.agentLinkConnect') }}
            </NButton>
          </div>
        </template>
      </template>

      <p v-if="error" class="link-error" role="alert">{{ error }}</p>
      <p class="link-security">{{ t('groupChat.agentLinkSecurityHint') }}</p>
    </section>
  </main>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.group-chat-link-view {
  min-height: calc(100 * var(--vh));
  box-sizing: border-box;
  display: grid;
  place-items: center;
  padding: 24px;
  background: $bg-primary;
}

.link-card {
  width: min(100%, 480px);
  box-sizing: border-box;
  padding: 36px;
  border: 1px solid $border-color;
  border-radius: 20px;
  background: $bg-card;
  box-shadow: 0 22px 70px rgba(0, 0, 0, 0.16);

  h1 {
    margin: 16px 0 8px;
    color: $text-primary;
    font-size: 25px;
  }

  > p {
    color: $text-secondary;
    line-height: 1.6;
  }
}

.link-logo {
  width: 48px;
  height: 48px;
  border-radius: 13px;
}

.requesting-origin {
  display: block;
  overflow: hidden;
  padding: 8px 10px;
  border: 1px solid $border-color;
  border-radius: 8px;
  color: $text-secondary;
  background: $bg-primary;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.link-form,
.link-success {
  display: grid;
  gap: 12px;
  margin-top: 22px;
}

.agent-config-form {
  padding: 14px;
  border: 1px solid $border-color;
  border-radius: 12px;
  background: $bg-primary;
}

.field {
  display: grid;
  gap: 6px;

  > label {
    color: $text-secondary;
    font-size: 12px;
    font-weight: 600;
  }
}

.group-agent-avatar-editor {
  display: flex;
  align-items: center;
  gap: 12px;
}

.group-agent-avatar-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.group-agent-avatar-file {
  display: none;
}

.link-form label {
  color: $text-secondary;
  font-size: 13px;
  font-weight: 600;
}

.link-status {
  padding: 30px 0;
  color: $text-muted;
  text-align: center;
}

.link-success strong {
  color: $success;
  font-size: 16px;
}

.manual-divider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 24px;
  color: $text-muted;
  font-size: 12px;

  &::before,
  &::after {
    content: '';
    flex: 1;
    height: 1px;
    background: $border-color;
  }
}

.manual-agent-preview {
  display: grid;
  gap: 2px;
  padding: 10px;
  border: 1px solid $border-color;
  border-radius: 8px;
  background: $bg-primary;

  strong {
    color: $text-primary;
    font-size: 13px;
  }

  span {
    overflow: hidden;
    color: $text-muted;
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.link-error {
  color: $error !important;
  font-size: 13px;
}

.link-security {
  margin: 22px 0 0;
  color: $text-muted !important;
  font-size: 12px;
}
</style>
