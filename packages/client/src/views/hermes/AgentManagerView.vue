<script setup lang="ts">
import { deploymentUrl } from '@/utils/deployment-url'
import { agentMetadata } from '@/utils/agent-catalog'
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import PluginAgentsPanel from '@/components/plugins/PluginAgentsPanel.vue'
import AgentManagerCard from '@/components/coding-agents/AgentManagerCard.vue'
import AgentAutoUpdateControl from '@/components/coding-agents/AgentAutoUpdateControl.vue'
import { studioAgentAction, type AgentUpdate } from '@/api/studio/agents'
import type { RouteLocationRaw } from 'vue-router'
import { getAgentUpdatePolicies, setAgentAutoUpdate, type AgentUpdatePolicyState } from '@/api/coding-agents'
import { computed, defineAsyncComponent, h, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NDrawer, NDrawerContent, NPopconfirm, NTag, useDialog, useMessage } from 'naive-ui'
import {
  deleteCodingAgent,
  fetchCodingAgentsStatus,
  installCodingAgent,
  type CodingAgentId,
  type CodingAgentToolStatus,
  type CodingAgentUpdateResult,
} from '@/api/coding-agents'
import { fetchAgentStatusSnapshot, type AgentStatusSnapshot } from '@/api/agent-status'
import {
  decideLegacyWindowsDataMigration,
  fetchLegacyWindowsDataMigrationStatus,
} from '@/api/hermes/legacy-data-migration'
import { fetchRuntimeVersionStatus, type RuntimeVersionStatus } from '@/api/hermes/runtime-versions'
import HermesDataDirectoryHint from '@/components/hermes/HermesDataDirectoryHint.vue'
import VersionManagementModal from '@/components/layout/VersionManagementModal.vue'
import { useAppStore } from '@/stores/hermes/app'
import { useChatStore } from '@/stores/hermes/chat'
import { desktopBridge } from '@/utils/desktop-bridge'

const DshVersions = defineAsyncComponent(() => import('@/components/coding-agents/dsh/DshVersions.vue'))
const AiHelpChatPanel = defineAsyncComponent(async () => (await import('@/components/hermes/chat/ChatPanel.vue')).default)

interface CodingAgentCard {
  id: CodingAgentId
  name: string
  provider: string
  logo: string
  command: string
  packageName: string
}

const codingAgents: CodingAgentCard[] = [
  {
    id: 'claude-code',
    name: 'Claude',
    provider: 'Anthropic',
    logo: '/coding-agents/claude-code.svg',
    command: 'claude',
    packageName: '@anthropic-ai/claude-code',
  },
  {
    id: 'codex',
    name: 'Codex',
    provider: 'OpenAI',
    logo: '/coding-agents/codex-openai.png',
    command: 'codex',
    packageName: '@openai/codex',
  },
  {
    id: 'pi',
    name: 'Pi',
    provider: 'Pi',
    logo: '/coding-agents/pi.svg',
    command: 'pi',
    packageName: '@earendil-works/pi-coding-agent',
  },
  {
    id: 'grok',
    name: 'Grok',
    provider: 'xAI',
    logo: '/coding-agents/grok.svg',
    command: 'grok',
    packageName: '@xai-official/grok',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    provider: 'OpenCode',
    logo: '/coding-agents/opencode.png',
    command: 'opencode',
    packageName: 'opencode-ai',
  },
  { id: 'dsh', name: 'DeepSeek Harness', provider: 'DeepSeek', logo: '/coding-agents/deepseek.svg', command: 'dsh', packageName: '@deepseek-ai/dsh' },
  {
    id: 'cursor',
    name: 'Cursor',
    provider: 'Cursor',
    logo: '/coding-agents/cursor-logo.png',
    command: 'agent',
    packageName: 'cursor-agent',
  },
  { id: 'antigravity', name: 'Antigravity', provider: 'Google', logo: '/coding-agents/antigravity.png', command: 'agy', packageName: '' },
  { id: 'qwen', name: 'Qwen Code', provider: 'Alibaba', logo: '/coding-agents/qwen-logo.svg', command: 'qwen', packageName: '@qwen-code/qwen-code' },
  { id: 'kimi', name: 'Kimi Code', provider: 'Moonshot AI', logo: '/coding-agents/kimi-logo.png', command: 'kimi', packageName: '@moonshot-ai/kimi-code' },
  { id: 'codebuddy', name: 'CodeBuddy', provider: 'Tencent', logo: '/coding-agents/codebuddy-logo.svg', command: 'codebuddy', packageName: '@tencent-ai/codebuddy-code' },
  { id: 'qoder', name: 'Qoder', provider: 'Qoder', logo: '/coding-agents/qoder-logo.svg', command: 'qoder', packageName: '@qoder-ai/qodercli' },
  { id: 'copilot', name: 'GitHub Copilot', provider: 'GitHub', logo: '/coding-agents/copilot-logo.svg', command: 'copilot', packageName: '@github/copilot' },
  { id: 'zcode', name: 'ZCode', provider: 'Z.ai', logo: '/coding-agents/zcode-logo.png', command: 'zcode', packageName: '' },
]

