import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { Context } from 'koa'
import { modelGatewayAdapters, type ModelGatewayProtocol } from '../../public/model-gateway-adapters'
import { qualifyModelRoute, providerRouteNamespace, canonicalModelRoute } from '../../public/model-routing'
import { resolveProviderUpstream } from '../../public/provider-upstream'
import { normalizeTokenUsage, normalizeUsageCost, recordSessionUsage } from '../../public/usage'
import { apiMode, unifiedCatalog } from './service'
import { ModelApiError } from './errors'
import { checkModelApiBudget, startModelApiKeyRequest } from './budget'
import { claimCloudUsageReceipt } from './cloud-usage'

function responseModel(value: any, model: string): any {
  if (!value || typeof value !== 'object') return value
  return { ...value, ...(typeof value.model === 'string' ? { model } : {}),
    ...(value.response ? { response: responseModel(value.response, model) } : {}),
    ...(value.type === 'message_start' && value.message ? { message: responseModel(value.message, model) } : {}) }
}

/** Rewrite envelope model IDs without changing text, tool arguments or signatures. */
export async function* gatewayModelStream(stream: AsyncIterable<Uint8Array | string>, model: string): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  const rewrite = (frame: string) => frame.replace(/^data: ?(.+)$/gm, (line, data) => {
    try { return `data: ${JSON.stringify(responseModel(JSON.parse(data), model))}` } catch { return line }
  })
  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    let end: RegExpExecArray | null
    while ((end = /\r?\n\r?\n/.exec(buffer))) {
      yield rewrite(buffer.slice(0, end.index)) + '\n\n'
      buffer = buffer.slice(end.index + end[0].length)
    }
    if (buffer.length > 32 * 1024 * 1024) throw new Error('Provider SSE event exceeds the gateway limit')
  }
  buffer += decoder.decode()
  if (buffer) yield rewrite(buffer)
}

function requestedModel(ctx: Context, protocol: ModelGatewayProtocol): string {
  if (protocol === 'gemini_contents') {
    const match = /\/v1beta\/models\/(.+):(?:streamGenerateContent|generateContent)$/.exec(ctx.path)
    if (!match) throw new ModelApiError('Invalid Gemini model operation.', 400, 'model')
    try { return decodeURIComponent(match[1]) } catch { throw new ModelApiError('Invalid model encoding.', 400, 'model') }
  }
  const model = (ctx.request.body as any)?.model
  if (typeof model !== 'string' || !model.trim()) throw new ModelApiError('A model route is required.', 400, 'model')
  return model
}

