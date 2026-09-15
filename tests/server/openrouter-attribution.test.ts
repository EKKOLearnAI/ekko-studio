import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRunGateway } from '../../packages/server/src/modules/coding-agents/protocol/gateway'
import { fetchProviderModels } from '../../packages/server/src/modules/studio/public/provider-catalog'

afterEach(() => vi.unstubAllGlobals())

describe('Studio OpenRouter attribution', () => {
  it('uses the same app identity for proxy completion, streaming, and model discovery', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.body && JSON.parse(String(init.body)).stream) {
        return new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
      }
      return Response.json({ data: [{ id: 'test-model' }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const gateway = new AgentRunGateway()
    const request = { url: 'https://openrouter.ai/api/v1/chat/completions', apiKey: 'test-key', body: {} }
    await gateway.completeJson(request)
    for await (const _chunk of await gateway.streamBytes({ ...request, body: { stream: true } })) { /* drain stream */ }
    expect(await fetchProviderModels('https://openrouter.ai/api/v1', 'test-key')).toEqual(['test-model'])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    for (const [, init] of fetchMock.mock.calls) {
      const headers = new Headers(init?.headers)
      expect(headers.get('X-OpenRouter-Title')).toBe('Ekko Studio')
      expect(headers.get('HTTP-Referer')).toBe('https://ekkostudio.xyz')
      expect(headers.get('X-OpenRouter-Categories')).toBe('cli-agent,personal-agent')
      expect(headers.get('authorization')).toBe('Bearer test-key')
    }
  })

  it('retains explicitly configured attribution', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => Response.json({}))
    vi.stubGlobal('fetch', fetchMock)
    await new AgentRunGateway().completeJson({
      url: 'https://openrouter.ai/api/v1/chat/completions', apiKey: 'test-key', body: {},
      headers: { 'X-OpenRouter-Title': 'Custom App', 'HTTP-Referer': 'https://example.com' },
    })
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get('X-OpenRouter-Title')).toBe('Custom App')
    expect(headers.get('HTTP-Referer')).toBe('https://example.com')
  })
})
