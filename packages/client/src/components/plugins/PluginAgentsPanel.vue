<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NTag, NPopconfirm, useMessage } from 'naive-ui'
import type { RouteLocationRaw } from 'vue-router'
import { isStoredSuperAdmin } from '@/api/client'
import { listStudioAgents, studioAgentAction, getStudioAgentUpdatePolicy, setStudioAgentUpdatePolicy, type AgentUpdate, type StudioAgent, type AgentUpdatePolicyState } from '@/api/studio/agents'
import { syncPluginAgentOptions } from '@/utils/agent-options'
import { chatSessionAgentAvatar } from '@/utils/chat-agent-avatar'
import AgentManagerCard from '@/components/coding-agents/AgentManagerCard.vue'
import AgentAutoUpdateControl from '@/components/coding-agents/AgentAutoUpdateControl.vue'

const router = useRouter(), { t } = useI18n(), message = useMessage()
const agents = ref<StudioAgent[]>([]), error = ref(''), busy = ref('')
const busyAction = ref('')
const updates = ref<Record<string, AgentUpdate>>({})
const policies = ref<Record<string, AgentUpdatePolicyState>>({})
const policyChanging = ref(false)
let policySequence = 0
function formatVersion(version: string) {
  const value = version.trim()
  return value ? (/^v(?=\d)/i.test(value) ? value : `v${value}`) : t('agentManager.unknownVersion')
}
let alive = true, sequence = 0
async function refresh() {
  const current = ++sequence
  try {
    const result = await listStudioAgents()
    if (!alive || current !== sequence) return
    agents.value = (result.agents || []).filter(agent => agent.origin === 'plugin')
    syncPluginAgentOptions(agents.value)
    if (isStoredSuperAdmin()) await refreshPolicies()
    error.value = ''
  } catch (cause) { if (alive && current === sequence) error.value = String(cause) }
}
async function refreshPolicies() {
  if (policyChanging.value) return
  const current = ++policySequence
  const result = await Promise.all(agents.value.filter(agent => agent.status.installed).map(async agent => {
    try {
      const policy = await getStudioAgentUpdatePolicy(agent.id)
      if (typeof policy.autoUpdate !== 'boolean' || typeof policy.autoUpdateSupported !== 'boolean') throw new Error('Invalid update policy')
      return [agent.id, policy] as const
    }
    catch { return [agent.id, { autoUpdate: false, autoUpdateSupported: false, status: 'unknown', currentVersion: agent.status.version, latestVersion: '', checkedAt: '' }] as const }
  }))
  if (alive && current === policySequence) policies.value = Object.fromEntries(result)
}
async function toggleAutoUpdate(agent: StudioAgent, enabled: boolean) {
  if (policyChanging.value) return
  policyChanging.value = true; policySequence++; error.value = ''
  try { policies.value[agent.id] = await setStudioAgentUpdatePolicy(agent.id, enabled) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { policyChanging.value = false; await refreshPolicies() }
}
async function action(agent: StudioAgent, kind: 'settings' | 'check-update' | 'upgrade' | 'install' | 'remove') {
  if (busy.value) return
  busy.value = agent.id; busyAction.value = kind; error.value = ''
  try {
    if (kind === 'settings') await router.push(await studioAgentAction<RouteLocationRaw>(agent.id, kind))
    else if (kind === 'check-update') {
      try { updates.value[agent.id] = await studioAgentAction<AgentUpdate>(agent.id, kind) }
      finally { await refreshPolicies() }
    }
    else if (kind === 'remove') {
      await studioAgentAction(agent.id, 'remove', { expectedVersion: agent.status.version })
      delete updates.value[agent.id]
      await refresh()
      message.success(t('codingAgents.deleteSuccess'))
    }
    else {
      const update = kind === 'install' ? await studioAgentAction<AgentUpdate>(agent.id, 'check-update') : updates.value[agent.id]
      if (!update?.updateAvailable || !update.latestVersion) {
        if (kind === 'install') throw new Error(update?.message || t('codingAgents.installFailed'))
        return
      }
      await studioAgentAction(agent.id, 'upgrade', { version: update.latestVersion, expectedVersion: update.currentVersion })
      delete updates.value[agent.id]
      await refresh()
      message.success(t('codingAgents.installSuccess'))
    }
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    if (['remove', 'upgrade', 'install'].includes(kind)) { delete updates.value[agent.id]; await refresh() }
    error.value = detail
  }
  finally { busy.value = ''; busyAction.value = '' }
}
let policyTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => { void refresh(); window.addEventListener('studio.plugins.changed', refresh); policyTimer = setInterval(() => { if (isStoredSuperAdmin()) void refreshPolicies() }, 15000) })
onBeforeUnmount(() => { alive = false; sequence++; if (policyTimer) clearInterval(policyTimer); window.removeEventListener('studio.plugins.changed', refresh) })
</script>

