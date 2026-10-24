import { StudioError } from '../../contracts/plugins'
import type { ModelClient } from '../../../../../../ekko-agent/src/model/types'
import { responsesToOpenAiChat, responsesToAnthropicMessages, openAiChatToResponses, anthropicMessageToResponses } from './protocol/adapters/responses'
import { anthropicToOpenAiChat, anthropicToOpenAiResponses, openAiToAnthropicMessage, openAiResponsesToAnthropicMessage } from './protocol/adapters/anthropic'
import { normalizeResponsesSseEvents, openAiChatSseToResponsesEvents, anthropicMessagesSseToResponsesEvents } from './protocol/adapters/responses-stream'
import { openAiChatSseToAnthropicEvents, openAiResponsesSseToAnthropicEvents } from './protocol/adapters/anthropic-stream'
import { NativeTools, unsupportedNative, validateTranslationInput } from './native-tools'
import { TranslationWire, translationFrames, translationJson, type TranslationStyle } from './native-translation-wire'

export function canTranslateNative(client: ModelClient, protocol: 'responses' | 'anthropic'): boolean {
  return !!client.nativeRequest && (client.requestStyle === 'openai-chat'
    || client.requestStyle === (protocol === 'responses' ? 'anthropic-messages' : 'openai-responses'))
}

/** Legacy wire codecs are shared; lifecycle, authorization and accounting belong to the Run gateway. */
export async function translatedNativeRequest(input: {
  client: ModelClient; protocol: 'responses' | 'anthropic'; model: string; publicModel: string;
  body: Record<string, any>; signal: AbortSignal; sessionId: string; images?: boolean; baseUrl?: string; authorize(): void
}): Promise<Response> {
  const { client, protocol, model, publicModel } = input
  if (!canTranslateNative(client, protocol)) unsupportedNative('this provider protocol')
  const controller = new AbortController(), signal = AbortSignal.any([input.signal, controller.signal])
  const check = () => { signal.throwIfAborted(); input.authorize() }
  check()
  let body = input.body
  validateTranslationInput(protocol, body)
  // Native passthrough retains these features. Translated paths must not silently discard them.
  if (body.tool_choice && body.tool_choice !== 'auto' && body.tool_choice?.type !== 'auto') unsupportedNative('forced tool choice')
  if (body.tool_choice?.disable_parallel_tool_use) unsupportedNative('serial tool enforcement')
  if (body.parallel_tool_calls === false || body.text?.format?.type && body.text.format.type !== 'text') unsupportedNative('strict output constraints')
  let tools: NativeTools | undefined
  if (protocol === 'responses') {
    tools = new NativeTools(body.tools)
    body = { ...body, tools: tools.tools, input: Array.isArray(body.input) ? body.input.map(item => tools!.input(item)) : body.input }
  } else if (body.tools?.some((tool: any) => tool.type && tool.type !== 'custom' || tool.strict || tool.defer_loading)) unsupportedNative('server or strict tools')
  const target = { model, provider: client.provider, baseUrl: input.baseUrl || '', reasoningEffort: body.reasoning?.effort }
  const outputTarget = { ...target, model: publicModel }
  const stream = body.stream === true
  const request = protocol === 'responses'
    ? client.requestStyle === 'openai-chat' ? responsesToOpenAiChat(body, target, stream) : responsesToAnthropicMessages(body, target, stream)
    : client.requestStyle === 'openai-chat' ? anthropicToOpenAiChat(body, target, stream) : anthropicToOpenAiResponses(body, target, stream)
  if (request.tools?.length && !client.capabilities.tools) unsupportedNative('tools on this model')
  const hasImage = (value: any): boolean => !!value && typeof value === 'object' && (['image_url', 'image', 'input_image'].includes(value.type) || Object.values(value).some(hasImage))
  if ((!client.capabilities.vision || input.images === false) && hasImage(request.messages || request.input)) unsupportedNative('images on this model')
  check()
  const upstream = await client.nativeRequest!(request, { model, messages: [], signal, metadata: { session_id: input.sessionId } })
  try { check() } catch (error) { await upstream.body?.cancel(); throw error }
  const mediaType = upstream.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  if (!upstream.ok || !upstream.body || mediaType !== (stream ? 'text/event-stream' : 'application/json')) {
    await upstream.body?.cancel(); throw new StudioError('RUNTIME_UNAVAILABLE', 'Provider translation is unavailable')
  }
  const wire = new TranslationWire(client.requestStyle as TranslationStyle)
  const projectResponse = (response: any) => {
    const usage = wire.usage('responses')
    return { ...response, status: wire.status,
      ...(wire.status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
      // Strict Responses clients require all totals when usage is an object.
      usage: usage.input_tokens == null || usage.output_tokens == null ? null : usage,
      output: response.output.map((item: any) => tools!.output(item)) }
  }
  if (!stream) {
    const data = await translationJson(upstream)
    check(); wire.observe(data, false); wire.finish()
    if (protocol === 'responses') return Response.json(projectResponse(client.requestStyle === 'openai-chat'
      ? openAiChatToResponses(data, outputTarget) : anthropicMessageToResponses(data, outputTarget)))
    const output = client.requestStyle === 'openai-chat' ? openAiToAnthropicMessage(data, outputTarget)
      : openAiResponsesToAnthropicMessage(data, outputTarget, body.tools)
    return Response.json({ ...output, usage: wire.usage('anthropic'), ...(wire.status === 'incomplete' ? { stop_reason: 'max_tokens' } : {}) })
  }
  const source = translationFrames(upstream, wire, signal, check)
  const events = protocol === 'responses'
    ? normalizeResponsesSseEvents(client.requestStyle === 'openai-chat' ? openAiChatSseToResponsesEvents(source, outputTarget) : anthropicMessagesSseToResponsesEvents(source, outputTarget))
    : client.requestStyle === 'openai-chat' ? openAiChatSseToAnthropicEvents(source, outputTarget) : openAiResponsesSseToAnthropicEvents(source, outputTarget, body.tools)
  async function* projected() {
    try {
      for await (const event of events) {
        check()
        let { type, data } = event
        if (protocol === 'responses') {
          if (data.item) data = { ...data, item: tools!.output(data.item) }
          if (type === 'response.completed') {
            wire.finish(); type = wire.status === 'incomplete' ? 'response.incomplete' : type
            data = { ...data, type, response: projectResponse(data.response) }
          }
        } else {
          if (type === 'message_start') data = { ...data, message: { ...(data.message as object), usage: {} } }
          if (type === 'message_delta') data = { ...data, usage: wire.usage('anthropic'),
            ...(wire.status === 'incomplete' ? { delta: { ...(data.delta as object), stop_reason: 'max_tokens' } } : {}) }
          if (type === 'message_stop') wire.finish()
        }
        yield `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
      }
    } finally { await source.return() }
  }
  const iterator = projected(), encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    async pull(destination) {
      try {
        const next = await iterator.next()
        if (next.done) destination.close()
        else destination.enqueue(encoder.encode(next.value))
      } catch (error) { controller.abort(); destination.error(error) }
    },
    async cancel() { controller.abort(); await iterator.return(undefined); if (!upstream.body!.locked) await upstream.body!.cancel() },
  }), { headers: { 'content-type': 'text/event-stream' } })
}
