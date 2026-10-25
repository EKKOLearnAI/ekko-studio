export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
export interface JsonObject { [key: string]: JsonValue }
export type JsonSchema = JsonObject | boolean
export type Disposer = () => void | Promise<void>

export type AgentProviderRef =
  | { kind: 'builtin'; module: 'hermes' | 'ekko'; implementationVersion: string }
  | { kind: 'plugin'; pluginId: string; version: string; generation: string }

export type PluginInstallationPolicy =
  | { kind: 'system'; removable: false }
  | { kind: 'user'; removable: true }

export interface PluginIdentity {
  readonly id: string
  readonly version: string
  readonly generation: string
}

export interface ExecutionScope {
  readonly scopeId: string
  readonly principal: { readonly id: string; readonly kind: 'user' | 'service' }
  readonly profileId: string
  readonly workspaceId?: string
  readonly sessionId?: string
  readonly runId?: string
  readonly surface: 'chat' | 'group-chat' | 'workflow' | 'global-agent' | 'api' | 'job' | 'event'
  readonly traceId: string
}

export interface ScopedLogger {
  info(message: string, data?: JsonObject): void
  warn(message: string, data?: JsonObject): void
  error(message: string, data?: JsonObject): void
}

export interface SessionSummary {
  id: string
  profileId: string
  title: string | null
  agentTypeId: string
  archived: boolean
}

export interface SessionRemovalResult {
  /** Whether a Studio record was removed; native-only history is reported separately. */
  deleted: boolean
  native: { attempted: boolean; deleted: boolean; profileId: string; error?: string }
}

export interface StudioDomainServices {
  /** Read only image artifacts attached to the current live Run. No paths or URLs. */
  readonly artifacts: {
    read(id: string, offset?: number): Promise<ArtifactChunk>
  }
  readonly models: {
    list(): Promise<ModelSummary[]>
    stream(input: ModelStreamInput): Promise<ModelStreamHandle>
    get(id: string): Promise<ModelCallRecord>
    /** Run-bound loopback access to a matching native provider protocol. */
    gateway(input: ModelGatewayInput): Promise<ModelGatewayHandle>
  }
  readonly workflows: {
    run(input: WorkflowRunStartInput): Promise<WorkflowRunReceipt>
    get(id: string): Promise<WorkflowRunReceipt>
    cancel(id: string): Promise<WorkflowRunReceipt>
  }
  readonly chat: {
    start(input: ChatRunStartInput): Promise<ChatRunReceipt>
    get(id: string): Promise<ChatRunRecord>
    cancel(id: string): Promise<ChatRunReceipt>
  }
  readonly sessions: {
    get(id: string): Promise<SessionSummary | null>
    remove(id: string): Promise<SessionRemovalResult>
  }
  readonly agents: {
    list(): Promise<AgentTypeSummary[]>
  }
  readonly runs: {
    start(input: AgentRunStartInput): Promise<AgentRunRecord>
    get(id: string): Promise<AgentRunRecord>
    output(id: string, after?: number): Promise<AgentOutputEvent[]>
    cancel(id: string): Promise<AgentRunRecord>
    interactions(id: string): Promise<AgentInteraction[]>
    respond(id: string, input: AgentInteractionResponse): Promise<AgentInteractionReceipt>
    usage(id: string): Promise<AgentUsage[]>
  }
}

export interface ModelGatewayInput { model: string; protocol: 'responses' | 'anthropic' | 'chat-completions' }
export interface ModelGatewayHandle {
  readonly baseUrl: string
  /** Ephemeral gateway credential, never an upstream provider key. */
  readonly token: string
  readonly model: string
  readonly protocol: ModelGatewayInput['protocol']
  /** Transport at admission; subsequent requests re-resolve the selected model.
   * Translation supports portable function tools; provider-hosted tools remain native-only. */
  readonly transport?: 'native' | 'translated'
  /** Host-resolved model capability; absent means unknown. */
  readonly images?: boolean
  /** Revoke admission, abort active requests, and await authoritative accounting. */
  dispose(): Promise<void>
}

