/**
 * Shared MCP types used by both the bridge client and the service layer.
 */

export interface McpServerEntry {
  name: string
  transport: string
  connected: boolean
  tools: number
  tools_registered: number
  tool_names: string[]
  tool_names_registered: string[]
  error?: string | null
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  tools_config?: { include?: string[]; exclude?: string[] }
  prompts?: boolean
  resources?: boolean
  enabled?: boolean
}

export interface McpToolEntry {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface McpActionResult {
  ok: boolean
  error?: string
}

export interface McpListResponse extends McpActionResult {
  servers: McpServerEntry[]
  total_tools: number
}

export interface McpAddResponse extends McpActionResult {
  name?: string
}

export interface McpTestResponse extends McpActionResult {
  tools?: string[]
}

export interface McpToolsListResponse extends McpActionResult {
  results?: Array<{ server: string; tools: McpToolEntry[] }>
}

export interface McpReloadResponse extends McpActionResult {
  message?: string
}

/**
 * Union of all MCP action responses.
 * Bridge client methods return this; controllers narrow by action.
 */
export type McpActionResponse =
  | McpListResponse
  | McpAddResponse
  | McpTestResponse
  | McpToolsListResponse
  | McpReloadResponse
  | McpActionResult
