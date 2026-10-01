import { describe, expect, it, vi } from 'vitest'
import { DSH_STREAM_PLUGIN, DSH_USAGE_METHOD } from '../../packages/server/src/modules/coding-agents/services/dsh/stream-plugin'

describe('DSH usage stream', () => {
  it('reports final disjoint usage once per call, including a call that terminates with an error', async () => {
    const hooks = new Map<string, any>()
    const write = vi.fn()
    let sequence = 0
    const apply = new Function('process', 'performance', 'randomUUID', DSH_STREAM_PLUGIN
      .replace("import { randomUUID } from 'node:crypto'", '')
      .replace('export const name', 'const name').replace('export function apply', 'function apply') + '\nreturn apply')(
      { stdout: { write } }, { now: () => 1000 }, () => `request-${++sequence}`,
    )
    apply({ on: (key: string, callback: any) => hooks.set(key, callback) })
    const input = { sessionId: 's', model: 'm', provider: 'p', messages: [{ content: 'private' }], apiKey: 'private-key' }
    const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 2 }
    async function* source() {
      yield { type: 'usage', usage: { ...usage, outputTokens: 1 } }
      yield { type: 'usage', usage }
      yield { type: 'text-delta', text: 'private' }
    }
    const delivered = []
    for await (const chunk of hooks.get('llm/stream')(input, source)) delivered.push(chunk)
    expect(delivered).toHaveLength(3)
    expect(write).toHaveBeenCalledTimes(1)
    const report = JSON.parse(write.mock.calls[0][0])
    expect(report).toMatchObject({ method: DSH_USAGE_METHOD, params: { requestId: 'request-1', sessionId: 's', model: 'm', provider: 'p', usage } })
    expect(write.mock.calls[0][0]).not.toContain('private')
    async function* interrupted() { yield { type: 'usage', usage }; throw new Error('aborted') }
    await expect(async () => { for await (const _ of hooks.get('llm/stream')(input, interrupted)) { /* drain */ } }).rejects.toThrow('aborted')
    expect(write).toHaveBeenCalledTimes(2)
    expect(JSON.parse(write.mock.calls[1][0]).params.requestId).toBe('request-2')
    async function* missing() { yield { type: 'text-delta', text: 'no usage' } }
    for await (const _ of hooks.get('llm/stream')(input, missing)) { /* drain */ }
    expect(write).toHaveBeenCalledTimes(2)
  })
})
