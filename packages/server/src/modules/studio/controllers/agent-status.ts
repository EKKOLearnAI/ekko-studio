import type { Context } from 'koa'
import { listAgentStatuses } from '../services/agents/inventory'
import {
  getAgentAvailabilitySnapshot,
  getAgentStatusSnapshot,
} from '../public/agent-status-registry'

async function plugins(ctx: Context) {
  if (!ctx.state.user || ctx.state.sessionShare) return []
  const agents = await listAgentStatuses({ userId: ctx.state.user.id, profile: ctx.state.profile?.name || 'default' }, 'plugin')
  return agents.map(({ status, ...descriptor }) => ({
    ...descriptor, installed: status.installed, available: status.installed, source: 'plugin', version: status.version,
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
