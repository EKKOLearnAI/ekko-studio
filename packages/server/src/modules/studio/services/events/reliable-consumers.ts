import { StudioError, type Disposer, type EventEnvelope, type ExecutionContext } from '../../contracts/plugins'
import { PluginConsumerStore, type ConsumerDelivery, type ConsumerRecord } from '../../repositories/plugin-consumer-store'

interface ConsumerBinding {
  context(event: EventEnvelope, signal: AbortSignal): Promise<ExecutionContext>
  deliver(event: EventEnvelope, context: ExecutionContext): Promise<void>
  /** Terminate a worker that did not finish in time before it can be reactivated. */
  deadline(): Promise<void>
  available?(): boolean
}
interface Mount { binding: ConsumerBinding; controllers: Set<AbortController>; tasks: Set<Promise<void>>; positions: Set<number> }

/** Poll the committed outbox, including events whose process died before notification. */
export class ReliablePluginConsumers {
  private readonly mounts = new Map<string, Mount>()
  private readonly timer: ReturnType<typeof setInterval>
  private lastRetention: number
  private closed = false
  private tasks = 0
  constructor(readonly store: PluginConsumerStore, private readonly options: {
    intervalMs?: number; timeoutMs?: number; now?: () => number; onError?: () => void
  } = {}) {
    this.lastRetention = this.now()
    this.timer = setInterval(() => { try { this.poll() } catch { this.options.onError?.() } }, options.intervalMs ?? 250)
    this.timer.unref?.()
  }

  mount(record: ConsumerRecord, binding: ConsumerBinding): Disposer {
    if (this.closed) throw new StudioError('PLUGIN_UNAVAILABLE', 'Consumers are closed')
    if (this.mounts.has(record.id)) throw new StudioError('REGISTRATION_CONFLICT', 'Consumer is already mounted')
    const mount: Mount = { binding, controllers: new Set(), tasks: new Set(), positions: new Set() }
    this.mounts.set(record.id, mount)
    return async () => {
      if (this.mounts.get(record.id) === mount) this.mounts.delete(record.id)
      for (const controller of mount.controllers) controller.abort(new StudioError(binding.available?.() === false ? 'PLUGIN_UNAVAILABLE' : 'CANCELLED', 'Consumer unloaded'))
      await Promise.allSettled([...mount.tasks])
    }
  }

  poll(): void {
    if (this.closed) return
    const now = this.now()
    if (now - this.lastRetention >= 60_000) {
      this.store.events.prune(now - 7 * 24 * 60 * 60 * 1000)
      this.lastRetention = now
    }
    for (const [id, mount] of this.mounts) {
      this.store.fill(id)
      while (mount.tasks.size < 4 && this.tasks < 64) {
        const delivery = this.store.claim(id, now, this.options.timeoutMs ?? 30_000, 5, [...mount.positions])
        if (!delivery) break
        const controller = new AbortController()
        mount.controllers.add(controller); mount.positions.add(delivery.position); this.tasks++
        const task = this.deliver(mount, delivery, controller).catch(() => this.options.onError?.()).finally(() => {
          mount.controllers.delete(controller); mount.tasks.delete(task); mount.positions.delete(delivery.position); this.tasks--
        })
        mount.tasks.add(task)
      }
    }
  }

  control(id: string, action: 'pause' | 'resume' | 'reset-now', revision: number): ConsumerRecord {
    const record = this.store.control(id, action, revision)
    if (action !== 'resume') for (const controller of this.mounts.get(id)?.controllers || []) controller.abort(new StudioError('CANCELLED', 'Consumer was paused or reset'))
    return record
  }

  requireRecord(pluginId: string, profileId: string, id: string): ConsumerRecord {
    const record = this.store.get(id)
    if (!record || record.pluginId !== pluginId || record.profileId !== profileId) throw new StudioError('NOT_FOUND', 'Consumer is unavailable')
    return record
  }

  async idle(): Promise<void> { await Promise.allSettled([...this.mounts.values()].flatMap(mount => [...mount.tasks])) }
  async close(): Promise<void> {
    this.closed = true; clearInterval(this.timer)
    const mounts = [...this.mounts.values()]; this.mounts.clear()
    for (const mount of mounts) for (const controller of mount.controllers) controller.abort(new StudioError('CANCELLED', 'Consumers closed'))
    await Promise.allSettled(mounts.flatMap(mount => [...mount.tasks]))
  }

  private async deliver(mount: Mount, delivery: ConsumerDelivery, controller: AbortController): Promise<void> {
    const timeout = setTimeout(() => controller.abort(new StudioError('DEADLINE_EXCEEDED', 'Consumer deadline exceeded')), this.options.timeoutMs ?? 30_000)
    timeout.unref?.()
    let aborted!: () => void, authorized = false
    const cancelled = new Promise<never>((_, reject) => {
      aborted = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', aborted, { once: true })
    })
    try {
      await Promise.race([cancelled, (async () => {
        const context = await mount.binding.context(delivery.event, controller.signal)
        if (controller.signal.aborted) throw controller.signal.reason
        authorized = true
        await mount.binding.deliver(delivery.event, context)
      })()])
      this.store.ack(delivery)
    } catch (error) {
      const code = error instanceof StudioError ? error.code : 'INTERNAL'
      if (code === 'DEADLINE_EXCEEDED') controller.abort(error)
      // A revoked resource is filtered on replay, not exposed to plugin code or diagnostics.
      if (!authorized && (code === 'FORBIDDEN' || code === 'NOT_FOUND')) this.store.ack(delivery)
      else this.store.fail(delivery, code, this.now(), 5, code === 'CANCELLED' && controller.signal.aborted)
      if (code === 'DEADLINE_EXCEEDED') await mount.binding.deadline()
    } finally {
      clearTimeout(timeout); controller.signal.removeEventListener('abort', aborted); controller.abort()
    }
  }
  private now(): number { return (this.options.now || Date.now)() }
}
