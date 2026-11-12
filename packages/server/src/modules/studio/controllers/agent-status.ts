import { ensureBuiltinPlugins } from '../services/plugins/host'
import type { Context } from 'koa'
import { agentDescriptors, agentStatus } from '../services/agents/registry'
import {
  getAgentAvailabilitySnapshot,
  getAgentStatusSnapshot,
} from '../public/agent-status-registry'

async function plugins(ctx: Context) {
  if (!ctx.state.user || ctx.state.sessionShare) return []
  await ensureBuiltinPlugins()
  return Promise.all(agentDescriptors().filter(agent => agent.origin === 'plugin').map(async descriptor => {
    try { const status = await agentStatus(descriptor.id, { userId: ctx.state.user!.id, profile: ctx.state.profile?.name || 'default' }); return { ...descriptor, installed: status.installed, available: status.installed, source: 'plugin', version: status.version } }
    catch { return { ...descriptor, installed: false, available: false, source: 'plugin', version: '' } }
  }))
}
export async function availability(ctx: Context) {
  const snapshot = getAgentAvailabilitySnapshot()
  ctx.body = { ...snapshot, agents: [...snapshot.agents, ...await plugins(ctx)] }
}

export async function status(ctx: Context) {
  const snapshot = getAgentStatusSnapshot()
  ctx.body = { ...snapshot, agents: [...snapshot.agents, ...await plugins(ctx)] }
}
