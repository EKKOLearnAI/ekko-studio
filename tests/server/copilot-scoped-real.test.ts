import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import Koa from 'koa'
import { describe, expect, it, vi } from 'vitest'
import { createRequestBodyParser } from '../../packages/server/src/modules/studio/middleware/request-body-parser'
import { codexProxyRoutes } from '../../packages/server/src/modules/coding-agents/routes/codex-proxy'
import { claudeCodeProxyRoutes } from '../../packages/server/src/modules/coding-agents/routes/claude-code-proxy'
import { registerCodexProxyTarget } from '../../packages/server/src/modules/coding-agents/services/codex/proxy'
import { registerClaudeCodeProxyTarget } from '../../packages/server/src/modules/coding-agents/services/claude-code/proxy'
import { NativeAcpTurn } from '../../packages/server/src/modules/coding-agents/protocol/acp/turn'
import { nativeScopedUsesChatCompletions, prepareNativeScopedRuntime } from '../../packages/server/src/modules/coding-agents/services/registry/native-agents'

vi.mock('../../packages/server/src/modules/coding-agents/services/runtime/run-manager', () => ({ codingAgentRunManager: {
  handleProxyUsageEvent: vi.fn(), handleResponseEvent: vi.fn(),
} }))

// Opt in with COPILOT_REAL_ACP_E2E=1. Only local mock endpoints and isolated
// offline BYOK homes are used; no GitHub login or paid provider is required.
const describeReal = process.env.COPILOT_REAL_ACP_E2E === '1' ? describe : describe.skip

async function listen(app: Koa): Promise<Server> {
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  return server
}

function origin(server: Server) {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function stop(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32') child.kill('SIGKILL')
    else process.kill(-child.pid, 'SIGKILL')
  } catch { child.kill('SIGKILL') }
}

describeReal('real Copilot scoped ACP', () => {
  it.each([
    ['glm-5.3-flash', 'chat_completions'],
    ['glm-5.3-flash', 'codex_responses'],
    ['glm-5.3-flash', 'anthropic_messages'],
    ['claude-sonnet-4-6', 'anthropic_messages'],
  ] as const)('keeps %s on the selected %s upstream without token-count warnings', async (model, apiMode) => {
    const requests: Array<{ path: string; body: any }> = []
    const upstream = new Koa()
    upstream.use(createRequestBodyParser())
    upstream.use(ctx => {
      const body = ctx.request.body as any
      requests.push({ path: ctx.path, body })
      const response = { id: 'response-mock', object: 'response', status: 'completed', model: body.model,
        output: [{ id: 'message-mock', type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'SCOPED_OK', annotations: [] }] }],
        usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } }
      const chat = { id: 'chat-mock', object: 'chat.completion', model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'SCOPED_OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }
      const message = { id: 'message-mock', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: 'SCOPED_OK' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 3 } }
      if (ctx.path.endsWith('/count_tokens')) { ctx.body = { input_tokens: 10 }; return }
      if (!body.stream) {
        ctx.body = apiMode === 'chat_completions' ? chat : apiMode === 'codex_responses' ? response : message
        return
      }
      ctx.set('Content-Type', 'text/event-stream')
      if (apiMode === 'chat_completions') {
        ctx.body = Readable.from([
          `data: ${JSON.stringify({ ...chat, object: 'chat.completion.chunk', choices: [{ index: 0,
            delta: { role: 'assistant', content: 'SCOPED_OK' }, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ ...chat, object: 'chat.completion.chunk', choices: [{ index: 0,
            delta: {}, finish_reason: 'stop' }] })}\n\n`,
          'data: [DONE]\n\n',
        ])
      } else {
        const events = apiMode === 'codex_responses' ? [
          { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
          { type: 'response.output_text.delta', item_id: 'message-mock', output_index: 0, content_index: 0, delta: 'SCOPED_OK' },
          { type: 'response.completed', response },
        ] : [
          { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SCOPED_OK' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
          { type: 'message_stop' },
        ]
        ctx.body = Readable.from(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
      }
    })
    const upstreamServer = await listen(upstream)
    const proxy = new Koa()
    proxy.use(createRequestBodyParser())
    proxy.use(codexProxyRoutes.routes())
    proxy.use(claudeCodeProxyRoutes.routes())
    const proxyServer = await listen(proxy)
    const rootDir = await mkdtemp(join(tmpdir(), 'ekko-copilot-real-'))
    const workspace = join(rootDir, 'workspace')
    await mkdir(workspace)
    let child: ChildProcess | undefined
    let turn: NativeAcpTurn | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const targetInput = { profile: 'real-test', agentId: 'copilot', agentSessionId: `${model}-${apiMode}`,
        provider: 'custom:local-mock', model, apiMode, baseUrl: `${origin(upstreamServer)}/v1`, apiKey: 'mock-upstream-key' }
      const target = nativeScopedUsesChatCompletions('copilot', model)
        ? registerCodexProxyTarget(targetInput) : registerClaudeCodeProxyTarget(targetInput)
      const runtime = await prepareNativeScopedRuntime({ agentId: 'copilot', rootDir, model,
        baseUrl: origin(proxyServer) + new URL(target.baseUrl).pathname,
        token: target.token, contextWindow: 128000, outputLimit: 8192 })
      child = spawn(process.env.COPILOT_REAL_CLI || 'copilot', [...runtime.args, '--acp'], {
        cwd: workspace, env: { ...process.env, ...runtime.env }, stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })
      let stderr = ''
      let reply = ''
      child.stderr!.on('data', chunk => { stderr += chunk.toString() })
      turn = new NativeAcpTurn(child, { session: () => {}, update: update => {
        if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') reply += update.content.text
      } })
      timer = setTimeout(() => stop(child!), 30_000)
      await turn.prompt({ cwd: workspace, mcpServers: [], text: 'Reply SCOPED_OK only.' })
      expect(reply).toBe('SCOPED_OK')
      expect(stderr + reply).not.toContain('No token count multiplier')
      const inference = requests.filter(request => !request.path.endsWith('/count_tokens'))
      expect(inference.length).toBeGreaterThan(0)
      for (const request of inference) {
        expect(request.path).toBe(apiMode === 'chat_completions' ? '/v1/chat/completions'
          : apiMode === 'codex_responses' ? '/v1/responses' : '/v1/messages')
        expect(request.body.model).toBe(model)
        expect(request.body.tools.length).toBeGreaterThan(0)
      }
    } finally {
      if (timer) clearTimeout(timer)
      turn?.dispose()
      if (child) {
        const closed = new Promise<void>(resolve => child!.once('close', () => resolve()))
        stop(child)
        if (child.exitCode === null && child.signalCode === null) await closed
      }
      await Promise.all([upstreamServer, proxyServer].map(server =>
        new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))))
      await rm(rootDir, { recursive: true, force: true })
    }
  }, 40_000)
})