export async function serveModelGateway(ctx: Context, protocol: ModelGatewayProtocol, profiles: string[]): Promise<void> {
  const user = ctx.state.user
  if (!user) throw new ModelApiError('Authentication is required.', 401)
  const body = ctx.request.body as any
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ModelApiError('Request body must be an object.', 400)
  const required = protocol === 'gemini_contents' ? 'contents' : protocol === 'codex_responses' ? 'input' : 'messages'
  if (!Array.isArray(body[required]) && !(required === 'input' && typeof body.input === 'string')) throw new ModelApiError(`Invalid ${required}.`, 400, required)
  let modelId = requestedModel(ctx, protocol)
  const catalog = await unifiedCatalog(profiles)
  // In-process Ekko clients keep logical model IDs. Their internal credential
  // binds the Profile; a provider header disambiguates the model in that scope.
  if (ctx.state.modelGateway && ctx.get('x-studio-provider')) {
    let provider = ctx.get('x-studio-provider')
    // HTTP headers cannot carry Unicode. Decode only explicitly encoded values
    // so legacy provider names containing literal percent escapes stay intact.
    if (ctx.get('x-studio-provider-encoding') === 'uri') {
      try { provider = decodeURIComponent(provider) } catch { throw new ModelApiError('Invalid provider encoding.', 400, 'provider') }
    }
    modelId = qualifyModelRoute(await providerRouteNamespace(ctx.state.modelGateway.profile, provider), modelId)
  }
  modelId = await canonicalModelRoute(modelId)
  if (ctx.state.modelApiKey && !(await Promise.all(ctx.state.modelApiKey.models.map(canonicalModelRoute))).includes(modelId)) throw new ModelApiError('Model is not available.', 404, 'model')
  const selected = catalog.get(modelId)
  if (!selected || selected.group.model_meta?.[selected.model]?.disabled) throw new ModelApiError('Model is not available.', 404, 'model')
  const { profile, group, model } = selected
  // HTTP response hooks run in the selected account/Profile, including sharing keys.
  ctx.state.profile = { name: profile }
  const mode = apiMode(group, model)
  if (mode === 'bedrock_converse' || mode === 'codex_app_server') throw new ModelApiError('This provider requires a native runtime.', 501, 'model')
  const runtime = await resolveProviderUpstream({ profile, provider: group.provider, model, apiMode: mode })
  if (!runtime.baseUrl) throw new ModelApiError('Provider endpoint is unavailable.', 503, 'model')
  const requestId = randomUUID()
  ctx.set('x-request-id', requestId)
  const counting = ctx.path.endsWith('/count_tokens')
  const keyId = counting ? undefined : ctx.state.modelApiKey?.id
  if (keyId) checkModelApiBudget(user.id, keyId)
  const internal = !!ctx.state.modelGateway
  const onUsage = claimCloudUsageReceipt(ctx.get('x-studio-cloud-usage'), user.id, keyId)
  let recorded = false
  const record = (event?: { type: string; data: any }, duration?: number) => {
    // Hermes records its own run once. Native coding/plugin targets carry their
    // existing run callbacks; neither is charged again as a shared API request.
    if (counting || internal || recorded) return
    const response = event?.data?.response || event?.data
    if (event && !['response.completed', 'response.failed', 'response.incomplete'].includes(event.type)) return
    recorded = true
    const usage = normalizeTokenUsage(response?.usage || {}, {}, { inputIncludesCache: mode !== 'anthropic_messages' })
    recordSessionUsage({ sessionId: '', runId: requestId, origin: 'external', accountId: String(user.id),
      modelApiKeyId: keyId, source: 'model_api', agent: 'model_api', usageScope: 'model_call', apiCalls: 1,
      profile, provider: group.provider, model, baseUrl: runtime.baseUrl, usage, cost: normalizeUsageCost(response), apiDuration: duration, onRecorded: onUsage })
  }
  const target = modelGatewayAdapters().register(protocol, { requestId, userId: user.id, profile, provider: group.provider, model,
    baseUrl: runtime.baseUrl, apiKey: runtime.apiKey || '', apiMode: mode || runtime.apiMode, onUsageEvent: record })
  const originalKey = ctx.params.key
  ctx.params.key = target.routeKey
  ;(ctx.state as any).modelGatewayTarget = target.routeKey
  if (protocol === 'gemini_contents') ctx.params.operation = `${modelId}:${ctx.path.endsWith(':streamGenerateContent') ? 'streamGenerateContent' : 'generateContent'}`
  let release = () => {}
  let streamed = false
  try {
    if (keyId) release = startModelApiKeyRequest(user.id, keyId, requestId)
    await modelGatewayAdapters().handle(protocol, ctx)
    if (ctx.body instanceof Readable) {
      streamed = true
      const stream = ctx.body
      let cleaned = false
      const cleanup = () => {
        if (cleaned) return
        cleaned = true
        try { record() } finally { stream.destroy(); release(); target.dispose() }
      }
      ctx.body = Readable.from((async function* () {
        try { yield* gatewayModelStream(stream, modelId) }
        finally { cleanup() }
      })())
      ;(ctx.body as Readable).once('close', cleanup)
    } else ctx.body = responseModel(ctx.body, modelId)
  } finally {
    ctx.params.key = originalKey
    delete (ctx.state as any).modelGatewayTarget
    if (!streamed) { try { record() } finally { release(); target.dispose() } }
  }
}