const updatePolicies = ref<Record<string, AgentUpdatePolicyState>>({})
let policyTimer: ReturnType<typeof setInterval> | undefined
async function refreshPolicies() {
  try { updatePolicies.value = (await getAgentUpdatePolicies()).agents } catch { /* unavailable to non-admin/old server */ }
}
function availableUpdateVersion(id: CodingAgentId): string {
  const policy = updatePolicies.value[id]
  if (policy) return ['available','waiting'].includes(policy.status) ? policy.latestVersion : ''
  return updateInfo.value[id]?.updateAvailable ? updateInfo.value[id]?.latestVersion || '' : ''
}
async function toggleAutoUpdate(id: CodingAgentId, enabled: boolean) {
  try { updatePolicies.value = (await setAgentAutoUpdate(id, enabled)).agents } catch (error) { message.error(String(error)) }
}
onMounted(() => { void refreshPolicies(); policyTimer = setInterval(() => void refreshPolicies(), 15000) })
onUnmounted(() => { if(policyTimer) clearInterval(policyTimer) })
const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()
const appStore = useAppStore()
const chatStore = useChatStore()
const route = useRoute()
const router = useRouter()

const tools = ref<CodingAgentToolStatus[]>([])
const agentStatusSnapshot = ref<AgentStatusSnapshot | null>(null)
const loading = ref(true)
const loadError = ref('')
const runtimeManagerVisible = ref(false)
const hermesCliDetailsVisible = ref(false)
const hermesCliDetailsLoading = ref(false)
const hermesRuntimeStatus = ref<RuntimeVersionStatus | null>(null)
const aiHelpDrawerVisible = ref(false)
const aiHelpPrompt = ref('')
const legacyDataMigrationChecked = ref(false)
const installing = ref<Record<CodingAgentId, boolean>>({ 'claude-code': false, codex: false, pi: false, grok: false, opencode: false, dsh: false, cursor: false, antigravity: false, qwen: false, kimi: false, codebuddy: false, qoder: false, copilot: false, zcode: false })
const deleting = ref<Record<CodingAgentId, boolean>>({ 'claude-code': false, codex: false, pi: false, grok: false, opencode: false, dsh: false, cursor: false, antigravity: false, qwen: false, kimi: false, codebuddy: false, qoder: false, copilot: false, zcode: false })
const checkingUpdate = ref<Record<CodingAgentId, boolean>>({ 'claude-code': false, codex: false, pi: false, grok: false, opencode: false, dsh: false, cursor: false, antigravity: false, qwen: false, kimi: false, codebuddy: false, qoder: false, copilot: false, zcode: false })
const updateInfo = ref<Record<CodingAgentId, CodingAgentUpdateResult | null>>({
  'claude-code': null,
  codex: null,
  pi: null,
  grok: null,
  opencode: null,
  dsh: null,
  cursor: null,
  antigravity: null,
  qwen: null,
  kimi: null,
  codebuddy: null,
  qoder: null,
  copilot: null,
  zcode: null,

})

const hermesStatus = computed(() => agentStatusSnapshot.value?.agents.find(agent => agent.id === 'hermes'))
const hermesDetected = computed(() => Boolean(hermesStatus.value?.installed))
const hermesVersion = computed(() => formatHermesVersion(hermesStatus.value?.version))
const hermesType = computed<'CLI' | 'Runtime' | ''>(() => {
  if (hermesStatus.value?.source === 'user-cli') return 'CLI'
  if (hermesStatus.value?.source === 'managed-runtime') return 'Runtime'
  return ''
})

