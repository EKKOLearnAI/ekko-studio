// Shared Responses payload translation for Coding Agent provider proxies.
import { imageUrlToAnthropicSource, openAiImageUrl } from './multimodal'
import { shouldPreserveReasoningContent } from './anthropic'

export interface ResponsesAdapterTarget {
  model: string
  provider?: string
  baseUrl?: string
}

const HERMES_STUDIO_NAMESPACE = 'mcp__ekko_studio'
const TOOL_SEARCH_NAME = 'tool_search'
const RESPONSES_TOOL_OUTPUT_FORWARD_LIMIT = 32 * 1024
const RESPONSES_TOOL_OUTPUT_HEAD_BYTES = 24 * 1024
const RESPONSES_TOOL_OUTPUT_TAIL_BYTES = 7 * 1024

const HERMES_STUDIO_MCP_TOOLS = [
  {
    name: 'ekko_studio_lan_devices_list',
    description: 'List known LAN and remote devices from Hermes Web UI, including pairing and online status.',
    inputSchema: inputSchema(),
  },
  {
    name: 'ekko_studio_lan_devices_scan',
    description: 'Refresh LAN device discovery cache and return known devices with pairing and online status.',
    inputSchema: inputSchema(),
  },
  {
    name: 'ekko_studio_lan_peer_connect',
    description: 'Connect to a paired LAN device by device id.',
    inputSchema: inputSchema({ device_id: { type: 'string' } }, ['device_id']),
  },
  {
    name: 'ekko_studio_lan_peer_connections',
    description: 'List active LAN peer socket connections.',
    inputSchema: inputSchema(),
  },
  {
    name: 'ekko_studio_lan_peer_disconnect',
    description: 'Disconnect an active LAN peer socket connection.',
    inputSchema: inputSchema({ connection_id: { type: 'string' } }, ['connection_id']),
  },
  {
    name: 'ekko_studio_lan_terminal_create',
    description: 'Create an interactive terminal on a connected LAN peer.',
    inputSchema: inputSchema({
      connection_id: { type: 'string' },
      shell: { type: 'string' },
      cols: { type: 'number' },
      rows: { type: 'number' },
    }, ['connection_id']),
  },
  {
    name: 'ekko_studio_lan_terminal_list',
    description: 'List interactive terminals tracked for a connected LAN peer, including IDs that can be read or closed.',
    inputSchema: inputSchema({ connection_id: { type: 'string' } }, ['connection_id']),
  },
  {
    name: 'ekko_studio_lan_terminal_input',
    description: 'Write input to an interactive terminal on a connected LAN peer.',
    inputSchema: inputSchema({
      connection_id: { type: 'string' },
      terminal_id: { type: 'string' },
      data: { type: 'string' },
    }, ['connection_id', 'terminal_id', 'data']),
  },
  {
    name: 'ekko_studio_lan_terminal_read',
    description: 'Read buffered terminal output from an interactive terminal.',
    inputSchema: inputSchema({
      connection_id: { type: 'string' },
      terminal_id: { type: 'string' },
    }, ['connection_id', 'terminal_id']),
  },
  {
    name: 'ekko_studio_lan_terminal_resize',
    description: 'Resize an interactive terminal on a connected LAN peer.',
    inputSchema: inputSchema({
      connection_id: { type: 'string' },
      terminal_id: { type: 'string' },
      cols: { type: 'number' },
      rows: { type: 'number' },
    }, ['connection_id', 'terminal_id', 'cols', 'rows']),
  },
  {
    name: 'ekko_studio_lan_terminal_close',
    description: 'Close an interactive terminal on a connected LAN peer.',
    inputSchema: inputSchema({
      connection_id: { type: 'string' },
      terminal_id: { type: 'string' },
    }, ['connection_id', 'terminal_id']),
  },
  {
    name: 'ekko_studio_lan_command_exec',
    description: 'Run a command on a connected LAN peer using command plus args, without shell string execution.',
    inputSchema: inputSchema({
      connection_id: { type: 'string' },
      command: { type: 'string' },
      args: { type: 'array', items: { type: 'string' } },
      cwd: { type: 'string' },
      timeout_ms: { type: 'number' },
    }, ['connection_id', 'command']),
  },
  {
    name: 'ekko_studio_lan_file_download',
    description: 'Download a file from a connected LAN peer remote path to a local path on this machine.',
    inputSchema: inputSchema({
      connection_id: { type: 'string' },
      remote_path: { type: 'string' },
      local_path: { type: 'string' },
      timeout_ms: { type: 'number' },
    }, ['connection_id', 'remote_path', 'local_path']),
  },
  {
    name: 'ekko_studio_lan_file_upload',
    description: 'Upload a local file path from this machine to a connected LAN peer remote path.',
    inputSchema: inputSchema({
      connection_id: { type: 'string' },
      local_path: { type: 'string' },
      remote_path: { type: 'string' },
      timeout_ms: { type: 'number' },
    }, ['connection_id', 'local_path', 'remote_path']),
  },
]

