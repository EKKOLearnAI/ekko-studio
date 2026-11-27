import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('child_process', () => ({ spawn: mocks.spawn }))
import { compactCodexThread } from '../../packages/server/src/modules/coding-agents/services/codex/compact'

let child: any
beforeEach(() => {
  child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 12345, killed: false, kill: vi.fn() })
  mocks.spawn.mockReturnValue(child)
})
function message(value: unknown) { child.stdout.write(JSON.stringify(value) + '\n') }
function start() {
  const result = compactCodexThread({ command: 'codex', env: {} }, 'thread-1', { timeoutMs: 10 })
  message({ id: 0, result: {} }); message({ id: 1, result: {} }); message({ id: 2, result: {} })
  message({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'compact-turn' } } })
  return result
}
function completed(status: string, id = 'compact-turn', threadId = 'thread-1') {
  message({ method: 'turn/completed', params: { threadId, turn: { id, status, error: status === 'failed' ? { message: 'provider unavailable' } : null } } })
}
it('settles on the current native turn/completed success and releases the child', async () => {
  const result = start(); completed('completed')
  await expect(result).resolves.toMatchObject({ compacted: true }); expect(child.kill).toHaveBeenCalledOnce()
})
it.each(['failed', 'interrupted'])('does not report a %s native turn as successful compression', async status => {
  const result = start(); completed(status)
  await expect(result).rejects.toThrow(status === 'failed' ? 'provider unavailable' : 'interrupted')
  expect(child.kill).toHaveBeenCalledOnce()
})
it('ignores completion for another thread or turn', async () => {
  const result = start(); completed('completed', 'other-turn'); completed('completed', 'compact-turn', 'other-thread')
  await expect(result).rejects.toThrow('timed out'); expect(child.kill).toHaveBeenCalledOnce()
})
it('supports legacy thread/compacted notification', async () => {
  const result = start(); message({ method: 'thread/compacted', params: { threadId: 'thread-1' } })
  await expect(result).resolves.toMatchObject({ compacted: true })
})
it('reports early process exit instead of hanging', async () => {
  const result = start(); child.emit('close', 1)
  await expect(result).rejects.toThrow('exited before compaction completed')
})

it('terminates the owned native process when cancellation is requested', async () => {
  const controller = new AbortController()
  const result = compactCodexThread({ command: 'codex', env: {} }, 'thread-1', { signal: controller.signal })
  controller.abort()
  await expect(result).rejects.toThrow('interrupted'); expect(child.kill).toHaveBeenCalledOnce()
})