watch(runtimeManagerVisible, (visible, previous) => {
  if (!visible && previous) {
    void syncAgentStatus().catch((error) => {
      loadError.value = errorMessage(error)
    })
  }
})

function toolStatus(id: CodingAgentId): CodingAgentToolStatus | undefined {
  return tools.value.find(tool => tool.id === id)
}

function formatVersion(value?: string): string {
  const version = value?.trim()
  if (!version) return t('agentManager.unknownVersion')
  return /^v(?=\d)/i.test(version) ? version : `v${version}`
}

function formatHermesVersion(value?: string): string {
  return formatVersion(value?.split('·')[0])
}

function installedVersion(id: CodingAgentId): string {
  const status = toolStatus(id)
  const version = status?.version?.trim()
  if (version) return formatVersion(version)
  return status?.rawVersion?.trim() || t('agentManager.unknownVersion')
}

function replaceTool(next: CodingAgentToolStatus) {
  tools.value = tools.value.some(tool => tool.id === next.id)
    ? tools.value.map(tool => tool.id === next.id ? next : tool)
    : [...tools.value, next]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type AgentManagementOperation = 'install' | 'delete'

function operationLabel(operation: AgentManagementOperation): string {
  return t(operation === 'install' ? 'agentManager.installOperation' : 'agentManager.deleteOperation')
}

function buildAiHelpPrompt(agent: CodingAgentCard, operation: AgentManagementOperation, error: string): string {
  return t('agentManager.aiHelpPrompt', {
    name: agent.name,
    id: agent.id,
    operation: operationLabel(operation),
    command: agent.command,
    package: agent.packageName,
    error,
  })
}

function startAiHelpChat(prompt: string) {
  chatStore.newChat({
    source: 'builtin_agent',
    agent: 'ekko-agent',
    codingAgentId: 'ekko-agent',
    codingAgentMode: 'scoped',
  })
  aiHelpPrompt.value = prompt
  aiHelpDrawerVisible.value = true
}

function openAiHelpDrawer(agent: CodingAgentCard, operation: AgentManagementOperation, error: string) {
  startAiHelpChat(buildAiHelpPrompt(agent, operation, error))
}

function openGeneralAiHelpDrawer() {
  startAiHelpChat(t('agentManager.aiHelpGeneralPrompt'))
}

function offerAiHelp(id: CodingAgentId, operation: AgentManagementOperation, error: string) {
  const agent = codingAgents.find(item => item.id === id)
  if (!agent) return
  dialog.warning({
    title: t('agentManager.aiHelpDialogTitle', { name: agent.name }),
    content: () => h('div', { class: 'agent-ai-help-dialog' }, [
      h('p', t('agentManager.aiHelpDialogQuestion', {
        name: agent.name,
        operation: operationLabel(operation),
      })),
      h('pre', { class: 'agent-ai-help-error' }, error),
    ]),
    positiveText: t('agentManager.aiHelpDialogPositive'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => openAiHelpDrawer(agent, operation, error),
  })
}

function handleMutationError(id: CodingAgentId, operation: AgentManagementOperation, error: unknown) {
  const detail = errorMessage(error)
  message.error(detail)
  offerAiHelp(id, operation, detail)
}

function applyAgentStatusSnapshot(snapshot: AgentStatusSnapshot) {
  agentStatusSnapshot.value = snapshot
  const statuses = new Map(snapshot.agents.map(status => [status.id, status]))
  tools.value = codingAgents.map((agent) => {
    const status = statuses.get(agent.id)
    return {
      ...agent,
      installed: Boolean(status?.installed),
      version: status?.version || '',
      rawVersion: status?.version || '',
      source: status?.source === 'user-cli' ? 'user-cli' : 'not-installed',
      path: status?.path || '',
      error: status?.error || '',
      compatibility: status?.compatibility,
    }
  })
}

async function syncAgentStatus() {
  applyAgentStatusSnapshot(await fetchAgentStatusSnapshot())
}

async function loadCachedStatus() {
  loading.value = true
  loadError.value = ''
  try {
    await syncAgentStatus()
  } catch (error) {
    loadError.value = errorMessage(error)
  } finally {
    loading.value = false
    void checkExternalCliInstallation()
  }
}

let checkingExternalInstallation = false
let managerMounted = false
let externalInstallationRefreshPending = false

async function checkExternalCliInstallation(event?: Event) {
  // Native CLIs are installed outside Studio. Returning from a guide or terminal
  // must probe the CLI again instead of reusing the startup inventory.
  if (!managerMounted || document.visibilityState === 'hidden') return
  if (loading.value || installing.value.cursor || installing.value.antigravity || checkingExternalInstallation) {
    externalInstallationRefreshPending = true
    return
  }
  externalInstallationRefreshPending = false
  const nativeTools = (['cursor', 'antigravity', 'zcode'] as const).filter(id => id === 'cursor' || id === 'antigravity' || agentStatusSnapshot.value?.agents.some(agent => agent.id === id))
  const knownTools = nativeTools.filter(id => toolStatus(id))
  // On entry only probe missing tools; on return also refresh installed versions.
  if (!knownTools.length || (!event && knownTools.every(id => toolStatus(id)?.installed))) return
  checkingExternalInstallation = true
  try {
    const result = await fetchCodingAgentsStatus()
    if (managerMounted) {
      // An older server or partial inventory may omit an Agent. Preserve its
      // cached status instead of turning an installed tool into Not installed.
      const detected = new Map(result.tools.map(tool => [tool.id, tool]))
      tools.value = tools.value.map(tool => detected.get(tool.id) || tool)
      for (const tool of result.tools) if (!tools.value.some(existing => existing.id === tool.id)) tools.value.push(tool)
      loadError.value = ''
    }
  } catch (error) {
    if (managerMounted) loadError.value = errorMessage(error)
  } finally {
    checkingExternalInstallation = false
    if (externalInstallationRefreshPending) void checkExternalCliInstallation()
  }
}

async function refreshAll() {
  loading.value = true
  loadError.value = ''
  const results = await Promise.allSettled([
    fetchCodingAgentsStatus(),
    fetchRuntimeVersionStatus({ includeRemote: false }),
  ])
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => errorMessage(result.reason))
  const runtimeResult = results[1]
  if (runtimeResult?.status === 'fulfilled') hermesRuntimeStatus.value = runtimeResult.value
  try {
    await syncAgentStatus()
  } catch (error) {
    errors.push(errorMessage(error))
  }
  if (errors.length) loadError.value = errors.join('\n')
  loading.value = false
  if (externalInstallationRefreshPending) void checkExternalCliInstallation()
}

async function openHermesCliDetails() {
  hermesCliDetailsLoading.value = true
  try {
    hermesRuntimeStatus.value = await fetchRuntimeVersionStatus({ includeRemote: false })
    hermesCliDetailsVisible.value = true
  } catch (error) {
    message.error(errorMessage(error))
  } finally {
    hermesCliDetailsLoading.value = false
  }
}

async function submitLegacyDataMigrationDecision(action: 'migrate' | 'decline'): Promise<boolean> {
  try {
    await decideLegacyWindowsDataMigration(action)
    if (action === 'migrate') {
      const bridge = desktopBridge()
      if (!bridge?.restartApp) throw new Error('Desktop restart is unavailable')
      message.success(t('agentManager.legacyDataMigrationSuccess'))
      await bridge.restartApp()
    }
    return true
  } catch (error) {
    message.error(t('agentManager.legacyDataMigrationFailed', { error: errorMessage(error) }))
    return false
  }
}

async function maybePromptLegacyWindowsDataMigration() {
  const bridge = desktopBridge()
  if (legacyDataMigrationChecked.value || bridge?.isDesktop !== true || bridge.remoteMode === true || bridge.platform !== 'win32') return
  legacyDataMigrationChecked.value = true

  try {
    const status = await fetchLegacyWindowsDataMigrationStatus()
    if (!status.shouldPrompt) return

    dialog.warning({
      title: t('agentManager.legacyDataMigrationTitle'),
      content: () => h('div', { class: 'legacy-data-migration-dialog' }, [
        h('p', t('agentManager.legacyDataMigrationDescription')),
        h('dl', [
          h('dt', t('agentManager.legacyDataMigrationSource')),
          h('dd', [h('code', status.sourceDirectory)]),
          h('dt', t('agentManager.legacyDataMigrationTarget')),
          h('dd', [h('code', status.targetDirectory)]),
        ]),
        h('p', { class: 'legacy-data-migration-warning' }, t('agentManager.legacyDataMigrationWarning')),
      ]),
      positiveText: t('agentManager.legacyDataMigrationPositive'),
      negativeText: t('agentManager.legacyDataMigrationNegative'),
      closable: false,
      maskClosable: false,
      closeOnEsc: false,
      onPositiveClick: () => submitLegacyDataMigrationDecision('migrate'),
      onNegativeClick: () => submitLegacyDataMigrationDecision('decline'),
    })
  } catch (error) {
    console.warn('[agent-manager] failed to check legacy Windows Hermes data migration', error)
  }
}

async function handleInstall(id: CodingAgentId, options: { version?: string; rollback?: boolean } = {}) {
  installing.value[id] = true
  try {
    if ((id === 'cursor' || id === 'antigravity' || agentMetadata(id)?.installation.method === 'manual') && typeof window !== 'undefined') {
      window.open(agentMetadata(id)?.installation.docsUrl || (id === 'antigravity' ? 'https://antigravity.google/docs/cli/install' : 'https://cursor.com/install'), '_blank', 'noopener,noreferrer')
    }
    const installed = toolStatus(id)
    const target = options.version || availableUpdateVersion(id)
    if (installed?.installed && target && !options.rollback) {
      await studioAgentAction(id, 'upgrade', { version: target, expectedVersion: installed.version })
      tools.value = (await fetchCodingAgentsStatus()).tools
      updateInfo.value[id] = null
      await refreshPolicies()
      message.success(t('codingAgents.installSuccess'))
      return
    }
    const result = await installCodingAgent(id, options)
    tools.value = result.tools
    if (result.updateState) updatePolicies.value[id] = result.updateState
    if ((id === 'cursor' || id === 'antigravity' || agentMetadata(id)?.installation.method === 'manual') && !result.success) {
      message.info(result.message || t('agentManager.codingAgentDescription'))
      return
    }
    if (!result.success) throw new Error(result.message || t('codingAgents.installFailed'))
    updateInfo.value[id] = null
    message.success(t('codingAgents.installSuccess'))
  } catch (error) {
    handleMutationError(id, 'install', error)
  } finally {
    installing.value[id] = false
    if (externalInstallationRefreshPending) void checkExternalCliInstallation()
  }
}

async function handleDelete(id: CodingAgentId) {
  deleting.value[id] = true
  try {
    const result = await deleteCodingAgent(id)
    tools.value = result.tools
    if (!result.success) throw new Error(result.message || t('codingAgents.deleteFailed'))
    updateInfo.value[id] = null
    message.success(t('codingAgents.deleteSuccess'))
  } catch (error) {
    handleMutationError(id, 'delete', error)
  } finally {
    deleting.value[id] = false
  }
}

async function openAgentSettings(id: CodingAgentId) {
  try { await router.push(await studioAgentAction<RouteLocationRaw>(id, 'settings')) }
  catch (error) { message.error(errorMessage(error)) }
}

async function handleCheckUpdate(id: CodingAgentId) {
  checkingUpdate.value[id] = true
  try {
    const checked = await studioAgentAction<AgentUpdate>(id, 'check-update')
    const result: CodingAgentUpdateResult = { success: true, tool: toolStatus(id)!, ...checked }
    if (!result.success) throw new Error(result.message || t('codingAgents.checkUpdateFailed'))
    replaceTool(result.tool)
    updateInfo.value[id] = result
    const previous = updatePolicies.value[id]
    if (previous) updatePolicies.value[id] = {
      ...previous, currentVersion: result.tool.version, latestVersion: result.latestVersion,
      checkedAt: new Date().toISOString(),
      status: result.tool.installed && result.updateAvailable ? 'available' : 'current', error: undefined,
    }
  } catch (error) {
    message.error(errorMessage(error))
  } finally {
    checkingUpdate.value[id] = false
  }
}

onMounted(() => {
  managerMounted = true
  window.addEventListener('focus', checkExternalCliInstallation)
  document.addEventListener('visibilitychange', checkExternalCliInstallation)
  if (route.query.runtime === 'install') {
    runtimeManagerVisible.value = true
    const query = { ...route.query }
    delete query.runtime
    void router.replace({ query })
  }
  void loadCachedStatus()
  void maybePromptLegacyWindowsDataMigration()
})

onUnmounted(() => {
  managerMounted = false
  externalInstallationRefreshPending = false
  window.removeEventListener('focus', checkExternalCliInstallation)
  document.removeEventListener('visibilitychange', checkExternalCliInstallation)
})
</script>

<template>
  <PageLoading :show="loading" class="agent-manager-panel">
      <PageHeader>
      <header class="page-header">
        <div class="agent-manager-header-left">
          <h2 class="header-title">{{ t('agentManager.title') }}</h2>
        </div>
        <div class="agent-manager-header-actions">
          <NButton size="small" secondary :loading="loading" @click="refreshAll()">
            {{ t('agentManager.refresh') }}
          </NButton>
          <NButton size="small" secondary @click="openGeneralAiHelpDrawer">
            {{ t('agentManager.aiHelpDialogPositive') }}
          </NButton>
        </div>
      </header>
      </PageHeader>

      <div class="agent-manager-spin">
        <div class="agent-manager-content">
          <NAlert v-if="loadError" type="error" :bordered="false">
            {{ loadError }}
          </NAlert>

          <div class="coding-agent-grid">
            <AgentManagerCard name="Ekko" :logo="deploymentUrl('/coding-agents/ekko-agent.png')" :version="`Studio ${formatVersion(appStore.serverVersion)}`" data-testid="agent-card-ekko">
              <template #badges><NTag type="success" size="small" :bordered="false">{{ t('agentManager.builtIn') }}</NTag></template>
              <template #actions>
                <NButton
                  secondary
                  size="small"
                  @click="router.push({ name: 'ekko.settings' })"
                >
                  {{ t('sidebar.settings') }}
                </NButton>
              </template>
            </AgentManagerCard>

            <AgentManagerCard name="Hermes" :logo="deploymentUrl('/coding-agents/hermes.png')" :version="hermesDetected ? hermesVersion : undefined" :description="t('agentManager.hermesDescription')" data-testid="agent-card-hermes">
              <template #badges>
                <NTag
                  v-if="hermesDetected && hermesType"
                  data-testid="hermes-source-type"
                  type="info"
                  size="small"
                  :bordered="false"
                >
                  {{ hermesType }}
                </NTag>
                <NTag :type="hermesDetected ? 'success' : 'warning'" size="small" :bordered="false">
                  {{ hermesDetected ? t('codingAgents.installed') : t('codingAgents.notInstalled') }}
                </NTag>
              </template>

              <template #actions>
                <NButton
                  v-if="hermesDetected"
                  secondary
                  size="small"
                  @click="router.push({ name: 'hermes.configSettings' })"
                >
                  {{ t('sidebar.settings') }}
                </NButton>
                <NButton
                  v-if="hermesDetected && hermesType === 'CLI'"
                  data-testid="view-hermes-cli-details"
                  secondary
                  size="small"
                  :loading="hermesCliDetailsLoading"
                  @click="openHermesCliDetails"
                >
                  {{ t('runtimeVersions.viewCliDetails') }}
                </NButton>
                <NButton
                  v-if="!hermesDetected || hermesType === 'Runtime'"
                  type="primary"
                  secondary
                  size="small"
                  @click="runtimeManagerVisible = true"
                >
                  {{ hermesDetected ? t('agentManager.manageRuntime') : t('codingAgents.installNow') }}
                </NButton>
              </template>
            </AgentManagerCard>

            <AgentManagerCard
              v-for="agent in codingAgents"
              :key="agent.id"
              :name="agent.name"
              :logo="agent.logo"
              :version="toolStatus(agent.id)?.installed ? installedVersion(agent.id) : undefined"
              :description="agent.id === 'antigravity' ? t('agentManager.antigravityDescription') : agent.id === 'cursor' ? t('agentManager.cursorDescription') : t('agentManager.codingAgentDescription')"
              :data-testid="`agent-card-${agent.id}`"
            >
              <template #badges>
                <NTag size="small" :bordered="false">{{ agent.provider }}</NTag>
                <NTag
                  :type="toolStatus(agent.id)?.installed ? 'success' : 'warning'"
                  size="small"
                  :bordered="false"
                >
                  {{ toolStatus(agent.id)?.installed ? t('codingAgents.installed') : t('codingAgents.notInstalled') }}
                </NTag>
              </template>

              <template #actions>
                <NButton
                  secondary
                  size="small"
                  v-if="agentMetadata(agent.id)?.config.mcp || agentMetadata(agent.id)?.config.settings"
                  :data-testid="`agent-settings-${agent.id}`"
                  @click="openAgentSettings(agent.id)"
                >
                  {{ t('sidebar.settings') }}
                </NButton>
                <NButton
                  v-if="!toolStatus(agent.id)?.installed"
                  type="primary"
                  secondary
                  size="small"
                  :loading="installing[agent.id]"
                  @click="handleInstall(agent.id)"
                >
                  {{ (agentMetadata(agent.id)?.installation.method === 'manual') ? t('codingAgents.cursorInstallGuide') : t('codingAgents.installNow') }}
                </NButton>
                <NButton
                  v-else-if="(agentMetadata(agent.id)?.installation.updates) && availableUpdateVersion(agent.id)"
                  type="primary"
                  secondary
                  size="small"
                  :loading="installing[agent.id]"
                  @click="handleInstall(agent.id)"
                >
                  {{ t('agentManager.updateToVersion', { version: formatVersion(availableUpdateVersion(agent.id)) }) }}
                </NButton>
                <NButton
                  v-if="(agentMetadata(agent.id)?.installation.updates) && toolStatus(agent.id)?.installed && !availableUpdateVersion(agent.id)"
                  secondary
                  size="small"
                  :loading="checkingUpdate[agent.id]"
                  :disabled="installing[agent.id] || deleting[agent.id]"
                  @click="handleCheckUpdate(agent.id)"
                >
                  {{ t('codingAgents.checkUpdate') }}
                </NButton>

                <NPopconfirm
                  v-if="(agentMetadata(agent.id)?.installation.updates) && toolStatus(agent.id)?.installed"
                  @positive-click="handleDelete(agent.id)"
                >
                  <template #trigger>
                    <NButton
                      type="error"
                      secondary
                      size="small"
                      :loading="deleting[agent.id]"
                      :disabled="installing[agent.id] || checkingUpdate[agent.id]"
                    >
                      {{ t('codingAgents.deleteNow') }}
                    </NButton>
                  </template>
                  {{ t('agentManager.deleteConfirm', { name: agent.name }) }}
                </NPopconfirm>
              </template>
              <DshVersions v-if="agent.id === 'dsh'" :info="toolStatus(agent.id)?.compatibility" :busy="installing.dsh || deleting.dsh" @install="handleInstall('dsh', $event)" />
              <AgentAutoUpdateControl v-if="toolStatus(agent.id)?.installed && updatePolicies[agent.id]" :state="updatePolicies[agent.id]!" @change="toggleAutoUpdate(agent.id, $event)" />
            </AgentManagerCard>
            <PluginAgentsPanel />
          </div>
        </div>
      </div>

    <VersionManagementModal v-model:show="runtimeManagerVisible" />

    <NDrawer
      v-model:show="hermesCliDetailsVisible"
      placement="right"
      width="var(--studio-drawer-width)"
    >
      <NDrawerContent :title="t('runtimeVersions.cliDetailsTitle')" closable>
        <div data-testid="hermes-cli-details" class="hermes-cli-details">
          <div class="hermes-cli-detail-row">
            <strong>{{ t('runtimeVersions.activePythonPath') }}</strong>
            <code>{{ hermesRuntimeStatus?.hermes.pythonPath || '-' }}</code>
          </div>
          <div class="hermes-cli-detail-row">
            <strong>{{ t('runtimeVersions.activeAgentRoot') }}</strong>
            <code>{{ hermesRuntimeStatus?.hermes.agentRoot || '-' }}</code>
          </div>
          <div class="hermes-cli-detail-row">
            <strong>{{ t('runtimeVersions.activeDataDirectory') }}</strong>
            <code>{{ hermesRuntimeStatus?.hermes.dataDirectory || '-' }}</code>
          </div>
          <HermesDataDirectoryHint />
        </div>
      </NDrawerContent>
    </NDrawer>

    <NDrawer
      v-model:show="aiHelpDrawerVisible"
      class="agent-ai-help-drawer"
      placement="right"
      width="var(--studio-drawer-width)"
    >
      <NDrawerContent :title="t('agentManager.aiHelpDrawerTitle')" closable body-content-style="padding: 0; overflow: hidden;">
        <AiHelpChatPanel
          v-if="aiHelpDrawerVisible"
          standalone
          :initial-composer-text="aiHelpPrompt"
          :composer-persist-draft="false"
        />
      </NDrawerContent>
    </NDrawer>
  </PageLoading>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.agent-manager-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--theme-content-bg, $bg-main-surface);
}

