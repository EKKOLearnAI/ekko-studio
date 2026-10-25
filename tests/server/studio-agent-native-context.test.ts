import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativeAgentContext, type NativeAgentContext } from '../../packages/server/src/modules/studio/services/agents/native-context'
import { runMcpCredentials } from '../../packages/server/src/modules/studio/services/auth/run-mcp-credentials'
import type { AgentInstance } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import type { ExecutionScope, AgentContextConfiguration } from '../../packages/studio-plugin-sdk/src'

let home: string
const contexts: NativeAgentContext[] = []
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'agent-bound-mcp-')); vi.stubEnv('HERMES_WEB_UI_HOME', home) })
afterEach(async () => { for (const context of contexts.splice(0)) await context.close(); vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }) })
const scope: ExecutionScope = { scopeId: 'native', principal: { kind: 'user', id: '7' }, profileId: 'one', sessionId: 'owned-chat', surface: 'chat', traceId: 'trace' }
const instance: AgentInstance = { id: 'instance', agentTypeId: 'test.native/agent', ownerId: '7', profileId: 'one', revision: 1, mode: 'global', config: {} }
const settings = { enabled: true, api: false, browser: false, devices: false, use: false }
const bind = () => ({ contextId: 'host_turn_context', sessionId: scope.sessionId!, instructions: 'Use the current task card and goals context.' })

function prepare(config: NonNullable<AgentContextConfiguration['studioMcp']> = settings, binding = bind) {
  const authorize = vi.fn(), bindTurn = vi.fn(binding)
  const context = createNativeAgentContext({ ...instance, config: { studioMcp: config } }, scope, new AbortController().signal, authorize, { bindTurn })!
  contexts.push(context)
  return { context, authorize, bindTurn }
}

it('injects interaction tools only from a host binding and uses the same context and owned chat in the credential', async () => {
  const f = prepare(), turn = await f.context.prepare('run', new AbortController().signal)
  expect(Object.keys(turn.mcpServers!)).toEqual(['ekko-studio-interaction'])
  const server = turn.mcpServers!['ekko-studio-interaction'] as { env: Record<string, string> }
  expect(server.env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', HERMES_WEB_UI_PROFILE: 'one', HERMES_MCP_RUN_BOUND_CONTEXT: '1', AUTH_TOKEN: '', HERMES_WEB_UI_TOKEN: '' })
  const file = server.env.HERMES_WEB_UI_RUN_TOKEN_FILE, credential = JSON.parse(await readFile(file, 'utf8'))
  expect(credential.context_id).toBe('host_turn_context')
  expect(runMcpCredentials.authenticate(credential.token)).toMatchObject({ runId: 'run', sessionId: 'owned-chat', contextId: 'host_turn_context', profile: 'one', userId: 7, agentId: instance.agentTypeId })
  expect(turn.turnInstructions).toContain(bind().instructions)
  expect(turn.turnInstructions).toContain('context_id="host_turn_context"')
  expect(JSON.stringify(turn)).not.toContain(credential.token)
  await f.context.end()
  expect(runMcpCredentials.authenticate(credential.token)).toBeUndefined()
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps API credentials chat-bound when interaction tools are disabled and does not allocate a task context', async () => {
  const f = prepare({ ...settings, api: true, interaction: false }), turn = await f.context.prepare('run', new AbortController().signal)
  expect(f.bindTurn).not.toHaveBeenCalled()
  expect(Object.keys(turn.mcpServers!)).toEqual(['ekko-studio-api'])
  const server = turn.mcpServers!['ekko-studio-api'] as { env: Record<string, string> }
  const credential = JSON.parse(await readFile(server.env.HERMES_WEB_UI_RUN_TOKEN_FILE, 'utf8'))
  expect(runMcpCredentials.authenticate(credential.token)?.sessionId).toBe('owned-chat')
  expect(turn.turnInstructions).not.toContain(bind().instructions)
})

it('does not fabricate task contexts for a chat when its host has no interaction adapter', async () => {
  const context = createNativeAgentContext({ ...instance, config: { studioMcp: { ...settings, api: true } } }, scope, new AbortController().signal, () => {})!
  contexts.push(context)
  const turn = await context.prepare('run', new AbortController().signal)
  expect(Object.keys(turn.mcpServers!)).toEqual(['ekko-studio-api'])
})

it('keeps background task cards enabled while withholding session goals and clarification tools', async () => {
  const f = prepare(settings, () => ({ ...bind(), interactive: false })), turn = await f.context.prepare('run', new AbortController().signal)
  const server = turn.mcpServers!['ekko-studio-interaction'] as { env: Record<string, string> }
  expect(server.env.HERMES_MCP_NATIVE_TASK_PLAN).toBeUndefined()
  expect(server.env.HERMES_MCP_SESSION_TASKS).toBe('0')
  expect(server.env.HERMES_MCP_USER_CLARIFICATION).toBe('')
})

it('rejects a binding for another chat before signing or injecting credentials', async () => {
  const f = prepare(settings, () => ({ ...bind(), sessionId: 'other-chat' }))
  await expect(f.context.prepare('run', new AbortController().signal)).rejects.toMatchObject({ code: 'FORBIDDEN' })
})

it('rechecks authorization after a suspended binding preparation', async () => {
  const gate = Promise.withResolvers<ReturnType<typeof bind>>()
  const context = createNativeAgentContext({ ...instance, config: { studioMcp: settings } }, scope, new AbortController().signal,
    () => { if (revoked) throw new Error('Owner revoked') }, { bindTurn: () => gate.promise })!
  contexts.push(context)
  let revoked = false
  const preparing = context.prepare('run', new AbortController().signal)
  const rejected = expect(preparing).rejects.toThrow('Owner revoked')
  revoked = true; gate.resolve(bind())
  await rejected
})
