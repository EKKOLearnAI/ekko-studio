import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const startAntigravityTurnProcess = vi.hoisted(() => vi.fn())
vi.mock('../../packages/server/src/modules/coding-agents/services/antigravity/turn-process', () => ({
  startAntigravityTurnProcess,
}))

import { applyResponseStreamEvent, flushResponseRunToDb } from '../../packages/server/src/modules/studio/services/chat-run/response-stream'
import { extractResponseText } from '../../packages/server/src/modules/studio/services/chat-run/response-utils'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { configureRunState } from '../../packages/server/src/modules/studio/public/run-state'
import { CodingAgentRunManager } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'

type TurnChild = EventEmitter & { pid: number; killed: boolean; exitCode: number | null; signalCode: null }
type Turn = {
  onEvent: (event: { type: string; data?: string; message?: string }) => void
  onClose: (code: number | null) => void
  child: TurnChild
}

let workspaceDir = ''
let sessionId = ''
let manager: CodingAgentRunManager
let turn: Turn
const events: Array<{ event: string; payload: unknown }> = []

beforeAll(() => { initAllHermesTables() })

beforeEach(async () => {
  events.length = 0
  workspaceDir = await mkdtemp(join(tmpdir(), 'agy-exit-'))
  sessionId = `agy-exit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  startAntigravityTurnProcess.mockImplementation((input: Turn) => {
    const child = new EventEmitter() as TurnChild
    child.pid = 2147483001
    child.killed = false
    child.exitCode = null
    child.signalCode = null
    turn = { onEvent: input.onEvent, onClose: input.onClose, child }
    return child
  })
  configureRunState({
    applyResponseStreamEvent,
    calcAndUpdateUsage: async () => ({}),
    completeWorkspaceRunCheckpoint: () => undefined,
    extractResponseText,
    flushResponseRunToDb,
    getChatRunServer: () => ({
      emitExternalEvent: (_id: string, event: string, payload: unknown) => { events.push({ event, payload }) },
    }),
    getOrCreateSession: () => ({ messages: [], isWorking: false, events: [], queue: [] }),
    startWorkspaceRunCheckpoint: () => undefined,
    updateContextTokenUsage: () => undefined,
  })
  manager = new CodingAgentRunManager()
  manager.start({
    agentSessionId: sessionId,
    agentId: 'antigravity',
    mode: 'global',
    profile: 'default',
    provider: '',
    model: '',
    sessionId,
    command: 'agy',
    args: [],
    shellCommand: '',
    workspaceDir,
  })
})

afterEach(async () => {
  if (turn?.child) {
    turn.child.killed = true
    turn.child.exitCode ??= 0
  }
  manager?.stop(sessionId)
  if (workspaceDir) await rm(workspaceDir, { recursive: true, force: true })
})

function beginTurn() {
  manager.send(sessionId, 'what happened yesterday')
  return turn
}

async function untilTerminal() {
  await vi.waitFor(() => {
    expect(events.some(entry => entry.event === 'run.completed' || entry.event === 'run.failed')).toBe(true)
  })
  await new Promise(resolve => setImmediate(resolve))
}

function payloadHas(text: string) {
  return events.some(entry => JSON.stringify(entry.payload).includes(text))
}

it('completes a zero exit after streamed assistant text', async () => {
  const current = beginTurn()
  current.onEvent({ type: 'text', data: 'yesterday was up' })
  current.onClose(0)
  await untilTerminal()
  expect(events.filter(entry => entry.event === 'run.completed')).toHaveLength(1)
  expect(events.some(entry => entry.event === 'run.failed')).toBe(false)
  expect(payloadHas('exited without a terminal result event')).toBe(false)
})

it('fails a zero exit that produced no assistant text', async () => {
  const current = beginTurn()
  current.onClose(0)
  await untilTerminal()
  expect(events.some(entry => entry.event === 'run.failed')).toBe(true)
  expect(payloadHas('Antigravity exited without a terminal result event')).toBe(true)
})

it('fails a non-zero exit after streamed text', async () => {
  const current = beginTurn()
  current.onEvent({ type: 'text', data: 'yesterday was up' })
  current.onClose(3)
  await untilTerminal()
  expect(events.some(entry => entry.event === 'run.failed')).toBe(true)
  expect(events.some(entry => entry.event === 'run.completed')).toBe(false)
})

it('keeps an explicit result when the process later exits 0', async () => {
  const completed = beginTurn()
  completed.onEvent({ type: 'complete' })
  completed.onClose(0)
  await untilTerminal()
  expect(events.filter(entry => entry.event === 'run.completed')).toHaveLength(1)
  expect(payloadHas('exited without a terminal result event')).toBe(false)

  events.length = 0
  const failed = beginTurn()
  failed.onEvent({ type: 'error', message: 'boom' })
  failed.onClose(0)
  await untilTerminal()
  expect(events.some(entry => entry.event === 'run.failed')).toBe(true)
  expect(events.some(entry => entry.event === 'run.completed')).toBe(false)
})
