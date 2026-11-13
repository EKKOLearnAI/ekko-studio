/**
 * Lease table, client registry and abort generations for the Web Broker
 * (spec-05 acceptance 15-21).
 *
 * Semantics are transcribed from the Electron broker: one lease per tab,
 * `LEASE_TTL_MS` validity, a sweep timer 25ms after expiry that also revokes
 * `agentControl`, stale-owner takeover based on `process.kill(pid, 0)` with
 * `EPERM` treated as alive, and a per-tab generation that is bumped by user
 * takeover so an in-flight operation aborts.
 */

export const LEASE_TTL_MS = 60_000
export const LEASE_SWEEP_GRACE_MS = 25
export const CLIENT_IDLE_TTL_MS = 24 * 60 * 60 * 1000

export const LEASE_CONFLICT_PREFIX = 'Browser tab is controlled by another MCP client'
export const LEASE_OWNERSHIP_MESSAGE = 'Browser tab lease belongs to another MCP client'
export const TAKEOVER_CANCEL_MESSAGE = 'Browser operation was cancelled by user takeover'

export interface BrokerLease {
  clientId: string
  expiresAt: number
}

export interface BrokerLeaseClient {
  token: string
  lastSeenAt: number
  pid?: number
}

export interface BrokerLeaseTableOptions {
  /** Called when a lease ends by TTL, release or takeover. */
  revokeAgentControl?: (tabId: string) => void
  /** Called on user takeover so in-flight work for the tab stops. */
  cancelTab?: (tabId: string) => void
  now?: () => number
}

export function isProcessAlive(pid: number | null | undefined): boolean {
  // Older clients do not report a PID, so a TTL-based lease is retained for them.
  if (!pid || !Number.isInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class BrokerLeaseTable {
  private readonly leases = new Map<string, BrokerLease>()
  private readonly leaseTimers = new Map<string, NodeJS.Timeout>()
  private readonly clients = new Map<string, BrokerLeaseClient>()
  private readonly generations = new Map<string, number>()
  private readonly options: BrokerLeaseTableOptions
  private readonly now: () => number

  constructor(options: BrokerLeaseTableOptions = {}) {
    this.options = options
    this.now = options.now ?? (() => Date.now())
  }

  registerClient(clientId: string, token: string, pid?: number): void {
    const client: BrokerLeaseClient = { token, lastSeenAt: this.now() }
    if (pid !== undefined) client.pid = pid
    this.clients.set(clientId, client)
  }

  getClient(clientId: string): BrokerLeaseClient | undefined {
    return this.clients.get(clientId)
  }

  touchClient(clientId: string): void {
    const client = this.clients.get(clientId)
    if (client) client.lastSeenAt = this.now()
  }

  clientCount(): number {
    return this.clients.size
  }

  generationOf(tabId: string): number {
    return this.generations.get(tabId) ?? 0
  }

  leaseOf(tabId: string): BrokerLease | undefined {
    return this.leases.get(tabId)
  }

  leasedTabIds(): string[] {
    return [...this.leases.keys()]
  }

  /**
   * Take (or refresh) the lease for a tab. A live foreign owner is a hard
   * conflict whose message is relied upon by the MCP layer; a dead owner is
   * treated as stale and taken over.
   */
  claim(tabId: string, clientId: string, method: string): void {
    const lease = this.leases.get(tabId)
    if (lease && lease.expiresAt > this.now() && lease.clientId !== clientId) {
      if (this.clientProcessIsAlive(lease.clientId)) {
        throw new Error(
          `${LEASE_CONFLICT_PREFIX}; user takeover is required before ${method}`,
        )
      }
      this.clearLease(tabId, false)
      this.clients.delete(lease.clientId)
    }

    this.leases.set(tabId, { clientId, expiresAt: this.now() + LEASE_TTL_MS })
    const previousTimer = this.leaseTimers.get(tabId)
    if (previousTimer) clearTimeout(previousTimer)

    const timer = setTimeout(() => {
      const current = this.leases.get(tabId)
      if (!current || current.clientId !== clientId || current.expiresAt > this.now()) return
      this.clearLease(tabId, true)
    }, LEASE_TTL_MS + LEASE_SWEEP_GRACE_MS)
    timer.unref?.()
    this.leaseTimers.set(tabId, timer)
  }

  release(tabId: string, clientId: string): void {
    const lease = this.leases.get(tabId)
    if (lease && lease.clientId !== clientId) throw new Error(LEASE_OWNERSHIP_MESSAGE)
    this.clearLease(tabId, true)
  }

  /** User takeover: bump the generation, drop the lease, cancel in-flight work. */
  revokeTab(tabId: string): void {
    this.generations.set(tabId, (this.generations.get(tabId) ?? 0) + 1)
    this.clearLease(tabId, false)
    this.options.cancelTab?.(tabId)
  }

  revokeAll(tabIds: Iterable<string>): void {
    for (const tabId of new Set(tabIds)) this.revokeTab(tabId)
  }

  /** Drop TTL-expired leases and clients idle for 24h. */
  cleanupExpired(): void {
    const current = this.now()
    for (const [tabId, lease] of [...this.leases.entries()]) {
      if (lease.expiresAt > current) continue
      this.clearLease(tabId, true)
    }
    for (const [clientId, client] of [...this.clients.entries()]) {
      if (current - client.lastSeenAt > CLIENT_IDLE_TTL_MS) this.clients.delete(clientId)
    }
  }

  /** Clear every timer; used on shutdown so the process can exit. */
  dispose(): void {
    for (const timer of this.leaseTimers.values()) clearTimeout(timer)
    this.leaseTimers.clear()
    this.leases.clear()
    this.clients.clear()
    this.generations.clear()
  }

  private clearLease(tabId: string, revokeControl: boolean): void {
    const timer = this.leaseTimers.get(tabId)
    if (timer) clearTimeout(timer)
    this.leaseTimers.delete(tabId)
    this.leases.delete(tabId)
    if (revokeControl) this.options.revokeAgentControl?.(tabId)
  }

  private clientProcessIsAlive(clientId: string): boolean {
    return isProcessAlive(this.clients.get(clientId)?.pid)
  }
}
