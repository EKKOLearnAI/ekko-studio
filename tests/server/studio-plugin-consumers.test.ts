import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { PluginConsumerStore, parseConsumerSpec } from '../../packages/server/src/modules/studio/repositories/plugin-consumer-store'
import { ReliablePluginConsumers } from '../../packages/server/src/modules/studio/services/events/reliable-consumers'
import { StudioError, type EventEnvelope, type ExecutionContext } from '../../packages/studio-plugin-sdk/src'

const databases: DatabaseSync[] = []
const dispatchers: ReliablePluginConsumers[] = []
afterEach(async () => { for (const dispatcher of dispatchers.splice(0)) await dispatcher.close(); for (const db of databases.splice(0)) db.close(); vi.useRealTimers() })
const identity = { pluginId: 'test.consumer', profileId: 'one', ownerId: 'owner', name: 'durable' }
const spec = { types: ['run.completed'], start: 'earliest' as const, resume: 'continue' as const }
function setup(maxPending?: number) {
  const db = new DatabaseSync(':memory:'); databases.push(db)
  const store = new PluginConsumerStore(db, maxPending), consumer = store.register(identity, spec)
  const append = (id: string, partition = 'a', profileId = 'one', type = 'run.completed', time = 1) => {
    const event: EventEnvelope = { schemaVersion: 1, id, type, occurredAt: time, partitionKey: `${profileId}:${partition}`, sequence: 0,
      subject: { profileId }, data: {}, correlationId: id }
    store.events.append([event]); return event
  }
  return { db, store, consumer, append }
}

it('replays committed events without a notification and keeps owner/profile registrations separate', () => {
  const { db, store, consumer, append } = setup()
  append('first'); append('foreign', 'a', 'two'); append('ignored', 'b', 'one', 'plugin.ready'); append('last')
  const restarted = new PluginConsumerStore(db)
  expect(restarted.register(identity, spec).id).toBe(consumer.id)
  expect(restarted.register({ ...identity, ownerId: 'other' }, spec).id).not.toBe(consumer.id)
  restarted.fill(consumer.id)
  const first = restarted.claim(consumer.id, 0)!
  expect(first.event.id).toBe('first'); restarted.ack(first)
  const last = restarted.claim(consumer.id, 0)!
  expect(last.event.id).toBe('last'); restarted.ack(last)
  expect(restarted.claim(consumer.id, 0)).toBeNull()
  expect(restarted.get(consumer.id)?.position).toBe(store.events.head())
})

it('keeps each partition ordered while a failing partition retries and enters dead letters', () => {
  const { store, consumer, append } = setup()
  append('a1'); append('a2'); append('b1', 'b'); store.fill(consumer.id)
  let now = 0, delivery = store.claim(consumer.id, now)!
  expect(delivery.event.id).toBe('a1'); store.fail(delivery, 'INTERNAL', now)
  const other = store.claim(consumer.id, now)!
  expect(other.event.id).toBe('b1'); store.ack(other)
  expect(store.claim(consumer.id, 999)).toBeNull()
  for (let attempt = 2; attempt <= 5; attempt++) {
    now += 30_000; delivery = store.claim(consumer.id, now)!
    expect(delivery.event.id).toBe('a1'); expect(delivery.attempt).toBe(attempt)
    store.fail(delivery, 'INTERNAL', now)
  }
  expect(store.claim(consumer.id, now + 60_000)).toBeNull()
  const dead = store.deliveries(consumer.id)[0]
  expect(dead).toMatchObject({ status: 'dead', attempts: 5, error_code: 'INTERNAL' })
  expect(dead).not.toHaveProperty('lease'); expect(dead).not.toHaveProperty('event')
  expect(() => store.retry(consumer.id, dead.position, dead.revision - 1)).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  store.retry(consumer.id, dead.position, dead.revision)
  delivery = store.claim(consumer.id, now)!
  expect(delivery.attempt).toBe(1); store.ack(delivery)
  expect(store.claim(consumer.id, now)?.event.id).toBe('a2')
})

it('recovers a crashed delivery lease and ignores stale success/failure acknowledgements', () => {
  const { db, store, consumer, append } = setup()
  append('event'); store.fill(consumer.id)
  const old = store.claim(consumer.id, 0)!, restarted = new PluginConsumerStore(db)
  expect(restarted.claim(consumer.id, 29_999)).toBeNull()
  const replay = restarted.claim(consumer.id, 30_000)!
  expect(replay.event.id).toBe(old.event.id); expect(replay.lease).not.toBe(old.lease)
  expect(restarted.ack(old)).toBe(false)
  restarted.fail(old, 'INTERNAL', 30_001)
  expect(restarted.deliveries(consumer.id)[0].status).toBe('processing')
  expect(restarted.ack(replay)).toBe(true)
})

