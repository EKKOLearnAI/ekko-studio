import type { JsonObject } from './types'
import { StudioError } from './errors'

/** Optional instance inputs, not an inventory of native management resources. */
export interface AgentContextConfiguration {
  /** Tool approvals are automatic by default, matching Studio's Coding Agent flow. */
  approvalRequired?: boolean
  systemPrompt?: string
  mcpServers?: Record<string, AgentMcpServerConfiguration>
  /** Explicitly opt in to host toolsets. Interaction tools require a bound chat context. */
  studioMcp?: { enabled: boolean; api?: boolean; browser?: boolean; devices?: boolean; use?: boolean; interaction?: boolean }
}

/** Host-only turn metadata, separate from saved instance configuration. */
export interface AgentNativeContextConfiguration extends AgentContextConfiguration { turnInstructions?: string }

export type AgentMcpServerConfiguration = {
  enabled?: boolean
  disabled?: boolean
} & (
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type?: 'http' | 'streamable_http' | 'sse'; url: string; headers?: Record<string, string> }
)

const strings = { type: 'object', maxProperties: 128, additionalProperties: { type: 'string', maxLength: 32768 } }
const enabled = { enabled: { type: 'boolean' }, disabled: { type: 'boolean' } }

/** Spread into a plugin's configSchema.properties to expose the same configuration in every client. */
export const agentContextConfigurationProperties: JsonObject = {
  approvalRequired: { type: 'boolean', default: false },
  systemPrompt: { type: 'string', maxLength: 65536 },
  studioMcp: { type: 'object', additionalProperties: false, required: ['enabled'], properties: {
    enabled: { type: 'boolean' }, api: { type: 'boolean' }, browser: { type: 'boolean' }, devices: { type: 'boolean' }, use: { type: 'boolean' }, interaction: { type: 'boolean' },
  } },
  mcpServers: {
    type: 'object', maxProperties: 32,
    propertyNames: { pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$', not: { enum: ['constructor', 'prototype'] } },
    additionalProperties: { oneOf: [
      { type: 'object', required: ['command'], additionalProperties: false, properties: {
        ...enabled, type: { const: 'stdio' }, command: { type: 'string', minLength: 1, maxLength: 4096 },
        args: { type: 'array', maxItems: 128, items: { type: 'string', maxLength: 16384 } }, env: strings,
      } },
      { type: 'object', required: ['url'], additionalProperties: false, properties: {
        ...enabled, type: { enum: ['http', 'streamable_http', 'sse'] },
        url: { type: 'string', minLength: 1, maxLength: 8192 }, headers: strings,
      } },
    ] },
  },
}

/** Compose a local copy; this never writes back to the host's saved configuration. */
export function mergeAgentContextConfiguration(...sources: AgentContextConfiguration[]): AgentContextConfiguration {
  const prompts: string[] = [], servers: Record<string, AgentMcpServerConfiguration> = {}
  for (const source of sources) {
    if (source.systemPrompt?.trim()) prompts.push(source.systemPrompt.trim())
    for (const [name, server] of Object.entries(source.mcpServers || {})) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name) || ['constructor', 'prototype', '__proto__'].includes(name)) {
        throw new StudioError('INVALID_ARGUMENT', 'Invalid MCP server name')
      }
      servers[name] = structuredClone(server)
    }
  }
  return { systemPrompt: prompts.join('\n\n'), mcpServers: servers }
}