export interface ModelSummary { id: string; provider: string; callable: boolean }
/** Full Responses-style history, including images, function results and encrypted reasoning items. */
export interface ModelStreamInput {
  idempotencyKey: string
  model: string
  input: string | JsonObject[]
  instructions?: string
  tools?: Array<{ type: 'function'; name: string; description?: string; parameters?: JsonObject }>
  toolChoice?: 'auto' | 'none' | 'required'
  maxOutputTokens?: number
  temperature?: number
  reasoning?: { effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'; summary?: 'auto' | 'concise' | 'detailed' }
  timeoutMs?: number
}
export interface ModelCallUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  costUsd?: number
  costSource?: 'reported' | 'estimated'
}
export interface ModelCallRecord {
  id: string
  profileId: string
  ownerId: string
  sessionId: string | null
  runId: string | null
  model: string
  status: 'running' | 'completed' | 'incomplete' | 'cancelled' | 'failed' | 'interrupted'
  output: JsonObject[]
  /** null means unknown, including cancellation before the provider reports counters. */
  usage: ModelCallUsage | null
  errorCode: string | null
  revision: number
  createdAt: number
  updatedAt: number
}
export type ModelStreamEvent =
  | { sequence: number; type: 'text.delta' | 'reasoning.delta'; text: string }
  | { sequence: number; type: 'output.item'; item: JsonObject }
  | { sequence: number; type: 'call.finished'; call: ModelCallRecord }
export interface ModelStreamHandle {
  readonly id: string
  /** Single reader. A completed idempotent replay yields the durable call.finished snapshot. */
  readonly events: AsyncIterable<ModelStreamEvent>
  /** Waits for the provider iterator and accounting to settle. */
  cancel(): Promise<void>
}

export interface WorkflowRunStartInput {
  workflowId: string
  idempotencyKey: string
  input?: string
  startNodeIds?: string[]
  timeoutMs?: number
}

