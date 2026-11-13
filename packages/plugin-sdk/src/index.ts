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
export type * from './agents'
export type Capability = 'api.read' | 'api.write' | 'tools' | 'commands' | 'events' | 'hooks' | 'automation' | 'ui' | 'storage.client' | 'agents'
/** Host-rendered line icons; settings navigation never accepts images or arbitrary SVG. */
export const PLUGIN_ICON_PATHS = {
  settings: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M8 15v6',
  skills: 'm12 2 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 17l9 5 9-5',
  mcp: 'M5 5h14v10H5zM8 19h8M12 15v4M8 10h.01M12 10h4',
  code: 'm8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
  terminal: 'm5 7 5 5-5 5M13 17h6',
  bot: 'M12 8V4H8M7 8h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3ZM2 14h2M20 14h2M9 13v2M15 13v2',
  folder: 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
  book: 'M12 5v16M3 3h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5v16h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3V3Z',
  chart: 'M3 3v18h18M7 15l4-5 4 3 5-7',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  history: 'M3 12a9 9 0 1 0 3-7M3 3v5h5M12 7v5l3 2',
  chat: 'M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10Z',
} as const
export type PluginIconName = keyof typeof PLUGIN_ICON_PATHS
export interface PluginNavigationEntry {
  viewId: string
  /** Defaults to the target view's title. */
  title?: string
  /** Required: named icon; main navigation also accepts bundled raster images. */
  icon: string
  order?: number
}
export interface PluginSettingsNavigationEntry extends Omit<PluginNavigationEntry, 'icon'> { icon: PluginIconName }
export interface PluginView {
  id: string
  title: string
  /** Page layout only. Global sidebar entries are declared separately in navigation. */
  slot: 'page' | 'settings' | 'workspace' | 'agent-settings'
  icon?: string
  order?: number
}
export interface PluginManifest {
  id: string
  name: string
  version: string
  apiVersion: 1
  description?: string
  author?: { name: string; url?: string }
  repository?: string
  homepage?: string
  documentation?: string
  issues?: string
  changelog?: string
  license?: string
  keywords?: string[]
  /** Relative bundled PNG/JPEG/WebP/GIF, or an inline base64 image. */
  icon?: string
  server?: string
  /** A bundled ES module exporting mount(element, ctx), optionally returning a disposer. */
  client?: string
  capabilities: Capability[]
  /** Omit to share ekko-studio-plugins; otherwise expose tools on this dedicated MCP server. */
  mcp?: { name: string }
  configSchema?: Schema
  dependencies?: Record<string, string>
  views?: PluginView[]
  /** Explicit, independent global entries. Omitted lists expose no sidebar entry. */
  navigation?: { main?: PluginNavigationEntry[]; settings?: PluginSettingsNavigationEntry[] }
  /** Optional dynamic sidebar view, mounted from the same client module. */
  workspace?: { sidebar: string }
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
export type ApiQuery = NonNullable<ApiRequest['query']>
export type JsonObject = Record<string, Json>
export interface SessionCreateInput {
  title?: string
  agent?: string
  mode?: 'scoped' | 'global'
}
export interface StudioApi {
  request<T = Json>(path: string, options?: ApiRequest): Promise<T>
  models: { list(): Promise<Json>; respond(input: Record<string, Json>): Promise<Json> }
  studio: {
    sessions: {
      list(query?: ApiQuery): Promise<Json>; get(id: string): Promise<Json>
      create(input?: SessionCreateInput): Promise<Json>
      /** Returns after the run starts/queues. Set wait:true to wait for completion. */
      run(id: string, input: string | JsonObject[], options?: JsonObject): Promise<Json>
      stop(id: string): Promise<Json>; remove(id: string): Promise<Json>
      rename(id: string, title: string): Promise<Json>
      archive(id: string, archived?: boolean): Promise<Json>
      setModel(id: string, model: JsonObject): Promise<Json>
      setWorkspace(id: string, workspace: string): Promise<Json>
      messages(id: string, query?: ApiQuery): Promise<Json>
    }
    groupChats: {
      list(): Promise<Json>; get(id: string): Promise<Json>
      create(input: JsonObject & { name: string; inviteCode: string }): Promise<Json>
      update(id: string, input: JsonObject): Promise<Json>; remove(id: string): Promise<Json>
      send(id: string, content: string | JsonObject[], mentions?: Json[]): Promise<Json>
      /** Interrupt one named agent using the same permissions as the chat UI. */
      stop(id: string, agentName: string): Promise<Json>
      messages(id: string, query?: ApiQuery): Promise<Json>
      agents: { list(id: string): Promise<Json>; add(id: string, input: JsonObject): Promise<Json>; update(id: string, agentId: string, input: JsonObject): Promise<Json>; remove(id: string, agentId: string): Promise<Json> }
    }
    workflows: {
      list(): Promise<Json>; get(id: string): Promise<Json>
      create(input: JsonObject & { name: string }): Promise<Json>
      update(id: string, input: JsonObject): Promise<Json>; remove(id: string): Promise<Json>
      run(id: string, input?: string): Promise<Json>; stop(id: string, runId: string): Promise<Json>
      runs(id: string): Promise<Json>; getRun(id: string, runId: string): Promise<Json>
      schedules: { list(id: string): Promise<Json>; create(id: string, input: JsonObject): Promise<Json>; update(id: string, scheduleId: string, input: JsonObject): Promise<Json>; remove(id: string, scheduleId: string): Promise<Json> }
    }
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
/** Observations available through ctx.on()/ctx.events.on(); delivery is in-memory. */
export const PLUGIN_EVENT_TYPES = [
  'chat.session.created', 'chat.session.removed', 'chat.message.created', 'chat.message.delta', 'chat.reasoning.delta',
  'chat.run.queued', 'chat.run.started', 'chat.run.updated', 'chat.run.completed', 'chat.run.failed', 'chat.run.stopped',
  'chat.tool.started', 'chat.tool.completed', 'chat.tool.failed', 'chat.plan.updated', 'chat.task.created', 'chat.task.completed',
  'chat.approval.requested', 'chat.approval.resolved', 'chat.clarification.requested', 'chat.clarification.resolved',
  'group.message.created', 'group.message.started', 'group.message.delta', 'group.message.completed', 'group.reasoning.delta',
  'group.run.updated', 'group.run.failed', 'group.run.stopped', 'group.plan.updated',
  'group.approval.requested', 'group.approval.resolved', 'group.clarification.requested', 'group.clarification.resolved',
  'workflow.run.updated', 'workflow.run.started', 'workflow.run.completed', 'workflow.run.failed', 'workflow.run.stopped', 'workflow.plan.updated',
  'person.run.completed', 'person.run.failed', 'person.run.updated',
  'person.approval.requested', 'person.approval.resolved', 'person.clarification.requested', 'person.clarification.resolved',
] as const
export type PluginEventType = typeof PLUGIN_EVENT_TYPES[number]
export type PluginEventPattern = PluginEventType | 'chat.*' | 'group.*' | 'workflow.*' | 'person.*' | '*' | (string & {})
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
  /** Stable host-owned directories, retained across plugin package upgrades. */
  readonly paths: { readonly dataDir: string }
  agents: { register(definition: import('./agents').AgentDefinition): import('./agents').AgentRegistration }
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
  on(type: PluginEventPattern, handler: (event: PluginEvent, ctx: RunContext) => void | Promise<void>): Dispose
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
export interface ClientModelSelection {
  profile: string
  provider: string
  model: string
  apiMode?: 'chat_completions' | 'codex_responses' | 'anthropic_messages' | 'bedrock_converse' | 'codex_app_server'
}
export interface ClientModelPickerOptions {
  current?: Pick<ClientModelSelection, 'provider' | 'model'>
}
export interface ClientContext {
  readonly locale?: string
  readonly plugin: Readonly<PluginManifest>
  readonly identity: PluginIdentity
  readonly view: string
  readonly slot: string
  readonly data: Json
  readonly location: { path: string; query: Record<string, string | string[]> }
  readonly signal: AbortSignal
  readonly api: StudioApi
  readonly models: StudioApi['models']
  readonly config: Readonly<Record<string, Json>>
  rpc<T extends Json = Json>(name: string, input?: Json): Promise<T>
  /** Requires storage.client; grants browser access to this plugin's entire store, including namespaces. */
  storage: PluginStorage
  events: { on(type: PluginEventPattern, handler: (event: PluginEvent) => void): Dispose }
  ui: {
    notify(message: string, level?: 'info' | 'error' | 'success'): void
    confirm(message: string): Promise<boolean>
    prompt(message: string): Promise<string | null>
    /** Open the host picker for this view's Profile. Cancellation returns null; no settings are changed. */
    selectModel(options?: ClientModelPickerOptions): Promise<ClientModelSelection | null>
    navigate(path: string): void
  }
  onDispose(dispose: Dispose): void
}
export interface ClientModule { mount(element: HTMLElement, ctx: ClientContext): void | Dispose | Promise<void | Dispose> }

export function createStudioApi(request: StudioApi['request']): StudioApi {
  const id = encodeURIComponent
  // This entire factory is serialized into the browser iframe; keep helpers local.
  const session = (value: string) => `/api/studio/sessions/${id(value)}`
  const room = (value: string) => `/api/studio/group-chat/rooms/${id(value)}`
  const workflow = (value: string) => `/api/studio/workflows/${id(value)}`
  const post = (path: string, body: Json = {}) => request(path, { method: 'POST', body })
  const remove = (path: string) => request(path, { method: 'DELETE' })
  return { request, models: {
    list: () => request('/api/ekko-studio/models/v1/models'),
    respond: input => request('/api/ekko-studio/models/v1/responses', { method: 'POST', body: { ...input, stream: false } }),
  }, studio: {
    sessions: {
      list: query => request('/api/studio/sessions', query ? { query } : undefined), get: value => request(session(value)),
      create: (input = {}) => post('/api/studio/sessions', { ...input }),
      run: (value, input, options = {}) => post('/api/studio/chat-run/runs', { wait: false, ...options, session_id: value, input }),
      stop: value => post(`${session(value)}/stop`), remove: value => remove(session(value)),
      rename: (value, title) => post(`${session(value)}/rename`, { title }),
      archive: (value, archived = true) => post(`${session(value)}/${archived ? 'archive' : 'unarchive'}`),
      setModel: (value, model) => post(`${session(value)}/model`, model),
      setWorkspace: (value, workspace) => post(`${session(value)}/workspace`, { workspace }),
      messages: (value, query) => request(`/api/studio/sessions/conversations/${id(value)}/messages/paginated`, { query }),
    },
    groupChats: {
      list: () => request('/api/studio/group-chat/rooms'), get: value => request(room(value)),
      create: input => post('/api/studio/group-chat/rooms', input),
      update: (value, input) => request(`${room(value)}/config`, { method: 'PUT', body: input }), remove: value => remove(room(value)),
      send: (value, content, mentions) => post(`${room(value)}/messages`, { content, ...(mentions ? { mentions } : {}) }),
      stop: (value, agentName) => post(`${room(value)}/stop`, { agentName }),
      messages: (value, query) => request(`${room(value)}/messages`, { query }),
      agents: {
        list: value => request(`${room(value)}/agents`), add: (value, input) => post(`${room(value)}/agents`, input),
        update: (value, agentId, input) => request(`${room(value)}/agents/${id(agentId)}`, { method: 'PUT', body: input }),
        remove: (value, agentId) => remove(`${room(value)}/agents/${id(agentId)}`),
      },
    },
    workflows: {
      list: () => request('/api/studio/workflows'), get: value => request(workflow(value)),
      create: input => post('/api/studio/workflows', input), update: (value, input) => request(workflow(value), { method: 'PATCH', body: input }),
      remove: value => remove(workflow(value)), run: (value, input) => post(`${workflow(value)}/run`, { ...(input ? { input } : {}) }),
      stop: (value, runId) => post(`${workflow(value)}/runs/${id(runId)}/stop`),
      runs: value => request(`${workflow(value)}/runs`), getRun: (value, runId) => request(`${workflow(value)}/runs/${id(runId)}`),
      schedules: {
        list: value => request(`${workflow(value)}/schedules`), create: (value, input) => post(`${workflow(value)}/schedules`, input),
        update: (value, scheduleId, input) => request(`${workflow(value)}/schedules/${id(scheduleId)}`, { method: 'PATCH', body: input }),
        remove: (value, scheduleId) => remove(`${workflow(value)}/schedules/${id(scheduleId)}`),
      },
    },
    files: { list: (path = '') => request('/api/studio/files/list', { query: { path } }), read: path => request('/api/studio/files/read', { query: { path } }) },
  } }
}
