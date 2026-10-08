import { describe, expect, it, vi } from 'vitest'
import { AgentBridgeClient } from '../../packages/server/src/modules/hermes/services/bridge/client'

describe('AgentBridgeClient output consumer ownership', () => {
  it('stops polling silent running output after the consumer loses its run', async () => {
    const client = new AgentBridgeClient()
    let ownsRun = true
    const output = vi.spyOn(client, 'getOutput').mockImplementation(async () => {
      ownsRun = false
      return { run_id: 'old', status: 'running', delta: '', done: false, cursor: 0, event_cursor: 0 } as any
    })
    const chunks = []
    for await (const chunk of client.streamOutput('old', { shouldContinue: () => ownsRun })) chunks.push(chunk)
    expect(chunks).toEqual([])
    expect(output).toHaveBeenCalledTimes(1)
  })

  it('keeps polling while owned and delivers its terminal result', async () => {
    const client = new AgentBridgeClient()
    const output = vi.spyOn(client, 'getOutput')
      .mockResolvedValueOnce({ run_id: 'current', status: 'running', delta: '', done: false, cursor: 0, event_cursor: 0 } as any)
      .mockResolvedValueOnce({ run_id: 'current', status: 'complete', delta: 'done', done: true, cursor: 1, event_cursor: 0 } as any)
    const chunks = []
    for await (const chunk of client.streamOutput('current', { intervalMs: 1, shouldContinue: () => true })) chunks.push(chunk)
    expect(chunks).toEqual([expect.objectContaining({ done: true, delta: 'done' })])
    expect(output).toHaveBeenCalledTimes(2)
  })
})
