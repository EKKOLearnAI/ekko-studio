import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('child_process', () => ({
  spawn: spawnMock,
}))

function makeChild() {
  const child = new EventEmitter() as any
  child.stdout = new EventEmitter() as any
  child.stderr = new EventEmitter() as any
  child.stdin = new EventEmitter() as any
  child.stdin.write = vi.fn()
  child.kill = vi.fn(() => true)
  child.killed = false
  return child
}

describe('compactCodexThread', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('resumes the thread before thread/compact/start and resolves on compaction', async () => {
    const child = makeChild()
    spawnMock.mockReturnValue(child)

    const { compactCodexThread } = await import('../../packages/server/src/modules/coding-agents/services/runtime/codex-compact')
    const promise = compactCodexThread({
      command: 'codex',
      env: { CODEX_HOME: '/tmp/codex' },
      workspaceDir: '/tmp/work',
    }, 'thread-1')

    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":0,"result":{"codexHome":"/tmp/codex"}}\n'))
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n'))
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":2,"result":{}}\n'))
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"last":{"totalTokens":1000,"inputTokens":900,"cachedInputTokens":0,"outputTokens":100,"reasoningOutputTokens":0,"cacheWriteInputTokens":0},"total":{"totalTokens":5000,"inputTokens":4000,"cachedInputTokens":0,"outputTokens":1000,"reasoningOutputTokens":0,"cacheWriteInputTokens":0},"modelContextWindow":950000}}}\n'))
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"last":{"totalTokens":400,"inputTokens":300,"cachedInputTokens":0,"outputTokens":100,"reasoningOutputTokens":0,"cacheWriteInputTokens":0},"total":{"totalTokens":5400,"inputTokens":4300,"cachedInputTokens":0,"outputTokens":1100,"reasoningOutputTokens":0,"cacheWriteInputTokens":0},"modelContextWindow":950000}}}\n'))
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","method":"thread/compacted","params":{"threadId":"thread-1","turnId":"turn-1"}}\n'))

    await expect(promise).resolves.toEqual({ compacted: true, beforeTokens: 1000, afterTokens: 400 })
    const writes = child.stdin.write.mock.calls.map((call: any[]) => call[0])
    expect(writes[0]).toContain('"method":"initialize"')
    expect(writes[1]).toContain('"method":"initialized"')
    expect(writes[2]).toContain('"method":"thread/resume"')
    expect(writes[2]).toContain('"threadId":"thread-1"')
    expect(writes[3]).toContain('"method":"thread/compact/start"')
    expect(writes[3]).toContain('"threadId":"thread-1"')
  })

  it('ignores turn/completed before compaction is accepted', async () => {
    const child = makeChild()
    spawnMock.mockReturnValue(child)

    const { compactCodexThread } = await import('../../packages/server/src/modules/coding-agents/services/runtime/codex-compact')
    const promise = compactCodexThread({
      command: 'codex',
      env: { CODEX_HOME: '/tmp/codex' },
    }, 'thread-1')
    let settled = false
    promise
      .then(() => { settled = true })
      .catch(() => { settled = true })

    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":0,"result":{}}\n'))
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n'))
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"thread-1"}}\n'))
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(settled).toBe(false)
    expect(child.kill).not.toHaveBeenCalled()

    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":2,"result":{}}\n'))
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","method":"thread/compacted","params":{"threadId":"thread-1"}}\n'))

    await expect(promise).resolves.toEqual({ compacted: true, beforeTokens: null, afterTokens: null })
  })

  it('rejects when the app-server returns a JSON-RPC error', async () => {
    const child = makeChild()
    spawnMock.mockReturnValue(child)

    const { compactCodexThread } = await import('../../packages/server/src/modules/coding-agents/services/runtime/codex-compact')
    const promise = compactCodexThread({
      command: 'codex',
      env: { CODEX_HOME: '/tmp/codex' },
    }, 'thread-1')

    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":0,"result":{}}\n'))
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"method not found"}}\n'))

    await expect(promise).rejects.toThrow('method not found')
  })

  it('rejects when thread/compact/start returns a JSON-RPC error', async () => {
    const child = makeChild()
    spawnMock.mockReturnValue(child)

    const { compactCodexThread } = await import('../../packages/server/src/modules/coding-agents/services/runtime/codex-compact')
    const promise = compactCodexThread({
      command: 'codex',
      env: { CODEX_HOME: '/tmp/codex' },
    }, 'thread-1')

    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":0,"result":{}}\n'))
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n'))
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"thread not found"}}\n'))

    await expect(promise).rejects.toThrow('thread not found')
  })
  it('treats the first usage update after compact acceptance as after-only', async () => {
    const child = makeChild()
    spawnMock.mockReturnValue(child)

    const { compactCodexThread } = await import('../../packages/server/src/modules/coding-agents/services/runtime/codex-compact')
    const promise = compactCodexThread({
      command: 'codex',
      env: { CODEX_HOME: '/tmp/codex' },
    }, 'thread-1')

    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":0,"result":{}}\n'))
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n'))
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":2,"result":{}}\n'))
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","tokenUsage":{"last":{"totalTokens":26094}}}}\n'))
    child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","method":"thread/compacted","params":{"threadId":"thread-1"}}\n'))

    await expect(promise).resolves.toEqual({ compacted: true, beforeTokens: null, afterTokens: 26094 })
  })

})
