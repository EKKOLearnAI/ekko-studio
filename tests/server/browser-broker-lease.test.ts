import { describe, expect, it, vi } from 'vitest'
import {
  BrokerLeaseTable,
  CLIENT_IDLE_TTL_MS,
  LEASE_OWNERSHIP_MESSAGE,
  LEASE_SWEEP_GRACE_MS,
  LEASE_TTL_MS,
  TAKEOVER_CANCEL_MESSAGE,
  isProcessAlive,
} from '../../packages/server/src/modules/studio/services/browser/broker-lease'

function createTable(overrides: { now?: () => number } = {}) {
  const revoked: string[] = []
  const cancelled: string[] = []
  const table = new BrokerLeaseTable({
    revokeAgentControl: tabId => revoked.push(tabId),
    cancelTab: tabId => cancelled.push(tabId),
    ...overrides,
  })
  return { table, revoked, cancelled }
}

describe('broker lease table', () => {
  it(`leases a tab for ${LEASE_TTL_MS}ms and refreshes on repeat claims`, () => {
    let now = 1_000
    const { table } = createTable({ now: () => now })

    table.claim('tab-1', 'client-a', 'navigate')
    expect(table.leaseOf('tab-1')).toEqual({ clientId: 'client-a', expiresAt: 1_000 + LEASE_TTL_MS })

    now += 30_000
    table.claim('tab-1', 'client-a', 'interact')
    expect(table.leaseOf('tab-1')?.expiresAt).toBe(now + LEASE_TTL_MS)
    expect(table.leasedTabIds()).toEqual(['tab-1'])
  })

  it('rejects a live foreign owner with the exact MCP-facing message', () => {
    const { table } = createTable()
    table.registerClient('client-b', 'token-b', process.pid)
    table.claim('tab-1', 'client-b', 'navigate')

    expect(() => table.claim('tab-1', 'client-a', 'interact')).toThrow(
      'Browser tab is controlled by another MCP client; user takeover is required before interact',
    )
  })

  it('takes over the lease when the previous owner process is gone', () => {
    const { table } = createTable()
    // PID 1 is alive but never ours; use an almost certainly dead pid instead.
    table.registerClient('ghost', 'token', 999_999_999)
    table.claim('tab-1', 'ghost', 'navigate')

    table.claim('tab-1', 'client-a', 'snapshot')

    expect(table.leaseOf('tab-1')?.clientId).toBe('client-a')
    expect(table.getClient('ghost')).toBeUndefined()
  })

  it('treats a client without a pid as alive (TTL-based behaviour)', () => {
    const { table } = createTable()
    table.registerClient('legacy', 'token')
    table.claim('tab-1', 'legacy', 'navigate')

    expect(isProcessAlive(undefined)).toBe(true)
    expect(() => table.claim('tab-1', 'client-a', 'navigate')).toThrow(/another MCP client/)
  })

  it('expires the lease after the TTL and revokes agent control', async () => {
    vi.useFakeTimers()
    try {
      const { table, revoked } = createTable()
      table.claim('tab-1', 'client-a', 'navigate')

      await vi.advanceTimersByTimeAsync(LEASE_TTL_MS + LEASE_SWEEP_GRACE_MS + 1)

      expect(table.leaseOf('tab-1')).toBeUndefined()
      expect(revoked).toContain('tab-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('only lets the owner release, and revokes control on release', () => {
    const { table, revoked } = createTable()
    table.claim('tab-1', 'client-a', 'navigate')

    expect(() => table.release('tab-1', 'client-b')).toThrow(LEASE_OWNERSHIP_MESSAGE)

    table.release('tab-1', 'client-a')
    expect(table.leaseOf('tab-1')).toBeUndefined()
    expect(revoked).toContain('tab-1')
  })

  it('bumps the generation and cancels work on user takeover', () => {
    const { table, cancelled, revoked } = createTable()
    table.claim('tab-1', 'client-a', 'navigate')

    const before = table.generationOf('tab-1')
    table.revokeTab('tab-1')

    expect(table.generationOf('tab-1')).toBe(before + 1)
    expect(table.leaseOf('tab-1')).toBeUndefined()
    expect(cancelled).toEqual(['tab-1'])
    // Takeover does not clear agentControl by itself; the cancel path owns that.
    expect(revoked).toEqual([])
    expect(TAKEOVER_CANCEL_MESSAGE).toContain('user takeover')
  })

  it('drops leases that ran past their expiry on cleanup', () => {
    let now = 10_000
    const { table, revoked } = createTable({ now: () => now })
    table.claim('tab-1', 'client-a', 'navigate')

    now += LEASE_TTL_MS + 1
    table.cleanupExpired()

    expect(table.leaseOf('tab-1')).toBeUndefined()
    expect(revoked).toEqual(['tab-1'])
  })

  it('forgets clients that have been idle for 24h', () => {
    let now = 1_000
    const { table } = createTable({ now: () => now })
    table.registerClient('old', 'token')
    table.registerClient('new', 'token')

    now += CLIENT_IDLE_TTL_MS + 1
    table.touchClient('new')
    table.cleanupExpired()

    expect(table.getClient('old')).toBeUndefined()
    expect(table.getClient('new')).toBeDefined()
    expect(table.clientCount()).toBe(1)
  })

  it('clears every timer on dispose so the process can exit', () => {
    const { table } = createTable()
    table.registerClient('client-a', 'token')
    table.claim('tab-1', 'client-a', 'navigate')

    table.dispose()

    expect(table.leasedTabIds()).toEqual([])
    expect(table.clientCount()).toBe(0)
  })
})
