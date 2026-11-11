/** Studio plugin API v1. These contracts are shared by the host and browser. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Dispose = () => void | Promise<void>
export interface Schema {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  title?: string
  description?: string
  properties?: Record<string, Schema>
  required?: string[]
  additionalProperties?: boolean
  items?: Schema
  enum?: Json[]
  default?: Json
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  maxItems?: number
  secret?: boolean
}
export type Capability = 'api.read' | 'api.write' | 'tools' | 'commands' | 'events' | 'hooks' | 'automation' | 'ui' | 'storage.client'
export interface PluginManifest {
  id: string
  name: string
  version: string
  apiVersion: 1
  description?: string
  server?: string
  /** A bundled ES module exporting mount(element, ctx), optionally returning a disposer. */
  client?: string
  capabilities: Capability[]
  configSchema?: Schema
  dependencies?: Record<string, string>
  views?: Array<{ id: string; title: string; slot: 'page' | 'sidebar' | 'message' | 'settings' }>
}
export interface PluginIdentity {
  readonly userId: number
  readonly profile: string
  readonly sessionId?: string
  readonly runId?: string
  readonly runtime?: string
  readonly surface?: string
  readonly workspace?: string
}
export interface ApiRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  query?: Record<string, string | number | boolean | undefined>
  body?: Json
}
export interface StudioApi {
  request<T = Json>(path: string, options?: ApiRequest): Promise<T>
  models: { list(): Promise<Json>; respond(input: Record<string, Json>): Promise<Json> }
  studio: {
    sessions: { list(): Promise<Json>; get(id: string): Promise<Json> }
    workflows: { list(): Promise<Json>; run(id: string, input?: string): Promise<Json> }
    files: { list(path?: string): Promise<Json>; read(path: string): Promise<Json> }
  }
}
export interface PluginStorage {
  /** Select an explicit, cumulative namespace. Namespaces organize data; they are not access controls. */
  namespace(...segments: string[]): PluginStorage
  get<T extends Json = Json>(key: string): Promise<T | undefined>
  set(key: string, value: Json): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}
export interface PluginEvent {
  id: string
  type: string
  timestamp: number
  identity: PluginIdentity
  data: Json
  audience?: 'caller' | 'plugin'
}
export interface ToolResult { ok: boolean; content: string; data?: Json; error?: string }
export interface RunContext {
  readonly identity: PluginIdentity
  readonly signal: AbortSignal
  readonly capabilities: readonly string[]
  readonly api: StudioApi
  readonly models: StudioApi['models']
  readonly storage: PluginStorage
  readonly config: Readonly<Record<string, Json>>
  session: { get(): Promise<Json> }
  workspace: { read(path: string): Promise<Json>; write(path: string, content: string): Promise<Json> }
  tools: { call(name: string, input: Record<string, Json>): Promise<ToolResult> }
  ui: { notify(message: string, level?: 'info' | 'error' | 'success'): void; emit(type: string, data: Json, options?: { audience?: 'caller' | 'plugin' }): void }
}
export interface PluginTool {
  name: string
  description: string
  inputSchema: Schema
  /** Every tool is a mutating operation unless explicitly marked readOnly. */
  readOnly?: boolean
  execute(input: Record<string, Json>, ctx: RunContext): Promise<ToolResult>
}
export interface PluginCommand {
  name: string
  description: string
  execute(args: string, ctx: RunContext): Promise<Json | void>
}
export interface PluginAction {
  name: string
  description: string
  inputSchema: Schema
  execute(input: Record<string, Json>, ctx: RunContext): Promise<Json>
}
export type PluginHook = 'input.transform' | 'context.transform' | 'tool.before' | 'tool.after'
export interface HookResult { value?: Json; deny?: string }
export interface PluginContext {
  readonly plugin: Readonly<PluginManifest>
  /** Current caller inside a handler; activation identity during startup/scheduled work. */
  readonly identity: PluginIdentity
  readonly config: Readonly<Record<string, Json>>
  readonly signal: AbortSignal
  /** Plugin-wide storage, shared with run.storage. Partition explicitly with namespace(). */
  readonly storage: PluginStorage
  readonly api: StudioApi
  readonly models: StudioApi['models']
  log: { info(message: string, data?: Json): void; warn(message: string, data?: Json): void; error(message: string, data?: Json): void }
  tools: { register(tool: PluginTool): Dispose }
  commands: { register(command: PluginCommand): Dispose }
  rpc: { register(name: string, handler: (input: Json, ctx: RunContext) => Promise<Json> | Json): Dispose }
  on(type: string, handler: (event: PluginEvent, ctx: RunContext) => void | Promise<void>): Dispose
  hooks: { register(name: PluginHook, handler: (value: Json, ctx: RunContext) => HookResult | Promise<HookResult>, priority?: number): Dispose }
  automation: {
    register(action: PluginAction): Dispose
    /** One global, non-overlapping timer per plugin; runs as the activating administrator. */
    every(id: string, intervalMs: number, action: string, input?: Record<string, Json>): Dispose
  }
  effect(acquire: () => Dispose | Promise<Dispose>): Promise<Dispose>
  onDispose(dispose: Dispose): void
}
export interface PluginModule { apply(ctx: PluginContext): void | Dispose | Promise<void | Dispose> }
export interface ClientContext {
  readonly plugin: Readonly<PluginManifest>
  readonly identity: PluginIdentity
  readonly view: string
  readonly slot: string
  readonly data: Json
  readonly signal: AbortSignal
  readonly api: StudioApi
  readonly models: StudioApi['models']
  readonly config: Readonly<Record<string, Json>>
  rpc<T extends Json = Json>(name: string, input?: Json): Promise<T>
  /** Requires storage.client; grants browser access to this plugin's entire store, including namespaces. */
  storage: PluginStorage
  events: { on(type: string, handler: (event: PluginEvent) => void): Dispose }
  ui: {
    notify(message: string, level?: 'info' | 'error' | 'success'): void
    confirm(message: string): Promise<boolean>
    prompt(message: string): Promise<string | null>
    navigate(path: string): void
  }
  onDispose(dispose: Dispose): void
}
export interface ClientModule { mount(element: HTMLElement, ctx: ClientContext): void | Dispose | Promise<void | Dispose> }

export function createStudioApi(request: StudioApi['request']): StudioApi {
  const id = encodeURIComponent
  return { request, models: {
    list: () => request('/api/ekko-studio/models/v1/models'),
    respond: input => request('/api/ekko-studio/models/v1/responses', { method: 'POST', body: { ...input, stream: false } }),
  }, studio: {
    sessions: { list: () => request('/api/studio/sessions'), get: value => request(`/api/studio/sessions/${id(value)}`) },
    workflows: { list: () => request('/api/studio/workflows'), run: (value, input) => request(`/api/studio/workflows/${id(value)}/run`, { method: 'POST', body: { ...(input ? { input } : {}) } }) },
    files: { list: (path = '') => request('/api/studio/files/list', { query: { path } }), read: path => request('/api/studio/files/read', { query: { path } }) },
  } }
}