it('bounds pending deliveries without dropping matching events, even with oversized scan batches', () => {
  const { store, consumer, append } = setup(2)
  append('one'); append('two'); append('three'); store.fill(consumer.id, 100_000)
  expect(store.get(consumer.id)).toMatchObject({ position: 2, errorCode: 'RESOURCE_EXHAUSTED' })
  expect(store.deliveries(consumer.id)).toHaveLength(2)
  store.ack(store.claim(consumer.id, 0)!); store.fill(consumer.id)
  expect(store.get(consumer.id)).toMatchObject({ position: 3, errorCode: null })
  store.ack(store.claim(consumer.id, 0)!)
  expect(store.claim(consumer.id, 0)?.event.id).toBe('three')
})

it('does not skip over a clamped scan limit', () => {
  const { store, consumer, append } = setup()
  for (let i = 0; i < 1002; i++) append(`event-${i}`)
  store.fill(consumer.id, 100_000)
  expect(store.get(consumer.id)?.position).toBe(1000)
  store.fill(consumer.id, 100_000)
  expect(store.deliveries(consumer.id)).toHaveLength(1000) // Bounded diagnostic page, not a queue truncation.
  expect(store.get(consumer.id)?.position).toBe(1002)
})

it('requires explicit reset after retention and preserves partition sequence after pruning', () => {
  const { db, store, consumer, append } = setup()
  append('old'); store.fill(consumer.id); const delivery = store.claim(consumer.id, 0)!
  expect(store.events.prune(2)).toBe(1)
  expect(() => store.register(identity, spec)).toThrow(expect.objectContaining({ code: 'EVENT_CURSOR_EXPIRED' }))
  expect(store.get(consumer.id)?.state).toBe('expired')
  expect(() => store.control(consumer.id, 'resume', 1)).toThrow(expect.objectContaining({ code: 'EVENT_CURSOR_EXPIRED' }))
  expect(() => store.register({ ...identity, name: 'new' }, spec)).toThrow(expect.objectContaining({ code: 'EVENT_CURSOR_EXPIRED' }))
  const restarted = new PluginConsumerStore(db)
  restarted.register(identity, { ...spec, resume: 'from-now' })
  expect(restarted.ack(delivery)).toBe(false)
  append('new', 'a', 'one', 'run.completed', 3)
  restarted.fill(consumer.id)
  expect(restarted.claim(consumer.id, 0)?.event).toMatchObject({ id: 'new', sequence: 2 })
})

it('preserves a paused consumer across reload and releases cancelled delivery without consuming attempts', () => {
  const { store, consumer, append } = setup()
  append('event'); store.fill(consumer.id)
  const delivery = store.claim(consumer.id, 0)!
  store.fail(delivery, 'CANCELLED', 0, 5, true)
  expect(store.claim(consumer.id, 0)?.attempt).toBe(1)
  const paused = store.control(consumer.id, 'pause', 1)
  expect(store.register(identity, spec).state).toBe('paused')
  expect(store.claim(consumer.id, 30_000)).toBeNull()
  expect(() => store.control(consumer.id, 'reset-now', 1)).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  const reset = store.control(consumer.id, 'reset-now', paused.revision)
  expect(reset).toMatchObject({ state: 'active', position: 1 })
  expect(store.deliveries(consumer.id)).toEqual([])
})

