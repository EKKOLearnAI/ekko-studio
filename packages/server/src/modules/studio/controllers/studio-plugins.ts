import type { Context } from 'koa'
import { randomUUID } from 'node:crypto'
import { StudioError, type JsonObject, type AgentRunStartInput, type ExecutionScope } from '../contracts/plugins'
import { getStudioPluginRuntime, authorizePluginScope } from '../services/plugins/runtime'
import { jsonCopy } from '../services/plugins/validation'
import { MAX_AGENT_IMAGE_BYTES } from '../services/agents/artifacts'
import { drainRejectedRequest, nonDestroyingRequestBody } from '../http/request-body'
import { getRunRequestContext } from '../services/auth/run-request-context'

const statusFor = (code: string): number => ({ INVALID_ARGUMENT: 400, FORBIDDEN: 403, NOT_FOUND: 404,
  SYSTEM_PLUGIN_PROTECTED: 403, REVISION_CONFLICT: 409, REGISTRATION_CONFLICT: 409,
  PLUGIN_UNAVAILABLE: 503, PLUGIN_VERSION_INCOMPATIBLE: 409, CAPABILITY_UNSUPPORTED: 422,
  RUNTIME_UNAVAILABLE: 503, DEADLINE_EXCEEDED: 504, CANCELLED: 409, RUN_FINALIZING: 409,
  RESOURCE_EXHAUSTED: 429, EVENT_CURSOR_EXPIRED: 409 }[code] || 500)

export async function respond(ctx: Context, action: () => unknown | Promise<unknown>): Promise<void> {
  ctx.set('Cache-Control', 'no-store')
  try { ctx.body = { ok: true, data: await action() } }
  catch (error) {
    if (!(error instanceof StudioError)) throw error
    ctx.status = statusFor(error.code)
    ctx.body = { ok: false, error: error.toJSON() }
  }
}

export function body(ctx: Context, keys: string[]): JsonObject {
  const value = jsonCopy(ctx.request.body || {})
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new StudioError('INVALID_ARGUMENT', 'Invalid plugin request')
  return value as JsonObject
}
function profile(ctx: Context): string {
  const id = ctx.state.profile?.name
  if (typeof id !== 'string' || !id) throw new StudioError('INVALID_ARGUMENT', 'Profile is required')
  authorizePluginScope({ scopeId: 'http', principal: { kind: 'user', id: userId(ctx) }, profileId: id, surface: 'api', traceId: 'http' })
  return id
}

function userId(ctx: Context): string {
  if (!ctx.state.user) throw new StudioError('FORBIDDEN', 'Authentication is required')
  return String(ctx.state.user.id)
}

export const listPlugins = (ctx: Context) => respond(ctx, () => getStudioPluginRuntime().host.list().map(plugin => ({
  id: plugin.id, version: plugin.manifest.version, generation: plugin.generation, origin: plugin.origin,
  installationPolicy: plugin.installationPolicy, revision: plugin.revision,
  agents: plugin.manifest.contributes.agents, requiredCapabilities: plugin.manifest.requires.capabilities,
})))

export const installPlugin = (ctx: Context) => respond(ctx, async () => {
  const input = body(ctx, ['path'])
  if (typeof input.path !== 'string' || !input.path.trim()) throw new StudioError('INVALID_ARGUMENT', 'Plugin directory path is required')
  const plugin = await getStudioPluginRuntime().host.install(input.path)
  return { id: plugin.id, version: plugin.manifest.version, installationPolicy: plugin.installationPolicy }
})

export const configurePlugin = (ctx: Context) => respond(ctx, async () => {
  const input = body(ctx, ['enabled', 'config', 'grants', 'revision', 'profile'])
  if (typeof input.enabled !== 'boolean' || !input.config || typeof input.config !== 'object' || Array.isArray(input.config)
    || !Array.isArray(input.grants) || input.grants.some(value => typeof value !== 'string') || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0) throw new StudioError('INVALID_ARGUMENT', 'Invalid plugin configuration')
  return getStudioPluginRuntime().host.configure({ pluginId: ctx.params.id,
    enabled: input.enabled, config: input.config, grants: input.grants as string[] }, Number(input.revision))
})

