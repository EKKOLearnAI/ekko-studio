import { performance } from 'node:perf_hooks'
import {
  StudioError, type HookPoint, type HookOptions, type HookSnapshot, type HookInputMap,
  type ExecutionContext, type JsonValue, type Disposer, type AgentRunStartInput,
} from '../../contracts/plugins'
import { jsonCopy } from '../plugins/validation'

export interface HookRegistration { point: HookPoint; options: Required<HookOptions> }
export function parseHookRegistration(input: unknown): HookRegistration {
  const value = input as HookRegistration
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['point', 'options'].includes(key))
    || !['runs.start', 'sessions.remove'].includes(value.point) || !value.options || typeof value.options !== 'object' || Array.isArray(value.options)
    || Object.keys(value.options).some(key => !['key', 'priority'].includes(key)) || typeof value.options.key !== 'string'
    || !/^[a-z][a-z0-9.-]{0,127}$/.test(value.options.key)
    || (value.options.priority !== undefined && (!Number.isSafeInteger(value.options.priority) || Math.abs(value.options.priority) > 1000))) {
    throw new StudioError('INVALID_ARGUMENT', 'Invalid hook declaration')
  }
  return { point: value.point, options: { key: value.options.key, priority: value.options.priority ?? 0 } }
}

export const HOOK_READ_CAPABILITIES = new Set(['models.read', 'agents.read', 'sessions.read', 'runs.read', 'chat.read', 'workflows.read'])
export function authorizeHookOperation(capability: string): void {
  if (!HOOK_READ_CAPABILITIES.has(capability)) throw new StudioError('FORBIDDEN', 'Hook contexts only permit queries')
}
interface Entry {
  snapshot: HookSnapshot; profileId: string; controller: AbortController
  invoke(input: JsonValue, context: ExecutionContext): Promise<JsonValue>
}
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}

/** Hook order is captured before the first callback and never changes mid-admission. */
export class PluginHookRegistry {
  private readonly entries = new Set<Entry>()
  private callbacks = 0
  constructor(private readonly options: { timeoutMs?: number; chainTimeoutMs?: number } = {}) {}

  validate(profileId: string, pluginId: string, declarations: unknown[]): HookRegistration[] {
    const parsed = declarations.map(parseHookRegistration), keys = new Set<string>()
    if (parsed.length > 32 || [...this.entries].filter(entry => entry.profileId === profileId).length + parsed.length > 128) throw new StudioError('RESOURCE_EXHAUSTED', 'Hook registration limit reached')
    for (const declaration of parsed) {
      const key = JSON.stringify([declaration.point, declaration.options.key])
      if (keys.has(key) || [...this.entries].some(entry => entry.profileId === profileId && entry.snapshot.pluginId === pluginId
        && entry.snapshot.point === declaration.point && entry.snapshot.key === declaration.options.key)) throw new StudioError('REGISTRATION_CONFLICT', 'Duplicate hook key')
      keys.add(key)
    }
    return parsed
  }

  register(profileId: string, pluginId: string, generation: string, declaration: HookRegistration,
    invoke: Entry['invoke']): Disposer {
    const [{ point, options }] = this.validate(profileId, pluginId, [declaration])
    const entry: Entry = { profileId, snapshot: { point, pluginId, generation, ...options }, invoke, controller: new AbortController() }
    this.entries.add(entry)
    return () => { this.entries.delete(entry); entry.controller.abort(new StudioError('PLUGIN_UNAVAILABLE', 'Hook provider ended')) }
  }

  has(profileId: string, point: HookPoint): boolean { return [...this.entries].some(entry => entry.profileId === profileId && entry.snapshot.point === point) }

