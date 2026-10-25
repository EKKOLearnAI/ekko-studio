import { expect, it, vi } from 'vitest'
import { RpcPeer } from '../../packages/studio-plugin-sdk/src/rpc'

it('rejects every pending call when a malformed error response arrives', async () => {
  const send = vi.fn(async () => {}), peer = new RpcPeer({ send })
  const first = peer.request('one', {}), second = peer.request('two', {})
  const results = Promise.allSettled([first, second])
  await expect(peer.receive({ kind: 'error', id: 1 })).rejects.toThrow('Malformed')
  expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected'])
  await expect(peer.request('three', {})).rejects.toThrow('closed')
})

it('bounds pending requests and ignores late replies after a deadline', async () => {
  vi.useFakeTimers()
  const peer = new RpcPeer({ send: async () => {} }, 10, 1)
  try {
    const pending = peer.request('one', {})
    const failure = expect(pending).rejects.toThrow('timed out')
    await expect(peer.request('two', {})).rejects.toThrow('Too many')
    await vi.advanceTimersByTimeAsync(10)
    await failure
    await peer.receive({ kind: 'response', id: 1, value: 'late' })
  } finally { peer.close(); vi.useRealTimers() }
})

it('serializes known failures without sending internal exception details', async () => {
  const send = vi.fn(async () => {}), peer = new RpcPeer({ send })
  peer.handle('broken', () => { throw new Error('private filesystem details') })
  await peer.receive({ kind: 'request', id: 1, method: 'broken', params: {} })
  expect(send).toHaveBeenCalledWith({ kind: 'error', id: 1, error: { code: 'INTERNAL', message: 'Plugin operation failed', retryable: false } })
  peer.close()
})
