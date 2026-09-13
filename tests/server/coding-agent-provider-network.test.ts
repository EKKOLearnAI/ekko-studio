import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  codexProxyResponses,
  registerCodexProxyTarget,
} from '../../packages/server/src/modules/coding-agents/services/codex/proxy'
import {
  claudeProxyMessages,
  registerClaudeCodeProxyTarget,
} from '../../packages/server/src/modules/coding-agents/services/claude-code/proxy'
import * as network from '../../packages/server/src/modules/studio/public/provider-network'

function context(target: { routeKey: string; token: string }, stream = false, userAgent = 'live-client/1.0'): any {
  const incoming = new Headers({
    authorization: `Bearer ${target.token}`,
    'user-agent': userAgent,
    originator: 'codex_cli',
    'x-app': 'cli',
    'anthropic-beta': 'test-beta',
    'x-stainless-runtime-version': 'current-runtime',
    'x-codex-turn-metadata': 'current-turn',
    cookie: 'private-cookie',
    'x-unrelated-private-header': 'private-value',
  })
  return {
    params: { key: target.routeKey },
    request: {
      body: { model: 'model', input: 'hello', messages: [{ role: 'user', content: 'hello' }], max_tokens: 16, stream },
    },
    req: new EventEmitter(),
    res: Object.assign(new EventEmitter(), { writableEnded: false }),
    get: (name: string) => incoming.get(name) || '',
    set: vi.fn(),
  }
}

function response(stream = false): Response {
  if (stream) {
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    })
  }
  return new Response(JSON.stringify({
    id: 'test', type: 'message', role: 'assistant', model: 'model',
    content: [{ type: 'text', text: 'ok' }], output: [],
    choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  }), { headers: { 'content-type': 'application/json' } })
}

afterEach(() => vi.restoreAllMocks())

