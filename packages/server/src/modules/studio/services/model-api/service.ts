import { hostedModelCatalog as unifiedCatalog, hostedModelApiMode as apiMode, hostedModelCallable as callable,
  hostedModelSupported as supported, resolveHostedModel } from '../models/hosted-provider'
import { logger } from '../../public/logging'
import { recordSessionUsage, type RecordedUsage } from '../usage/usage-recorder'
import { ModelApiError, modelApiErrorBody } from './errors'
import { responsesModelRequest, validateResponsesBody } from './input'
import { ResponsesOutput, type ResponsesEvent } from './output'
import { reasoningCodec } from './reasoning'
import { checkModelApiBudget, startModelApiKeyRequest } from './budget'

export async function listApiModels(profiles: string[], allowedModels?: readonly string[]) {
  const catalog = await unifiedCatalog(profiles)
  const allowed = allowedModels === undefined ? undefined : new Set(allowedModels)
  return { object: 'list', data: [...catalog].filter(([id]) => !allowed || allowed.has(id)).map(([id, entry]) => ({
    id, object: 'model', created: 0, owned_by: entry.group.provider,
    api_mode: apiMode(entry.group, entry.model) || null,
    responses_supported: callable(entry),
  })) }
}

export async function prepareModelResponse(input: {
  profiles: string[]
  onUsage?: (usage: RecordedUsage) => void
  accountId?: string
  apiKeyId?: string
  allowedModels?: readonly string[]
  body: unknown
  signal: AbortSignal
  /** Trusted host binding; never read from the public request body. */
  internal?: { id: string; sessionId?: string; parentRunId?: string; authorize(): void }
}) {
  validateResponsesBody(input.body)
  const checkBudget = () => {
    input.internal?.authorize()
    if (input.apiKeyId && input.accountId) checkModelApiBudget(Number(input.accountId), input.apiKeyId)
  }
  const startAccounting = (id: string) => input.apiKeyId && input.accountId ? startModelApiKeyRequest(Number(input.accountId), input.apiKeyId, id) : () => {}
  checkBudget()
  const body = input.body
  if (input.allowedModels && !input.allowedModels.includes(body.model)) throw new ModelApiError('Model is not available.', 404, 'model')
  const catalog = await unifiedCatalog(input.profiles)
  const selected = catalog.get(body.model)
  if (!selected || selected.group.model_meta?.[selected.model]?.disabled) throw new ModelApiError('Model is not available.', 404, 'model')
  const { profile, group, model } = selected
  if (!supported(group, model)) throw new ModelApiError('This provider requires a runtime that does not support direct model requests.', 501, 'model')
  const { client, baseUrl, accountingBaseUrl, requestStyle } = await resolveHostedModel(selected, input.internal?.authorize)
  const codec = await reasoningCodec(JSON.stringify([profile, group.provider, model, baseUrl, requestStyle]))
  const request = responsesModelRequest(body, model, codec, input.signal)
  if (request.messages.some(message => message.contentParts?.some(part => part.type === 'image')) && !client.capabilities.vision) {
    throw new ModelApiError('This model does not support images.', 400, 'input')
  }
  const output = new ResponsesOutput(body.model, codec, body, requestStyle !== 'openai-responses', input.internal?.id)
  let recorded = false
  const record = (startedAt: number) => {
    if (recorded) return
    recorded = true
    recordSessionUsage({
      onRecorded: input.onUsage,
      sessionId: input.internal?.sessionId || '', runId: output.id, origin: input.internal ? 'internal' : 'external', accountId: input.accountId, modelApiKeyId: input.apiKeyId,
      ...(input.internal ? { parentRunId: input.internal.parentRunId, requirePersistence: true } : {}),
      source: 'model_api', agent: 'model_api', usageScope: 'model_call', apiCalls: 1,
      profile, provider: group.provider, model, baseUrl: accountingBaseUrl,
      usage: output.usage, apiDuration: (performance.now() - startedAt) / 1000,
    })
  }
  checkBudget()
  return {
    id: output.id,
    stream: body.stream === true,
    async create() {
      checkBudget()
      const release = startAccounting(output.id)
      const startedAt = performance.now()
      try {
        const result = await client.create(request)
        const events = output.finish(result)
        return events[events.length - 1].response
      } finally { try { record(startedAt) } finally { release() } }
    },
    async *events(): AsyncGenerator<ResponsesEvent> {
      const startedAt = performance.now()
      let admitted = false
      let release = () => {}
      try {
        checkBudget()
        release = startAccounting(output.id)
        admitted = true
        yield output.event('response.created', { response: output.response() })
        yield output.event('response.in_progress', { response: output.response() })
        for await (const event of client.stream(request)) {
          if (event.type === 'error') throw new Error(event.error)
          if (event.type === 'done') {
            yield* output.finish(event.response)
            return
          }
          yield* output.consume(event)
        }
        // An EOF without a terminal event is never a successful response.
        throw new Error('Provider stream ended before completion')
      } catch (error) {
        if (!input.signal.aborted) {
          logger.warn({ requestId: output.id, provider: group.provider }, 'Model API stream failed')
          yield output.event('response.failed', { response: output.response('failed', modelApiErrorBody(error).body.error) })
        }
      } finally { try { if (admitted) record(startedAt) } finally { release() } }
    },
  }
}
