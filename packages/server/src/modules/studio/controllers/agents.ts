import type { Context } from 'koa'
import { agentCheckUpdate, agentDescriptors, agentModels, agentSettings, agentStatus, agentUpgrade } from '../services/agents/registry'
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
  return agentCheckUpdate(ctx.params.id, identity(ctx))
})
export const upgrade = (ctx: Context) => respond(ctx, () => {
  if (runMcpCredentials.recognizes(ctx.get('authorization').replace(/^Bearer\s+/i, ''))) throw new PluginError('Agent management requires an interactive login', 'AGENT_FORBIDDEN', 403)
  return agentUpgrade(ctx.params.id, identity(ctx), ctx.request.body as { version: string; expectedVersion: string })
})
