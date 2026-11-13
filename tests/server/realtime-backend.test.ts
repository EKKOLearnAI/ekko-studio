import { describe, expect, it, vi } from 'vitest'
vi.mock('../../packages/server/src/modules/studio/services/meeting-asr', () => ({ meetingASRService: {} }))
import { createRealtimeBackendReady } from '../../packages/server/src/modules/studio/services/realtime-backend'

describe('Realtime managed backend recovery', () => {
  it('shares startup across concurrent upgrades and reuses the running child', async () => {
    const status = { isRunning: false }
    let finish!: () => void
    const start = vi.fn(() => new Promise<void>(resolve => { finish = () => { status.isRunning = true; resolve() } }))
    const ready = createRealtimeBackendReady({ status, start })
    const first = ready(); const second = ready()
    expect(start).toHaveBeenCalledTimes(1)
    finish(); await Promise.all([first, second]); await ready()
    expect(start).toHaveBeenCalledTimes(1)
    status.isRunning = false
    const recovery = ready(); finish(); await recovery
    expect(start).toHaveBeenCalledTimes(2)
  })
  it('clears failed startup so the next listen can recover', async () => {
    const status = { isRunning: false }
    const start = vi.fn().mockRejectedValueOnce(new Error('startup failed')).mockImplementationOnce(async () => { status.isRunning = true })
    const ready = createRealtimeBackendReady({ status, start })
    await expect(ready()).rejects.toThrow('startup failed')
    await ready(); expect(start).toHaveBeenCalledTimes(2)
  })
  it('waits for an API-initiated startup without spawning another child', async () => {
    const status = { isRunning: false, startupPhase: 'starting' }
    const start = vi.fn()
    const ready = createRealtimeBackendReady({ status, start })
    const waiting = ready()
    status.isRunning = true
    await waiting
    expect(start).not.toHaveBeenCalled()
  })
})