<template>
  <NAlert v-if="error" class="plugin-agent-error" type="error" closable @close="error = ''">{{ error }}</NAlert>
  <AgentManagerCard
    v-for="agent in agents"
    :key="agent.id"
    :name="agent.name"
    :logo="chatSessionAgentAvatar({ agent: agent.id }).src"
    :version="agent.status.installed ? formatVersion(agent.status.version) : undefined"
    :data-testid="`agent-card-${agent.id}`"
  >
    <template #badges>
      <NTag size="small" :bordered="false">{{ agent.vendor }}</NTag>
      <NTag :type="agent.status.installed ? 'success' : 'warning'" size="small" :bordered="false">{{ t(agent.status.installed ? 'codingAgents.installed' : 'codingAgents.notInstalled') }}</NTag>
    </template>
    <template #actions>
      <NButton v-if="agent.actions.settings" size="small" secondary :loading="busy === agent.id && busyAction === 'settings'" :disabled="Boolean(busy)" @click="action(agent, 'settings')">{{ t('sidebar.settings') }}</NButton>
      <NButton v-if="!agent.status.installed && agent.actions.upgrade && agent.actions.checkUpdate && isStoredSuperAdmin()" size="small" type="primary" secondary :loading="busy === agent.id && busyAction === 'install'" :disabled="Boolean(busy)" @click="action(agent, 'install')">{{ t('codingAgents.installNow') }}</NButton>
      <NButton v-if="agent.actions.checkUpdate && (agent.status.installed || !agent.actions.upgrade) && !(agent.actions.upgrade && updates[agent.id]?.updateAvailable) && isStoredSuperAdmin()" size="small" secondary :loading="busy === agent.id && busyAction === 'check-update'" :disabled="Boolean(busy)" @click="action(agent, 'check-update')">{{ t('codingAgents.checkUpdate') }}</NButton>
      <NButton v-if="agent.status.installed && agent.actions.upgrade && updates[agent.id]?.updateAvailable && isStoredSuperAdmin()" size="small" type="primary" secondary :loading="busy === agent.id && busyAction === 'upgrade'" :disabled="Boolean(busy)" @click="action(agent, 'upgrade')">{{ t('agentManager.updateToVersion', { version: formatVersion(updates[agent.id]!.latestVersion) }) }}</NButton>
      <NPopconfirm v-if="agent.status.installed && agent.actions.remove && isStoredSuperAdmin()" :positive-text="t('common.confirm')" :negative-text="t('common.cancel')" @positive-click="action(agent, 'remove')">
        <template #trigger><NButton type="error" secondary size="small" :loading="busy === agent.id && busyAction === 'remove'" :disabled="Boolean(busy)">{{ t('codingAgents.deleteNow') }}</NButton></template>
        {{ t('agentManager.deleteConfirm', { name: agent.name }) }}
      </NPopconfirm>
    </template>
    <AgentAutoUpdateControl v-if="agent.status.installed && policies[agent.id]" :state="policies[agent.id]!" :disabled="Boolean(busy) || policyChanging" @change="toggleAutoUpdate(agent, $event)" />
    <NAlert v-if="agent.status.error" type="error">{{ agent.status.error }}</NAlert>
  </AgentManagerCard>
</template>

<style scoped lang="scss">
.plugin-agent-error { grid-column: 1 / -1; }
</style>