describe('coding agent provider network options', () => {
  for (const agentId of ['codex', 'claude-code'] as const) {
    const register = agentId === 'codex' ? registerCodexProxyTarget : registerClaudeCodeProxyTarget
    const handle = agentId === 'codex' ? codexProxyResponses : claudeProxyMessages

    it.each(['chat_completions', 'codex_responses', 'anthropic_messages'] as const)(
      `${agentId} applies configured headers and proxy to %s JSON and streaming calls`,
      async apiMode => {
        const fetch = vi.spyOn(network, 'fetchProvider')
        const target = register({
          profile: 'default', provider: 'custom:network', model: 'model',
          baseUrl: 'https://provider.example/v1', apiKey: 'upstream-key', apiMode, agentId,
          preserveClientIdentity: true,
          extraHeaders: { 'User-Agent': 'configured-client', 'X-Custom': 'configured-value' },
          proxyUrl: 'http://user:proxy-password@proxy.example:8080',
        })
        expect(Buffer.from(target.routeKey, 'base64url').toString()).not.toContain('proxy-password')
        for (const stream of [false, true]) {
          fetch.mockResolvedValueOnce(response(stream))
          const ctx = context(target, stream)
          await handle(ctx)
          expect(ctx.status).not.toBe(502)
          const [, init, proxyUrl] = fetch.mock.calls.at(-1)!
          const headers = new Headers(init!.headers)
          expect(headers.get('user-agent')).toBe('configured-client')
          expect(headers.get('x-custom')).toBe('configured-value')
          expect(headers.get('authorization')).toBe('Bearer upstream-key')
          expect(headers.has('cookie')).toBe(false)
          expect(headers.has('x-unrelated-private-header')).toBe(false)
          expect(proxyUrl).toBe('http://user:proxy-password@proxy.example:8080')
          expect(init!.signal).toBeInstanceOf(AbortSignal)
          if (apiMode === 'anthropic_messages') expect(headers.get('x-api-key')).toBe('upstream-key')
          if (stream) {
            for await (const _chunk of ctx.body) { /* Consume the proxy stream. */ }
          }
          ctx.res.writableEnded = true
          ctx.res.emit('finish')
          expect(ctx.req.listenerCount('aborted')).toBe(0)
          expect(ctx.res.listenerCount('close')).toBe(0)
        }
      },
    )

    it(`${agentId} forwards only its current client identity when enabled`, async () => {
      const fetch = vi.spyOn(network, 'fetchProvider').mockImplementation(async () => response())
      const target = register({
        profile: 'default', provider: 'custom:identity', model: 'model',
        baseUrl: 'https://provider.example/v1', apiKey: 'upstream-key', apiMode: 'codex_responses',
        agentId, preserveClientIdentity: true,
      })
      for (const userAgent of ['live-client/1.0', 'live-client/2.0']) {
        const ctx = context(target, false, userAgent)
        await handle(ctx)
        const headers = new Headers(fetch.mock.calls.at(-1)![1]!.headers)
        expect(headers.get('user-agent')).toBe(userAgent)
        expect(headers.get(agentId === 'codex' ? 'originator' : 'x-app')).toBe(agentId === 'codex' ? 'codex_cli' : 'cli')
        expect(headers.has(agentId === 'codex' ? 'x-app' : 'originator')).toBe(false)
        ctx.res.writableEnded = true
        ctx.res.emit('finish')
      }
    })

    it.each([undefined, false])(`${agentId} does not forward identity with preserveClientIdentity=%s`, async preserveClientIdentity => {
      const fetch = vi.spyOn(network, 'fetchProvider').mockResolvedValue(response())
      const target = register({
        profile: 'default', provider: 'custom:disabled', model: 'model',
        baseUrl: 'https://provider.example/v1', apiKey: 'upstream-key', apiMode: 'codex_responses',
        agentId, preserveClientIdentity,
      })
      const ctx = context(target)
      await handle(ctx)
      expect(new Headers(fetch.mock.calls[0][1]!.headers).has('user-agent')).toBe(false)
      ctx.res.emit('close')
    })

    it.each(['request', 'response'])(`${agentId} cancels upstream work when the %s disconnects`, async side => {
      const fetch = vi.spyOn(network, 'fetchProvider').mockResolvedValue(response())
      const target = register({
        profile: 'default', provider: 'custom:cancel', model: 'model',
        baseUrl: 'https://provider.example/v1', apiKey: 'upstream-key', apiMode: 'codex_responses', agentId,
      })
      const ctx = context(target)
      await handle(ctx)
      const signal = fetch.mock.calls[0][1]!.signal
      expect(signal?.aborted).toBe(false)
      if (side === 'request') ctx.req.emit('aborted')
      else ctx.res.emit('close')
      expect(signal?.aborted).toBe(true)
      expect(ctx.req.listenerCount('aborted')).toBe(0)
    })

    it(`${agentId} does not cancel on a completed request body or a normal response finish`, async () => {
      const fetch = vi.spyOn(network, 'fetchProvider').mockResolvedValue(response())
      const target = register({
        profile: 'default', provider: 'custom:finish', model: 'model',
        baseUrl: 'https://provider.example/v1', apiKey: 'upstream-key', apiMode: 'codex_responses', agentId,
      })
      const ctx = context(target)
      await handle(ctx)
      const signal = fetch.mock.calls[0][1]!.signal
      ctx.req.emit('close')
      expect(signal?.aborted).toBe(false)
      ctx.res.writableEnded = true
      ctx.res.emit('finish')
      ctx.res.emit('close')
      expect(signal?.aborted).toBe(false)
      expect(ctx.req.listenerCount('aborted')).toBe(0)
      expect(ctx.res.listenerCount('close')).toBe(0)
    })

    it(`${agentId} rejects unsafe saved extra headers before sending a request`, () => {
      expect(() => register({
        profile: 'default', provider: 'custom:unsafe', model: 'model',
        baseUrl: 'https://provider.example/v1', apiKey: 'upstream-key', agentId,
        extraHeaders: { Authorization: 'incorrect-key' },
      })).toThrow(/authentication|transport/)
    })
  }

  it.each(['pi', 'grok', 'opencode', 'dsh'])('does not disguise %s as a Codex client', async agentId => {
    const fetch = vi.spyOn(network, 'fetchProvider').mockResolvedValue(response())
    const target = registerCodexProxyTarget({
      profile: 'default', provider: 'custom:other-agent', model: 'model',
      baseUrl: 'https://provider.example/v1', apiKey: 'upstream-key', apiMode: 'codex_responses',
      agentId, preserveClientIdentity: true,
    })
    const ctx = context(target)
    await codexProxyResponses(ctx)
    expect(new Headers(fetch.mock.calls[0][1]!.headers).has('originator')).toBe(false)
    ctx.res.emit('close')
  })
})
