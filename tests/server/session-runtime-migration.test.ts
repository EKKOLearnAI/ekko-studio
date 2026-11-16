import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateSessionRuntime } from '../../packages/server/src/modules/coding-agents/services/session-runtime-migration'

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'session-runtime-migration-')) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

it('retains native history, migrates once under concurrency and never replaces current history', async () => {
  const source = join(home, 'legacy/runs/session')
  const target = join(home, 'account/runs/session')
  await mkdir(join(source, 'sessions'), { recursive: true })
  await writeFile(join(source, 'sessions/native.jsonl'), '{"sessionId":"native-id","text":"existing history"}\n')
  const input = { target, candidates: [join(home, 'missing'), source], accountId: 1, agentSessionId: 'agent-id',
    session: { studio_user_id: '1', agent_session_id: 'agent-id' } }
  await Promise.all([migrateSessionRuntime(input), migrateSessionRuntime(input)])
  const history = await readFile(join(source, 'sessions/native.jsonl'), 'utf8')
  expect(await readFile(join(target, 'sessions/native.jsonl'), 'utf8')).toBe(history)
  await writeFile(join(target, 'sessions/native.jsonl'), history + '{"text":"continued"}\n')
  await migrateSessionRuntime(input)
  expect(await readFile(join(target, 'sessions/native.jsonl'), 'utf8')).toContain('continued')
  expect(await readFile(join(source, 'sessions/native.jsonl'), 'utf8')).toBe(history)
})

it('does not import another account or another native session and accepts legacy Studio ownership', async () => {
  const source = join(home, 'legacy')
  const target = join(home, 'account')
  await mkdir(source)
  await writeFile(join(source, 'history'), 'private-history')
  const input = { target, candidates: [source], accountId: 2, agentSessionId: 'agent-id',
    session: { user_id: '1', source: 'coding_agent', agent_session_id: 'agent-id' } }
  await migrateSessionRuntime(input)
  await expect(readFile(join(target, 'history'))).rejects.toMatchObject({ code: 'ENOENT' })
  await migrateSessionRuntime({ ...input, accountId: 1, agentSessionId: 'new-agent-id' })
  await expect(readFile(join(target, 'history'))).rejects.toMatchObject({ code: 'ENOENT' })
  await migrateSessionRuntime({ ...input, accountId: 1 })
  expect(await readFile(join(target, 'history'), 'utf8')).toBe('private-history')
})