.hermes-cli-details {
  display: flex;
  flex-direction: column;
  gap: calc(12px * var(--spacing-scale, 1));
}

.hermes-cli-detail-row {
  display: flex;
  flex-direction: column;
  gap: calc(6px * var(--spacing-scale, 1));
  padding: calc(12px * var(--spacing-scale, 1));
  border: var(--border-width, 1px) solid var(--border-color);
  border-radius: var(--radius-component, 6px);

  strong {
    color: var(--text-color-2);
    font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  }

  code {
    overflow-wrap: anywhere;
    color: var(--text-color-1);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  }
}

:global(.agent-ai-help-dialog p) {
  margin: 0 0 12px;
}

:global(.legacy-data-migration-dialog p) {
  margin: 0 0 12px;
}

:global(.legacy-data-migration-dialog dl) {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: calc(8px * var(--spacing-scale, 1)) calc(12px * var(--spacing-scale, 1));
  margin: 0 0 12px;
}

:global(.legacy-data-migration-dialog dt) {
  color: var(--text-color-2);
}

:global(.legacy-data-migration-dialog dd) {
  min-width: 0;
  margin: 0;
}

:global(.legacy-data-migration-dialog code) {
  overflow-wrap: anywhere;
}

:global(.legacy-data-migration-dialog .legacy-data-migration-warning) {
  margin-bottom: 0;
  color: var(--warning-color);
}

