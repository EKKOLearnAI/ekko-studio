import { describe, expect, it, vi } from 'vitest'
import { geminiToResponses, responsesToGemini } from '../../packages/server/src/modules/coding-agents/services/antigravity/gemini-adapter'
import { registerCodexProxyTarget, antigravityProxyGenerate } from '../../packages/server/src/modules/coding-agents/services/codex/proxy'
import { codingAgentRunManager } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'

const body = { systemInstruction: { parts: [{ text: 'rules' }] }, contents: [
  { role: 'user', parts: [{ text: 'hello' }] },
  { role: 'model', parts: [{ functionCall: { name: 'read', args: { path: 'a' } } }] },
  { role: 'user', parts: [{ functionResponse: { name: 'read', response: { output: 'contents' } } }] },
], tools: [{ functionDeclarations: [{ name: 'read', parameters: { type: 'object' } }] }] }
describe('Antigravity scoped provider bridge', () => {
  it('pairs function history and retains system/tool schema', () => {
    const out = geminiToResponses(body)
    expect(out.input).toEqual([
      { role: 'user', content: 'hello' },
      { type: 'function_call', call_id: 'agy_call_0', name: 'read', arguments: '{"path":"a"}' },
      { type: 'function_call_output', call_id: 'agy_call_0', output: '{"output":"contents"}' },
    ])
    expect(out.instructions).toBe('rules')
    expect(out.tools[0].name).toBe('read')
    expect(() => geminiToResponses({ contents: [{ parts: [{ functionResponse: { name: 'unmatched' } }] }] })).toThrow()
  })
  it('returns text and function calls without leaking upstream reasoning', () => {
    expect(responsesToGemini({ output: [{ type: 'function_call', name: 'read', arguments: '{"path":"a"}' }], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } })).toMatchObject({ candidates: [{ content: { parts: [{ functionCall: { name: 'read', args: { path: 'a' } } }] } }], usageMetadata: { totalTokenCount: 13 } })
    expect(() => responsesToGemini({ output: [{ type: 'function_call', name: 'read', arguments: '{' }] })).toThrow()
  })
  it.each(['chat_completions', 'codex_responses', 'anthropic_messages'] as const)('pins both title and main requests to the selected %s model', async apiMode => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(apiMode === 'chat_completions'
      ? { id: 'r', choices: [{ message: { content: 'external answer' } }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }
      : apiMode === 'anthropic_messages' ? { id: 'r', content: [{ type: 'text', text: 'external answer' }], usage: { input_tokens: 10, output_tokens: 3 } }
        : { id: 'r', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'external answer' }] }], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } }), { headers: { 'Content-Type': 'application/json' } }))
    const usage = vi.spyOn(codingAgentRunManager, 'handleProxyUsageEvent').mockImplementation(() => {})
    const lifecycle = vi.spyOn(codingAgentRunManager, 'handleResponseEvent')
    try {
      const imageBody = { ...body, contents: [
        ...body.contents.slice(0, -1),
        { role: 'user', parts: [{ functionResponse: { name: 'read', response: { output: 'opened image' },
          parts: [{ inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }] } }] },
      ] }
      const target = registerCodexProxyTarget({ profile: 'test', provider: 'external', model: 'chosen-model', baseUrl: 'https://example.test/v1', apiKey: 'upstream-secret', apiMode, agentId: 'antigravity', agentSessionId: 's' })
      for (const operation of ['gemini-title:streamGenerateContent', 'gemini-main:streamGenerateContent']) {
        const ctx: any = { params: { key: target.routeKey, operation }, path: '/api/codex-proxy/key/gemini/v1beta/models/'+operation,
          get: (name: string) => name === 'x-goog-api-key' ? target.token : '', request: { body: imageBody }, res: { once: vi.fn(), off: vi.fn(), writableEnded: false }, set: vi.fn() }
        await antigravityProxyGenerate(ctx)
        expect(ctx.body?.error).toBeUndefined()
        expect(ctx.status).toBeUndefined()
        const chunks: any[] = []; for await (const chunk of ctx.body) chunks.push(chunk)
        expect(chunks.join('')).toContain('external answer')
      }
      const init: any = fetch.mock.calls[0][1]
      expect(JSON.parse(init.body).model).toBe('chosen-model')
      expect(init.body).toContain('aW1hZ2U=')
      expect(init.body).toContain('opened image')
      expect(init.headers.Authorization).toBe('Bearer upstream-secret')
      expect(usage).toHaveBeenCalledTimes(2)
      expect(lifecycle).not.toHaveBeenCalled()
    } finally { vi.restoreAllMocks() }
  })
  it('rejects invalid per-run credentials before provider access', async () => {
    const target = registerCodexProxyTarget({ profile: 'test', provider: 'external', model: 'm', baseUrl: 'https://example.test/v1', apiKey: 'secret', agentId: 'antigravity' })
    const ctx: any = { params: { key: target.routeKey }, path: '/gemini/', get: () => 'wrong', request: { body } }
    await antigravityProxyGenerate(ctx)
    expect(ctx.status).toBe(401)
  })
})

describe('Antigravity scoped secret/config isolation', () => {
  it('uses a per-run proxy credential and never changes user settings', async () => {
    const { mkdtemp, mkdir, writeFile, readFile, rm, readdir } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { prepareAntigravityRuntime } = await import('../../packages/server/src/modules/coding-agents/services/antigravity/config')
    const home = await mkdtemp('/tmp/agy-scope-config-')
    try {
      await mkdir(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
      await writeFile(join(home, '.gemini', 'antigravity-cli', 'settings.json'), '{}')
      const rootDir = join(home, 'runtime')
      const prepared = await prepareAntigravityRuntime({ home, rootDir, systemPrompt: 'rules', managedMcp: {}, externalModel: { baseUrl: 'http://127.0.0.1:8648/api/codex-proxy/route/gemini', token: 'local-run-token' } })
      expect(prepared.env.GEMINI_API_KEY).toBe('local-run-token')
      expect(JSON.parse(await readFile(join(rootDir, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')).modelProvider).toBe('gemini')
      expect(await readFile(join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')).toBe('{}')
      expect(await readdir(join(rootDir, '.gemini'))).not.toContain('antigravity')
    } finally { await rm(home, { recursive: true, force: true }) }
  })
})
