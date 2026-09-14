import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRunGateway, ProviderApiError } from '../../packages/server/src/modules/coding-agents/protocol/gateway'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('agent run gateway', () => {
  it('does not start an already-cancelled request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(new AgentRunGateway().completeJson({
      url: 'https://provider.example/v1/responses', apiKey: 'test-key',
      body: {}, signal: AbortSignal.abort(),
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('retries a classified connection failure but not arbitrary error text', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }))
      .mockResolvedValueOnce(new Response('{"ok":true}'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(new AgentRunGateway().completeJson({
      url: 'https://provider.example/v1/responses', apiKey: 'test-key', body: {},
    })).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    fetchMock.mockReset().mockRejectedValue(new Error('response body contains ECONNREFUSED'))
    await expect(new AgentRunGateway().completeJson({
      url: 'https://provider.example/v1/responses', apiKey: 'test-key', body: {},
    })).rejects.toThrow('response body')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each(['ECONNRESET', 'UND_ERR_SOCKET', 'EPROTO', 'CERT_HAS_EXPIRED'])('does not replay requests on %s', async code => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed', { cause: { code } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(new AgentRunGateway().completeJson({
      url: 'https://provider.example/v1/responses', apiKey: 'test-key', body: {},
    })).rejects.toThrow('fetch failed')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('aborts a pending retry without sending another request', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }))
    vi.stubGlobal('fetch', fetchMock)
    const pending = new AgentRunGateway().completeJson({
      url: 'https://provider.example/v1/responses', apiKey: 'test-key', body: {}, signal: controller.signal,
    })
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await new Promise(resolve => setTimeout(resolve, 20))
    controller.abort()
    await rejection
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('shares OpenCode affinity across protocols and retries for one conversation', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const stream = JSON.parse(String(init?.body)).stream
      return new Response(stream ? 'data: [DONE]\n\n' : '{}', {
        headers: { 'Content-Type': stream ? 'text/event-stream' : 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const gateway = new AgentRunGateway()
    for (const [sessionId, endpoint, stream] of [
      ['session-a', 'chat/completions', false],
      ['session-a', 'responses', true],
      ['session-b', 'messages', false],
      ['session-a', 'chat/completions', false],
    ] as const) {
      const request = { url: `https://opencode.ai/zen/go/v1/${endpoint}`, apiKey: 'test-key', sessionId, body: { stream } }
      if (stream) {
        for await (const _chunk of await gateway.streamBytes(request)) { /* drain */ }
      } else await gateway.completeJson(request)
    }
    const ids = fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('x-opencode-session'))
    expect(ids[0]).toMatch(/^[a-f0-9]{64}$/)
    expect(ids[1]).toBe(ids[0])
    expect(ids[2]).not.toBe(ids[0])
    expect(ids[3]).toBe(ids[0])
  })

  it('posts JSON requests with bearer auth and custom headers', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await new AgentRunGateway().completeJson({
      url: 'https://api.example.com/v1/messages',
      apiKey: 'sk-test',
      headers: { 'x-api-key': 'sk-test' },
      body: { model: 'm' },
    })

    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/v1/messages', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer sk-test',
        'Content-Type': 'application/json',
        'x-api-key': 'sk-test',
      }),
      body: '{"model":"m"}',
    }))
  })

  it.each([false, true])('omits upstream authorization for keyless requests (stream=%s)', async (stream) => {
    const fetchMock = vi.fn(async () => new Response(stream ? 'data: [DONE]\n\n' : '{}', {
      headers: { 'Content-Type': stream ? 'text/event-stream' : 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const gateway = new AgentRunGateway()
    const request = { url: 'https://opencode.ai/zen/v1/chat/completions', apiKey: '', body: { stream } }
    if (stream) {
      for await (const _chunk of await gateway.streamBytes(request)) { /* drain */ }
    } else await gateway.completeJson(request)
    const headers = new Headers((fetchMock.mock.calls[0] as any)[1].headers)
    expect(headers.has('authorization')).toBe(false)
    expect(headers.has('x-api-key')).toBe(false)
  })

  it('throws structured provider errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'bad key' },
    }), { status: 401, headers: { 'Content-Type': 'application/json' } })))

    await expect(new AgentRunGateway().completeJson({
      url: 'https://api.example.com/v1/messages',
      apiKey: 'sk-test',
      body: {},
    })).rejects.toMatchObject({
      name: 'ProviderApiError',
      status: 401,
      providerError: { error: { message: 'bad key' } },
      message: 'bad key',
    } satisfies Partial<ProviderApiError>)
  })

  it('returns provider byte streams', async () => {
    const encoder = new TextEncoder()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('chunk'))
        controller.close()
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })))

    const stream = await new AgentRunGateway().streamBytes({
      url: 'https://api.example.com/v1/responses',
      apiKey: 'sk-test',
      body: { stream: true },
    })

    const chunks: string[] = []
    for await (const chunk of stream) chunks.push(new TextDecoder().decode(chunk))
    expect(chunks).toEqual(['chunk'])
  })

  it('rejects JSON error bodies returned with HTTP 200 for stream requests', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 500,
      msg: '404 NOT_FOUND',
      success: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    await expect(new AgentRunGateway().streamBytes({
      url: 'https://api.example.com/v1/messages',
      apiKey: 'sk-test',
      body: { stream: true },
    })).rejects.toMatchObject({
      name: 'ProviderApiError',
      status: 200,
      providerError: { code: 500, msg: '404 NOT_FOUND', success: false },
    } satisfies Partial<ProviderApiError>)
  })
})
