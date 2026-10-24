import { randomUUID } from 'node:crypto'

export const DESKTOP_BROWSER_IDLE_MS = 10 * 60 * 1000
export const DESKTOP_BROWSER_METHODS = new Set([
  'state', 'tabs.list', 'tabs.create', 'tabs.activate', 'tabs.close', 'lease.release',
  'navigate', 'navigation.action', 'snapshot', 'text.read', 'interact', 'interact.batch',
  'screenshot', 'console.read', 'console.clear', 'upload', 'wait', 'download.start', 'download.read',
  'dialog', 'network.read', 'network.clear',
])
// Uploads carry base64 file content (Desktop caps files at 10 MB); other requests stay small.
const MAX_REQUEST_CHARS = 1_000_000
const MAX_UPLOAD_REQUEST_CHARS = 16_000_000
export type DesktopBrowserOwnerState = 'active' | 'standby' | 'busy'
type RelayPeer = {
  id: string
  userId: number
  profile: string
  request: (body: Record<string, unknown>) => Promise<unknown>
  revoke: () => void
  ownerState?: (state: DesktopBrowserOwnerState) => void
}
type Connection = { peer: RelayPeer; lastActivity: number; inFlight: number }
type Group = { ownerId: string | null; epoch: number; bindings: Map<string, { id: string; epoch: number }> }

/** Server-clock activity, never heartbeat/Agent activity. Bindings never silently retarget. */
export class DesktopBrowserRelayRegistry {
  private peers = new Map<string, Connection>()
  private groups = new Map<string, Group>()
  constructor(private readonly now: () => number = Date.now) {}

  private group(userId: number, profile: string): Group {
    const key = JSON.stringify([userId, profile])
    let group = this.groups.get(key)
    if (!group) { group = { ownerId: null, epoch: 0, bindings: new Map() }; this.groups.set(key, group) }
    return group
  }
  private notify(userId: number, profile: string): void {
    const group = this.group(userId, profile)
    const owner = group.ownerId ? this.peers.get(group.ownerId) : undefined
    for (const { peer } of this.peers.values()) {
      if (peer.userId === userId && peer.profile === profile) {
        peer.ownerState?.(peer.id === group.ownerId ? 'active' : owner?.inFlight ? 'busy' : 'standby')
      }
    }
  }
  register(peer: RelayPeer): () => void {
    // An id is a connection capability, not a reusable device name.
    if (this.peers.has(peer.id)) throw new Error('Desktop browser connection already registered')
    this.peers.set(peer.id, { peer, lastActivity: this.now(), inFlight: 0 })
    this.activity(peer.id)
    return () => {
      if (this.peers.get(peer.id)?.peer !== peer) return
      this.peers.delete(peer.id)
      const group = this.group(peer.userId, peer.profile)
      if (group.ownerId === peer.id) { group.ownerId = null; group.epoch++ }
      // Keep tombstones so a disconnected run cannot jump to another browser.
      peer.revoke()
      this.notify(peer.userId, peer.profile)
    }
  }
  activity(id: string): void {
    const connection = this.peers.get(id)
    if (!connection) return
    const { peer } = connection
    const group = this.group(peer.userId, peer.profile)
    const owner = group.ownerId ? this.peers.get(group.ownerId) : undefined
    const idle = !owner || this.now() - owner.lastActivity >= DESKTOP_BROWSER_IDLE_MS
    connection.lastActivity = this.now()
    if (group.ownerId !== id && idle && !owner?.inFlight) { group.ownerId = id; group.epoch++ }
    this.notify(peer.userId, peer.profile)
  }
  async request(userId: number, profile: string, input: Record<string, unknown>, bindingId?: string): Promise<unknown> {
    if (typeof input.method !== 'string' || !DESKTOP_BROWSER_METHODS.has(input.method)) throw new Error('Unsupported browser method')
    const limit = input.method === 'upload' ? MAX_UPLOAD_REQUEST_CHARS : MAX_REQUEST_CHARS
    if (JSON.stringify(input).length > limit) throw new Error(`Browser request exceeds ${limit / 1_000_000} MB`)
    const group = this.group(userId, profile)
    const bound = bindingId ? group.bindings.get(bindingId) : undefined
    let targetId = bound?.id
    if (bound && (bound.epoch !== group.epoch || targetId !== group.ownerId || !this.peers.has(bound.id))) {
      throw new Error('This browser run lost its original Desktop target. Start a new run after selecting the intended Desktop.')
    }
    targetId ||= group.ownerId || undefined
    const connection = targetId ? this.peers.get(targetId) : undefined
    if (!connection) throw new Error('No authorized active Desktop browser. Enable remote control and interact with the intended Desktop.')
    if (bindingId && !group.bindings.has(bindingId)) {
      // Never evict live/tombstone bindings and accidentally retarget an old run.
      if (group.bindings.size >= 10000) throw new Error('Browser run binding capacity reached. Restart the Studio service to clear old bindings.')
      group.bindings.set(bindingId, { id: connection.peer.id, epoch: group.epoch })
    }
    connection.inFlight++
    this.notify(userId, profile)
    try {
      const result = await connection.peer.request({ method: input.method, params: input.params || {}, operation_id: randomUUID() })
      if (this.peers.get(connection.peer.id) !== connection || group.ownerId !== connection.peer.id) throw new Error('Desktop browser disconnected during operation')
      return result
    } finally {
      connection.inFlight--
      // Do not apply an old standby activity after completion: require a new user gesture.
      this.notify(userId, profile)
    }
  }
}
export const desktopBrowserRelays = new DesktopBrowserRelayRegistry()
