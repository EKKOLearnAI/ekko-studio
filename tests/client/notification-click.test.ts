import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

it('opens the Person session in the window for this Studio deployment', async () => {
  const scope = 'https://example.test/studio/'
  const client = { url: scope, navigate: vi.fn(), focus: vi.fn() }
  const other = { ...client, url: 'https://example.test/other/', focus: vi.fn() }
  const handlers = new Map()
  runInNewContext(readFileSync('packages/client/public/notification-sw.js', 'utf8'), {
    URL, self: { registration: { scope }, addEventListener: handlers.set.bind(handlers) },
    clients: { matchAll: async () => [other, client] },
  })
  let pending: Promise<void>
  handlers.get('notificationclick')({
    notification: { close() {}, data: { clickUrl: '/person?session=abc' } },
    waitUntil(work: Promise<void>) { pending = work },
  })
  await pending!
  expect(client.navigate).toHaveBeenCalledWith(scope + '#/person?session=abc')
  expect(client.focus).toHaveBeenCalledOnce()
  expect(other.focus).not.toHaveBeenCalled()
})
