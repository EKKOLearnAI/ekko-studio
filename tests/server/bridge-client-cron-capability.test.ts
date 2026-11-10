import './fixtures/isolated-studio-state'
import { describe, expect, it } from 'vitest'

describe('AgentBridgeClient.chat trusted Cron capability', () => {
  it('forwards a run capability in the Bridge chat request and omits it otherwise', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/modules/hermes/services/bridge/client')
    const client: any = new (AgentBridgeClient as any)()
    const sent: any[] = []
    client.request = async (payload: any) => { sent.push(payload); return { ok: true, run_id: 'r', status: 'running' } }
    await client.chat('s1', 'hi', [], undefined, 'default', { studio_cron_capability: 'studio_run_TURN' })
    await client.chat('s1', 'hi', [], undefined, 'default', {})
    expect(sent[0]).toMatchObject({ studio_cron_capability: 'studio_run_TURN' })
    expect(sent[1]).not.toHaveProperty('studio_cron_capability')
  })
})