  async run<K extends HookPoint>(point: K, input: HookInputMap[K], context: ExecutionContext): Promise<{ input: HookInputMap[K]; snapshot: HookSnapshot[] }> {
    const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0
    const chain = [...this.entries].filter(entry => entry.profileId === context.scope.profileId && entry.snapshot.point === point)
      .sort((a, b) => b.snapshot.priority - a.snapshot.priority || compare(a.snapshot.pluginId, b.snapshot.pluginId) || compare(a.snapshot.key, b.snapshot.key))
    let current = jsonCopy(input)
    const snapshot = chain.map(entry => jsonCopy(entry.snapshot)), end = performance.now() + (this.options.chainTimeoutMs ?? 5_000)
    for (const entry of chain) {
      const remaining = end - performance.now()
      if (remaining <= 0) throw new StudioError('DEADLINE_EXCEEDED', 'Hook chain deadline exceeded')
      if (this.callbacks >= 128) throw new StudioError('RESOURCE_EXHAUSTED', 'Hook callback limit reached')
      const controller = new AbortController()
      const signal = AbortSignal.any([context.signal, entry.controller.signal, controller.signal])
      if (signal.aborted) throw signal.reason instanceof StudioError ? signal.reason : new StudioError('CANCELLED', 'Hook caller ended')
      this.callbacks++
      const timer = setTimeout(() => controller.abort(new StudioError('DEADLINE_EXCEEDED', 'Hook deadline exceeded')), Math.min(remaining, this.options.timeoutMs ?? 2_000))
      timer.unref?.()
      let abort!: () => void
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason instanceof StudioError ? signal.reason : new StudioError('CANCELLED', 'Hook caller ended'))
        signal.addEventListener('abort', abort, { once: true })
      })
      try {
        const result = await Promise.race([entry.invoke(freeze(jsonCopy(current)) as unknown as JsonValue, { ...context, signal }), cancelled])
        if (signal.aborted) throw signal.reason instanceof StudioError ? signal.reason : new StudioError('CANCELLED', 'Hook caller ended')
        current = this.apply(point, current, result)
      } catch (error) { throw error instanceof StudioError ? error : new StudioError('INTERNAL', 'Hook callback failed') }
      finally { this.callbacks--; clearTimeout(timer); signal.removeEventListener('abort', abort); controller.abort() }
    }
    if (context.signal.aborted) throw new StudioError('CANCELLED', 'Hook caller ended')
    return { input: current, snapshot }
  }

  private apply<K extends HookPoint>(point: K, input: HookInputMap[K], value: JsonValue): HookInputMap[K] {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !['continue', 'reject', 'patch'].includes(String(value.action))
      || Object.keys(value).some(key => key !== 'action' && !(value.action === 'patch' && key === 'patch'))) throw new StudioError('INVALID_ARGUMENT', 'Invalid hook result')
    if (value.action === 'reject') throw new StudioError('FORBIDDEN', 'Operation rejected by a plugin hook')
    if (value.action === 'continue') return input
    const patch = value.patch
    if (point !== 'runs.start' || !patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length
      || Object.keys(patch).some(key => !['content', 'timeoutMs'].includes(key))) throw new StudioError('INVALID_ARGUMENT', 'Hook patch is not allowed')
    const request = input as AgentRunStartInput
    if (patch.timeoutMs !== undefined && (!Number.isSafeInteger(patch.timeoutMs) || Number(patch.timeoutMs) < 100
      || Number(patch.timeoutMs) > (request.input.timeoutMs ?? 600_000))) throw new StudioError('INVALID_ARGUMENT', 'Hook cannot increase the run budget')
    if (patch.content !== undefined && (!Array.isArray(patch.content) || !patch.content.length || patch.content.length > 100
      || patch.content.some(block => !block || typeof block !== 'object' || Array.isArray(block) || block.type !== 'text' || typeof block.text !== 'string'
        || Object.keys(block).some(key => !['type', 'text'].includes(key))))) throw new StudioError('INVALID_ARGUMENT', 'Invalid hook content patch')
    return { ...request, input: { ...request.input, ...jsonCopy(patch) } } as HookInputMap[K]
  }
}
