import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
    ['glm-5.3-flash', 'chat_completions', false],
    ['glm-5.3-flash', 'codex_responses', false],
    ['glm-5.3-flash', 'anthropic_messages', false],
    ['claude-sonnet-4-6', 'anthropic_messages', false],
    ['gpt-5.6-sol', 'codex_responses', true],
  ] as const)('executes a command with %s on the selected %s upstream (image: %s)', async (model, apiMode, withImage) => {
    const requests: Array<{ path: string; body: any }> = []
    const toolInput = { command: 'printf SCOPED_TOOL_OK', description: 'Print verification marker', initial_wait: 1 }
    const toolArguments = JSON.stringify(toolInput)
    const patchInput = '*** Begin Patch\n*** Add File: SCOPED_TOOL_OK.txt\n+IMAGE_CUSTOM_OK\n*** End Patch'
    let inferenceCount = 0
    const upstream = new Koa()
    upstream.use(createRequestBodyParser())
    upstream.use(ctx => {
      const body = ctx.request.body as any
      requests.push({ path: ctx.path, body })
      if (ctx.path.endsWith('/count_tokens')) { ctx.body = { input_tokens: 10 }; return }
      const callTool = inferenceCount++ === 0
      const call = withImage
        ? { id: 'tool-mock', type: 'custom_tool_call', call_id: 'call-patch', name: 'apply_patch', input: patchInput, status: 'completed' }
        : { id: 'tool-mock', type: 'function_call', call_id: 'call-bash', name: 'bash', arguments: toolArguments, status: 'completed' }
      const response = { id: 'response-mock', object: 'response', status: 'completed', model: body.model,
        output: callTool ? [call] : [{ id: 'message-mock', type: 'message', role: 'assistant',
          status: 'completed', content: [{ type: 'output_text', text: 'SCOPED_OK', annotations: [] }] }],
        usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } }
      const chat = { id: 'chat-mock', object: 'chat.completion', model: body.model,
        choices: [{ index: 0, message: callTool ? { role: 'assistant', content: null,
          tool_calls: [{ id: 'call-bash', type: 'function', function: { name: 'bash', arguments: toolArguments } }] }
          : { role: 'assistant', content: 'SCOPED_OK' }, finish_reason: callTool ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }
      const message = { id: 'message-mock', type: 'message', role: 'assistant', model: body.model,
        content: callTool ? [{ type: 'tool_use', id: 'call-bash', name: 'bash', input: toolInput }]
          : [{ type: 'text', text: 'SCOPED_OK' }], stop_reason: callTool ? 'tool_use' : 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 3 } }
      if (!body.stream) {
        ctx.body = apiMode === 'chat_completions' ? chat : apiMode === 'codex_responses' ? response : message
        return
      }
      ctx.set('Content-Type', 'text/event-stream')
      if (apiMode === 'chat_completions') {
        const deltas = callTool ? [
          { tool_calls: [{ index: 0, id: 'call-bash', type: 'function', function: { name: 'bash', arguments: toolArguments.slice(0, 2) } }] },
          { tool_calls: [{ index: 0, function: { arguments: toolArguments.slice(2) } }] },
        ] : [{ role: 'assistant', content: 'SCOPED_OK' }]
        ctx.body = Readable.from([
          ...deltas.map(delta =>
            `data: ${JSON.stringify({ ...chat, object: 'chat.completion.chunk', choices: [{ index: 0,
              delta, finish_reason: null }] })}\n\n`),
          `data: ${JSON.stringify({ ...chat, object: 'chat.completion.chunk', choices: [{ index: 0,
            delta: {}, finish_reason: callTool ? 'tool_calls' : 'stop' }] })}\n\n`,
          'data: [DONE]\n\n',
        ])
      } else {
        const events = apiMode === 'codex_responses' ? [
          { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
          ...(callTool ? [
            { type: 'response.output_item.added', output_index: 0,
              item: { ...response.output[0], ...(withImage ? { input: '' } : { arguments: '' }), status: 'in_progress' } },
            { type: withImage ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta',
              item_id: 'tool-mock', output_index: 0, delta: (withImage ? patchInput : toolArguments).slice(0, 2) },
            { type: withImage ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta',
              item_id: 'tool-mock', output_index: 0, delta: (withImage ? patchInput : toolArguments).slice(2) },
            { type: 'response.output_item.done', output_index: 0, item: response.output[0] },
          ] : [{ type: 'response.output_text.delta', item_id: 'message-mock', output_index: 0, content_index: 0, delta: 'SCOPED_OK' }]),
          { type: 'response.completed', response },
        ] : [
          { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
          ...(callTool ? [
            { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-bash', name: 'bash', input: {} } },
            { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: toolArguments.slice(0, 2) } },
            { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: toolArguments.slice(2) } },
          ] : [
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SCOPED_OK' } },
          ]),
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: callTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
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
    const imagePath = join(workspace, 'image space.png')
    const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFElEQVQYlWP4z8CABzGMSjNgCQMAt8pjnanKDKUAAAAASUVORK5CYII=', 'base64')
    if (withImage) await writeFile(imagePath, imageBytes)
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
      const toolUpdates: any[] = []
      child.stderr!.on('data', chunk => { stderr += chunk.toString() })
      turn = new NativeAcpTurn(child, { session: () => {}, update: update => {
        if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') reply += update.content.text
        if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') toolUpdates.push(update)
      } })
      timer = setTimeout(() => stop(child!), 30_000)
      await turn.prompt({ cwd: workspace, mcpServers: [], text: 'Run printf SCOPED_TOOL_OK, then reply SCOPED_OK only.',
        ...(withImage ? { images: [{ path: imagePath, mediaType: 'image/png' }] } : {}) })
      expect(reply).toBe('SCOPED_OK')
      expect(toolUpdates.some(update => update.status === 'completed'
        && JSON.stringify(update.rawOutput ?? update.content).includes('SCOPED_TOOL_OK'))).toBe(true)
      expect(toolUpdates.some(update => update.status === 'failed')).toBe(false)
      expect(stderr + reply).not.toContain('No token count multiplier')
      const inference = requests.filter(request => !request.path.endsWith('/count_tokens'))
      expect(inference.length).toBe(2)
      if (withImage) {
        const image = inference[0].body.input.flatMap((item: any) => Array.isArray(item.content) ? item.content : [])
          .find((part: any) => part.type === 'input_image')
        expect(image.image_url).toBe(`data:image/png;base64,${imageBytes.toString('base64')}`)
        const custom = inference[0].body.tools.find((tool: any) => tool.type === 'custom' && tool.name === 'apply_patch')
        expect(custom.format).toMatchObject({ type: 'grammar', syntax: 'lark', definition: expect.any(String) })
        expect(custom.format).not.toHaveProperty('grammar')
        expect(await readFile(join(workspace, 'SCOPED_TOOL_OK.txt'), 'utf8')).toBe('IMAGE_CUSTOM_OK\n')
        expect(inference[1].body.input.find((item: any) => item.type === 'custom_tool_call')).toMatchObject({
          name: 'apply_patch', input: patchInput, call_id: 'call-patch',
        })
      }
      const toolResult = apiMode === 'codex_responses'
        ? inference[1].body.input.find((item: any) => item.type === (withImage ? 'custom_tool_call_output' : 'function_call_output'))?.output
        : apiMode === 'chat_completions'
          ? inference[1].body.messages.find((item: any) => item.role === 'tool')?.content
          : inference[1].body.messages.flatMap((item: any) => Array.isArray(item.content) ? item.content : [])
            .find((item: any) => item.type === 'tool_result')?.content
      expect(JSON.stringify(toolResult)).toContain('SCOPED_TOOL_OK')
      expect(JSON.stringify(toolResult)).not.toContain('Unexpected non-whitespace')
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
