import { describe, expect, it, vi } from 'vitest'
import { AnthropicMessagesModelClient } from '../../packages/ekko-agent/src/model/providers/anthropic'
import { OpenAICompatibleModelClient } from '../../packages/ekko-agent/src/model/providers/openai-compatible'
import { BUILTIN_MODEL_PROVIDER_PRESETS } from '../../packages/ekko-agent/src/model/provider-presets'
import { currentMiniMaxCatalogModels, PROVIDER_PRESETS } from '../../packages/server/src/modules/studio/contracts/providers'
import type { ModelProviderConfig, ModelRequest } from '../../packages/ekko-agent/src/model/types'

const messages: ModelRequest['messages'] = [
  { role: 'user', content: 'Read the file.' },
  { role: 'assistant', content: '', reasoning: {
    text: 'Read first.',
    native: { format: 'anthropic-thinking-blocks', data: [{ type: 'thinking', thinking: 'Read first.' }] },
  }, toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'README.md' } }] },
  { role: 'tool', content: 'File contents', toolCallId: 'call_1', name: 'read_file' },
]

function harness(protocol: 'anthropic' | 'openai', host = 'api.minimax.io') {
  const config: ModelProviderConfig = {
    id: 'minimax', type: protocol === 'anthropic' ? 'anthropic' : 'openai-compatible',
    baseUrl: `https://${host}/${protocol === 'anthropic' ? 'anthropic' : 'v1'}`,
    apiKey: 'test-key', defaultModel: 'MiniMax-M3.1-Flash',
  }
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(protocol === 'anthropic'
    ? { id: 'msg_1', model: 'MiniMax-M3.1-Flash', content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn' }
    : { id: 'chat_1', model: 'MiniMax-M3.1-Flash', choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }] }), { status: 200 }))
  const client = protocol === 'anthropic'
    ? new AnthropicMessagesModelClient(config, { fetch: fetchImpl })
    : new OpenAICompatibleModelClient(config, { fetch: fetchImpl })
  return { config, fetchImpl, client }
}

