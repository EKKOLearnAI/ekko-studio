import { describe, expect, it, vi } from 'vitest'
import { createModelClient } from '../../packages/ekko-agent/src/index'

describe('OpenRouter app attribution', () => {
  it.each([
    ['openrouter', 'https://openrouter.ai/api/v1', true],
    ['custom:router', 'https://openrouter.ai/api/v1', true],
    ['custom:openrouter', 'https://proxy.example/v1', true],
    ['other', 'https://openrouter.ai.example/v1', false],
    ['other', 'https://example.com/openrouter.ai/v1', false],
  ])('attributes %s at %s for regular and streaming requests', async (id, baseUrl, attributed) => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (JSON.parse(String(init?.body)).stream) return new Response('data: [DONE]\n\n')
      return Response.json({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })
    })
    const client = createModelClient({ id, baseUrl, type: 'openai-compatible', apiKey: 'test-key', defaultModel: 'test-model' }, { fetch: fetchMock })
    const request = { messages: [{ role: 'user' as const, content: 'Hello' }] }
    await client.create(request)
    for await (const _event of client.stream(request)) { /* drain stream */ }
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [, init] of fetchMock.mock.calls) {
      const headers = new Headers(init?.headers)
      expect(headers.get('X-OpenRouter-Title')).toBe(attributed ? 'Ekko Studio' : null)
      expect(headers.get('HTTP-Referer')).toBe(attributed ? 'https://ekkostudio.xyz' : null)
      expect(headers.get('X-OpenRouter-Categories')).toBe(attributed ? 'cli-agent,personal-agent' : null)
      expect(headers.get('authorization')).toBe('Bearer test-key')
    }
  })
})
