import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import type { AgentOutputEvent } from '../../packages/studio-plugin-sdk/src'

let directory: string, codexInteractions: typeof import('../../plugins/codex/src/interactions').codexInteractions
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'codex-mcp-approval-'))
  const file = join(directory, 'approval.cjs')
  await build({ entryPoints: ['plugins/codex/src/interactions.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node24.22.1', outfile: file,
    alias: { '@ekko-studio/plugin-sdk': resolve('packages/studio-plugin-sdk/src/index.ts') }, logLevel: 'silent' })
  codexInteractions = createRequire(import.meta.url)(file).codexInteractions
})
afterAll(async () => { await rm(directory, { recursive: true, force: true }) })

const input = { serverName: 'fixture-mcp', mode: 'form', message: 'Allow this MCP tool call?', requestedSchema: { type: 'object', properties: {} } }
it.each(['accept', 'decline', 'cancel'])('returns an explicit %s for an empty native MCP confirmation', async action => {
  const events: Array<Omit<AgentOutputEvent, 'producerSequence'> & { requestId?: string }> = []
  const handler = codexInteractions(event => events.push(event)), controller = new AbortController()
  const result = handler.request('mcpServer/elicitation/request', input, controller.signal)
  expect(events).toEqual([expect.objectContaining({ type: 'interaction.requested', kind: 'approval', allowText: false,
    choices: [{ id: 'accept', label: 'Allow once' }, { id: 'decline', label: 'Decline' }],
  })])
  if (action === 'cancel') controller.abort()
  else handler.respond({ requestId: events[0].requestId!, choiceId: action })
  expect(await result).toEqual({ action, ...(action === 'accept' ? { content: {} } : {}) })
})

it.each([
  { mode: 'url', url: 'https://fixture.invalid/login' },
  { requestedSchema: { type: 'object', properties: { password: { type: 'string' } } } },
  { requestedSchema: { type: 'object', properties: {}, required: ['secret'] } },
  { requestedSchema: { type: 'object', properties: {}, allOf: [{ required: ['secret'] }] } },
  { requestedSchema: { type: 'object', properties: {}, additionalProperties: {} } },
])('rejects unsupported elicitation data before creating a persisted question: %j', async patch => {
  const events: unknown[] = [], handler = codexInteractions(event => events.push(event))
  await expect(handler.request('mcpServer/elicitation/request', { ...input, ...patch }, new AbortController().signal)).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  expect(events).toEqual([])
})