const HERMES_STUDIO_SPLIT_MCP_TOOLS = new Map<string, Array<{
  name: string
  description: string
  inputSchema: Record<string, unknown>
}>>([
  ['mcp__ekko_studio_api', [
    {
      name: 'ekko_studio_api_openapi_get',
      description: 'Return the compact Ekko Studio API module index or filtered endpoint documentation. Call without filters first, then filter by tag, path, or method.',
      inputSchema: inputSchema({
        path: { type: 'string', description: 'Optional exact endpoint path filter.' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] },
        tag: { type: 'string', description: 'Optional module or tag filter.' },
        full: { type: 'boolean', description: 'Return the raw full OpenAPI JSON.' },
      }),
    },
    {
      name: 'ekko_studio_api_request',
      description: 'Call a documented Ekko Studio API endpoint using its relative path and structured JSON fields.',
      inputSchema: inputSchema({
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] },
        path: { type: 'string', description: 'Relative /api/... or /health path. Full URLs are rejected.' },
        body: { type: ['object', 'array', 'string', 'number', 'boolean', 'null'] },
        query: { type: 'object', additionalProperties: true },
        headers: {
          type: 'object',
          additionalProperties: { type: ['string', 'number', 'boolean', 'array'] },
        },
      }, ['path']),
    },
  ]],
  ['mcp__ekko_studio_browser', [categoryToolset(
    'ekko_studio_browser_toolset',
    'Discover and invoke Ekko Studio Desktop browser operations. Covers tabs and leases, navigation, accessibility snapshots, interaction, screenshots, and console logs.',
  )]],
  ['mcp__ekko_studio_devices', [categoryToolset(
    'ekko_studio_devices_toolset',
    'Discover and invoke Ekko Studio LAN and remote-device operations. Covers discovery, peer connections, terminals, structured commands, and file transfer.',
  )]],
  ['mcp__ekko_studio_use', [categoryToolset(
    'ekko_studio_use_toolset',
    'Discover and invoke high-level Ekko Studio operations for explicit user-requested runs, sessions, usage, profiles, models, providers, workers, and workflows.',
  )]],
])

// Historical conversations may still refer to the previous MCP namespaces.
HERMES_STUDIO_SPLIT_MCP_TOOLS.set('mcp__hermes_studio', HERMES_STUDIO_MCP_TOOLS.map(tool => ({
  ...tool, name: tool.name.replace(/^ekko_studio_/, 'hermes_studio_'),
})))
for (const [namespace, tools] of [...HERMES_STUDIO_SPLIT_MCP_TOOLS]) {
  if (!namespace.startsWith('mcp__ekko_studio_')) continue
  HERMES_STUDIO_SPLIT_MCP_TOOLS.set(namespace.replace('mcp__ekko_', 'mcp__hermes_'), tools.map(tool => ({
    ...tool, name: tool.name.replace(/^ekko_studio_/, 'hermes_studio_'),
  })))
}

const HERMES_STUDIO_MCP_TOOL_NAMESPACES = new Map<string, string>(
  HERMES_STUDIO_MCP_TOOLS.map(tool => [tool.name, HERMES_STUDIO_NAMESPACE]),
)
for (const [namespace, tools] of HERMES_STUDIO_SPLIT_MCP_TOOLS) {
  for (const tool of tools) HERMES_STUDIO_MCP_TOOL_NAMESPACES.set(tool.name, namespace)
}

// These tools are exposed by the dedicated, context-scoped interaction server.
// Restore only the return-call namespace; do not synthesize tools or expand
// permissions when the MCP server has intentionally omitted them.
for (const prefix of ['ekko', 'hermes']) {
  for (const suffix of ['update_plan', 'clarify']) {
    HERMES_STUDIO_MCP_TOOL_NAMESPACES.set(`${prefix}_studio_${suffix}`, `mcp__${prefix}_studio_interaction`)
  }
}

function inputSchema(properties: Record<string, unknown> = {}, required: string[] = []) {
  return {
    type: 'object',
    properties: {
      token: {
        type: 'string',
        description: 'Optional Hermes Web UI bearer token. Usually omit this and pass profile so the MCP server can read the temporary profile token.',
      },
      profile: {
        type: 'string',
        description: 'Hermes profile name for profile-scoped Web UI requests and temporary profile token lookup.',
      },
      ...properties,
    },
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  }
}