export const getPluginProfile = (ctx: Context) => respond(ctx, () => getStudioPluginRuntime().store.state(ctx.params.id))
export const getPluginDiagnostic = (ctx: Context) => respond(ctx, () => getStudioPluginRuntime().host.diagnostic(ctx.params.id))
export const listPluginConsumers = (ctx: Context) => respond(ctx, () => getStudioPluginRuntime().consumers.store.list(ctx.params.id))
function consumer(ctx: Context) {
  const consumers = getStudioPluginRuntime().consumers
  const record = consumers.requireRecord(ctx.params.id, ctx.params.consumerId)
  return { consumers, record }
}
export const getPluginConsumerDeliveries = (ctx: Context) => respond(ctx, () => {
  const { consumers, record } = consumer(ctx)
  return consumers.store.deliveries(record.id)
})
export const controlPluginConsumer = (ctx: Context) => respond(ctx, () => {
  const { consumers, record } = consumer(ctx), input = body(ctx, ['action', 'revision', 'profile'])
  if (!['pause', 'resume', 'reset-now'].includes(String(input.action)) || !Number.isSafeInteger(input.revision) || Number(input.revision) < 1) throw new StudioError('INVALID_ARGUMENT', 'Invalid consumer control')
  return consumers.control(record.id, input.action as 'pause' | 'resume' | 'reset-now', Number(input.revision))
})
export const retryPluginConsumerDelivery = (ctx: Context) => respond(ctx, () => {
  const { consumers, record } = consumer(ctx), input = body(ctx, ['position', 'revision', 'profile'])
  if (!Number.isSafeInteger(input.position) || Number(input.position) < 1 || !Number.isSafeInteger(input.revision) || Number(input.revision) < 1) throw new StudioError('INVALID_ARGUMENT', 'Invalid dead letter retry')
  consumers.store.retry(record.id, Number(input.position), Number(input.revision))
  return { accepted: true }
})
export const removePlugin = (ctx: Context) => respond(ctx, async () => {
  await getStudioPluginRuntime().host.uninstall(ctx.params.id)
  return { removed: true }
})
export const listAgentTypes = (ctx: Context) => respond(ctx, () => {
  userId(ctx)
  return { revision: getStudioPluginRuntime().registry.getRevision(), agents: getStudioPluginRuntime().registry.list('') }
})