/** Workflow scheduling state; no native credentials, graph configuration or error text. */
export interface WorkflowRunReceipt {
  id: string
  workflowId: string
  profileId: string
  ownerId: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled'
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

/** Continue an owned chat using its stored Agent/model configuration. */
export interface ChatRunStartInput {
  sessionId: string
  input: string
  idempotencyKey: string
}

/** Host receipt, distinct from the underlying runtime's run id. */
export interface ChatRunRecord {
  id: string
  sessionId: string
  profileId: string
  ownerId: string
  status: AgentRunStatus | 'queued' | 'waiting_input'
  output: string
  reasoning: string
  truncated: boolean
  revision: number
  createdAt: number
  updatedAt: number
  errorCode: string | null
}

/** Mutation receipts contain no text; reading output always requires chat.read. */
export type ChatRunReceipt = Omit<ChatRunRecord, 'output' | 'reasoning' | 'truncated'>

export interface ExecutionContext extends StudioDomainServices {
  readonly scope: ExecutionScope
  readonly signal: AbortSignal
  readonly logger: ScopedLogger
}

export interface AgentCapabilities {
  text: boolean
  images?: boolean
  files?: boolean
  streaming?: boolean
  reasoning?: boolean
  resume?: boolean
  /** Top-level configuration fields that may change without discarding native state.
   * Opt-in; mode, provider/version and all other changed fields start fresh. */
  resumeConfigKeys?: string[]
  persistentSession?: boolean
  compact?: boolean
  approvals?: boolean
  clarifications?: boolean
  steering?: boolean
  nativeMcp?: boolean
  modes: Array<'scoped' | 'global'>
}

export interface AgentTypeSummary {
  id: string
  name: string
  description?: string
  configSchema: JsonSchema
  capabilities: AgentCapabilities
  provider: AgentProviderRef
  management?: { inspect?: true; locations?: true; setup?: true; prepareLogin?: true; prepareInstall?: true }
}

/** Native metadata only: never return credentials, config files or account identifiers. */
export interface AgentInspection {
  native: { name: string; version?: string }
  authentication: {
    state: 'authenticated' | 'required' | 'not_required' | 'unknown'
    methods: Array<{ id: string; name: string }>
  }
  models: { status: 'available' | 'unsupported' | 'authentication_required'; items: Array<{ id: string; name: string; isDefault?: boolean; reasoningEfforts?: string[] }> }
}
export type AgentManagementInput = Pick<RuntimeCreateInput, 'instanceId' | 'config' | 'configRevision' | 'mode'>
/** Manual native setup, separate from plugin installation and account verification.
 * Commands are displayed as argument arrays; the host must not execute them as shell text. */
export interface AgentSetup {
  cli: { state: 'available' | 'unavailable'; version?: string }
  installation: { command: string; args: string[] } | { kind: 'manual'; url: string }
  authentication: { kind: 'native' | 'studio'; command?: string; args?: string[]; input?: string }
}
export interface AgentManagementAdapter {
  /** Declare an exact native CLI package; the host installs into private instance storage. */
  prepareInstall?(input: AgentManagementInput, context: AgentRuntimeContext): Promise<AgentCliInstallPlan>
  /** Short-lived resources; no prompt, login, credential refresh or config mutation. */
  inspect?(input: AgentManagementInput, context: AgentRuntimeContext): Promise<AgentInspection>
  /** Declare all native resource locations. Studio scans, reads and edits their contents. */
  locations?(input: AgentManagementInput, context: AgentRuntimeContext): Promise<import('./agent-resources').AgentResourceLocations>
  /** Probe the executable and provide manual installation/login instructions; never logs in. */
  setup?(input: AgentManagementInput, context: AgentRuntimeContext): Promise<AgentSetup>
  /** Prepare a native login command. The host opens the owned interactive terminal;
   * this callback must not start inference or report account authentication. */
  prepareLogin?(input: AgentManagementInput, context: AgentRuntimeContext): Promise<Omit<ProcessSpawnInput, 'terminal'>>
}

export interface AgentCliInstallPlan {
  kind: 'npm'; packageName: string; version: string; bin: string; runner: 'node' | 'binary'
  /** Prefer a shared dependency version when the native CLI's SDK requires one module identity. */
  preferDedupe?: boolean
  /** Native home/config variable names; the host supplies private installer paths. */
  nativeHomeEnv?: string[]
}
export type AgentNativeCli = { state: 'ready'; command: string; args: string[] } | { state: 'unavailable' }

export type AgentManagementOperationStatus = 'starting' | 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted'
export interface AgentManagementOperation {
  id: string; instanceId: string; configRevision: number; provider: AgentProviderRef; action: 'login' | 'install'
  status: AgentManagementOperationStatus; createdAt: number; updatedAt: number; expiresAt: number
  errorCode: string | null; exit: ProcessExit | null
}
export interface AgentManagementOutput {
  chunks: Array<{ sequence: number; data: string }>
  lastSequence: number; nextInputSequence: number; truncated: boolean; finished: boolean
}

export interface AgentRuntimeContext {
  /** Host-owned persistent directory, isolated by provider/version, owner, profile and instance.
   * Compatible configuration revisions share their original directory.
   * Available in either mode when host storage is configured; it does not change native account homes. */
  readonly stateDirectory?: string
  /** Host-verified private CLI. An unavailable installation requires repair or an explicit custom command. */
  readonly nativeCli?: AgentNativeCli
  readonly provider: AgentProviderRef
  readonly runtimeSessionId: string
  readonly profileId: string
  readonly ownerId: string
  readonly signal: AbortSignal
  readonly logger: ScopedLogger
  readonly processes: RuntimeProcesses
  readonly mcp: RuntimeMcp
  /** Available only for declared, granted commands in a host-bound chat runtime. */
  readonly commands?: import('./commands').RuntimeCommandContributions
}

/** Managed processes belong to the runtime lease, not a single turn or HTTP request. */
export interface ProcessSpawnInput {
  command: string
  args: string[]
  cwd: string
  /** Literal additions to a minimal host environment; no implicit provider credentials. */
  env?: Record<string, string>
  /** Explicit PTY allocation; stdout/stderr are merged into stdout byte chunks. */
  terminal?: { cols: number; rows: number }
}
export interface ProcessExit { code: number | null; signal: string | null }
export interface ProcessReadResult {
  chunks: Array<{ stream: 'stdout' | 'stderr'; data: Uint8Array }>
  truncated: boolean
  /** Once non-null, drain remaining chunks before finishing the output stream. */
  exit: ProcessExit | null
}
export interface ProcessHandle {
  readonly id: string
  /** Bounded long poll; one reader per process. An empty batch is not EOF. */
  read(): Promise<ProcessReadResult>
  write(data: Uint8Array): Promise<void>
  end(): Promise<void>
  /** Available on PTYs. Pipe handles reject resizing; PTYs cannot half-close stdin. */
  resize?(cols: number, rows: number): Promise<void>
  /** Wait for confirmed exit, escalating termination when needed. */
  stop(): Promise<void>
  /** Stop and release the handle; repeated disposal is harmless. */
  dispose(): Promise<void>
}
export interface RuntimeProcesses { spawn(input: ProcessSpawnInput): Promise<ProcessHandle> }

/** Explicit plugin-owned configuration; host profile secrets are never expanded into this DTO. */
export type McpConnectInput = (
  | ({ type: 'stdio' } & Omit<ProcessSpawnInput, 'terminal'>)
  | { type: 'streamable_http'; url: string; headers?: Record<string, string> }
) & { timeoutMs?: number; supportsParallelToolCalls?: boolean }
export interface McpToolDefinition {
  /** Model-safe name; unsafe remote names are represented by a server proxy tool. */
  name: string
  description?: string
  parameters: JsonObject
  concurrency: 'serial' | 'parallel'
}
export interface McpToolResult {
  ok: boolean
  content: string
  contentParts?: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  data?: JsonValue
  error?: string
}
export interface McpPage<T> { items: T[]; nextCursor?: string }
export interface McpResource { uri: string; name: string; title?: string; description?: string; mimeType?: string; size?: number }
export interface McpResourceTemplate { uriTemplate: string; name: string; title?: string; description?: string; mimeType?: string }
export type McpResourceContents = { uri: string; mimeType?: string } & ({ text: string } | { blob: string })
export interface McpPrompt { name: string; title?: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }
export interface McpPromptResult { description?: string; messages: Array<{ role: 'user' | 'assistant'; content: JsonObject }> }
export interface McpConnectionHandle {
  readonly id: string
  listTools(): Promise<McpToolDefinition[]>
  /** Transport failures are not replayed; callers must decide whether a side effect may have occurred. */
  callTool(name: string, input: JsonObject): Promise<McpToolResult>
  /** One bounded page. Missing remote capability is distinct from an empty list. */
  listResources(cursor?: string): Promise<McpPage<McpResource>>
  listResourceTemplates(cursor?: string): Promise<McpPage<McpResourceTemplate>>
  readResource(uri: string): Promise<McpResourceContents[]>
  listPrompts(cursor?: string): Promise<McpPage<McpPrompt>>
  getPrompt(name: string, args?: Record<string, string>): Promise<McpPromptResult>
  dispose(): Promise<void>
}
export interface RuntimeMcp { connect(input: McpConnectInput): Promise<McpConnectionHandle> }

export interface AgentRunContext extends ExecutionContext {
  readonly scope: ExecutionScope & { readonly runId: string; readonly runtimeSessionId: string }
  /** Host-owned per-turn configuration; never accepted from Run input. */
  readonly nativeContext?: import('./agent-configuration').AgentNativeContextConfiguration
}

export interface RuntimeCreateInput {
  instanceId: string
  config: JsonObject
  configRevision: number
  mode: 'scoped' | 'global'
  workspaceId?: string
  resume?: JsonValue
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image' | 'file'; artifactId: string; mediaType: string }

export interface ImageArtifact {
  id: string
  mediaType: string
  byteLength: number
}
export interface ArtifactChunk extends ImageArtifact {
  offset: number
  /** Base64 encoded bytes; bounded independently of the full artifact size. */
  data: string
  nextOffset: number
  done: boolean
}

export interface AgentRunInput {
  content: ContentBlock[]
  model?: string
  timeoutMs?: number
}

/** Start an independent instance run. Identity and execution scope are supplied by the host. */
export interface AgentRunStartInput {
  instanceId: string
  input: AgentRunInput
  idempotencyKey: string
}

export type AgentOutputEvent =
  | { type: 'message.delta'; producerSequence: number; messageId: string; text: string }
  | { type: 'message.snapshot'; producerSequence: number; messageId: string; text: string }
  | { type: 'reasoning.delta'; producerSequence: number; messageId: string; text: string }
  | { type: 'tool.started' | 'tool.completed' | 'tool.failed'; producerSequence: number; callId: string; name: string; data: JsonValue }
  | { type: 'usage.reported'; producerSequence: number; modelCallId: string; model: string; mode: 'delta' | 'cumulative' | 'final'; revision: number;
      /** Total input including cache; optional counters are breakdowns, not additional tokens. */
      inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }
  | { type: 'checkpoint.updated'; producerSequence: number; value: JsonValue }
  | { type: 'interaction.requested'; producerSequence: number; requestId: string; kind: 'approval' | 'clarification'; prompt: string; choices: AgentInteractionChoice[]; allowText?: boolean; expiresAt?: number }
  | { type: 'interaction.withdrawn'; producerSequence: number; requestId: string }
  | { type: 'diagnostic'; producerSequence: number; message: string }

export interface AgentInteractionChoice { id: string; label: string; description?: string }

export interface AgentInteraction {
  id: string
  runId: string
  requestId: string
  kind: 'approval' | 'clarification'
  prompt: string
  choices: AgentInteractionChoice[]
  /** Clarifications allow text by default. Approvals always require a choice. */
  allowText?: boolean
  expiresAt: number | null
  status: 'pending' | 'responding' | 'resolved' | 'withdrawn' | 'expired' | 'interrupted'
}

export interface AgentInteractionResponse {
  interactionId: string
  idempotencyKey: string
  choiceId?: string
  text?: string
}

/** Responding does not grant permission to read the interaction's private content. */
export type AgentInteractionReceipt = Pick<AgentInteraction, 'id' | 'runId' | 'status'>

/** A missing model call is unknown usage, never a measured zero. */
export interface AgentUsage {
  modelCallId: string
  model: string
  revision: number
  inputTokens: number | null
  outputTokens: number | null
  final: boolean
  source?: 'host' | 'runtime'
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  costUsd?: number
  costSource?: 'reported' | 'estimated'
}

export interface AgentRunResult { status: 'completed' | 'cancelled'; checkpoint?: JsonValue }

export type AgentRunStatus = 'accepted' | 'queued' | 'starting' | 'running' | 'waiting_input' | 'finalizing' | 'cancelling' | 'completed' | 'cancelled' | 'failed' | 'interrupted'
export interface AgentRunRecord {
  /** Actual host execution surface; absent on records created before origin tracking. */
  surface?: ExecutionScope['surface']
  /** Present only for a host-authorized chat binding; native history is isolated per conversation. */
  sessionId?: string
  conversationId?: string
  id: string
  instanceId: string
  profileId: string
  ownerId: string
  status: AgentRunStatus
  provider: AgentProviderRef
  configRevision: number
  revision: number
  createdAt: number
  updatedAt: number
  errorCode: string | null
  hooks?: HookSnapshot[]
}

export interface AgentRunHandle {
  readonly events: AsyncIterable<AgentOutputEvent>
  readonly result: Promise<AgentRunResult>
  cancel(reason: string): Promise<void>
  /** withdrawn means native resolution won the race; the answer was not delivered. */
  respond?(input: { requestId: string; choiceId?: string; text?: string }): Promise<void | { status: 'withdrawn' }>
}

export interface AgentRuntime {
  run(input: AgentRunInput, ctx: AgentRunContext): Promise<AgentRunHandle>
  checkpoint?(): Promise<JsonValue>
  dispose(reason: string): Promise<void>
}

export interface AgentTypeDefinition {
  id: string
  name: string
  description?: string
  configSchema: JsonSchema
  capabilities: AgentCapabilities
  management?: AgentManagementAdapter
  create(input: RuntimeCreateInput, ctx: AgentRuntimeContext): Promise<AgentRuntime>
}

export interface EventSubject {
  /** Absent for global plugin lifecycle events; present for profile data events. */
  profileId?: string
  sessionId?: string
  runId?: string
  pluginId?: string
  agentTypeId?: string
}

export interface StudioEventMap {
  'plugin.ready': { pluginId: string; generation: string }
  'plugin.disabled': { pluginId: string; generation: string }
  'plugin.failed': { pluginId: string; generation: string }
  'agent.available': { agentTypeId: string }
  'agent.unavailable': { agentTypeId: string }
  'service.available': { serviceId: string; version: string }
  'service.unavailable': { serviceId: string; version: string }
  'run.completed': { runId: string }
  'run.failed': { runId: string }
  'run.cancelled': { runId: string }
  'session.deleted': { sessionId: string }
}

export interface EventEnvelope<T = JsonObject> {
  schemaVersion: 1
  id: string
  type: string
  occurredAt: number
  partitionKey: string
  sequence: number
  subject: EventSubject
  data: T
  correlationId: string
  causationId?: string
}

export type EventHandler<K extends keyof StudioEventMap> =
  (event: EventEnvelope<StudioEventMap[K]>, ctx: ExecutionContext) => void | Promise<void>

/** Stable names retain their cursor across reloads. A reset must be explicit. */
export interface EventConsumerSpec {
  types: Array<keyof StudioEventMap>
  start: 'now' | 'earliest'
  resume: 'continue' | 'from-now'
}
export type ReliableEventHandler = (event: EventEnvelope, ctx: ExecutionContext) => void | Promise<void>

export interface HookInputMap {
  'runs.start': AgentRunStartInput
  'sessions.remove': { sessionId: string }
}
export type HookPoint = keyof HookInputMap
export interface HookContext extends Pick<ExecutionContext, 'scope' | 'signal' | 'logger'> {
  readonly models: Pick<ExecutionContext['models'], 'list' | 'get'>
  readonly agents: ExecutionContext['agents']
  readonly sessions: Pick<ExecutionContext['sessions'], 'get'>
  readonly runs: Pick<ExecutionContext['runs'], 'get' | 'output' | 'interactions' | 'usage'>
  readonly chat: Pick<ExecutionContext['chat'], 'get'>
  readonly workflows: Pick<ExecutionContext['workflows'], 'get'>
}
export interface RunHookPatch { content?: Array<{ type: 'text'; text: string }>; timeoutMs?: number }
export type HookDecision = { action: 'continue' } | { action: 'reject' }
export type HookResult<K extends HookPoint> = HookDecision | (K extends 'runs.start' ? { action: 'patch'; patch: RunHookPatch } : never)
export interface HookOptions { key: string; priority?: number }
export interface HookSnapshot { point: HookPoint; pluginId: string; generation: string; key: string; priority: number }
export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T
export type HookHandler<K extends HookPoint> = (input: DeepReadonly<HookInputMap[K]>, context: HookContext) => HookResult<K> | Promise<HookResult<K>>

export interface ServiceToken {
  /** Publisher namespace plus service name and major, e.g. acme.search/index@1. */
  id: string
  version: string
  methods: Record<string, { input: JsonSchema; output: JsonSchema }>
}
export interface ServiceDependency { id: string; version: string; optional?: boolean }
export type ServiceImplementation = Record<string, (input: JsonValue, context: ExecutionContext) => JsonValue | Promise<JsonValue>>
export interface ServiceClient {
  status(): Promise<{ available: boolean; version?: string }>
  /** Must receive a live context issued by the host, never caller-created identity. */
  call(context: ExecutionContext, method: string, input: JsonValue): Promise<JsonValue>
}

export interface PluginManifest {
  schemaVersion: 1
  id: string
  version: string
  engines: { studioSdk: string; rpc: 1 }
  backend: string
  /** Plugins activate once globally. 'profile' is accepted only for legacy manifests. */
  activation: 'global' | 'profile'
  contributes: { agents: string[]; commands?: string[]; runtimeCommands?: string[]; events?: Record<string, JsonSchema>; services?: ServiceToken[] }
  requires: { capabilities: string[]; services?: ServiceDependency[] }
  configSchema?: JsonSchema
}

export interface PluginContext {
  readonly plugin: PluginIdentity
  readonly config: Readonly<JsonObject>
  readonly logger: ScopedLogger
  readonly commands: import('./commands').CommandContributions
  readonly agents: { register(definition: AgentTypeDefinition): Disposer }
  readonly services: {
    provide(token: ServiceToken, implementation: ServiceImplementation): Disposer
    use(dependency: ServiceDependency): ServiceClient
  }
  readonly lifecycle: { onDispose(dispose: Disposer): Disposer }
  readonly events: { consume(name: string, spec: EventConsumerSpec, handler: ReliableEventHandler): Disposer }
  readonly hooks: { before<K extends HookPoint>(point: K, handler: HookHandler<K>, options: HookOptions): Disposer }
  on<K extends keyof StudioEventMap>(type: K, handler: EventHandler<K>): Disposer
  once<K extends keyof StudioEventMap>(type: K, handler: EventHandler<K>): Disposer
  emit(type: string, data: JsonObject): Promise<{ id: string }>
}

export interface StudioPlugin { apply(ctx: PluginContext): void | Promise<void> }

export function definePlugin(plugin: StudioPlugin): StudioPlugin { return plugin }
