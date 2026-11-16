import type { Context } from 'koa'

export type ModelGatewayProtocol = 'chat_completions' | 'codex_responses' | 'anthropic_messages' | 'gemini_contents'
export interface ModelGatewayBinding { userId: number; profile: string; agentId?: string; sessionId?: string; runId?: string; model?: string; provider?: string }
export interface ModelGatewayTarget extends ModelGatewayBinding {
  requestId?: string
  provider: string
  model: string
  baseUrl: string
  apiKey: string
  apiMode?: string
  reasoningEffort?: string
  onUsageEvent?: (event: { type: string; data: any }, duration?: number, baseUrl?: string) => void
}
export interface ModelGatewayAdapters {
  authenticate(token: string): ModelGatewayBinding | null
  handle(protocol: ModelGatewayProtocol, ctx: Context): Promise<void>
  register(protocol: ModelGatewayProtocol, target: ModelGatewayTarget, persisted?: { token: string }): { routeKey: string; dispose(): void }
}
let adapters: ModelGatewayAdapters | undefined
export const configureModelGatewayAdapters = (next: ModelGatewayAdapters) => { adapters = next }
export function modelGatewayAdapters(): ModelGatewayAdapters {
  if (!adapters) throw new Error('Model gateway adapters are not configured')
  return adapters
}

export function gatewayProtocol(path: string): ModelGatewayProtocol | undefined {
  if (!path.startsWith('/api/ekko-studio/models/')) return undefined
  if (/\/v1\/responses\/?$/.test(path)) return 'codex_responses'
  if (/\/v1\/chat\/completions\/?$/.test(path)) return 'chat_completions'
  if (/\/v1\/messages(?:\/count_tokens)?\/?$/.test(path)) return 'anthropic_messages'
  if (/\/v1beta\/models\/.+:(?:streamGenerateContent|generateContent)$/.test(path)) return 'gemini_contents'
  return undefined
}

export function gatewayToken(ctx: Context): string {
  return ctx.get('authorization').replace(/^Bearer\s+/i, '').trim() || ctx.get('x-api-key').trim() || ctx.get('x-goog-api-key').trim()
}
