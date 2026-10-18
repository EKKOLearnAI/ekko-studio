import { describe, expect, it } from 'vitest'
import { JevPhysicalSlots, JevSidecarQueue } from '../../packages/server/src/modules/studio/services/jev/sidecar-queue'

async function tick() { await new Promise(resolve => setTimeout(resolve, 0)) }

describe('JEV sidecar queue', () => {
  it('enforces global/profile queue limits and duplicate keys', () => {
    const queue = new JevSidecarQueue({ maxQueued: 2, maxQueuedPerProfile: 1, maxWorkers: 0, maxWorkersPerProfile: 1 })
    expect(queue.enqueue({ key: 'a', profile: 'one', run: async () => {} })).toBe('accepted')
    expect(queue.enqueue({ key: 'a', profile: 'one', run: async () => {} })).toBe('duplicate')
    expect(queue.enqueue({ key: 'b', profile: 'one', run: async () => {} })).toBe('queue_full')
    expect(queue.enqueue({ key: 'c', profile: 'two', run: async () => {} })).toBe('accepted')
    expect(queue.enqueue({ key: 'd', profile: 'three', run: async () => {} })).toBe('queue_full')
  })

  it('runs profiles fairly while respecting one worker per profile', async () => {
    const queue = new JevSidecarQueue({ maxQueued: 8, maxQueuedPerProfile: 4, maxWorkers: 2, maxWorkersPerProfile: 1 })
    const started: string[] = []
    let releaseOne!: () => void
    const blocked = new Promise<void>(resolve => { releaseOne = resolve })
    queue.enqueue({ key: 'one-a', profile: 'one', run: async () => { started.push('one-a'); await blocked } })
    queue.enqueue({ key: 'one-b', profile: 'one', run: async () => { started.push('one-b') } })
    queue.enqueue({ key: 'two-a', profile: 'two', run: async () => { started.push('two-a') } })
    await tick()
    expect(started).toEqual(['one-a', 'two-a'])
    releaseOne(); await tick(); await tick()
    expect(started).toEqual(['one-a', 'two-a', 'one-b'])
  })

  it('keeps physical capacity until the real operation releases it', () => {
    const slots = new JevPhysicalSlots(2, 1)
    const releaseOne = slots.tryAcquire('one')!
    expect(slots.tryAcquire('one')).toBeNull()
    const releaseTwo = slots.tryAcquire('two')!
    expect(slots.tryAcquire('three')).toBeNull()
    releaseOne()
    expect(slots.tryAcquire('one')).toBeTypeOf('function')
    releaseTwo()
  })
})