it('validates consumer declarations and rejects accidental type changes without reset', () => {
  const { store } = setup()
  for (const value of [{ ...spec, types: [] }, { ...spec, types: ['run.completed', 'run.completed'] }, { ...spec, ownerId: 'forged' }, { ...spec, resume: 'auto' }]) {
    expect(() => parseConsumerSpec(value)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  }
  expect(() => store.register(identity, { ...spec, types: ['run.failed'] })).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  expect(store.register(identity, { ...spec, types: ['run.failed'], resume: 'from-now' }).types).toEqual(['run.failed'])
})

function dispatch(store: PluginConsumerStore, options: ConstructorParameters<typeof ReliablePluginConsumers>[1] = {}) {
  const dispatcher = new ReliablePluginConsumers(store, { intervalMs: 1_000_000, ...options }); dispatchers.push(dispatcher)
  return dispatcher
}
const context = async (_event: EventEnvelope, signal: AbortSignal) => ({ signal }) as ExecutionContext

it('reauthorizes each replay and retries handler failures without logging event content', async () => {
  const { store, consumer, append } = setup()
  append('denied'); append('missing'); append('failure'); append('success', 'b')
  const dispatcher = dispatch(store, { now: () => 0 }), delivered: string[] = []
  dispatcher.mount(consumer, { context: async (event, signal) => {
    if (event.id === 'denied') throw new StudioError('FORBIDDEN', 'secret detail')
    if (event.id === 'missing') throw new StudioError('NOT_FOUND', 'secret detail')
    return context(event, signal)
  }, deliver: async event => { delivered.push(event.id); if (event.id === 'failure') throw new StudioError('FORBIDDEN', 'handler failure') }, deadline: async () => {} })
  for (let i = 0; i < 4; i++) { dispatcher.poll(); await dispatcher.idle() }
  expect(delivered.sort()).toEqual(['failure', 'success'])
  expect(store.deliveries(consumer.id)).toEqual([expect.objectContaining({ status: 'pending', error_code: 'FORBIDDEN', attempts: 1 })])
})

it('unloads a pending callback promptly, revokes its scope, and replays the same event id', async () => {
  const { store, consumer, append } = setup(); append('event')
  const dispatcher = dispatch(store, { now: () => 0 })
  let signal: AbortSignal | undefined
  const unmount = dispatcher.mount(consumer, { context, deliver: async (_event, ctx) => { signal = ctx.signal; await new Promise(() => {}) }, deadline: async () => {} })
  dispatcher.poll(); await vi.waitFor(() => expect(signal).toBeDefined())
  await unmount(); expect(signal!.aborted).toBe(true)
  expect(store.deliveries(consumer.id)[0]).toMatchObject({ status: 'pending', attempts: 0 })
  const deliver = vi.fn(async () => {})
  dispatcher.mount(consumer, { context, deliver, deadline: async () => {} })
  dispatcher.poll(); await dispatcher.idle()
  expect(deliver.mock.calls).toHaveLength(1)
  expect(store.deliveries(consumer.id)).toEqual([])
})

it('bounds parallel partitions and does not run later events in a busy partition', async () => {
  const { store, consumer, append } = setup()
  for (let i = 0; i < 6; i++) { append(`${i}-first`, `${i}`); append(`${i}-next`, `${i}`) }
  const dispatcher = dispatch(store, { now: () => 0 }), delivered: string[] = [], releases: Array<() => void> = []
  dispatcher.mount(consumer, { context, deliver: async event => { delivered.push(event.id); await new Promise<void>(resolve => releases.push(resolve)) }, deadline: async () => {} })
  dispatcher.poll(); await vi.waitFor(() => expect(delivered).toHaveLength(4)); dispatcher.poll()
  expect(delivered).toEqual(['0-first', '1-first', '2-first', '3-first'])
  for (const release of releases) release(); await dispatcher.idle()
  expect(store.deliveries(consumer.id)).toHaveLength(8)
})

it('does not recover a live delivery as crashed when the wall clock advances', async () => {
  const { store, consumer, append } = setup(); append('event')
  let now = 0
  const dispatcher = dispatch(store, { now: () => now }), deliver = vi.fn(async () => { await new Promise(() => {}) })
  dispatcher.mount(consumer, { context, deliver, deadline: async () => {} })
  dispatcher.poll(); await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
  now = 31_000; dispatcher.poll(); await Promise.resolve()
  expect(deliver).toHaveBeenCalledTimes(1)
  expect(store.deliveries(consumer.id)[0]).toMatchObject({ status: 'processing', attempts: 1 })
})

it('expires a deadline once, aborts its scope, and invokes worker termination before further delivery', async () => {
  vi.useFakeTimers()
  const { store, consumer, append } = setup(); append('event')
  const dispatcher = dispatch(store, { timeoutMs: 30, now: () => 0 }), deadline = vi.fn(async () => {})
  let signal: AbortSignal | undefined
  dispatcher.mount(consumer, { context, deliver: async (_event, ctx) => { signal = ctx.signal; await new Promise(() => {}) }, deadline })
  dispatcher.poll(); await vi.advanceTimersByTimeAsync(30); await dispatcher.idle()
  expect(signal!.aborted).toBe(true); expect(deadline).toHaveBeenCalledTimes(1)
  expect(store.deliveries(consumer.id)[0]).toMatchObject({ attempts: 1, status: 'pending', error_code: 'DEADLINE_EXCEEDED' })
})

it('keeps management scoped and rejects stale controls before cancelling callbacks', async () => {
  const { store, consumer, append } = setup(); append('event')
  const dispatcher = dispatch(store, { now: () => 0 })
  for (const [plugin, profile] of [['other', 'one'], ['test.consumer', 'other']]) {
    expect(() => dispatcher.requireRecord(plugin, profile, consumer.id)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  }
  let signal: AbortSignal | undefined
  dispatcher.mount(consumer, { context, deliver: async (_event, ctx) => { signal = ctx.signal; await new Promise(() => {}) }, deadline: async () => {} })
  dispatcher.poll(); await vi.waitFor(() => expect(signal).toBeDefined())
  expect(() => dispatcher.control(consumer.id, 'pause', 99)).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  expect(signal!.aborted).toBe(false)
  dispatcher.control(consumer.id, 'pause', consumer.revision); await dispatcher.idle()
  expect(signal!.aborted).toBe(true); expect(store.get(consumer.id)?.state).toBe('paused')
})

it('performs bounded seven-day retention and requires reset for paused cursors', async () => {
  const { store, consumer, append } = setup(); append('old')
  store.control(consumer.id, 'pause', 1)
  let now = 0
  const dispatcher = dispatch(store, { now: () => now })
  dispatcher.mount(consumer, { context, deliver: async () => {}, deadline: async () => {} })
  now = 8 * 24 * 60 * 60 * 1000; dispatcher.poll()
  expect(store.events.get(1)).toBeNull()
  expect(store.get(consumer.id)?.state).toBe('expired')
})
