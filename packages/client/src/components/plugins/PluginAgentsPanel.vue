<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NTag, useMessage } from 'naive-ui'
import type { RouteLocationRaw } from 'vue-router'
import { isStoredSuperAdmin } from '@/api/client'
import { listStudioAgents, studioAgentAction, type AgentUpdate, type StudioAgent } from '@/api/studio/agents'
import { syncPluginAgentOptions } from '@/utils/agent-options'

const router = useRouter(), { t } = useI18n(), message = useMessage()
const agents = ref<StudioAgent[]>([]), error = ref(''), busy = ref('')
const busyAction = ref('')
const updates = ref<Record<string, AgentUpdate>>({})
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
  <NAlert v-if="error" type="error" closable @close="error = ''">{{ error }}</NAlert>
  <section v-if="agents.length" class="plugin-agent-grid">
    <article v-for="agent in agents" :key="agent.id" class="plugin-agent-card" data-theme-surface="card" :data-testid="`agent-card-${agent.id}`">
      <header class="plugin-agent-heading">
        <img v-if="agent.icon" :src="agent.icon" alt="" width="40" height="40" />
        <div><h3>{{ agent.name }}</h3><span>{{ agent.status.installed ? agent.status.version : t('codingAgents.notInstalled') }}</span></div>
        <NTag size="small" :bordered="false">{{ agent.vendor }}</NTag>
      </header>
      <p v-if="agent.description">{{ agent.description }}</p>
      <NAlert v-if="agent.status.error" type="error">{{ agent.status.error }}</NAlert>
      <div class="plugin-agent-actions">
        <NButton v-if="agent.actions.settings" size="small" secondary :loading="busy === agent.id && busyAction === 'settings'" :disabled="Boolean(busy)" @click="action(agent, 'settings')">{{ t('sidebar.settings') }}</NButton>
        <NButton v-if="!agent.status.installed && agent.actions.upgrade && agent.actions.checkUpdate && isStoredSuperAdmin()" size="small" type="primary" :loading="busy === agent.id && busyAction === 'install'" :disabled="Boolean(busy)" @click="action(agent, 'install')">{{ t(busy === agent.id && busyAction === 'install' ? 'codingAgents.installing' : 'codingAgents.kinds.install') }}</NButton>
        <NButton v-if="agent.actions.checkUpdate && (agent.status.installed || !agent.actions.upgrade) && isStoredSuperAdmin()" size="small" secondary :loading="busy === agent.id && busyAction === 'check-update'" :disabled="Boolean(busy)" @click="action(agent, 'check-update')">{{ t('codingAgents.checkUpdate') }}</NButton>
        <NButton v-if="agent.status.installed && agent.actions.upgrade && updates[agent.id]?.updateAvailable && isStoredSuperAdmin()" size="small" type="primary" :loading="busy === agent.id && busyAction === 'upgrade'" :disabled="Boolean(busy)" @click="action(agent, 'upgrade')">{{ t('agentManager.updateToVersion', { version: updates[agent.id]?.latestVersion }) }}</NButton>
      </div>
    </article>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.plugin-agent-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr)); gap: 16px; }
.plugin-agent-card { background: $bg-card; color: $text-primary; border: 1px solid $border-light; border-radius: $radius-lg; padding: 16px; min-width: 0; }
.plugin-agent-heading, .plugin-agent-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.plugin-agent-heading h3 { margin: 0; }
.plugin-agent-heading span, .plugin-agent-card p { color: $text-muted; }
.plugin-agent-actions { margin-top: 16px; }
</style>
