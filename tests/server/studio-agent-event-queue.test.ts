import { expect, it } from 'vitest'
import { AgentEventQueue } from '../../packages/studio-agent-drivers/src'

it('drains ordered events before reporting a protocol failure', async () => {
  const queue = new AgentEventQueue<string>(), received: string[] = []
  const reading = (async () => { for await (const event of queue) received.push(event) })()
  queue.push('first'); queue.push('second'); queue.fail(new Error('native failure'))
  await expect(reading).rejects.toThrow('native failure')
  expect(received).toEqual(['first', 'second'])
})

it('bounds pending bytes and events, then wakes the consumer on overflow', async () => {
  for (const queue of [new AgentEventQueue<string>(5), new AgentEventQueue<string>(100, 1)]) {
    queue.push('one')
    expect(() => queue.push('two')).toThrow('buffer limit')
    const received = queue[Symbol.asyncIterator]()
    expect((await received.next()).value).toBe('one')
    await expect(received.next()).rejects.toThrow('buffer limit')
  }
})

it('wakes an idle reader on end and rejects multiple readers or late writes', async () => {
  const queue = new AgentEventQueue<string>(), reader = queue[Symbol.asyncIterator]()
  const next = reader.next()
  await expect(queue[Symbol.asyncIterator]().next()).rejects.toThrow('one reader')
  queue.end()
  expect(await next).toEqual({ value: undefined, done: true })
  expect(() => queue.push('late')).toThrow('closed')
})