export function executionScope(ctx: Context): ExecutionScope {
  const profileId = profile(ctx), run = getRunRequestContext(ctx)
  if (run && run.profile !== profileId) throw new StudioError('FORBIDDEN', 'Profile is outside the authenticated Run')
  return { scopeId: randomUUID(), principal: { kind: 'user', id: userId(ctx) }, profileId, surface: 'api', traceId: randomUUID(),
    ...(run ? { sessionId: run.sessionId, ...(run.runId ? { runId: run.runId } : {}) } : {}) }
}
export const listAgentInstances = (ctx: Context) => respond(ctx, () => getStudioPluginRuntime().coordinator.listInstances(executionScope(ctx)))
export const createAgentChat = (ctx: Context) => respond(ctx, () => {
  const input = body(ctx, ['revision', 'idempotencyKey', 'profile'])
  return getStudioPluginRuntime().agentChats.create(executionScope(ctx), ctx.params.id,
    { revision: input.revision as number, idempotencyKey: input.idempotencyKey as string })
})
export const createOrdinaryAgentChat = (ctx: Context) => respond(ctx, () => {
  const { profile: _profile, ...input } = body(ctx, ['profile', 'sessionId', 'agentTypeId', 'mode', 'workspace', 'model', 'provider', 'reasoningEffort', 'agentPreset', 'categoryId', 'pushEnabled', 'baseUrl', 'apiKey', 'apiMode'])
  return getStudioPluginRuntime().ordinaryChats.create(executionScope(ctx), input)
})
export const listBundledAgentPlugins = (ctx: Context) => respond(ctx, () => getStudioPluginRuntime().bundledAgents.list())
export const enableBundledAgentPlugin = (ctx: Context) => respond(ctx, () => {
  const input = body(ctx, ['revision', 'grants', 'profile'])
  return getStudioPluginRuntime().bundledAgents.enable(ctx.params.id, userId(ctx), input.revision as number, input.grants as string[] | undefined)
})
export const setupAgentInstance = (ctx: Context) => respond(ctx, async () => {
  const input = body(ctx, ['revision', 'profile'])
  const controller = new AbortController(), abort = () => controller.abort()
  ctx.res.once('close', abort)
  if (ctx.res.destroyed) abort()
  try { return await getStudioPluginRuntime().coordinator.setupInstance(executionScope(ctx), ctx.params.id, input.revision as number, controller.signal) }
  finally { ctx.res.removeListener('close', abort) }
})
let agentImageUploads = 0
export const uploadAgentImage = (ctx: Context) => respond(ctx, async () => {
  const scope = executionScope(ctx)
  if (ctx.get('content-type').split(';')[0] !== 'application/octet-stream') throw new StudioError('INVALID_ARGUMENT', 'Expected image bytes as application/octet-stream')
  if (agentImageUploads >= 4) throw new StudioError('RESOURCE_EXHAUSTED', 'Image upload is busy')
  agentImageUploads++
  const controller = new AbortController(), abort = () => controller.abort()
  ctx.res.once('close', abort)
  try {
    let chunks: Buffer[] = []
    let size = 0
    for await (const chunk of nonDestroyingRequestBody(ctx.req)) {
      size += chunk.length
      if (size > MAX_AGENT_IMAGE_BYTES) break
      chunks.push(chunk)
    }
    if (size > MAX_AGENT_IMAGE_BYTES) {
      chunks = []
      await drainRejectedRequest(ctx.req)
      throw new StudioError('RESOURCE_EXHAUSTED', 'Image exceeds 4 MiB')
    }
    return await getStudioPluginRuntime().artifacts.create(scope, Buffer.concat(chunks), controller.signal)
  } finally { agentImageUploads--; ctx.res.removeListener('close', abort) }
})
export const removeAgentImage = (ctx: Context) => respond(ctx, () => {
  getStudioPluginRuntime().artifacts.remove(executionScope(ctx), ctx.params.id)
  return { removed: true }
})
export const readAgentChatImage = async (ctx: Context) => {
  let image: { mediaType: string; bytes: Buffer } | undefined
  await respond(ctx, () => {
    const runtime = getStudioPluginRuntime(), scope = executionScope(ctx)
    runtime.agentChats.ownedBinding(scope, ctx.params.sessionId)
    image = runtime.artifacts.readForChat(scope, ctx.params.sessionId, ctx.params.id)
    return null
  })
  if (image) {
    ctx.set('X-Content-Type-Options', 'nosniff')
    ctx.type = image.mediaType
    ctx.body = image.bytes
  }
}
export const inspectAgentInstance = (ctx: Context) => respond(ctx, async () => {
  body(ctx, ['profile'])
  const controller = new AbortController(), abort = () => controller.abort()
  ctx.res.once('close', abort)
  if (ctx.res.destroyed) abort()
  try { return await getStudioPluginRuntime().coordinator.inspectInstance(executionScope(ctx), ctx.params.id, controller.signal) }
  finally { ctx.res.removeListener('close', abort) }
})
export const createAgentInstance = (ctx: Context) => respond(ctx, () => {
  const input = body(ctx, ['agentTypeId', 'config', 'mode', 'profile'])
  if (typeof input.agentTypeId !== 'string' || !input.config || typeof input.config !== 'object' || Array.isArray(input.config)
    || (input.mode !== 'scoped' && input.mode !== 'global')) throw new StudioError('INVALID_ARGUMENT', 'Invalid Agent instance')
  return getStudioPluginRuntime().coordinator.createInstance(executionScope(ctx), { agentTypeId: input.agentTypeId, config: input.config, mode: input.mode })
})
export const agentInstanceLocations = (ctx: Context) => respond(ctx, async () => {
  const input = body(ctx, ['revision', 'profile'])
  const controller = new AbortController(), abort = () => controller.abort()
  ctx.res.once('close', abort)
  if (ctx.res.destroyed) abort()
  try { return await getStudioPluginRuntime().coordinator.resourceLocations(executionScope(ctx), ctx.params.id, input.revision as number, controller.signal) }
  finally { ctx.res.removeListener('close', abort) }
})
export const agentInstanceResources = (ctx: Context) => respond(ctx, async () => {
  const input = body(ctx, ['action', 'revision', 'snapshot', 'kind', 'locationId', 'path', 'content', 'etag', 'profile'])
  if (!['list', 'read', 'write', 'review-skill', 'remove-skill'].includes(String(input.action))) throw new StudioError('INVALID_ARGUMENT', 'Invalid resource operation')
  const allowed = input.action === 'list' ? ['action', 'revision', 'profile'] : ['action', 'revision', 'profile', 'snapshot', 'kind', 'locationId', 'path', ...(input.action === 'write' ? ['content', 'etag'] : input.action === 'remove-skill' ? ['etag'] : [])]
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new StudioError('INVALID_ARGUMENT', 'Unexpected resource fields')
  const { revision, snapshot, profile: _profile, ...operation } = input
  const controller = new AbortController(), abort = () => controller.abort()
  ctx.res.once('close', abort)
  if (ctx.res.destroyed) abort()
  try { return await getStudioPluginRuntime().coordinator.resourceFiles(executionScope(ctx), ctx.params.id, revision as number,
    operation as unknown as import('../services/agents/resource-files').ResourceFileOperation, snapshot as string | undefined, controller.signal) }
  finally { ctx.res.removeListener('close', abort) }
})
export const startAgentExecution = (ctx: Context) => respond(ctx, () => {
  const input = body(ctx, ['input', 'idempotencyKey', 'profile'])
  const context = getStudioPluginRuntime().context(executionScope(ctx), new AbortController().signal)
  return context.runs.start({ instanceId: ctx.params.id, input: input.input, idempotencyKey: input.idempotencyKey } as unknown as AgentRunStartInput)
})
export const configureAgentInstance = (ctx: Context) => respond(ctx, () => {
  const { profile: _profile, ...input } = body(ctx, ['revision', 'config', 'mode', 'profile'])
  return getStudioPluginRuntime().coordinator.updateInstance(executionScope(ctx), ctx.params.id,
    input as unknown as import('../repositories/agent-execution-store').AgentInstanceConfiguration)
})
export const getAgentExecution = (ctx: Context) => respond(ctx, () => getStudioPluginRuntime().coordinator.get(executionScope(ctx), ctx.params.id))
export const getAgentExecutionOutput = (ctx: Context) => respond(ctx, () => getStudioPluginRuntime().coordinator.output(executionScope(ctx), ctx.params.id, Number(ctx.query.after ?? -1)))
export const cancelAgentExecution = (ctx: Context) => respond(ctx, () => getStudioPluginRuntime().coordinator.cancel(executionScope(ctx), ctx.params.id))
export const getAgentExecutionInteractions = (ctx: Context) => respond(ctx, () => getStudioPluginRuntime().coordinator.interactions(executionScope(ctx), ctx.params.id))
export const getAgentExecutionUsage = (ctx: Context) => respond(ctx, () => getStudioPluginRuntime().coordinator.usage(executionScope(ctx), ctx.params.id))
export const respondAgentExecution = (ctx: Context) => respond(ctx, () => {
  const input = body(ctx, ['interactionId', 'idempotencyKey', 'choiceId', 'text', 'profile'])
  const { profile: _profile, ...response } = input
  return getStudioPluginRuntime().coordinator.respond(executionScope(ctx), ctx.params.id, response as unknown as import('../contracts/plugins').AgentInteractionResponse)
})


