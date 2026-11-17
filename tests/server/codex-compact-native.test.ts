import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { compactCodexThread } from '../../packages/server/src/modules/coding-agents/services/codex/compact'

// Opt in with a local Codex binary; the provider is a local deterministic fixture.
it.skipIf(!process.env.STUDIO_TEST_CODEX_BINARY)('compacts a real native thread using only an isolated home and local Responses fixture', async () => {
  const home = await mkdtemp(join(tmpdir(), 'studio-compact-native-'))
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume the request */ }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: {
      id: 'fixture', object: 'response', status: 'completed', output: [{ id: 'summary', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Local compact summary.' }] }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    } })}\n\n`)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const command = process.env.STUDIO_TEST_CODEX_BINARY!, env = { PATH: process.env.PATH, CODEX_HOME: home }
  await writeFile(join(home, 'config.toml'), `model = "fixture"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:${(server.address() as any).port}/v1"\nwire_api = "responses"\n`)
  const child = spawn(command, ['app-server', '--stdio'], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.resume()
  const lines = createInterface({ input: child.stdout })
  try {
    const threadId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('native thread setup timeout')), 5000)
      const send = (id: number | undefined, method: string, params?: unknown) => child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
      child.once('error', reject)
      let createdThreadId = ''
      lines.on('line', line => {
        const message = JSON.parse(line)
        if (message.id === 0) { send(undefined, 'initialized'); send(1, 'thread/start', { cwd: home, model: 'fixture', modelProvider: 'fixture' }) }
        if (message.id === 1) {
          if (message.error) { clearTimeout(timer); reject(new Error(message.error.message)); return }
          createdThreadId = message.result.thread.id
          send(2, 'turn/start', { threadId: createdThreadId, input: [{ type: 'text', text: 'Fixture context for compact test.' }] })
        }
        if (message.method === 'turn/completed') { clearTimeout(timer); resolve(createdThreadId) }
      })
      send(0, 'initialize', { clientInfo: { name: 'compact_fixture', version: '1' } })
    })
    const exit = once(child, 'close'); child.stdin.end(); await exit
    await expect(compactCodexThread({ command, env, workspaceDir: home }, threadId, { timeoutMs: 5000 })).resolves.toMatchObject({ compacted: true })
  } finally {
    lines.close(); if (child.exitCode == null) child.kill()
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(home, { recursive: true, force: true })
  }
}, 15000)
