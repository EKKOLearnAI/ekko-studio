import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NativeAcpTurn } from '../../packages/server/src/modules/coding-agents/services/native/acp-turn'
import { prepareNativeScopedRuntime } from '../../packages/server/src/modules/coding-agents/services/native/runtime-config'

// Opt-in vendor binaries, isolated homes, local mock model only; no paid calls.
describe('real native ACP image input', () => {
  for (const agentId of ['qwen', 'kimi', 'codebuddy', 'copilot'] as const) {
    const command = process.env[`${agentId.toUpperCase()}_IMAGE_TEST_CLI`]
    it.skipIf(!command)(`${agentId} forwards images and long Unicode text to its scoped model`, async () => {
      const root = await mkdtemp(join(tmpdir(), `ekko-${agentId}-image-`))
      const requests: any[] = []
      const server = createServer(async (request, response) => {
        let text = ''; for await (const chunk of request) text += chunk.toString()
        const body = JSON.parse(text || '{}')
        response.setHeader('Content-Type', 'application/json')
        if (request.url?.endsWith('/count_tokens')) { response.end(JSON.stringify({ input_tokens: 100 })); return }
        requests.push(body)
        const content = 'IMAGE_OK'
        const chat = request.url?.includes('chat/completions')
        const message = { id: 'msg-local', type: 'message', role: 'assistant', model: body.model,
          content: [{ type: 'text', text: content }], stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 3 } }
        if (!body.stream) {
          response.end(JSON.stringify(chat ? { id: 'chat-local', model: body.model,
            choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 3 } } : message))
          return
        }
        response.setHeader('Content-Type', 'text/event-stream')
        if (chat) response.end(`data: ${JSON.stringify({ id: 'chat-local', model: body.model,
          choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`)
        else {
          const events = [
            { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
            { type: 'message_stop' },
          ]
          response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
        }
      })
      let child: ChildProcess | undefined, turn: NativeAcpTurn | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let stderr = '', output = ''
      try {
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        const workspace = join(root, 'workspace'); await mkdir(workspace)
        const path = join(workspace, '图片 space.png')
        const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFElEQVQYlWP4z8CABzGMSjNgCQMAt8pjnanKDKUAAAAASUVORK5CYII=', 'base64')
        await writeFile(path, bytes)
        const runtime = await prepareNativeScopedRuntime({ agentId, rootDir: join(root, 'runtime'), model: 'claude-sonnet-4-6',
          baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, token: 'local-test-token', contextWindow: 128000, outputLimit: 8192 })
        child = spawn(command!, [...runtime.args, ...(agentId === 'kimi' ? ['acp'] : ['--acp'])], {
          cwd: workspace, env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, ...runtime.env },
          stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
        })
        child.stderr?.on('data', chunk => { stderr += chunk.toString() })
        turn = new NativeAcpTurn(child, { session: () => {}, update: update => {
          if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') output += update.content.text
        } })
        timer = setTimeout(() => {
          turn?.dispose(new Error(`Native image check timed out: ${stderr.slice(-1000)}`))
        }, 25000)
        await turn.prompt({ cwd: workspace, mcpServers: [], text: '中文😀\r\n'.repeat(8000) + '\nFINAL_IMAGE_SENTINEL',
          images: [{ path, name: '图片.png', mediaType: 'image/png' }] })
        expect(output, stderr).toContain('IMAGE_OK')
        const imageRequests = requests.filter(body => JSON.stringify(body).includes(bytes.toString('base64')))
        expect(imageRequests.length, stderr).toBeGreaterThan(0)
        expect(imageRequests.some(body => JSON.stringify(body).includes('FINAL_IMAGE_SENTINEL'))).toBe(true)
      } finally {
        clearTimeout(timer); turn?.dispose()
        if (child && child.exitCode === null && child.signalCode === null) {
          const closed = once(child, 'close').catch(() => {})
          try { process.kill(process.platform === 'win32' ? child.pid! : -child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') }
          await closed
        }
        server.closeAllConnections(); server.close()
        await rm(root, { recursive: true, force: true })
      }
    }, 35000)
  }
})
