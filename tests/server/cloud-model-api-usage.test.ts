import { afterEach, expect, it, vi } from 'vitest'
import { CloudModelUsageOutbox } from '../../packages/server/src/modules/studio/services/app-relay/model-api-usage'

const summary = (id = 'request-1') => ({ id, inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: null, costSource: 'unknown' as const })
let outbox: CloudModelUsageOutbox
afterEach(() => { outbox?.stop(); vi.useRealTimers() })

it('retries the same report after reconnect and preserves newer cost fills while an old ack is pending', () => {
  const callbacks: Array<(ok: boolean) => void> = []
  let connected = false
  const send = vi.fn((_value, ack) => { if (!connected) return false; callbacks.push(ack); return true })
  outbox = new CloudModelUsageOutbox(send)
  outbox.report(summary())
  connected = true; outbox.flush()
  outbox.report({ ...summary(), costUsd: 0.002, costSource: 'estimated' })
  callbacks[0](true)
  outbox.flush()
  expect(send.mock.calls.at(-1)![0].costUsd).toBe(0.002)
  callbacks[1](true)
  const count = send.mock.calls.length
  outbox.flush()
  expect(send).toHaveBeenCalledTimes(count)
})

it('bounds reports, retries and outstanding acknowledgements; explicit stop discards later callbacks', async () => {
  vi.useFakeTimers()
  const send = vi.fn(() => true)
  outbox = new CloudModelUsageOutbox(send)
  for (let i = 0; i < 300; i++) outbox.report(summary(String(i)))
  expect(send).toHaveBeenCalledTimes(4)
  await vi.advanceTimersByTimeAsync(10001)
  expect(send).toHaveBeenCalledTimes(8)
  await vi.advanceTimersByTimeAsync(3600000)
  const count = send.mock.calls.length
  outbox.flush()
  expect(send).toHaveBeenCalledTimes(count)
  outbox.stop(); outbox.report(summary('late'))
  expect(send).toHaveBeenCalledTimes(count)
})
