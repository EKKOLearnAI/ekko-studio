import { StudioError, type Disposer, type EventEnvelope, type ExecutionContext, type StudioEventMap, type EventHandler } from '../../contracts/plugins'
import { jsonCopy } from '../plugins/validation'

export interface EventSubscriptionScope {
  profileId?: string
  context(event: EventEnvelope, signal: AbortSignal): Promise<ExecutionContext>
}

interface Subscription {
  type: string
  accepting: boolean
  pending: number
  once: boolean
  claimed: boolean
  scope: EventSubscriptionScope
  controller: AbortController
  partitions: Map<string, Promise<void>>
  handler(event: EventEnvelope, ctx: ExecutionContext): void | Promise<void>
}

/** Volatile, bounded notifications. Durable delivery belongs to the event outbox. */
export class PluginEventBus {
  private readonly subscriptions = new Set<Subscription>()

  constructor(private readonly options: {
    maxPending?: number
    timeoutMs?: number
    onError?: (error: unknown) => void
  } = {}) {}

  subscribe<K extends keyof StudioEventMap>(type: K, scope: EventSubscriptionScope, handler: EventHandler<K>, once = false): Disposer {
    const subscription: Subscription = {
      type, scope, once, claimed: false, accepting: true, pending: 0,
      controller: new AbortController(), partitions: new Map(),
      handler: handler as Subscription['handler'],
    }
    this.subscriptions.add(subscription)
    return () => {
      subscription.accepting = false
      subscription.controller.abort()
      this.subscriptions.delete(subscription)
    }
  }

  publish(input: EventEnvelope): void {
    const event = jsonCopy(input)
    for (const subscriber of this.subscriptions) {
      if (!subscriber.accepting || subscriber.type !== event.type || (subscriber.scope.profileId !== undefined && subscriber.scope.profileId !== event.subject.profileId)) continue
      if (subscriber.pending >= (this.options.maxPending ?? 128)) {
        subscriber.accepting = false
        subscriber.controller.abort()
        this.subscriptions.delete(subscriber)
        this.report(new StudioError('RESOURCE_EXHAUSTED', 'Plugin event subscription queue is full'))
        continue
      }
      subscriber.pending++
      const predecessor = subscriber.partitions.get(event.partitionKey) || Promise.resolve()
      const pending = predecessor.then(() => this.deliver(subscriber, event)).catch(error => this.report(error)).finally(() => {
        subscriber.pending--
        if (subscriber.partitions.get(event.partitionKey) === pending) subscriber.partitions.delete(event.partitionKey)
        if (subscriber.once && subscriber.claimed && subscriber.pending === 0) this.subscriptions.delete(subscriber)
      })
      subscriber.partitions.set(event.partitionKey, pending)
    }
  }

  private async deliver(subscription: Subscription, event: EventEnvelope): Promise<void> {
    if (subscription.controller.signal.aborted || subscription.claimed) return
    const controller = new AbortController()
    const abort = () => controller.abort()
    subscription.controller.signal.addEventListener('abort', abort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        (async () => {
          const context = await subscription.scope.context(event, controller.signal)
          if (controller.signal.aborted || subscription.claimed) return
          if (subscription.once) { subscription.claimed = true; subscription.accepting = false }
          await subscription.handler(jsonCopy(event), context)
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new StudioError('DEADLINE_EXCEEDED', 'Plugin event callback timed out'))
          }, this.options.timeoutMs ?? 5_000)
          timer.unref?.()
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
      controller.abort()
      subscription.controller.signal.removeEventListener('abort', abort)
    }
  }

  async idle(): Promise<void> {
    await Promise.all([...this.subscriptions].flatMap(subscription => [...subscription.partitions.values()]))
  }

  close(): void {
    for (const subscription of this.subscriptions) subscription.controller.abort()
    this.subscriptions.clear()
  }

  private report(error: unknown): void {
    try { this.options.onError?.(error) } catch { /* Diagnostics cannot stop business events. */ }
  }
}
