export interface SidecarQueueLimits {
  maxQueued: number
  maxQueuedPerProfile: number
  maxWorkers: number
  maxWorkersPerProfile: number
}

interface Entry { key: string; profile: string; run: () => Promise<void> }

export class JevSidecarQueue {
  private readonly queues = new Map<string, Entry[]>()
  private readonly activeKeys = new Set<string>()
  private readonly activeByProfile = new Map<string, number>()
  private profileCursor = 0
  private active = 0
  private closed = false

  constructor(private readonly limits: SidecarQueueLimits) {}

  enqueue(entry: Entry): 'accepted' | 'duplicate' | 'queue_full' | 'queue_unavailable' {
    if (this.closed) return 'queue_unavailable'
    if (this.activeKeys.has(entry.key)) return 'duplicate'
    const totalQueued = [...this.queues.values()].reduce((sum, queue) => sum + queue.length, 0)
    const queue = this.queues.get(entry.profile) ?? []
    if (totalQueued >= this.limits.maxQueued || queue.length >= this.limits.maxQueuedPerProfile) return 'queue_full'
    queue.push(entry)
    this.queues.set(entry.profile, queue)
    this.activeKeys.add(entry.key)
    queueMicrotask(() => this.pump())
    return 'accepted'
  }

  close(): void {
    this.closed = true
    for (const queue of this.queues.values()) for (const entry of queue) this.activeKeys.delete(entry.key)
    this.queues.clear()
  }

  status() { return { queued: [...this.queues.values()].reduce((sum, queue) => sum + queue.length, 0), active: this.active, closed: this.closed } }

  private pump(): void {
    while (!this.closed && this.active < this.limits.maxWorkers) {
      const profiles = [...this.queues.keys()].filter(profile => (this.queues.get(profile)?.length ?? 0) > 0)
      if (!profiles.length) return
      let selected: string | undefined
      for (let offset = 0; offset < profiles.length; offset += 1) {
        const profile = profiles[(this.profileCursor + offset) % profiles.length]
        if ((this.activeByProfile.get(profile) ?? 0) < this.limits.maxWorkersPerProfile) {
          selected = profile
          this.profileCursor = (this.profileCursor + offset + 1) % profiles.length
          break
        }
      }
      if (!selected) return
      const queue = this.queues.get(selected)!
      const entry = queue.shift()!
      if (!queue.length) this.queues.delete(selected)
      this.active += 1
      this.activeByProfile.set(selected, (this.activeByProfile.get(selected) ?? 0) + 1)
      void entry.run().catch(() => undefined).finally(() => {
        this.active -= 1
        this.activeKeys.delete(entry.key)
        const count = (this.activeByProfile.get(selected!) ?? 1) - 1
        if (count) this.activeByProfile.set(selected!, count); else this.activeByProfile.delete(selected!)
        this.pump()
      })
    }
  }
}

export class JevPhysicalSlots {
  private global = 0
  private readonly byProfile = new Map<string, number>()
  constructor(private readonly globalLimit: number, private readonly perProfileLimit: number) {}
  tryAcquire(profile: string): (() => void) | null {
    if (this.global >= this.globalLimit || (this.byProfile.get(profile) ?? 0) >= this.perProfileLimit) return null
    this.global += 1
    this.byProfile.set(profile, (this.byProfile.get(profile) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      this.global -= 1
      const count = (this.byProfile.get(profile) ?? 1) - 1
      if (count) this.byProfile.set(profile, count); else this.byProfile.delete(profile)
    }
  }
  get active(): number { return this.global }
}
