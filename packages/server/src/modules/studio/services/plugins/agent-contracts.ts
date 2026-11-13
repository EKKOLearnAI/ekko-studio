import type { AgentCheckpoint, AgentDefinition, AgentEvent, AgentRunResult, HookResult, Schema, ToolResult } from '../../contracts/plugins'
import { json, validate } from './schema'

const string: Schema = { type: 'string' }
const text: Schema = { type: 'string', minLength: 1 }
const boolean: Schema = { type: 'boolean' }
const number: Schema = { type: 'number', minimum: 0 }
const integer: Schema = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
const strings: Schema = { type: 'array', items: string }
const object = (properties: Record<string, Schema>, required: string[] = Object.keys(properties)): Schema => ({ type: 'object', properties, required, additionalProperties: false })
const choice = (...values: string[]): Schema => ({ type: 'string', enum: values })
function checked<T>(schema: Schema, value: unknown, label: string, opaque: string[] = []): T {
  const data = json(value)
  // Opaque payloads have already passed strict JSON validation; only their presence is constrained here.
  const envelope = opaque.length && data && typeof data === 'object' && !Array.isArray(data)
    ? Object.fromEntries(Object.entries(data).map(([key, item]) => [key, opaque.includes(key) ? null : item])) : data
  validate(schema, envelope, label)
  return data as T
}
type Result<K extends keyof AgentDefinition> = AgentDefinition[K] extends (...args: any[]) => infer R ? Awaited<R> : never
export const agentStatus = (value: unknown) => checked<Result<'getStatus'>>(object({ installed: boolean, version: string, source: string, path: string, error: string }, ['installed', 'version']), value, 'Agent status')
export function agentSettings(value: unknown) {
  const data = checked<{ viewId: string; query?: Record<string, string> }>(object({ viewId: text, query: { type: 'object', additionalProperties: true } }, ['viewId']), value, 'Agent settings')
  for (const item of Object.values(data.query || {})) validate(string, item, 'Agent settings query')
  return data
}
export const agentUpdate = (value: unknown) => checked<{ currentVersion: string; latestVersion: string; updateAvailable: boolean; message?: string }>(object({ currentVersion: string, latestVersion: string, updateAvailable: boolean, message: string }, ['currentVersion', 'latestVersion', 'updateAvailable']), value, 'Agent update result')
export const agentUpgrade = (value: unknown) => checked<{ installedVersion: string; message?: string }>(object({ installedVersion: text, message: string }, ['installedVersion']), value, 'Agent upgrade result')
export function agentModels(value: unknown): Awaited<ReturnType<NonNullable<AgentDefinition['modes']['global']>['listModels']>> {
  return checked(object({
    status: choice('ready', 'empty', 'not_installed', 'auth_required', 'unsupported', 'timeout', 'error'), source: string,
    scope: choice('available', 'configured', 'builtin'),
    models: { type: 'array', items: object({ id: text, name: string, provider: string, resolvedModel: string, isDefault: boolean, hidden: boolean, contextWindow: integer, maxOutputTokens: integer, reasoningEfforts: strings }, ['id', 'name']) },
    message: string,
  }, ['status', 'source', 'scope', 'models']), value, 'Agent model catalog')
}
export function agentCheckpoint(value: unknown): AgentCheckpoint {
  return checked(object({ schemaVersion: { ...integer, minimum: 1 }, data: { type: 'null' } }), value, 'Agent checkpoint', ['data'])
}
export function agentResult(value: unknown): AgentRunResult {
  const data = json(value) as unknown as AgentRunResult
  const content = object({ type: choice('text', 'image', 'file') }, ['type'])
  validate(object({ content: { type: 'array', items: { ...content, additionalProperties: true } }, finishReason: choice('stop', 'length', 'tool_limit'), usage: { type: 'object' }, checkpoint: { type: 'object' } }, ['content', 'finishReason']), data, 'Agent run result')
  for (const part of data.content) validate(part.type === 'text' ? object({ type: choice('text'), text: string }) : object({ type: choice('image', 'file'), assetId: text, name: text, mediaType: text }), part, 'Agent content')
  if (data.usage) {
    // Nullable counters are explicitly required; optional counters/cost must be omitted or null.
    const usage = Object.fromEntries(Object.entries(data.usage).map(([key, item]) => [key, ['inputTokens', 'outputTokens', 'cacheReadTokens', 'costUsd'].includes(key) && item === null ? 0 : item]))
    validate(object({ inputTokens: integer, outputTokens: integer, cacheReadTokens: integer, costUsd: number, isEstimated: boolean }, ['inputTokens', 'outputTokens', 'isEstimated']), usage, 'Agent usage')
  }
  if (data.checkpoint) agentCheckpoint(data.checkpoint)
  return data
}
const eventSchemas: Record<AgentEvent['type'], Schema> = {
    'text.delta': object({ type: choice('text.delta'), text: string }),
    'reasoning.summary.delta': object({ type: choice('reasoning.summary.delta'), text: string }),
    status: object({ type: choice('status'), phase: choice('thinking', 'working', 'compressing'), message: string }, ['type', 'phase']),
    'tool.started': object({ type: choice('tool.started'), callId: text, name: text, input: { type: 'object' } }),
    'tool.completed': object({ type: choice('tool.completed'), callId: text, result: { type: 'null' } }),
    'tool.failed': object({ type: choice('tool.failed'), callId: text, error: string }),
}
export function agentEvent(value: unknown): AgentEvent {
  const data = json(value) as unknown as AgentEvent
  const type = data?.type
  return checked(eventSchemas[type] || object({ type: choice(...Object.keys(eventSchemas)) }), data, 'Agent event', type === 'tool.completed' ? ['result'] : [])
}
export const toolResult = (value: unknown): ToolResult => checked(object({ ok: boolean, content: string, error: string, data: { type: 'null' } }, ['ok', 'content']), value, 'Plugin tool result', ['data'])
export const hookResult = (value: unknown): HookResult => checked(object({ deny: string, value: { type: 'null' } }, []), value, 'Plugin hook result', ['value'])
