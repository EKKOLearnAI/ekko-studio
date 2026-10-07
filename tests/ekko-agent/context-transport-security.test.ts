import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { AnthropicMessagesModelClient } from '../../packages/ekko-agent/src/model/providers/anthropic'
import { OpenAIResponsesModelClient } from '../../packages/ekko-agent/src/model/providers/openai-responses'
import type { ModelClient, ModelProviderConfig, ModelRequest } from '../../packages/ekko-agent/src/model/types'

const fixtureKey = 'FIXTURE_ONLY_NOT_A_REAL_API_KEY'
const fixtureContent = 'FIXTURE_ONLY_PRIVATE_MODEL_BODY'
const fixtureHeaders = {
  'x-bili-plugin': 'ekko-agent',
  'x-bili-plugin-conversation': 'FIXTURE_ONLY_CONVERSATION_ID',
  'x-bili-plugin-model': 'fixture-model',
}
const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

interface WireRequest {
  url: string | undefined
  method: string | undefined
  headers: IncomingMessage['headers']
  body: string
}

async function loopback(handler: (wire: WireRequest, response: ServerResponse) => void) {
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    handler({ url: request.url, method: request.method, headers: request.headers, body }, response)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback address')
  closers.push(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close(error => error ? reject(error) : resolve())
  }))
  return `http://127.0.0.1:${address.port}`
}

type Style = 'anthropic' | 'openai-responses'

function model(style: Style, baseUrl: string, headers?: Record<string, string>): ModelClient {
  const config: ModelProviderConfig = { id: style, type: style === 'anthropic' ? 'anthropic' : 'openai', baseUrl, apiKey: fixtureKey, defaultModel: 'fixture-model', timeoutMs: 2000, headers }
  return style === 'anthropic'
    ? new AnthropicMessagesModelClient(config)
    : new OpenAIResponsesModelClient(config)
}

function answer(style: Style, streaming: boolean, response: ServerResponse) {
  if (streaming) {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(style === 'anthropic'
      ? 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"fixture-answer"}}\n\ndata: {"type":"message_stop"}\n\n'
      : 'data: {"type":"response.output_text.delta","delta":"fixture-answer"}\n\ndata: [DONE]\n\n')
    return
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(style === 'anthropic'
    ? { content: [{ type: 'text', text: 'fixture-answer' }], stop_reason: 'end_turn' }
    : { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture-answer' }] }] }))
}

async function consume(client: ModelClient, request: ModelRequest, streaming: boolean): Promise<string> {
  if (!streaming) return (await client.create(request)).content
  let text = ''
  for await (const event of client.stream(request)) {
    if (event.type === 'text-delta') text += event.text
  }
  return text
}

const cases = (['anthropic', 'openai-responses'] as const)
  .flatMap(style => [false, true].map(streaming => ({ style, streaming })))

describe('bili model transport redirect security', () => {
  it.each(cases.flatMap(test => [307, 308].map(status => ({ ...test, status }))))(
    'rejects cross-origin $status without sending to the sink: $style streaming=$streaming',
    async ({ style, streaming, status }) => {
      const sinkRequests: WireRequest[] = []
      const sink = await loopback((wire, response) => {
        sinkRequests.push(wire)
        answer(style, streaming, response)
      })
      const proxyRequests: WireRequest[] = []
      const proxy = await loopback((wire, response) => {
        proxyRequests.push(wire)
        response.writeHead(status, { location: `${sink}/capture` })
        response.end()
      })
      const client = model(style, `${sink}/v1`)
      const request: ModelRequest = {
        messages: [{ role: 'user', content: fixtureContent }],
        transport: { proxyOrigin: proxy, headers: fixtureHeaders },
      }
      const result = await consume(client, request, streaming).then(
        value => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      )

      expect(proxyRequests).toHaveLength(1)
      expect(proxyRequests[0].url).toBe(`/bili/${client.requestTarget!(request)}`)
      expect(proxyRequests[0].method).toBe('POST')
      expect(proxyRequests[0].headers).toMatchObject(fixtureHeaders)
      expect(proxyRequests[0].headers.authorization).toBe(`Bearer ${fixtureKey}`)
      if (style === 'anthropic') expect(proxyRequests[0].headers['x-api-key']).toBe(fixtureKey)
      expect(proxyRequests[0].body).toContain(fixtureContent)
      expect(JSON.parse(proxyRequests[0].body).stream).toBe(streaming)
      expect(sinkRequests, 'Redirect must not transmit body, credentials or bili identity').toHaveLength(0)
      expect(result.error).toBeInstanceOf(TypeError)
      expect(result.error).toMatchObject({ message: 'fetch failed' })
      expect(result.value).toBeUndefined()
    },
  )

  it.each(cases.flatMap(test => [false, true].map(biliLooking => ({ ...test, biliLooking }))))(
    'preserves native redirect following: $style streaming=$streaming biliLooking=$biliLooking',
    async ({ style, streaming, biliLooking }) => {
      const sinkRequests: WireRequest[] = []
      const sink = await loopback((wire, response) => {
        sinkRequests.push(wire)
        answer(style, streaming, response)
      })
      const originRequests: WireRequest[] = []
      const origin = await loopback((wire, response) => {
        originRequests.push(wire)
        response.writeHead(307, { location: `${sink}/capture` })
        response.end()
      })
      const client = model(style, `${origin}${biliLooking ? '/bili/fixture/v1' : '/v1'}`, biliLooking ? fixtureHeaders : undefined)
      const result = await consume(client, { messages: [{ role: 'user', content: fixtureContent }] }, streaming)

      expect(result).toBe('fixture-answer')
      expect(originRequests).toHaveLength(1)
      expect(sinkRequests).toHaveLength(1)
      expect(sinkRequests[0].method).toBe('POST')
      expect(sinkRequests[0].body).toContain(fixtureContent)
      if (biliLooking) expect(sinkRequests[0].headers).toMatchObject(fixtureHeaders)
    },
  )
})