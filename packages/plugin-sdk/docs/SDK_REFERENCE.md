# Studio Plugin SDK 结构参考

由 SDK 源码生成，版本 1.0.0。完整保留字段、可选性、返回类型与源码注释；语义说明见 STUDIO_CTX.md 和 STUDIO_RETURNS.md。

## src/agents.ts

```ts
import type { Dispose, Json, PluginIdentity, RunContext } from './index'

export type PluginAgentId = `plugin:${string}/${string}`
export type AgentMode = 'scoped' | 'global'
export type AgentApiMode = 'chat_completions' | 'codex_responses' | 'anthropic_messages'
export interface AgentLog {
  info(message: string, data?: Json): void
  warn(message: string, data?: Json): void
  error(message: string, data?: Json): void
}
export interface AgentResources { add(dispose: Dispose): Dispose }
export interface AgentManagementContext {
  readonly identity: PluginIdentity & { readonly agentId: string }
  readonly mode?: AgentMode
  readonly signal: AbortSignal
  readonly log: AgentLog
  readonly resources: AgentResources
  progress(input: { message: string; percent?: number }): void
}
export interface AgentStatus { installed: boolean; version: string; source?: string; path?: string; error?: string }
export interface AgentSettingsTarget { viewId: string; query?: Record<string, string> }
export interface AgentUpdateInfo { currentVersion: string; latestVersion: string; updateAvailable: boolean; message?: string }
export interface AgentUpgradeRequest { version: string; expectedVersion: string }
export interface AgentModel {
  id: string; name: string; provider?: string; resolvedModel?: string; isDefault?: boolean; hidden?: boolean
  contextWindow?: number; maxOutputTokens?: number; reasoningEfforts?: string[]
}
export interface AgentModelCatalog {
  status: 'ready' | 'empty' | 'not_installed' | 'auth_required' | 'unsupported' | 'timeout' | 'error'
  source: string; scope: 'available' | 'configured' | 'builtin'; models: AgentModel[]; message?: string
}
export interface AgentScopedModel {
  provider: string; model: string
  /** Protocol spoken by the plugin to Studio, independently of the upstream protocol. */
  apiMode: AgentApiMode
  baseUrl: string
  /** Studio proxy credential, never the upstream provider key. */
  token: string
  reasoningEffort?: string
  contextWindow: number | null; outputLimit: number | null
}
export type AgentContent = { type: 'text'; text: string }
  | { type: 'image' | 'file'; assetId: string; name: string; mediaType: string }
export interface AgentMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: AgentContent[]; toolCallId?: string }
export interface AgentRunInput {
  input: AgentContent[]
  /** Does not include this turn's input. */
  history: AgentMessage[]
  instructions: Array<{ kind: 'system' | 'role' | 'task' | 'workspace'; text: string }>
  options: Record<string, Json>
}
export type AgentEvent = { type: 'text.delta' | 'reasoning.summary.delta'; text: string }
  | { type: 'status'; phase: 'thinking' | 'working' | 'compressing'; message?: string }
  | { type: 'tool.started'; callId: string; name: string; input: Record<string, Json> }
  | { type: 'tool.completed'; callId: string; result: Json }
  | { type: 'tool.failed'; callId: string; error: string }
export interface AgentCheckpoint { schemaVersion: number; data: Json }
export interface AgentSessionContext {
  readonly identity: PluginIdentity & { readonly agentId: string; readonly sessionId: string }
  readonly mode: AgentMode
  readonly paths: { runtimeDir: string; workspaceDir: string }
  readonly resumeState?: AgentCheckpoint
  readonly signal: AbortSignal
  readonly log: AgentLog
  readonly resources: AgentResources
}
export type AgentRunContext = Omit<RunContext, 'identity'> & {
  readonly identity: AgentSessionContext['identity'] & { readonly runId: string }
  readonly paths: AgentSessionContext['paths']
  readonly deadlineAt: number
  readonly log: AgentLog
  readonly resources: AgentResources
  readonly events: { emit(event: AgentEvent): Promise<void> }
  /** Run-scoped Studio transports; the plugin writes its engine's native MCP configuration. */
  readonly mcpServers: Readonly<Record<string, Record<string, Json>>>
  readonly interactions: {
    approve(input: { operationId: string; title: string; details: string; input?: Json }): Promise<{ outcome: 'approved' | 'denied' | 'cancelled' | 'timeout' }>
    clarify(input: { question: string; choices?: string[] }): Promise<{ outcome: 'answered'; text: string } | { outcome: 'dismissed' | 'cancelled' | 'timeout' }>
  }
  /** Text, images and files are baseline inputs for every runtime. */
  readonly attachments: {
    resolve(assetId: string): Promise<{ assetId: string; name: string; mediaType: string; localPath: string; size: number }>
    read(assetId: string): Promise<Uint8Array>
  }
} & ({ readonly mode: 'scoped'; readonly model: Readonly<AgentScopedModel> }
  | { readonly mode: 'global'; readonly model: Readonly<{ model?: string; reasoningEffort?: string }> })
export interface AgentRunResult {
  /** Final complete reply, committed once; deltas are its live preview. */
  content: AgentContent[]
  finishReason: 'stop' | 'length' | 'tool_limit'
  usage?: { inputTokens: number | null; outputTokens: number | null; cacheReadTokens?: number | null; costUsd?: number | null; isEstimated: boolean }
  checkpoint?: AgentCheckpoint
}
export interface AgentSession {
  run(input: AgentRunInput, ctx: AgentRunContext): Promise<AgentRunResult>
  checkpoint?(): Promise<AgentCheckpoint>
  dispose(): void | Promise<void>
}
export interface AgentDefinition {
  id: string; name: string; vendor: string; description?: string; icon?: string; agentApiVersion: 1
  getStatus(ctx: AgentManagementContext): Promise<AgentStatus>
  management: {
    settings?(ctx: AgentManagementContext): AgentSettingsTarget | Promise<AgentSettingsTarget>
    checkUpdate?(ctx: AgentManagementContext): Promise<AgentUpdateInfo>
    upgrade?(input: AgentUpgradeRequest, ctx: AgentManagementContext): Promise<{ installedVersion: string; message?: string }>
  }
  modes: {
    global?: { listModels(ctx: AgentManagementContext & { refresh: boolean }): Promise<AgentModelCatalog> }
    scoped?: { protocols: AgentApiMode[] }
  }
  capabilities: { surfaces: Array<'chat' | 'group-chat' | 'workflow' | 'api'>; streaming: boolean; resume: boolean }
  runtime: { createSession(ctx: AgentSessionContext): AgentSession | Promise<AgentSession> }
}
export interface AgentRegistration { readonly id: PluginAgentId; dispose(): Promise<void> }
```

## src/index.ts

```ts
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
export interface PluginView {
  id: string
  title: string
  /** Main navigation page, settings navigation page, or a page in the plugin's own workspace. */
  slot: 'page' | 'settings' | 'workspace'
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
```

## 契约变更记录

### 1. 建立 Studio 插件 SDK v1 的上下文、数据结构及回传协议完整参考。

兼容与迁移：记录现有 SDK v1 契约，不改变运行时接口；已有插件继续兼容，新项目增加文档和结构检查。

契约摘要：`6680373647f30f3a2e017d55539391514fcfe8a4d747e6d79504269adc8b48a4`