describe('MiniMax current text rollout', () => {
  it('prefers Flash for direct APIs and preserves the known OAuth model', () => {
    expect(BUILTIN_MODEL_PROVIDER_PRESETS.minimax.defaultModel).toBe('MiniMax-M3.1-Flash')
    for (const id of ['minimax', 'minimax-cn']) {
      expect(PROVIDER_PRESETS.find(p => p.value === id)?.models).toEqual(['MiniMax-M3.1-Flash', 'MiniMax-M3'])
    }
    expect(BUILTIN_MODEL_PROVIDER_PRESETS['minimax-oauth'].models).toEqual(['MiniMax-M3'])
    expect(PROVIDER_PRESETS.find(p => p.value === 'opencode-zen')?.models).toContain('minimax-m3.1-flash-free')
  })

  it('curates stale discovery while preserving unrelated media and custom endpoints', () => {
    const models = ['MiniMax-M2.7', 'MiniMax-M1', 'MiniMax-M3', 'speech-2.6-hd', 'image-01', 'MiniMax-Hailuo-2.3']
    expect(currentMiniMaxCatalogModels('minimax', 'https://api.minimax.io/anthropic/', models))
      .toEqual(['MiniMax-M3.1-Flash', 'MiniMax-M3', 'speech-2.6-hd', 'image-01', 'MiniMax-Hailuo-2.3'])
    expect(currentMiniMaxCatalogModels('custom:local', 'https://custom.test', models)).toEqual(models)
    expect(currentMiniMaxCatalogModels('minimax', 'https://custom.test', models)).toEqual(models)
    expect(currentMiniMaxCatalogModels('opencode-zen', 'https://opencode.ai/zen/v1', ['minimax-m2.5-free', 'minimax-m3.1-flash-free', 'gpt-test']))
      .toEqual(['minimax-m3.1-flash-free', 'gpt-test'])
    expect(currentMiniMaxCatalogModels('openrouter', 'https://openrouter.ai/api/v1', ['minimax/minimax-m3', 'gpt-test', 'minimax/minimax-m3.1-flash:free']))
      .toEqual(['minimax/minimax-m3.1-flash:free', 'gpt-test', 'minimax/minimax-m3'])
  })

  for (const protocol of ['anthropic', 'openai'] as const) {
    for (const host of ['api.minimax.io', 'api.minimaxi.com']) {
      it(`${protocol} serializes Flash defaults and tool history for ${host}`, async () => {
        const { client, fetchImpl, config } = harness(protocol, host)
        const response = await client.create({ messages, tools: [{ name: 'read_file', parameters: { type: 'object' } }] })
        expect(response.content).toBe('Done')
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
        expect(url).toBe(`${config.baseUrl}/${protocol === 'anthropic' ? 'v1/messages' : 'chat/completions'}`)
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-key')
        const payload = JSON.parse(String(init.body))
        expect(payload.model).toBe('MiniMax-M3.1-Flash')
        expect(payload.thinking).toEqual({ type: 'adaptive' })
        expect(payload.tools).toHaveLength(1)
        if (protocol === 'anthropic') {
          expect(payload.output_config).toEqual({ effort: 'max' })
          expect(payload).not.toHaveProperty('reasoning_effort')
          expect(payload.messages[1].content).toEqual(expect.arrayContaining([
            { type: 'thinking', thinking: 'Read first.' },
            { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'README.md' } },
          ]))
          expect(payload.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1' })
        } else {
          expect(payload.reasoning_effort).toBe('max')
          expect(payload).not.toHaveProperty('output_config')
          expect(payload.messages[1]).toMatchObject({ reasoning_content: 'Read first.', tool_calls: [{ id: 'call_1' }] })
          expect(payload.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' })
        }
      })
    }
    it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)(`${protocol} sends explicit Flash effort %s`, async effort => {
      const { client, fetchImpl } = harness(protocol)
      await client.create({ messages: [{ role: 'user', content: 'Hi' }], reasoningEffort: effort })
      const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
      const payload = JSON.parse(String(init.body))
      expect(protocol === 'anthropic' ? payload.output_config.effort : payload.reasoning_effort).toBe(effort)
    })
    it(`${protocol} serializes the same Flash controls for streaming with image input`, async () => {
      const { client, fetchImpl } = harness(protocol)
      const event = protocol === 'anthropic'
        ? { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done' } }
        : { choices: [{ delta: { content: 'Done' } }] }
      fetchImpl.mockResolvedValue(new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      }))
      const events = []
      for await (const event of client.stream({ messages: [{ role: 'user', content: 'Describe', contentParts: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }] }] })) events.push(event)
      expect(events).toContainEqual({ type: 'text-delta', text: 'Done' })
      const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
      const payload = JSON.parse(String(init.body))
      expect(payload.stream).toBe(true)
      expect(payload.thinking).toEqual({ type: 'adaptive' })
      expect(payload.messages[0].content).toEqual(expect.arrayContaining([
        protocol === 'anthropic'
          ? { type: 'image', source: { type: 'base64', data: 'aW1hZ2U=', media_type: 'image/png' } }
          : expect.objectContaining({ type: 'image_url' }),
      ]))
    })
    it.each(['none', 'minimal'] as const)(`${protocol} rejects unsupported Flash effort %s before transport`, async effort => {
      const { client, fetchImpl } = harness(protocol)
      await expect(client.create({ messages: [], reasoningEffort: effort })).rejects.toThrow('requires reasoning effort')
      expect(fetchImpl).not.toHaveBeenCalled()
    })
    it.each(['none', 'high'] as const)(`${protocol} maps M3 thinking %s without depth tuning`, async effort => {
      const { client, fetchImpl } = harness(protocol)
      await client.create({ model: 'MiniMax-M3', messages: [], reasoningEffort: effort })
      const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
      const payload = JSON.parse(String(init.body))
      expect(payload.thinking.type).toBe(effort === 'none' ? 'disabled' : 'adaptive')
      expect(payload).not.toHaveProperty('reasoning_effort')
      expect(payload).not.toHaveProperty('output_config')
    })
    it(`${protocol} preserves saved legacy IDs and M3 defaults`, async () => {
      for (const model of ['MiniMax-M2.7-highspeed', 'MiniMax-M3', 'my-custom-model']) {
        const { client, fetchImpl } = harness(protocol)
        await client.create({ model, messages: [{ role: 'user', content: 'Hi' }] })
        const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
        const payload = JSON.parse(String(init.body))
        expect(payload.model).toBe(model)
        expect(payload).not.toHaveProperty('thinking')
        expect(payload).not.toHaveProperty('reasoning_effort')
        expect(payload).not.toHaveProperty('output_config')
      }
    })
    it(`${protocol} keeps custom hosts free of direct-only fields`, async () => {
      const { client, fetchImpl } = harness(protocol, 'gateway.example')
      await client.create({ messages: [], reasoningEffort: 'high' })
      const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
      expect(JSON.parse(String(init.body))).not.toHaveProperty('thinking')
    })
  }
})