:global(.agent-ai-help-error) {
  max-height: 180px;
  margin: 0;
  padding: calc(10px * var(--spacing-scale, 1)) calc(12px * var(--spacing-scale, 1));
  overflow: auto;
  border-radius: var(--radius-component, 8px);
  background: rgba(127, 127, 127, 0.1);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  white-space: pre-wrap;
  word-break: break-word;
}

:global(.agent-ai-help-drawer .n-drawer-body-content-wrapper) {
  height: 100%;
}

.agent-manager-header-left,
.agent-manager-header-actions {
  display: flex;
  align-items: center;
}

.agent-manager-header-left {
  min-width: 0;
  gap: calc(8px * var(--spacing-scale, 1));
}

.agent-manager-header-actions {
  flex: 0 0 auto;
  gap: calc(8px * var(--spacing-scale, 1));
}

.header-title {
  margin: 0;
}

.agent-manager-spin {
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;

}

.agent-manager-content {
  container: agent-manager / inline-size;
  min-height: 100%;
  display: flex;
  flex-direction: column;
  gap: calc(16px * var(--spacing-scale, 1));
  margin: 0 auto;
  padding: calc(24px * var(--spacing-scale, 1));
}

.coding-agent-grid {
  display: grid;
  grid-template-columns: 1fr;
  align-items: stretch;
  gap: calc(16px * var(--spacing-scale, 1));
}

// Keep cards at least 340px wide when showing multiple columns, including 16px gaps.
@container agent-manager (min-width: 696px) {
  .coding-agent-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@container agent-manager (min-width: 1052px) {
  .coding-agent-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: $breakpoint-mobile) {
  .agent-manager-content {
    padding: calc(16px * var(--spacing-scale, 1));
  }

  .coding-agent-grid {
    grid-template-columns: 1fr;
  }

}
</style>
