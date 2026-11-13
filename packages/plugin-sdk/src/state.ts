import type { Json } from './core'

export interface PluginStorage {
  /** Select an explicit, cumulative namespace. Namespaces organize data; they are not access controls. */
  namespace(...segments: string[]): PluginStorage
  get<T extends Json = Json>(key: string): Promise<T | undefined>
  set(key: string, value: Json): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}

/** Explicit data scopes; namespaces organize records, not access controls. */
export interface PluginState {
  readonly plugin: PluginStorage
  readonly user: PluginStorage
  readonly profile: PluginStorage
  readonly session?: PluginStorage
  readonly agentSession?: PluginStorage
}