export const listPluginCommands = (ctx: Context) => respond(ctx, () => {
  if (typeof ctx.query.sessionId !== 'string' || !ctx.query.sessionId || ctx.query.sessionId.length > 256) throw new StudioError('INVALID_ARGUMENT', 'Session is required')
  return getStudioPluginRuntime().commands.list(executionScope(ctx), ctx.query.sessionId)
})
const commandReceipt = (record: import('../repositories/plugin-command-store').CommandCall) => {
  const { ownerId: _owner, profileId: _profile, ...receipt } = record
  return receipt
}
export const startPluginCommand = (ctx: Context) => respond(ctx, () => {
  const { profile: _profile, ...input } = body(ctx, ['sessionId', 'commandId', 'revision', 'text', 'idempotencyKey', 'profile'])
  return commandReceipt(getStudioPluginRuntime().commands.start(executionScope(ctx), input as unknown as import('../repositories/plugin-command-store').CommandStart))
})
export const getPluginCommand = (ctx: Context) => respond(ctx, () => commandReceipt(getStudioPluginRuntime().commands.get(executionScope(ctx), ctx.params.id)))
export const cancelPluginCommand = (ctx: Context) => respond(ctx, async () => {
  body(ctx, ['profile'])
  return commandReceipt(await getStudioPluginRuntime().commands.cancel(executionScope(ctx), ctx.params.id))
})
