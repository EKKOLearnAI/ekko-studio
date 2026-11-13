import type { Json, PluginIdentity, RunContext, PluginLifecycle, PluginState, PluginStorage } from './index'

export type PluginAgentId = `plugin:${string}/${string}`
export type AgentMode = 'scoped' | 'global'
export type AgentApiMode = 'chat_completions' | 'codex_responses' | 'anthropic_messages'
export interface AgentLog {
  info(message: string, data?: Json): void
  warn(message: string, data?: Json): void
  error(message: string, data?: Json): void
}
export interface AgentManagementContext {
  readonly identity: PluginIdentity & { readonly agentId: string }
  readonly mode?: AgentMode
  readonly signal: AbortSignal
  readonly log: AgentLog
  readonly lifecycle: PluginLifecycle
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
  readonly lifecycle: PluginLifecycle
}
export type AgentRunContext = Omit<RunContext, 'identity' | 'state'> & {
  readonly identity: AgentSessionContext['identity'] & { readonly runId: string }
  readonly state: PluginState & { readonly agentSession: PluginStorage }
  readonly paths: AgentSessionContext['paths']
  readonly deadlineAt: number
  readonly log: AgentLog
  readonly lifecycle: PluginLifecycle
  readonly output: { emit(event: AgentEvent): Promise<void> }
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
    /** Remove only the managed engine; retain plugin settings and conversation data. */
    remove?(ctx: AgentManagementContext): Promise<void>
    /** Whether this installation can be updated without external setup or user interaction. Defaults to false. */
    supportsAutoUpdate?(ctx: AgentManagementContext): boolean | Promise<boolean>
  }
  modes: {
    global?: { listModels(ctx: AgentManagementContext & { refresh: boolean }): Promise<AgentModelCatalog> }
    scoped?: { protocols: AgentApiMode[] }
  }
  features: { surfaces: Array<'chat' | 'group-chat' | 'workflow' | 'api'>; streaming: boolean; resume: boolean }
  runtime: { createSession(ctx: AgentSessionContext): AgentSession | Promise<AgentSession> }
}
export interface AgentRegistration { readonly id: PluginAgentId; dispose(): Promise<void> }
