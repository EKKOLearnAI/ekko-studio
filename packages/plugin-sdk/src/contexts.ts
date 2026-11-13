import type { Json, Schema, Dispose, PluginPermission, PluginIdentity, PluginManifest, PluginLifecycle } from './core'
import type { HostApi } from './host'
import type { PluginState } from './state'

export interface PluginEvent {
  channel?: 'business' | 'message'
  id: string
  type: string
  timestamp: number
  identity: PluginIdentity
  data: Json
  audience?: 'caller' | 'plugin'
}
/** Observations available through ctx.events.on(); delivery is in-memory. */
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
  readonly permissions: readonly PluginPermission[]
  readonly features: readonly string[]
  readonly host: HostApi
  readonly state: PluginState
  readonly config: Readonly<Record<string, Json>>
  session: { get(): Promise<Json> }
  workspace: { read(path: string): Promise<Json>; write(path: string, content: string): Promise<Json> }
  lifecycle: PluginLifecycle
  tools: { call(name: string, input: Record<string, Json>): Promise<ToolResult> }
  messages: { notify(message: string, level?: 'info' | 'error' | 'success'): void; emit(type: string, data: Json, options?: { audience?: 'caller' | 'plugin' }): void }
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
  readonly plugin: Readonly<PluginManifest>
  /** Current caller inside a handler; activation identity during startup/scheduled work. */
  readonly identity: PluginIdentity
  readonly config: Readonly<Record<string, Json>>
  readonly signal: AbortSignal
  /** Plugin data scopes; plugin is global and user/profile/session scopes bind to the caller. */
  readonly state: PluginState
  readonly host: HostApi
  log: { info(message: string, data?: Json): void; warn(message: string, data?: Json): void; error(message: string, data?: Json): void }
  extensions: PluginExtensions
  events: { on(type: PluginEventPattern, handler: (event: PluginEvent, ctx: RunContext) => void | Promise<void>): Dispose }
  scheduler: { every(id: string, intervalMs: number, action: string, input?: Record<string, Json>): Dispose }
  lifecycle: PluginLifecycle
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
  readonly host: HostApi
  readonly config: Readonly<Record<string, Json>>
  rpc: { call<T extends Json = Json>(name: string, input?: Json): Promise<T> }
  /** Requires storage.client; grants browser access to this plugin's entire store, including namespaces. */
  state: PluginState
  events: { on(type: PluginEventPattern, handler: (event: PluginEvent) => void): Dispose }
  messages: { on(type: string, handler: (event: PluginEvent) => void): Dispose }
  ui: {
    notify(message: string, level?: 'info' | 'error' | 'success'): void
    confirm(message: string): Promise<boolean>
    prompt(message: string): Promise<string | null>
    /** Open the host picker for this view's Profile. Cancellation returns null; no settings are changed. */
    selectModel(options?: ClientModelPickerOptions): Promise<ClientModelSelection | null>
    navigate(path: string): void
  }
  lifecycle: PluginLifecycle
}
export interface ClientModule { mount(element: HTMLElement, ctx: ClientContext): void | Dispose | Promise<void | Dispose> }


export interface PluginExtensions {
  agents: { register(definition: import('./agents').AgentDefinition): import('./agents').AgentRegistration }
  tools: { register(tool: PluginTool): Dispose }
  commands: { register(command: PluginCommand): Dispose }
  rpc: { register(name: string, handler: (input: Json, ctx: RunContext) => Promise<Json> | Json): Dispose }
  hooks: { register(name: PluginHook, handler: (value: Json, ctx: RunContext) => HookResult | Promise<HookResult>, priority?: number): Dispose }
  actions: { register(action: PluginAction): Dispose }
}
