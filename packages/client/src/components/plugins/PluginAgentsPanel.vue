<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NTag, useMessage } from 'naive-ui'
import type { RouteLocationRaw } from 'vue-router'
import { isStoredSuperAdmin } from '@/api/client'
import { listStudioAgents, studioAgentAction, type AgentUpdate, type StudioAgent } from '@/api/studio/agents'
import { syncPluginAgentOptions } from '@/utils/agent-options'
import { chatSessionAgentAvatar } from '@/utils/chat-agent-avatar'
import AgentManagerCard from '@/components/coding-agents/AgentManagerCard.vue'

const router = useRouter(), { t } = useI18n(), message = useMessage()
const agents = ref<StudioAgent[]>([]), error = ref(''), busy = ref('')
const busyAction = ref('')
const updates = ref<Record<string, AgentUpdate>>({})
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
    error.value = ''
  } catch (cause) { if (alive && current === sequence) error.value = String(cause) }
}
async function action(agent: StudioAgent, kind: 'settings' | 'check-update' | 'upgrade' | 'install') {
  if (busy.value) return
  busy.value = agent.id; busyAction.value = kind; error.value = ''
  try {
    if (kind === 'settings') await router.push(await studioAgentAction<RouteLocationRaw>(agent.id, kind))
    else if (kind === 'check-update') updates.value[agent.id] = await studioAgentAction<AgentUpdate>(agent.id, kind)
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
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { busy.value = ''; busyAction.value = '' }
}
onMounted(() => { void refresh(); window.addEventListener('studio.plugins.changed', refresh) })
onBeforeUnmount(() => { alive = false; sequence++; window.removeEventListener('studio.plugins.changed', refresh) })
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
    </template>
    <NAlert v-if="agent.status.error" type="error">{{ agent.status.error }}</NAlert>
  </AgentManagerCard>
</template>

<style scoped lang="scss">
.plugin-agent-error { grid-column: 1 / -1; }
</style>