function categoryToolset(name: string, description: string) {
  return {
    name,
    description: `${description} Use action=list for the compact catalog, action=describe for one full schema, then action=call with that tool name and arguments.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'describe', 'call'],
          description: 'List operations, describe one operation, or call one operation.',
        },
        query: { type: 'string', description: 'Optional operation filter for action=list.' },
        tool: { type: 'string', description: 'Exact operation name required by describe and call.' },
        arguments: {
          type: 'object',
          description: 'Arguments matching the described operation schema.',
          additionalProperties: true,
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  }
}

function normalizedNamespaceName(value: unknown): string {
  return String(value || '').trim().replace(/-/g, '_')
}

function expandedResponseTools(tools: unknown): any[] {
  if (!Array.isArray(tools)) return []
  const mapped: any[] = []
  const seen = new Set<string>()
  const addFunctionTool = (tool: any) => {
    const name = String(tool?.name || '').trim()
    if (!name || seen.has(name)) return
    seen.add(name)
    mapped.push({
      type: 'function',
      name,
      description: String(tool?.description || ''),
      parameters: tool?.parameters || tool?.inputSchema || { type: 'object', properties: {} },
      ...(tool?.namespace ? { namespace: tool.namespace } : {}),
    })
  }
  for (const tool of tools) {
    if (tool?.type === 'function') {
      addFunctionTool(tool)
      continue
    }
    if (tool?.type === 'tool_search') {
      addFunctionTool({
        type: 'function',
        name: TOOL_SEARCH_NAME,
        description: tool.description,
        parameters: tool.parameters,
      })
      continue
    }
    if (tool?.type === 'namespace') {
      const namespace = normalizedNamespaceName(tool?.name)
      if (Array.isArray(tool?.tools)) {
        for (const nestedTool of tool.tools) {
          if (nestedTool?.type !== 'function') continue
          addFunctionTool({ ...nestedTool, namespace })
        }
        continue
      }
      const namespaceTools = namespace === HERMES_STUDIO_NAMESPACE
        ? HERMES_STUDIO_MCP_TOOLS
        : HERMES_STUDIO_SPLIT_MCP_TOOLS.get(namespace)
      if (namespaceTools) {
        for (const mcpTool of namespaceTools) {
          addFunctionTool({
            type: 'function',
            name: mcpTool.name,
            description: `${mcpTool.description} MCP namespace: ${namespace}.`,
            parameters: mcpTool.inputSchema,
            namespace,
          })
        }
        continue
      }
    }
    if (tool?.type === 'namespace') {
      const namespace = normalizedNamespaceName(tool?.name)
      if (namespace.startsWith('mcp__')) {
        addFunctionTool({
          type: 'function',
          name: namespace,
          description: `${String(tool?.description || `Tools in the ${namespace} MCP namespace.`)} Call a tool in this MCP namespace by passing the tool name and its JSON arguments.`,
          parameters: {
            type: 'object',
            properties: {
              tool: {
                type: 'string',
                description: 'Name of the MCP tool to call inside this namespace.',
              },
              arguments: {
                type: 'object',
                description: 'JSON arguments for the MCP tool.',
                additionalProperties: true,
              },
            },
            required: ['tool', 'arguments'],
            additionalProperties: false,
          },
          namespace,
        })
      }
    }
  }
  return mapped
}

function responseInputItems(body: any): any[] {
  return Array.isArray(body?.input) ? body.input : []
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function utf8Head(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  let bytes = 0
  let end = 0
  for (const char of text) {
    const nextBytes = utf8ByteLength(char)
    if (bytes + nextBytes > maxBytes) break
    bytes += nextBytes
    end += char.length
  }
  return text.slice(0, end)
}

function utf8Tail(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  let bytes = 0
  let start = text.length
  while (start > 0) {
    let nextStart = start - 1
    const code = text.charCodeAt(nextStart)
    if (code >= 0xDC00 && code <= 0xDFFF && nextStart > 0) {
      const prev = text.charCodeAt(nextStart - 1)
      if (prev >= 0xD800 && prev <= 0xDBFF) nextStart -= 1
    }
    const char = text.slice(nextStart, start)
    const nextBytes = utf8ByteLength(char)
    if (bytes + nextBytes > maxBytes) break
    bytes += nextBytes
    start = nextStart
  }
  return text.slice(start)
}

function truncateResponsesToolOutputText(output: string): string {
  const originalBytes = utf8ByteLength(output)
  if (originalBytes <= RESPONSES_TOOL_OUTPUT_FORWARD_LIMIT) return output
  const marker = `[Hermes Web UI: coding-agent tool output truncated before provider request; original_chars=${output.length}; original_bytes=${originalBytes}]`
  const markerOverhead = utf8ByteLength(marker) + 4
  const contentBudget = Math.max(0, RESPONSES_TOOL_OUTPUT_FORWARD_LIMIT - markerOverhead)
  const tailBytes = Math.min(RESPONSES_TOOL_OUTPUT_TAIL_BYTES, Math.floor(contentBudget / 4))
  const headBytes = Math.min(RESPONSES_TOOL_OUTPUT_HEAD_BYTES, Math.max(0, contentBudget - tailBytes))
  const head = utf8Head(output, headBytes)
  const tail = utf8Tail(output, tailBytes)
  return [
    head,
    '',
    marker,
    '',
    tail,
  ].join('\n')
}

function inlineResponseImageDataUrl(part: any): string {
  if (!part || typeof part !== 'object' || part.type !== 'input_image') return ''
  const imageUrl = typeof part.image_url === 'string'
    ? part.image_url
    : typeof part.image_url?.url === 'string'
      ? part.image_url.url
      : ''
  return /^data:image\//i.test(imageUrl) ? imageUrl : ''
}

function historicalImageOmission(originalBytes: number): any {
  return {
    type: 'input_text',
    text: `[Hermes Web UI: historical inline image omitted before provider request; original_bytes=${originalBytes}]`,
  }
}

/**
 * Remove every inline image before the latest user item. The latest user item
 * and every item produced after it form the active Codex turn, so all of their
 * images remain available to the model. The transformation is copy-on-write.
 */
export function stripHistoricalResponsesInlineImages(body: any): any {
  const input = responseInputItems(body)
  if (!input.length) return body

  let currentTurnStart = -1
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (input[index]?.role === 'user') {
      currentTurnStart = index
      break
    }
  }
  if (currentTurnStart <= 0) return body

  let changed = false
  const nextInput = input.map((item: any, itemIndex: number) => {
    if (itemIndex >= currentTurnStart || !item || typeof item !== 'object') return item

    let nextItem: any = item
    for (const key of ['content', 'output'] as const) {
      if (!Array.isArray(item[key])) continue
      let partsChanged = false
      const nextParts = item[key].map((part: any) => {
        const imageUrl = inlineResponseImageDataUrl(part)
        if (!imageUrl) return part
        partsChanged = true
        changed = true
        return historicalImageOmission(utf8ByteLength(imageUrl))
      })
      if (partsChanged) {
        if (nextItem === item) nextItem = { ...item }
        nextItem[key] = nextParts
      }
    }
    return nextItem
  })

  return changed ? { ...body, input: nextInput } : body
}

export function truncateResponsesToolOutputs(body: any): any {
  const input = responseInputItems(body)
  if (!input.length) return body

  let changed = false
  const nextInput = input.map((item: any) => {
    if (!item || typeof item !== 'object' || item.type !== 'function_call_output' || typeof item.output !== 'string') {
      return item
    }
    const nextOutput = truncateResponsesToolOutputText(item.output)
    if (nextOutput === item.output) return item
    changed = true
    return { ...item, output: nextOutput }
  })

  return changed ? { ...body, input: nextInput } : body
}

function responsesAvailableTools(body: any): any[] {
  const tools = Array.isArray(body?.tools) ? [...body.tools] : []
  if (Array.isArray(body?.additional_tools)) tools.push(...body.additional_tools)
  for (const item of responseInputItems(body)) {
    if ((item?.type === 'tool_search_output' || item?.type === 'additional_tools') && Array.isArray(item.tools)) {
      tools.push(...item.tools)
    }
  }
  return tools
}

function toolSearchOutputText(item: any): string {
  const names: string[] = []
  for (const tool of Array.isArray(item?.tools) ? item.tools : []) {
    if (tool?.type === 'namespace') {
      const namespace = String(tool.name || '').trim()
      for (const nestedTool of Array.isArray(tool.tools) ? tool.tools : []) {
        const name = String(nestedTool?.name || '').trim()
        if (name) names.push(namespace ? `${namespace}.${name}` : name)
      }
      if (!Array.isArray(tool.tools) || !tool.tools.length) names.push(namespace)
      continue
    }
    const name = String(tool?.name || '').trim()
    if (name) names.push(name)
  }
  return names.length
    ? `Loaded deferred tools: ${names.join(', ')}`
    : 'No deferred tools matched the search.'
}

function toolSearchArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return safeJsonParse(String(value || '{}'))
}

function responseToolCall(name: unknown, argumentsValue: unknown, id: unknown, index: number): any {
  const rawName = String(name || 'tool')
  const callId = String(id || `call_${index}`)
  if (rawName === TOOL_SEARCH_NAME) {
    return {
      type: 'tool_search_call',
      call_id: callId,
      status: 'completed',
      execution: 'client',
      arguments: toolSearchArguments(argumentsValue),
    }
  }
  const rawArguments = typeof argumentsValue === 'string'
    ? argumentsValue
    : JSON.stringify(argumentsValue || {})
  return {
    type: 'function_call',
    id: String(id || `fc_${index}`),
    call_id: callId,
    ...normalizeResponseFunctionCall(rawName, rawArguments),
  }
}

export function responseToolNamespaceForName(name: unknown): string | undefined {
  return HERMES_STUDIO_MCP_TOOL_NAMESPACES.get(String(name || ''))
}

export function normalizeResponseFunctionCall(name: unknown, argumentsValue: unknown): { name: string; arguments: string; namespace?: string } {
  const rawName = String(name || 'tool')
  const rawArguments = String(argumentsValue || '{}')
  const namespace = normalizedNamespaceName(rawName)
  if (namespace.startsWith('mcp__')) {
    const parsed = safeJsonParse(rawArguments)
    const toolName = String(parsed?.tool || parsed?.name || '').trim()
    if (toolName) {
      const toolArguments = parsed?.arguments && typeof parsed.arguments === 'object'
        ? parsed.arguments
        : parsed?.input && typeof parsed.input === 'object'
          ? parsed.input
          : {}
      return {
        name: toolName,
        arguments: JSON.stringify(toolArguments),
        namespace,
      }
    }
  }

  const knownNamespace = responseToolNamespaceForName(rawName)
  return {
    name: rawName,
    arguments: rawArguments,
    ...(knownNamespace ? { namespace: knownNamespace } : {}),
  }
}

export function targetReasoningEffort(target: any): string {
  const effort = String(target?.reasoningEffort || '').trim()
  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? effort : ''
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object') {
        const block = item as any
        if (typeof block.text === 'string') return block.text
        if (typeof block.output === 'string') return block.output
      }
      return JSON.stringify(item)
    }).filter(Boolean).join('\n')
  }
  if (value == null) return ''
  return JSON.stringify(value)
}

function safeJsonParse(value: string): any {
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}
function responseContentToOpenAiChat(content: unknown): string | any[] {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return stringifyContent(content)
  const parts: any[] = []
  let hasImage = false
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push({ type: 'text', text: part })
      continue
    }
    if (part?.type === 'input_text' || part?.type === 'output_text' || part?.type === 'text' || (part && typeof part === 'object' && 'text' in part)) {
      parts.push({ type: 'text', text: String(part.text || '') })
      continue
    }
    if (part?.type === 'input_image') {
      const url = openAiImageUrl(part)
      if (url) {
        hasImage = true
        const detail = typeof part.detail === 'string' ? part.detail : ''
        parts.push({
          type: 'image_url',
          image_url: {
            url,
            ...(detail ? { detail } : {}),
          },
        })
      }
      continue
    }
    const text = stringifyContent(part)
    if (text) parts.push({ type: 'text', text })
  }
  if (hasImage) return parts
  return parts.map(part => String(part.text || '')).filter(Boolean).join('\n')
}

function responseToolOutputToOpenAiChat(output: unknown, toolName: string, callId: string): {
  toolContent: string
  imageMessageContent: any[]
} {
  const converted = responseContentToOpenAiChat(output)
  if (typeof converted === 'string') {
    return { toolContent: converted, imageMessageContent: [] }
  }
  const imageParts = converted.filter(part => part?.type === 'image_url')
  const text = converted
    .filter(part => part?.type === 'text')
    .map(part => String(part.text || ''))
    .filter(Boolean)
    .join('\n')
  if (!imageParts.length) {
    return { toolContent: text, imageMessageContent: [] }
  }
  return {
    toolContent: text || `[Image output attached for tool ${toolName}]`,
    imageMessageContent: [
      { type: 'text', text: `[Image output from tool ${toolName} (${callId})]` },
      ...imageParts,
    ],
  }
}

function chatRoleForResponsesRole(role: unknown): string {
  const value = String(role || '').trim()
  if (value === 'developer') return 'system'
  if (value === 'system' || value === 'user' || value === 'assistant' || value === 'tool') return value
  return 'user'
}

function inlineReasoningText(item: any): string {
  for (const field of ['reasoning_content', 'reasoning', 'reasoning_text']) {
    if (typeof item?.[field] === 'string' && item[field]) return item[field]
  }
  return ''
}

function responsesReasoningText(item: any): string {
  const inline = inlineReasoningText(item)
  if (inline) return inline

  const textParts = (value: unknown): string[] => {
    const entries = Array.isArray(value) ? value : [value]
    return entries.flatMap((entry: any) => {
      if (typeof entry === 'string') return entry ? [entry] : []
      if (!entry || typeof entry !== 'object') return []
      if (typeof entry.text === 'string' && entry.text) return [entry.text]
      return textParts(entry.summary)
    })
  }

  return [...textParts(item?.summary), ...textParts(item?.content)].join('')
}

function responsesInputToChatMessages(body: any, target: ResponsesAdapterTarget): any[] {
  const messages: any[] = []
  if (body?.instructions) {
    messages.push({ role: 'system', content: stringifyContent(body.instructions) })
  }

  const input = body?.input
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input })
    return messages
  }

  let pendingToolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = []
  let pendingToolOutputs = new Map<string, any>()
  let pendingReasoning = ''
  const preserveReasoningContent = shouldPreserveReasoningContent({
    provider: String(target.provider || ''),
    model: target.model,
    baseUrl: String(target.baseUrl || ''),
  })
  const flushCompletedToolCalls = () => {
    if (!pendingToolCalls.length) return
    const outputs = pendingToolCalls.map(call => pendingToolOutputs.get(call.id))
    if (outputs.every(Boolean)) {
      const imageMessageContent: any[] = []
      messages.push({
        role: 'assistant',
        content: null,
        // Synthetic/replayed tool calls may have no reasoning item. Keep the
        // required field present, matching Ekko's Chat Completions adapter.
        ...(preserveReasoningContent
          ? { reasoning_content: pendingReasoning }
          : {}),
        tool_calls: pendingToolCalls,
      })
      for (let index = 0; index < pendingToolCalls.length; index += 1) {
        const call = pendingToolCalls[index]
        const converted = responseToolOutputToOpenAiChat(
          outputs[index].output,
          call.function.name,
          call.id,
        )
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: converted.toolContent,
        })
        imageMessageContent.push(...converted.imageMessageContent)
      }
      if (imageMessageContent.length) {
        messages.push({
          role: 'user',
          content: imageMessageContent,
        })
      }
    }
    pendingToolCalls = []
    pendingToolOutputs = new Map()
    pendingReasoning = ''
  }

  for (const item of Array.isArray(input) ? input : []) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 'reasoning') {
      flushCompletedToolCalls()
      const reasoning = responsesReasoningText(item)
      if (reasoning.startsWith(pendingReasoning)) pendingReasoning = reasoning
      else if (reasoning && !pendingReasoning.endsWith(reasoning)) pendingReasoning += reasoning
      continue
    }
    if (item.type === 'function_call' || item.type === 'tool_search_call') {
      const callId = String(item.call_id || item.id || `call_${messages.length}`)
      pendingToolCalls.push({
        id: callId,
        type: 'function',
        function: {
          name: item.type === 'tool_search_call' ? TOOL_SEARCH_NAME : String(item.name || 'tool'),
          arguments: item.type === 'tool_search_call'
            ? JSON.stringify(toolSearchArguments(item.arguments))
            : String(item.arguments || '{}'),
        },
      })
      continue
    }
    if (item.type === 'function_call_output' || item.type === 'tool_search_output') {
      const callId = String(item.call_id || '')
      if (pendingToolCalls.some(call => call.id === callId)) {
        pendingToolOutputs.set(callId, item.type === 'tool_search_output'
          ? { output: toolSearchOutputText(item) }
          : item)
        if (pendingToolCalls.every(call => pendingToolOutputs.has(call.id))) {
          flushCompletedToolCalls()
        }
      }
      continue
    }
    flushCompletedToolCalls()
    if (item.role) {
      const role = chatRoleForResponsesRole(item.role)
      messages.push({
        role,
        content: responseContentToOpenAiChat(item.content),
        ...(role === 'assistant' && preserveReasoningContent
          ? { reasoning_content: inlineReasoningText(item) || pendingReasoning }
          : {}),
      })
      pendingReasoning = ''
    }
  }
  flushCompletedToolCalls()

  const built = messages.length ? messages : [{ role: 'user', content: '' }]
  return consolidateChatSystemMessages(built)
}

// Codex sends both a top-level `instructions` string and `developer` messages
// inside `input`; converting each to a `system` message yields multiple system
// messages with the later ones out of position. Some providers (notably vLLM)
// reject that with "System message must be at the beginning" (400). Fix: keep
// exactly one leading system message — merging any additional ones into it in
// original order (top-level instructions first, then in-input developer
// messages).
function consolidateChatSystemMessages(messages: any[]): any[] {
  const systemMessages: any[] = []
  const rest: any[] = []
  for (const message of messages) {
    if (message?.role === 'system') systemMessages.push(message)
    else rest.push(message)
  }
  if (systemMessages.length === 0) return messages
  // Exactly one system message: keep its content verbatim (string or image
  // parts) and only relocate it to the front if it was mid-conversation.
  if (systemMessages.length === 1) {
    const only = systemMessages[0]
    if (messages[0] === only) return messages
    return [only, ...rest]
  }
  // Multiple system messages (top-level instructions + in-input developer
  // messages): merge their text into one leading system message.
  const parts = systemMessages
    .map(message => (typeof message.content === 'string' ? message.content : stringifyContent(message.content)))
    .filter(Boolean)
  return [{ role: 'system', content: parts.join('\n\n') }, ...rest]
}

function responsesToolsToChatTools(tools: unknown): any[] | undefined {
  const mapped = expandedResponseTools(tools).map((tool: any) => {
    if (tool?.type !== 'function') return null
    return {
      type: 'function',
      function: {
        name: String(tool.name || ''),
        description: String(tool.description || ''),
        parameters: tool.parameters || { type: 'object', properties: {} },
      },
    }
  }).filter((tool: any) => tool?.function?.name)
  return mapped.length ? mapped : undefined
}

export function responsesToOpenAiChat(body: any, target: ResponsesAdapterTarget, stream = false): any {
  const tools = responsesToolsToChatTools(responsesAvailableTools(body))
  const reasoningEffort = targetReasoningEffort(target)
  return {
    model: target.model,
    messages: responsesInputToChatMessages(body, target),
    ...(typeof body?.max_output_tokens === 'number' ? { max_tokens: body.max_output_tokens } : {}),
    ...(typeof body?.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof body?.top_p === 'number' ? { top_p: body.top_p } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(tools?.length ? { tools } : {}),
    stream,
  }
}

function responsesRoleToAnthropicRole(role: unknown): 'user' | 'assistant' {
  return String(role || '') === 'assistant' ? 'assistant' : 'user'
}

function responsesContentToAnthropicContent(content: unknown, role: 'user' | 'assistant'): any[] {
  const parts = Array.isArray(content) ? content : [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: stringifyContent(content) }]
  const mapped = parts.map((part: any) => {
    if (typeof part === 'string') return { type: 'text', text: part }
    if (part?.type === 'input_text' || part?.type === 'output_text' || part?.type === 'text' || (part && typeof part === 'object' && 'text' in part)) {
      return { type: 'text', text: String(part.text || '') }
    }
    if (part?.type === 'input_image') {
      const url = openAiImageUrl(part)
      const source = url ? imageUrlToAnthropicSource(url) : null
      return source ? { type: 'image', source } : null
    }
    return null
  }).filter(Boolean)
  return mapped.length ? mapped : [{ type: 'text', text: '' }]
}

function responsesToolOutputToAnthropicContent(output: unknown): string | any[] {
  if (typeof output === 'string') return output
  const parts = responsesContentToAnthropicContent(output, 'user')
  if (parts.some(part => part?.type === 'image')) return parts
  return parts.map(part => String(part.text || '')).filter(Boolean).join('\n')
}

function responsesInputToAnthropicMessages(body: any): any[] {
  const messages: any[] = []
  const input = body?.input
  if (typeof input === 'string') return [{ role: 'user', content: [{ type: 'text', text: input }] }]

  for (const item of Array.isArray(input) ? input : []) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 'function_call' || item.type === 'tool_search_call') {
      messages.push({
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: String(item.call_id || item.id || `toolu_${messages.length}`),
          name: item.type === 'tool_search_call' ? TOOL_SEARCH_NAME : String(item.name || 'tool'),
          input: item.type === 'tool_search_call'
            ? toolSearchArguments(item.arguments)
            : safeJsonParse(String(item.arguments || '{}')),
        }],
      })
      continue
    }
    if (item.type === 'function_call_output' || item.type === 'tool_search_output') {
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: String(item.call_id || ''),
          content: item.type === 'tool_search_output'
            ? toolSearchOutputText(item)
            : responsesToolOutputToAnthropicContent(item.output),
        }],
      })
      continue
    }
    if (item.role) {
      const role = responsesRoleToAnthropicRole(item.role)
      messages.push({
        role,
        content: responsesContentToAnthropicContent(item.content, role),
      })
    }
  }

  return messages.length ? messages : [{ role: 'user', content: [{ type: 'text', text: '' }] }]
}

function responsesToolsToAnthropicTools(tools: unknown): any[] | undefined {
  const mapped = expandedResponseTools(tools).map((tool: any) => {
    if (tool?.type !== 'function') return null
    return {
      name: String(tool.name || ''),
      description: String(tool.description || ''),
      input_schema: tool.parameters || { type: 'object', properties: {} },
    }
  }).filter((tool: any) => tool?.name)
  return mapped.length ? mapped : undefined
}

export function responsesToAnthropicMessages(body: any, target: ResponsesAdapterTarget, stream = false): any {
  const tools = responsesToolsToAnthropicTools(responsesAvailableTools(body))
  const reasoningEffort = targetReasoningEffort(target)
  return {
    model: target.model,
    messages: responsesInputToAnthropicMessages(body),
    ...(body?.instructions ? { system: stringifyContent(body.instructions) } : {}),
    ...(typeof body?.max_output_tokens === 'number' ? { max_tokens: body.max_output_tokens } : { max_tokens: 4096 }),
    ...(typeof body?.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof body?.top_p === 'number' ? { top_p: body.top_p } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(tools?.length ? { tools } : {}),
    stream,
  }
}

function responseId(data: any): string {
  return String(data?.id || `resp_${Date.now()}`)
}

function usageFromChat(data: any) {
  return {
    input_tokens: Number(data?.usage?.prompt_tokens || 0),
    output_tokens: Number(data?.usage?.completion_tokens || 0),
    total_tokens: Number(data?.usage?.total_tokens || 0),
  }
}

function usageFromAnthropic(data: any) {
  const inputTokens = Number(data?.usage?.input_tokens || 0)
  const outputTokens = Number(data?.usage?.output_tokens || 0)
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  }
}

function openAiChatReasoningText(message: any): string {
  for (const field of ['reasoning_content', 'reasoning', 'reasoning_text']) {
    if (typeof message?.[field] === 'string' && message[field]) return message[field]
  }

  const details = Array.isArray(message?.reasoning_details)
    ? message.reasoning_details
    : [message?.reasoning_details]
  return details.map((entry: any) => {
    if (typeof entry === 'string') return entry
    return typeof entry?.text === 'string' ? entry.text : ''
  }).join('')
}

export function openAiChatToResponses(data: any, target: ResponsesAdapterTarget): any {
  const choice = data?.choices?.[0] || {}
  const message = choice.message || {}
  const output: any[] = []
  const reasoningText = openAiChatReasoningText(message)

  if (reasoningText) {
    output.push({
      type: 'reasoning',
      id: `rs_${responseId(data)}`,
      summary: [{ type: 'summary_text', text: reasoningText }],
    })
  }

  if (message.content) {
    output.push({
      type: 'message',
      id: `msg_${responseId(data)}`,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: String(message.content), annotations: [] }],
    })
  }

  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    output.push(responseToolCall(
      call.function?.name || 'tool',
      call.function?.arguments || '{}',
      call.id,
      output.length,
    ))
  }

  return {
    id: responseId(data),
    object: 'response',
    created_at: Number(data?.created || Math.floor(Date.now() / 1000)),
    status: 'completed',
    model: target.model,
    output,
    usage: usageFromChat(data),
  }
}

export function anthropicMessageToResponses(data: any, target: ResponsesAdapterTarget): any {
  const output: any[] = []
  const textParts: string[] = []
  const reasoningParts: string[] = []
  for (const block of Array.isArray(data?.content) ? data.content : []) {
    if (block?.type === 'text' && block.text) textParts.push(String(block.text))
    if (block?.type === 'thinking' && block.thinking) reasoningParts.push(String(block.thinking))
    if (block?.type === 'redacted_thinking') reasoningParts.push('[redacted thinking]')
    if (block?.type === 'tool_use') {
      output.push(responseToolCall(
        block.name || 'tool',
        block.input || {},
        block.id,
        output.length,
      ))
    }
  }
  if (textParts.length) {
    output.unshift({
      type: 'message',
      id: `msg_${responseId(data)}`,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: textParts.join('\n'), annotations: [] }],
    })
  }
  if (reasoningParts.length) {
    output.unshift({
      type: 'reasoning',
      id: `rs_${responseId(data)}`,
      summary: [{ type: 'summary_text', text: reasoningParts.join('\n') }],
    })
  }

  return {
    id: responseId(data),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: target.model,
    output,
    usage: usageFromAnthropic(data),
  }
}
