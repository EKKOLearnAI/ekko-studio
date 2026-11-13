import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { collectModelEvents, createModelClient } from '../../packages/ekko-agent/src/index'

type ToolDelta = {
  index: number
  id?: string
  function?: { name?: string; arguments?: string }
}

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  })))
})

async function streamToolCalls(deltas: ToolDelta[][]) {
  const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
  const server = createServer(async (request, response) => {
    const body: Buffer[] = []
    for await (const part of request) body.push(Buffer.from(part))
    requests.push({ url: request.url, body: JSON.parse(Buffer.concat(body).toString()) })
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const tool_calls of deltas) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls } }] })}\n\n`)
    }
    response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`)
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const client = createModelClient({
    id: 'test-compatible',
    type: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    defaultModel: 'fixture-model',
  })
  const events = await collectModelEvents(client.stream({ messages: [{ role: 'user', content: 'Check the weather' }] }))
  expect(requests).toEqual([{
    url: '/v1/chat/completions',
    body: expect.objectContaining({ model: 'fixture-model', stream: true }),
  }])
  return events.message.toolCalls ?? []
}

describe('OpenAI-compatible streamed tool identity', () => {
  it.each(['id', 'name', 'both'] as const)('preserves a known tool identity when continuation %s is empty', async empty => {
    const continuation = {
      ...(empty !== 'name' ? { id: '' } : {}),
      function: { ...(empty !== 'id' ? { name: '' } : {}), arguments: '{"city": ' },
    }
    const calls = await streamToolCalls([
      [{ index: 0, id: 'call_weather', function: { name: 'get_weather', arguments: '' } }],
      [{ index: 0, ...continuation }],
      [{ index: 0, id: empty === 'name' ? undefined : '', function: { arguments: '"Beijing' } }],
      [{ index: 0, id: empty === 'name' ? undefined : '', function: { arguments: '"' } }],
      [{ index: 0, id: empty === 'name' ? undefined : '', function: { arguments: '}' } }],
      [{ index: 0, id: empty === 'name' ? undefined : '', function: { arguments: '' } }],
    ])
    expect(calls).toEqual([{
      id: 'call_weather', name: 'get_weather', arguments: { city: 'Beijing' }, rawArguments: '{"city": "Beijing"}',
    }])
  })

  it.each([false, true])('keeps interleaved indices and arguments separate with empty identity=%s', async empty => {
    const identity = empty ? { id: '', name: '' } : {}
    const calls = await streamToolCalls([
      [
        { index: 0, id: 'first', function: { name: 'weather', arguments: '{"city":' } },
        { index: 1, id: 'second', function: { name: 'clock', arguments: '{"zone":' } },
      ],
      [{ index: 1, id: identity.id, function: { name: identity.name, arguments: '"UTC"}' } }],
      [{ index: 0, id: identity.id, function: { name: identity.name, arguments: '"Beijing"}' } }],
    ])
    expect(calls).toEqual([
      { id: 'first', name: 'weather', arguments: { city: 'Beijing' }, rawArguments: '{"city":"Beijing"}' },
      { id: 'second', name: 'clock', arguments: { zone: 'UTC' }, rawArguments: '{"zone":"UTC"}' },
    ])
  })

  it('accepts later nonempty identity updates', async () => {
    expect(await streamToolCalls([
      [{ index: 0, id: 'provisional', function: { name: 'initial', arguments: '{' } }],
      [{ index: 0, id: 'confirmed', function: { name: 'final', arguments: '}' } }],
    ])).toEqual([{ id: 'confirmed', name: 'final', arguments: {}, rawArguments: '{}' }])
  })

  it.each(['id', 'name'] as const)('still rejects a call whose %s was never supplied', async missing => {
    await expect(streamToolCalls([
      [{ index: 0, id: missing === 'id' ? '' : 'call_weather', function: { name: missing === 'name' ? '' : 'weather', arguments: '{' } }],
      [{ index: 0, id: '', function: { name: '', arguments: '}' } }],
    ])).rejects.toMatchObject({ details: { reason: 'invalid_tool_call' }, retryable: true })
  })
})
