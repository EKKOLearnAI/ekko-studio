import type { Context } from 'koa'
import { agentCheckUpdate, agentDescriptors, agentModels, agentSettings, agentStatus, agentUpgrade, agentRemove, builtinAgentUpdatePolicy, isPluginAgentId } from '../services/agents/registry'
import { getPluginAgentUpdates } from '../services/agents/plugin-update-policy'
import { resolvePluginIdentity, ensureBuiltinPlugins } from '../services/plugins/host'
import { PluginError } from '../services/plugins/errors'
import { runMcpCredentials } from '../services/auth/run-mcp-credentials'

function identity(ctx: Context) {
  if (!ctx.state.user || ctx.state.sessionShare) throw new PluginError('Studio login required', 'AGENT_FORBIDDEN', 403)
  return resolvePluginIdentity({ userId: ctx.state.user.id, profile: ctx.state.profile?.name || 'default', surface: 'ui' })
}
async function respond(ctx: Context, work: () => unknown | Promise<unknown>) {
  try { ctx.body = await work() } catch (error: any) { ctx.status = error.status || 500; ctx.body = { error: error.message, code: error.code || 'AGENT_ERROR' } }
}
export const list = (ctx: Context) => respond(ctx, async () => {
  const who = identity(ctx)
  await ensureBuiltinPlugins()
  const agents = await Promise.all(agentDescriptors().map(async descriptor => {
    try { const status = await agentStatus(descriptor.id, who); return { ...descriptor, status: { installed: status.installed, version: status.version, source: status.source, error: status.error } } }
    catch (error) { return { ...descriptor, status: { installed: false, version: '', error: error instanceof Error ? error.message : String(error) } } }
  }))
  return { agents }
})
export const status = (ctx: Context) => respond(ctx, () => agentStatus(ctx.params.id, identity(ctx)))
export const models = (ctx: Context) => respond(ctx, () => agentModels(ctx.params.id, identity(ctx), ctx.query.refresh === 'true'))
export const settings = (ctx: Context) => respond(ctx, () => agentSettings(ctx.params.id, identity(ctx)))
export const checkUpdate = (ctx: Context) => respond(ctx, () => {
  if (runMcpCredentials.recognizes(ctx.get('authorization').replace(/^Bearer\s+/i, ''))) throw new PluginError('Agent management requires an interactive login', 'AGENT_FORBIDDEN', 403)
  const who = identity(ctx)
  return isPluginAgentId(ctx.params.id) ? getPluginAgentUpdates().checkUpdate(ctx.params.id, who) : agentCheckUpdate(ctx.params.id, who)
})
export const upgrade = (ctx: Context) => respond(ctx, () => {
  if (runMcpCredentials.recognizes(ctx.get('authorization').replace(/^Bearer\s+/i, ''))) throw new PluginError('Agent management requires an interactive login', 'AGENT_FORBIDDEN', 403)
  const who = identity(ctx), input = ctx.request.body as { version: string; expectedVersion: string }
  return isPluginAgentId(ctx.params.id) ? getPluginAgentUpdates().upgrade(ctx.params.id, who, input) : agentUpgrade(ctx.params.id, who, input)
})
function managementIdentity(ctx: Context) {
  if (runMcpCredentials.recognizes(ctx.get('authorization').replace(/^Bearer\s+/i, ''))) throw new PluginError('Agent management requires an interactive login', 'AGENT_FORBIDDEN', 403)
  return identity(ctx)
}
export const remove = (ctx: Context) => respond(ctx, () => {
  const who = managementIdentity(ctx), input = ctx.request.body as { expectedVersion: string }
  return isPluginAgentId(ctx.params.id) ? getPluginAgentUpdates().remove(ctx.params.id, who, input) : agentRemove(ctx.params.id, who, input)
})
export const updatePolicy = (ctx: Context) => respond(ctx, () => {
  const who = managementIdentity(ctx)
  return isPluginAgentId(ctx.params.id) ? getPluginAgentUpdates().snapshot(ctx.params.id, who) : builtinAgentUpdatePolicy(ctx.params.id)
})
export const setUpdatePolicy = (ctx: Context) => respond(ctx, () => {
  const who = managementIdentity(ctx)
  const enabled = (ctx.request.body as { autoUpdate?: unknown })?.autoUpdate
  if (typeof enabled !== 'boolean') throw new PluginError('autoUpdate must be boolean', 'AGENT_UPDATE_POLICY', 400)
  return isPluginAgentId(ctx.params.id) ? getPluginAgentUpdates().set(ctx.params.id, enabled, who) : builtinAgentUpdatePolicy(ctx.params.id, enabled, true)
})
