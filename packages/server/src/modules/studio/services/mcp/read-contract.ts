import { StudioError, type JsonObject, type McpPage, type McpResource, type McpResourceTemplate, type McpResourceContents, type McpPrompt, type McpPromptResult } from '../../contracts/plugins'
import { jsonCopy } from '../plugins/validation'

export const MAX_MCP_READ_BYTES = 524_288
const invalid = () => new StudioError('INVALID_ARGUMENT', 'Invalid MCP resource or prompt data')
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, any>
}
function text(value: unknown, max: number, nonempty = true): string {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.length) || value.includes('\0')) throw invalid()
  return value
}
function optional(value: Record<string, any>, key: string, max = 8192): Record<string, string> {
  return value[key] === undefined ? {} : { [key]: text(value[key], max, false) }
}
function array(value: unknown, max: number): any[] { if (!Array.isArray(value) || value.length > max) throw invalid(); return value }
function binary(value: unknown): string {
  const data = text(value, MAX_MCP_READ_BYTES, false)
  if (Buffer.from(data, 'base64').toString('base64') !== data) throw invalid()
  return data
}
export function mcpReadString(value: unknown, max = 8192): string { return text(value, max) }
export function mcpReadArguments(value: unknown): Record<string, string> {
  const input = object(jsonCopy(value, 65_536))
  if (Object.keys(input).length > 64) throw invalid()
  const entries = Object.entries(input).map(([key, value]) => [text(key, 256), text(value, 16384, false)])
  return Object.fromEntries(entries)
}
function resource(value: unknown, template = false): McpResource | McpResourceTemplate {
  const input = object(value), uriKey = template ? 'uriTemplate' : 'uri'
  const result = { [uriKey]: text(input[uriKey], 8192), name: text(input.name, 256), ...optional(input, 'title', 256), ...optional(input, 'description'), ...optional(input, 'mimeType', 256) }
  if (!template && input.size !== undefined) {
    if (!Number.isSafeInteger(input.size) || input.size < 0) throw invalid()
    return { ...result, size: input.size } as unknown as McpResource
  }
  return result as unknown as McpResource | McpResourceTemplate
}
function prompt(value: unknown): McpPrompt {
  const input = object(value)
  const args = input.arguments === undefined ? undefined : array(input.arguments, 64).map(value => {
    const item = object(value)
    if (item.required !== undefined && typeof item.required !== 'boolean') throw invalid()
    return { name: text(item.name, 256), ...optional(item, 'description'), ...(item.required === undefined ? {} : { required: item.required as boolean }) }
  })
  if (args && new Set(args.map(item => item.name)).size !== args.length) throw invalid()
  return { name: text(input.name, 256), ...optional(input, 'title', 256), ...optional(input, 'description'), ...(args ? { arguments: args } : {}) }
}
export function parseMcpPage(value: unknown, kind: 'resources' | 'resourceTemplates' | 'prompts'): McpPage<McpResource | McpResourceTemplate | McpPrompt> {
  const input = object(jsonCopy(value, MAX_MCP_READ_BYTES)), items = array(input[kind], 256).map(item => kind === 'prompts' ? prompt(item) : resource(item, kind === 'resourceTemplates'))
  const ids = items.map(item => 'uri' in item ? item.uri : 'uriTemplate' in item ? item.uriTemplate : item.name)
  if (new Set(ids).size !== ids.length) throw invalid()
  return { items, ...(input.nextCursor === undefined ? {} : { nextCursor: text(input.nextCursor, 4096) }) }
}
function contents(value: unknown): McpResourceContents {
  const input = object(value), base = { uri: text(input.uri, 8192), ...optional(input, 'mimeType', 256) }
  if ((input.text === undefined) === (input.blob === undefined)) throw invalid()
  return input.text === undefined ? { ...base, blob: binary(input.blob) } : { ...base, text: text(input.text, MAX_MCP_READ_BYTES, false) }
}
export function parseMcpResource(value: unknown): McpResourceContents[] {
  return array(object(jsonCopy(value, MAX_MCP_READ_BYTES)).contents, 64).map(contents)
}
export function parseMcpPrompt(value: unknown): McpPromptResult {
  const input = object(jsonCopy(value, MAX_MCP_READ_BYTES))
  return { ...optional(input, 'description'), messages: array(input.messages, 64).map(value => {
    const message = object(value), input = object(message.content)
    if (!['user', 'assistant'].includes(message.role)) throw invalid()
    let content: JsonObject
    if (input.type === 'text') content = { type: 'text', text: text(input.text, MAX_MCP_READ_BYTES, false) }
    else if (input.type === 'image' || input.type === 'audio') content = { type: input.type, data: binary(input.data), mimeType: text(input.mimeType, 256) }
    else if (input.type === 'resource') content = { type: 'resource', resource: contents(input.resource) as unknown as JsonObject }
    else if (input.type === 'resource_link') content = { type: 'resource_link', ...resource(input) } as unknown as JsonObject
    else throw new StudioError('CAPABILITY_UNSUPPORTED', 'MCP prompt content type is unsupported')
    return { role: message.role as 'user' | 'assistant', content }
  }) }
}
