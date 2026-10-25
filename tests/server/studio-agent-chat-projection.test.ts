import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import { AgentChatProjection } from '../../packages/server/src/modules/studio/repositories/agent-chat-projection'
import { PluginEventStore } from '../../packages/server/src/modules/studio/repositories/plugin-event-store'
import type { AgentOutputEvent, AgentProviderRef } from '../../packages/studio-plugin-sdk/src'
import { agentChatArtifactPath } from '../../packages/shared/agent-chat-artifact'
import { SKILL_USAGE_EVENTS_SCHEMA, SKILL_USAGE_EVENTS_INDEXES } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })
const provider: AgentProviderRef = { kind: 'plugin', pluginId: 'test.chat', version: '1.0.0', generation: 'first' }
const input = { content: [{ type: 'text' as const, text: 'hello' }] }

function setup() {
  const db = new DatabaseSync(':memory:')
  cleanup.push(() => db.close())
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, profile TEXT NOT NULL, studio_user_id TEXT, source TEXT NOT NULL,
    agent TEXT NOT NULL DEFAULT 'test.chat/agent', agent_native_session_id TEXT NOT NULL DEFAULT '',
    message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0, last_active INTEGER DEFAULT 0, ended_at INTEGER, end_reason TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
    reasoning TEXT, tool_calls TEXT, tool_call_id TEXT, tool_name TEXT, run_marker TEXT, timestamp INTEGER, finish_reason TEXT);`)
  for (const id of ['a', 'b', 'old']) db.prepare("INSERT INTO sessions (id, profile, studio_user_id, source) VALUES (?, 'one', '7', 'coding_agent')").run(id)
  db.exec(`CREATE TABLE skill_usage_events (${Object.entries(SKILL_USAGE_EVENTS_SCHEMA).map(([name, sql]) => `${name} ${sql}`).join(', ')})`)
  for (const sql of Object.values(SKILL_USAGE_EVENTS_INDEXES)) db.exec(sql)
  const projection = new AgentChatProjection(db), store = new AgentExecutionStore(db, projection)
  const instance = store.createInstance({ agentTypeId: 'test.chat/agent', profileId: 'one', ownerId: '7', mode: 'global', config: {} })
  projection.attach('a', instance); projection.attach('b', instance)
  const accept = (sessionId: string, key: string) => store.accept(instance, provider, input, key, undefined, { kind: 'chat', sessionId }).run
  const start = (sessionId: string, key: string) => { const run = accept(sessionId, key); store.transition(run.id, ['accepted'], 'running'); return run }
  const messages = (sessionId: string) => db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY id').all(sessionId)
  const session = (sessionId: string) => db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId)!
  return { db, store, projection, instance, accept, start, messages, session }
}

it('writes one user message and updates the same assistant rows across deltas, snapshots, reasoning and retry', () => {
  const f = setup(), run = f.start('a', 'request')
  expect(f.accept('a', 'request').id).toBe(run.id)
  expect(f.messages('a')).toMatchObject([{ role: 'user', content: 'hello', run_marker: run.id }])
  const output: AgentOutputEvent[] = [
    { type: 'reasoning.delta', producerSequence: 0, messageId: 'm', text: 'Think ' },
    { type: 'message.delta', producerSequence: 1, messageId: 'm', text: 'hel' },
    { type: 'message.delta', producerSequence: 2, messageId: 'm', text: 'lo' },
    { type: 'reasoning.delta', producerSequence: 3, messageId: 'm', text: 'carefully' },
    { type: 'message.snapshot', producerSequence: 4, messageId: 'm', text: 'final text' },
  ]
  for (const event of output) f.store.appendOutput(run.id, event)
  expect(f.messages('a')).toMatchObject([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'final text', reasoning: 'Think carefully', run_marker: run.id }])
  expect(f.session('a').message_count).toBe(2)
  expect(f.store.output(run.id)).toHaveLength(5)
  expect(() => f.store.appendOutput(run.id, output[4])).toThrow()
  expect(f.messages('a')).toHaveLength(2)
})

it('keeps image references renderable in historical rows without copying bytes or changing admission input', () => {
  const f = setup(), artifactId = 'ab012345-6789-0123-4567-0123456789ab'
  const input = { content: [{ type: 'text' as const, text: 'Describe' }, { type: 'image' as const, artifactId, mediaType: 'image/png' }] }
  const { run } = f.store.accept(f.instance, provider, input, 'image-request', undefined, { kind: 'chat', sessionId: 'a' })
  f.store.transition(run.id, ['accepted'], 'running')
  expect(JSON.parse(String(f.messages('a')[0].content))).toEqual([
    { type: 'text', text: 'Describe' }, { type: 'image', path: agentChatArtifactPath('a', artifactId), media_type: 'image/png', name: 'image.png' },
  ])
  expect(f.store.originalInput(run.id)).toEqual(input)
  expect(f.store.accept(f.instance, provider, input, 'image-request', undefined, { kind: 'chat', sessionId: 'a' }).created).toBe(false)
  expect(f.messages('a')).toHaveLength(1)
})

it('bounds SDK text reads and replaces a truncated snapshot instead of retaining stale receipt text', () => {
  const f = setup(), run = f.start('a', 'request')
  f.store.appendOutput(run.id, { type: 'message.snapshot', producerSequence: 0, messageId: 'm', text: 'x'.repeat(70_000) })
  const first = f.projection.text(run.id)
  expect(first.output).toHaveLength(65_536)
  expect(first.truncated).toBe(true)
  f.store.appendOutput(run.id, { type: 'message.snapshot', producerSequence: 1, messageId: 'm', text: 'Short correction' })
  expect(f.projection.text(run.id)).toEqual({ output: 'Short correction', reasoning: '', truncated: false, producerSequence: 1 })
})

it('projects existing tool-call/result fields, preserves unknown usage, and finishes once without another history write', () => {
  const f = setup(), run = f.start('a', 'request')
  f.store.appendOutput(run.id, { type: 'tool.started', producerSequence: 0, callId: 'call', name: 'search', data: { query: 'fixture' } })
  f.store.appendOutput(run.id, { type: 'tool.completed', producerSequence: 1, callId: 'call', name: 'search', data: { answer: 'found' } })
  expect(f.messages('a')).toMatchObject([{ role: 'user' }, { role: 'assistant' }, { role: 'tool', tool_call_id: 'call', tool_name: 'search', content: '{"answer":"found"}' }])
  expect(JSON.parse(String(f.messages('a')[1].tool_calls))).toEqual([{ id: 'call', type: 'function', function: { name: 'search', arguments: '{"query":"fixture"}' } }])
  expect(f.session('a')).toMatchObject({ message_count: 3, tool_call_count: 1 })
  expect(f.store.state.usage(run.id)).toEqual([])
  f.store.finish(run.id, 'completed', null, { native: 'native-session' })
  expect(f.store.finish(run.id, 'completed', null)).toEqual([])
  expect(f.messages('a')).toHaveLength(3)
  expect(f.session('a')).toMatchObject({ end_reason: 'completed', ended_at: expect.any(Number) })
  expect(new PluginEventStore(f.db).read('one')).toHaveLength(1)
})

it('reuses evidence-backed skill tracking once for the projected tool result and canonical Run', () => {
  const f = setup(), run = f.start('a', 'request')
  f.store.appendOutput(run.id, { type: 'tool.started', producerSequence: 0, callId: 'skill', name: 'skill_view', data: { name: 'fixture-skill' } })
  for (const sequence of [1, 2]) f.store.appendOutput(run.id, { type: 'tool.completed', producerSequence: sequence, callId: 'skill', name: 'skill_view', data: 'The skill instructions' })
  expect(f.db.prepare('SELECT * FROM skill_usage_events').all()).toMatchObject([{ session_id: 'a', run_id: run.id, profile: 'one', agent: 'test.chat/agent', skill: 'fixture-skill', action: 'view' }])
  expect(f.messages('a')).toHaveLength(3)
})

it('leaves independent executions and the legacy chat writer outside this projection', () => {
  const f = setup(), run = f.store.accept(f.instance, provider, input, 'independent').run
  f.store.transition(run.id, ['accepted'], 'running')
  f.store.appendOutput(run.id, { type: 'message.delta', producerSequence: 0, messageId: 'm', text: 'Independent response' })
  f.store.finish(run.id, 'completed', null)
  expect(f.store.output(run.id)).toHaveLength(1)
  expect(f.messages('a')).toEqual([])
  expect(f.messages('b')).toEqual([])
})

it('keeps equal native message and tool identities separate between chats and Runs', () => {
  const f = setup(), a = f.start('a', 'a1'), b = f.start('b', 'b1')
  for (const [run, text] of [[a, 'private a'], [b, 'private b']] as const) {
    f.store.appendOutput(run.id, { type: 'message.snapshot', producerSequence: 0, messageId: 'same-native-id', text })
  }
  const again = f.start('a', 'a2')
  f.store.appendOutput(again.id, { type: 'message.snapshot', producerSequence: 0, messageId: 'same-native-id', text: 'next a' })
  expect(f.messages('a').map(row => row.content)).toEqual(['hello', 'private a', 'hello', 'next a'])
  expect(f.messages('b').map(row => row.content)).toEqual(['hello', 'private b'])
  expect(new Set([...f.messages('a'), ...f.messages('b')].map(row => row.id)).size).toBe(6)
})

it('rolls back both the canonical output and transcript when a history write fails', () => {
  const f = setup(), run = f.start('a', 'request')
  f.db.exec("CREATE TRIGGER fail_message BEFORE UPDATE OF content ON messages WHEN NEW.content='write failure' BEGIN SELECT RAISE(ABORT, 'fixture transcript failure'); END")
  expect(() => f.store.appendOutput(run.id, { type: 'message.delta', producerSequence: 0, messageId: 'm', text: 'write failure' })).toThrow('fixture transcript failure')
  expect(f.store.output(run.id)).toEqual([])
  expect(f.messages('a')).toHaveLength(1)
  expect(f.db.prepare('SELECT count(*) AS count FROM studio_agent_chat_messages').get()?.count).toBe(1)
  f.store.finish(run.id, 'failed', 'INTERNAL')
  expect(f.store.get(run.id)?.status).toBe('failed')
  expect(f.session('a').message_count).toBe(1)
})

it('rejects old history and mismatched bindings before accepting a Run or user message', () => {
  const f = setup()
  f.db.prepare("INSERT INTO messages (session_id, role, content) VALUES ('old', 'assistant', 'existing history')").run()
  expect(() => f.projection.attach('old', f.instance)).toThrow(expect.objectContaining({ code: 'CAPABILITY_UNSUPPORTED' }))
  expect(() => f.accept('old', 'request')).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  expect(f.db.prepare('SELECT count(*) AS count FROM studio_agent_runs').get()?.count).toBe(0)
  expect(f.db.prepare('SELECT count(*) AS count FROM studio_agent_conversations').get()?.count).toBe(0)
  expect(f.messages('old')).toMatchObject([{ role: 'assistant', content: 'existing history' }])
  const other = f.store.createInstance({ ...f.instance, config: {}, agentTypeId: 'test.chat/agent' })
  expect(() => f.projection.attach('a', other)).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
})

it('rejects an empty imported transcript that still references an existing native conversation', () => {
  const f = setup()
  f.db.prepare("UPDATE sessions SET agent_native_session_id='existing-native' WHERE id='old'").run()
  expect(() => f.projection.attach('old', f.instance)).toThrow(expect.objectContaining({ code: 'CAPABILITY_UNSUPPORTED' }))
  expect(f.projection.binding('old')).toBeUndefined()
})

it('keeps accepted input durable while rolling back dispatch and its transcript row on a history insert failure', () => {
  const f = setup()
  f.db.exec("CREATE TRIGGER fail_input AFTER INSERT ON messages BEGIN SELECT RAISE(ABORT, 'fixture input failure'); END")
  const run = f.accept('a', 'request')
  expect(() => f.store.transition(run.id, ['accepted'], 'starting')).toThrow('fixture input failure')
  expect(f.store.get(run.id)?.status).toBe('accepted')
  expect(f.store.originalInput(run.id)).toEqual(input)
  for (const table of ['studio_agent_chat_messages', 'messages']) {
    expect(f.db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count).toBe(0)
  }
  f.db.exec('DROP TRIGGER fail_input')
  expect(f.store.transition(run.id, ['accepted'], 'starting')).toBe(true)
  expect(f.messages('a')).toHaveLength(1)
})

it.each([['hermes', 'cli', 'hermes'], ['ekko-agent', 'builtin_agent', 'ekko']] as const)('preserves the builtin identity for %s when attaching an owned empty chat', (agent, source, module) => {
  const f = setup(), instance = f.store.createInstance({ agentTypeId: agent, profileId: 'one', ownerId: '7', config: {}, mode: 'global' })
  f.db.prepare('UPDATE sessions SET agent=?, source=? WHERE id=?').run(agent, source, 'old')
  f.projection.attach('old', instance, source)
  const run = f.store.accept(instance, { kind: 'builtin', module, implementationVersion: 'test' }, input, 'builtin', undefined, { kind: 'chat', sessionId: 'old' }).run
  f.store.transition(run.id, ['accepted'], 'starting')
  expect(f.projection.binding('old')?.source).toBe(source)
  expect(f.session('old')).toMatchObject({ agent, source })
  expect(f.messages('old')).toMatchObject([{ role: 'user', content: 'hello', run_marker: run.id }])
})

it.each(['delete', 'transfer', 'retype', 'reprofile', 'resurface'])('ends the canonical Run without writing into an unavailable chat after %s', action => {
  const f = setup(), run = f.start('a', 'request')
  if (action === 'delete') f.db.prepare("DELETE FROM sessions WHERE id='a'").run()
  else if (action === 'transfer') f.db.prepare("UPDATE sessions SET studio_user_id='8' WHERE id='a'").run()
  else if (action === 'retype') f.db.prepare("UPDATE sessions SET agent='other-agent' WHERE id='a'").run()
  else if (action === 'reprofile') f.db.prepare("UPDATE sessions SET profile='other-profile' WHERE id='a'").run()
  else f.db.prepare("UPDATE sessions SET source='group_chat' WHERE id='a'").run()
  expect(() => f.store.appendOutput(run.id, { type: 'message.delta', producerSequence: 0, messageId: 'm', text: 'late private output' })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  f.store.finish(run.id, 'failed', 'FORBIDDEN')
  expect(f.store.get(run.id)?.status).toBe('failed')
  expect(f.messages('a')).toHaveLength(1)
  if (action !== 'delete') expect(f.session('a').ended_at).toBeNull()
})

it('publishes one terminal usage card on the answer instead of each tool-call row', () => {
  const f = setup(), run = f.start('a', 'tools')
  const output: AgentOutputEvent[] = [
    { type: 'message.delta', messageId: 'answer', producerSequence: 0, text: 'Checking files' },
    { type: 'tool.started', callId: 'read', name: 'read_file', data: { path: 'a.ts' }, producerSequence: 1 },
    { type: 'tool.completed', callId: 'read', name: 'read_file', data: 'contents', producerSequence: 2 },
    { type: 'tool.started', callId: 'write', name: 'write_file', data: { path: 'b.ts' }, producerSequence: 3 },
    { type: 'usage.reported', modelCallId: 'call', model: 'model', mode: 'final', revision: 1, inputTokens: 20, outputTokens: 5, producerSequence: 4 },
    { type: 'tool.completed', callId: 'write', name: 'write_file', data: 'saved', producerSequence: 5 },
    { type: 'message.snapshot', messageId: 'answer', producerSequence: 6, text: 'Updated both files.' },
  ]
  for (const event of output) {
    f.store.appendOutput(run.id, event)
    expect(f.projection.rows(run.id, [event], true).every(row => !(row as any).run_usage)).toBe(true)
  }
  f.store.finish(run.id, 'completed', null)
  const rows = f.projection.rows(run.id, [], false, true)
  expect(rows).toMatchObject([{ role: 'assistant', content: 'Updated both files.', run_usage: { runId: run.id, inputTokens: 20, outputTokens: 5 } }])
  expect(rows).toHaveLength(1)
  const restored = f.projection.rows(run.id, output, true)
  expect(restored.filter(row => (row as any).run_usage)).toHaveLength(1)
  expect(restored.find(row => (row as any).run_usage)?.content).toBe('Updated both files.')
  expect(restored.filter(row => row.tool_calls?.length).every(row => !(row as any).run_usage)).toBe(true)
})
