import type { Context } from 'koa'
import { runMcpCredentials } from '../services/auth/run-mcp-credentials'
import type { ApiRequest, PluginIdentity } from '../contracts/plugins'
import { resolvePluginIdentity, pluginAdministrationIdentity, getPluginManager, getPluginDevelopment, ensureBuiltinPlugins } from '../services/plugins/host'
import { PluginError } from '../services/plugins/errors'
import { identifier, json } from '../services/plugins/schema'
import { mergeSecrets, publicConfig } from '../services/plugins/policy'
import { synchronizePluginMcpServers } from '../services/plugins/mcp'

function body(ctx: Context): Record<string, any> { return (ctx.request.body || {}) as Record<string, any> }
function login(ctx: Context) {
  if (!ctx.state.user || ctx.state.sessionShare) throw new PluginError('Studio login required', 'PLUGIN_FORBIDDEN', 403)
  return ctx.state.user
}
function identity(ctx: Context): PluginIdentity {
  const user = login(ctx)
  const binding = runMcpCredentials.authenticate(ctx.get('authorization').replace(/^Bearer\s+/i, ''))
  const profile = binding?.profile || ctx.state.profile?.name
  if (!profile) throw new PluginError('Select a profile before using plugins')
  const sessionId = binding?.sessionId || (typeof body(ctx).sessionId === 'string' ? body(ctx).sessionId : typeof ctx.query.sessionId === 'string' ? ctx.query.sessionId : undefined)
  return resolvePluginIdentity({ userId: user.id, profile, sessionId, runId: binding?.contextId, runtime: binding?.agentId, surface: binding ? 'agent' : 'ui' })
}
function management(ctx: Context): PluginIdentity {
  login(ctx)
  if (ctx.state.user?.role !== 'super_admin' || runMcpCredentials.recognizes(ctx.get('authorization').replace(/^Bearer\s+/i, ''))) throw new PluginError('Installing executable plugins requires a super administrator login', 'PLUGIN_FORBIDDEN', 403)
  return pluginAdministrationIdentity(ctx.state.user!.id)
}
async function respond(ctx: Context, work: () => unknown | Promise<unknown>) {
  try { ctx.body = await work() }
  catch (error) {
    ctx.status = error instanceof PluginError ? error.status : 500
    ctx.body = { error: error instanceof Error ? error.message : String(error), code: error instanceof PluginError ? error.code : 'PLUGIN_EXECUTION' }
  }
}
function clientConfig(record: ReturnType<ReturnType<typeof getPluginManager>['snapshot']>['plugins'][number]) {
  return publicConfig(record.config, record.manifest.configSchema)
}
export const list = (ctx: Context) => respond(ctx, async () => {
  login(ctx)
  await ensureBuiltinPlugins()
  const snapshot = getPluginManager().snapshot()
  return { ...snapshot, plugins: snapshot.plugins.map(record => ({ ...record, config: clientConfig(record) })) }
})
export const install = (ctx: Context) => respond(ctx, async () => {
  const who = management(ctx), input = body(ctx)
  if (input.trusted !== true) throw new PluginError('Confirm that this executable plugin is trusted')
  if (input.expectedVersion !== undefined && (typeof input.expectedVersion !== 'string' || input.expectedVersion.length > 128 || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(input.expectedVersion))) throw new PluginError('Invalid expected plugin version')
  await getPluginManager().install(who, input.source, input.revision, input.pluginId, { expectedVersion: input.expectedVersion })
  await synchronizePluginMcpServers()
  return { ok: true }
})
export const update = (ctx: Context) => respond(ctx, async () => {
  const who = management(ctx), input = body(ctx)
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new PluginError('enabled must be boolean')
  if (input.action !== undefined && !['reload', 'rollback', 'uninstall', 'stop-development'].includes(input.action)) throw new PluginError('Unknown plugin operation')
  const id = identifier(ctx.params.id)
  if (input.config !== undefined) {
    const record = getPluginManager().store.read().records[id]
    if (!record) throw new PluginError('Plugin not found', 'PLUGIN_NOT_FOUND', 404)
    input.config = mergeSecrets(json(input.config), record.config, record.manifest.configSchema)
  }
  await getPluginManager().update(who, id, input.revision, input)
  await synchronizePluginMcpServers()
  return { ok: true }
})
export const client = (ctx: Context) => respond(ctx, async () => ({ source: await getPluginManager().client(identity(ctx), ctx.params.id) }))
export const logs = (ctx: Context) => respond(ctx, () => ({ entries: getPluginManager().logs(management(ctx), ctx.params.id) }))
export const events = (ctx: Context) => respond(ctx, () => getPluginManager().poll(identity(ctx), Number(ctx.query.cursor) || 0, typeof ctx.query.pluginId === 'string' ? ctx.query.pluginId : undefined))
export const invoke = (ctx: Context) => respond(ctx, async () => {
  const who = identity(ctx), input = body(ctx)
  if (!['rpc', 'tool', 'command', 'action'].includes(input.kind)) throw new PluginError('Unknown plugin invocation kind')
  const controller = new AbortController()
  const close = () => { if (!ctx.res.writableEnded) controller.abort() }
  ctx.res.once('close', close)
  try { return { result: await getPluginManager().runtime(who, ctx.params.id).invoke(input.kind, input.name, json(input.input ?? null), who, controller.signal) } }
  finally { ctx.res.off('close', close) }
})
export const api = (ctx: Context) => respond(ctx, async () => {
  const who = identity(ctx), input = body(ctx)
  const controller = new AbortController()
  const close = () => { if (!ctx.res.writableEnded) controller.abort() }
  ctx.res.once('close', close)
  try { return { result: await getPluginManager().request(who, ctx.params.id, input.path, input.options as ApiRequest || {}, controller.signal) } }
  finally { ctx.res.off('close', close) }
})
export const storage = (ctx: Context) => respond(ctx, async () => {
  const who = identity(ctx), input = body(ctx), runtime = getPluginManager().runtime(who, ctx.params.id)
  runtime.require('storage.client')
  if (input.namespace !== undefined && (!Array.isArray(input.namespace) || input.namespace.length > 16 || input.namespace.some((part: unknown) => typeof part !== 'string' || !part || part.length > 256))) throw new PluginError('Invalid storage namespace')
  const scope = input.scope || 'plugin'
  if (!['plugin', 'user', 'profile', 'session'].includes(scope)) throw new PluginError('Invalid storage scope')
  const state = runtime.runContext(who, runtime.effects.controller.signal).state
  const selected = state[scope as 'plugin' | 'user' | 'profile' | 'session']
  if (!selected) throw new PluginError('Storage scope is unavailable')
  const store = selected.namespace(...(input.namespace || []))
  switch (input.action) {
    case 'get': { const value = await store.get(input.key); return { present: value !== undefined, value: value ?? null } }
    case 'set': await store.set(input.key, json(input.value)); return { ok: true }
    case 'delete': await store.delete(input.key); return { ok: true }
    case 'keys': return { keys: await store.keys() }
    default: throw new PluginError('Unknown storage operation')
  }
})

export const developmentList = (ctx: Context) => respond(ctx, async () => {
  management(ctx)
  return getPluginDevelopment().list()
})
export const developmentStart = (ctx: Context) => respond(ctx, async () => {
  const who = management(ctx), input = body(ctx)
  if (input.trusted !== true) throw new PluginError('Confirm that this development project and its build scripts are trusted')
  await getPluginDevelopment().start(who, identifier(ctx.params.id), input.revision)
  return { ok: true }
})
export const developmentUnlink = (ctx: Context) => respond(ctx, async () => {
  await getPluginDevelopment().unlink(management(ctx), identifier(ctx.params.id), Number(ctx.query.revision))
  return { ok: true }
})

export const browser = (ctx: Context) => respond(ctx, async () => {
  const who = identity(ctx), input = body(ctx), runtime = getPluginManager().runtime(who, ctx.params.id)
  const controller = new AbortController()
  const close = () => { if (!ctx.res.writableEnded) controller.abort() }
  ctx.res.once('close', close)
  try {
    const signal = AbortSignal.any([runtime.effects.controller.signal, controller.signal])
    return await runtime.browserRequest(who, signal, input.method, input.params || {})
  } finally { ctx.res.off('close', close) }
})
