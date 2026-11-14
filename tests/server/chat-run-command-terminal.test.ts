import { afterEach, expect, it, vi } from 'vitest'
import Koa from 'koa'
import { bodyParser } from '@koa/bodyparser'
import { once } from 'node:events'
import { Server } from 'socket.io'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { port: 1 } }))
vi.mock('../../packages/server/src/modules/studio/public/chat-run', () => ({ getChatRunServer: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/contracts/runs/model-execution-identity', () => ({ resolveModelExecutionIdentity: async () => ({ provider: 'test', model: 'test' }) }))
vi.mock('../../packages/server/src/modules/studio/services/session-shares/access', () => ({ prepareSessionShareRun: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/sessions/control', () => ({ prepareSessionRun: (_user: unknown, _profile: string, body: unknown) => body }))
vi.mock('../../packages/server/src/modules/studio/services/agents/registry', () => ({ isPluginAgentId: () => false, pluginAgentIsGlobalOnly: () => false }))
import { runOnce } from '../../packages/server/src/modules/studio/controllers/chat-run'

afterEach(() => vi.unstubAllEnvs())

async function run(input: string, events: Array<[string, Record<string, unknown>]>, timeout = 200, mcp = false): Promise<any> {
  const app = new Koa()
  app.use(bodyParser())
  app.use(runOnce)
  const http = app.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const base = `http://127.0.0.1:${(http.address() as any).port}`
  vi.stubEnv('HERMES_WEB_UI_URL', base)
  const io = new Server(http)
  io.of('/chat-run').on('connection', socket => socket.on('run', () => {
    for (const [name, payload] of events) socket.emit(name, { session_id: 'compact-session', ...payload })
  }))
  try {
    if (mcp) {
      const client = new Client({ name: 'compact-terminal-test', version: '1' })
      try {
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('bin/ekko-studio-mcp.mjs'), 'use'], env: {
          PATH: process.env.PATH || '', HERMES_WEB_UI_URL: base, HERMES_WEB_UI_PROFILE: 'default', HERMES_WEB_UI_TOKEN: 'fixture-only',
        } }))
        return await client.callTool({ name: 'ekko_studio_use_chat_run', arguments: { input, session_id: 'compact-session', source: 'coding_agent', coding_agent_id: 'codex', timeout_ms: timeout } })
      } finally { await client.close() }
    }
    const response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, session_id: 'compact-session', source: 'coding_agent', coding_agent_id: 'codex', timeout_ms: timeout, include_events: true }) })
    return { status: response.status, body: await response.json() }
  } finally {
    await new Promise<void>(resolve => io.close(() => resolve()))
    http.closeAllConnections()
    http.close()
  }
}

it('finishes a successful native command instead of waiting for an unrelated run.completed', async () => {
  const result = await run('/compact', [
    ['session.command', { command: 'compact', terminal: false, started: true, message: 'Native /compact sent to Codex.' }],
    ['session.command', { command: 'compact', terminal: true, compacted: true, ok: true, message: 'Compaction completed.' }],
  ])
  expect(result).toMatchObject({ status: 200, body: { ok: true, status: 'completed', event: 'session.command', output: 'Compaction completed.' } })
  expect(result.body.events).toHaveLength(2)
})

it('returns the native command failure as a structured error', async () => {
  expect(await run('/compact', [['session.command', { command: 'compact', terminal: true, ok: false, message: 'Compaction failed: provider unavailable' }]]))
    .toMatchObject({ status: 500, body: { ok: false, status: 'failed', event: 'session.command', error: 'Compaction failed: provider unavailable' } })
})

it('ignores progress and terminal events for another command or session', async () => {
  expect(await run('/compact', [
    ['session.command', { command: 'compact', terminal: false, started: true }],
    ['session.command', { command: 'status', terminal: true, ok: true }],
    ['session.command', { session_id: 'other-session', command: 'compact', terminal: true, ok: true }],
  ])).toMatchObject({ status: 504, body: { status: 'timeout' } })
})

it('does not mistake incidental command events for the completion of ordinary input', async () => {
  expect(await run('hello', [
    ['session.command', { command: 'status', terminal: true, ok: true }],
    ['run.completed', { output: 'Hello!' }],
  ])).toMatchObject({ status: 200, body: { status: 'completed', output: 'Hello!' } })
})

it('returns a busy rejection without pretending the active turn has terminated', async () => {
  expect(await run('/compact', [['session.command', { command: 'compact', terminal: false, ok: false, message: 'Codex is still processing the previous input' }]]))
    .toMatchObject({ status: 500, body: { status: 'failed', error: 'Codex is still processing the previous input' } })
})

it('delivers command completion through the real MCP stdio → HTTP → Socket.IO chain', async () => {
  const result = await run('/compact', [['session.command', { command: 'compact', terminal: true, ok: true, message: 'Compaction completed.' }]], 1000, true)
  expect(result.isError).not.toBe(true)
  expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: true, status: 'completed', output: 'Compaction completed.' })
})

it('returns cancellation without waiting for a late native command result', async () => {
  expect(await run('/compact', [['abort.completed', {}]])).toMatchObject({ status: 409, body: { ok: false, error: 'Session command interrupted' } })
})
