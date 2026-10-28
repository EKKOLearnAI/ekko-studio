import { expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { once, EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ports = vi.hoisted(() => ({ server: undefined as any, manager: undefined as any }))
vi.mock('../../packages/server/src/modules/studio/public/chat-run', () => ({ getChatRunServer: () => ports.server }))
vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({
  chatCodingAgentRunManager: { hasSession: (id: string) => ports.manager.hasSession(id), stop: (...args: any[]) => ports.manager.stop(...args), waitForSessionExit: (id: string) => ports.manager.waitForSessionExit(id) },
  hasChatEkkoBackgroundTasks: () => false, abortChatEkkoBackgroundTasks: async () => 0,
}))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', async original => ({ ...await original<any>(), updateSession: vi.fn(), updateSessionStats: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/bridge-message', () => ({ flushBridgePendingToDb: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/response-stream', () => ({ flushResponseRunToDb: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/compression', () => ({ replaceState: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({ calcAndUpdateUsage: vi.fn(async () => ({ inputTokens: 0, outputTokens: 0 })) }))
import { codingAgentRunManager, CodingAgentRunManager } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'
import { ChatRunSocket } from '../../packages/server/src/modules/studio/sockets/chat-run'
import { stopPersonTask } from '../../packages/server/src/bootstrap/person-task-runtime'

it.skipIf(process.platform === 'win32')('keeps Person stopping until a real child that ignores SIGINT has exited', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr3554-native-stop-'))
  const output = join(dir, 'worker-output.txt')
  const child = spawn(process.execPath, ['-e', "const fs=require('node:fs'); process.on('SIGINT',()=>{}); let n=0; fs.writeFileSync(process.argv[1], '0'); setInterval(()=>fs.writeFileSync(process.argv[1],String(++n)),20); process.stdout.write('ready');", output], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = once(child, 'close')
  await once(child.stdout!, 'data')
  const state: any = { messages: [], events: [], queue: [], isWorking: true, source: 'coding_agent', runId: 'review-run' }
  const run: any = { id: 'review-run', launch: { sessionId: 'review-session', agentId: 'codex', mode: 'scoped' }, state, currentChild: child, terminalOutput: '', exited: false }
  ports.manager = codingAgentRunManager
  const manager = codingAgentRunManager as any
  manager.runs.set(run.id, run); manager.sessionIndex.set('review-session', run.id)
  const flush = vi.spyOn(manager, 'flushTerminalOutput').mockImplementation(() => {})
  const usage = vi.spyOn(manager, 'finalizeInterruptedUsage').mockReturnValue(undefined)
  const nsp: any = { adapter: { rooms: new Map() }, to: () => ({ emit: () => {} }) }
  ports.server = Object.assign(Object.create(ChatRunSocket.prototype), {
    nsp, bridge: {}, sessionMap: new Map([['review-session', state]]), runHandlers: new Map(),
    mobileRunTargets: new Map(), finishTaskPlanRun: vi.fn(), emitExternalEvent: vi.fn(), runQueuedItem: vi.fn(),
  })
  try {
    let acknowledged = false
    const stopped = stopPersonTask('review-session').then(() => { acknowledged = true })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(acknowledged).toBe(false)
    expect(child.exitCode).toBeNull()
    expect(child.signalCode).toBeNull()
    await stopped
    expect(child.signalCode).toBe('SIGKILL')
    const finalOutput = readFileSync(output, 'utf8')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(readFileSync(output, 'utf8')).toBe(finalOutput)
  } finally {
    if (run.currentChildKillTimer) clearTimeout(run.currentChildKillTimer)
    try { process.kill(-child.pid!, 'SIGKILL') } catch {}
    await closed
    flush.mockRestore(); usage.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('retains an unconfirmed exit across unregistering and retries, without resolving on a timeout', async () => {
  vi.useFakeTimers()
  const manager = new CodingAgentRunManager()
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null })
  const run: any = { id: 'slow', currentChild: child }
  const lookup = vi.spyOn(manager, 'getBySession').mockReturnValue(run)
  try {
    const exit = manager.waitForSessionExit('slow-session')
    lookup.mockReturnValue(undefined)
    expect(manager.waitForSessionExit('slow-session')).toBe(exit)
    let ended = false; void exit.then(() => { ended = true })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(ended).toBe(false)
    child.emit('close')
    await exit
    expect(ended).toBe(true)
    await manager.waitForSessionExit('slow-session')
  } finally { vi.useRealTimers(); lookup.mockRestore() }
})

it('waits for PTY exit rather than its kill request', async () => {
  const manager = new CodingAgentRunManager()
  let exited!: () => void
  const run: any = { id: 'pty', pty: { onExit: (callback: () => void) => { exited = callback } } }
  vi.spyOn(manager, 'getBySession').mockReturnValue(run)
  const exit = manager.waitForSessionExit('pty-session')
  let ended = false; void exit.then(() => { ended = true })
  await Promise.resolve()
  expect(ended).toBe(false)
  exited(); await exit
  expect(ended).toBe(true)
})
