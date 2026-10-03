import { abortSignal, isPlainRecord } from '../model/http'
import type { AgentToolDefinition, FetchLike, ModelRequest } from '../model/types'
import type { AgentTool } from '../tools/types'
import type { AgentContextManager, AgentContextManagerRequest } from './types'

export interface BillionContextClientOptions {
  proxyOrigin: string
  fetch?: FetchLike
  timeoutMs?: number
}

export interface BillionContextPublicRequest {
  method?: 'GET' | 'POST'
  body?: Record<string, unknown>
  signal?: AbortSignal
}

export interface BillionContextManifest {
  ok: true
  protocolVersion: number
  toolNames: string[]
  tools: { openai: Array<{ type: string; function: AgentToolDefinition }> }
  [key: string]: unknown
}

/** Public HTTP protocol only; no proxy process, private code or state-file ownership. */
export class BillionContextClient {
  readonly proxyOrigin: string
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number

  constructor(options: BillionContextClientOptions) {
    const origin = new URL(options.proxyOrigin)
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
      throw new Error('Billion-context proxyOrigin must be an HTTP(S) origin without credentials or a path.')
    }
    this.proxyOrigin = origin.origin
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = options.timeoutMs ?? 10000
  }

  async callPublic<T = Record<string, unknown>>(path: string, options: BillionContextPublicRequest = {}): Promise<T> {
    const target = new URL(path, this.proxyOrigin)
    if (target.origin !== this.proxyOrigin || !target.pathname.startsWith('/__bili/')) {
      throw new Error('Billion-context public requests must stay under /__bili/ on the configured proxy.')
    }
    const response = await this.fetchImpl(target, {
      method: options.method ?? (options.body ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json' },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: abortSignal(this.timeoutMs, options.signal),
      redirect: 'error',
    })
    if (!response.ok) throw new Error(`Billion-context ${target.pathname} failed with HTTP ${response.status}.`)
    const value: unknown = await response.json()
    if (!isPlainRecord(value) || value.ok !== true) throw new Error(`Billion-context ${target.pathname} returned an unsuccessful response.`)
    return value as T
  }

  async manifest(signal?: AbortSignal): Promise<BillionContextManifest> {
    const value = await this.callPublic<BillionContextManifest>('/__bili/plugin/manifest', { signal })
    if (!Number.isInteger(value.protocolVersion) || value.protocolVersion < 1 || !Array.isArray(value.toolNames) || !value.toolNames.length || !isPlainRecord(value.tools) || !Array.isArray(value.tools.openai)) {
      throw new Error('Billion-context returned an invalid tool manifest.')
    }
    const requiredTools = ['compress', 'decompress', 'search_context', 'acp_status', 'acp_cache']
    if (!requiredTools.every(name => value.toolNames.includes(name))) {
      throw new Error('Billion-context manifest must advertise all five public tools.')
    }
    for (const tool of value.tools.openai) {
      if (!isPlainRecord(tool) || tool.type !== 'function' || !isPlainRecord(tool.function) || typeof tool.function.name !== 'string' || !tool.function.name || !isPlainRecord(tool.function.parameters) || tool.function.parameters.type !== 'object') {
        throw new Error('Billion-context manifest has an invalid tool schema.')
      }
    }
    const seen = new Set<string>()
    for (const name of value.toolNames) {
      const matches = value.tools.openai.filter(tool => isPlainRecord(tool) && isPlainRecord(tool.function) && tool.function.name === name)
      if (typeof name !== 'string' || !name || seen.has(name) || matches.length !== 1 || !isPlainRecord(matches[0].function.parameters)) {
        throw new Error('Billion-context manifest has missing or duplicate tool schemas.')
      }
      seen.add(name)
    }
    return value
  }

  register(body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.callPublic('/__bili/plugin/register', { body, signal })
  }

  runtimeInfo(body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.callPublic('/__bili/plugin/runtime-info', { body, signal })
  }

  async tool(conversationId: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const reply = await this.callPublic('/__bili/plugin/tool', { body: { conversationId, tool, args }, signal })
    if (typeof reply.result !== 'string') throw new Error('Billion-context tool returned no result text.')
    return reply.result
  }

  status(conversationId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.callPublic(`/__bili/plugin/status?conversationId=${encodeURIComponent(conversationId)}`, { signal })
  }

  /** Notify a native history rewrite; this does not ask bili to compress history. */
  compact(conversationId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.callPublic('/__bili/plugin/compact', { body: { conversationId }, signal })
  }
}

export interface BillionContextManagerOptions extends BillionContextClientOptions {
  agent?: string
  contextWindow?: number
}

export class BillionContextManager implements AgentContextManager {
  readonly strategy = 'billion-context'
  readonly client: BillionContextClient
  private readonly agent: string
  private readonly contextWindow?: number
  private manifest?: BillionContextManifest
  private manifestPromise?: Promise<BillionContextManifest>

  constructor(options: BillionContextManagerOptions) {
    if (options.contextWindow !== undefined && (!Number.isSafeInteger(options.contextWindow) || options.contextWindow <= 0)) {
      throw new Error('Billion-context contextWindow must be a positive integer.')
    }
    this.client = new BillionContextClient(options)
    this.agent = options.agent ?? 'ekko-agent'
    this.contextWindow = options.contextWindow
  }

  async tools(signal?: AbortSignal): Promise<AgentTool[]> {
    const manifest = await this.loadManifest(signal)
    return manifest.toolNames.map(name => {
      const definition = manifest.tools.openai.find(tool => tool.function.name === name)!.function
      return {
        definition: structuredClone(definition),
        execute: async (args, context) => {
          if (!context?.contextConversationId) throw new Error('Billion-context tool requires a runtime-owned conversation ID.')
          return { ok: true, content: await this.client.tool(context.contextConversationId, name, args, context.signal) }
        },
      }
    })
  }

  async prepareRequest(request: ModelRequest, binding: AgentContextManagerRequest): Promise<ModelRequest> {
    if (binding.modelClient.supportsContextTransport !== true) {
      throw new Error(`Billion-context transport is unsupported by ${binding.modelClient.requestStyle}.`)
    }
    await this.loadManifest(request.signal)
    const model = request.model ?? binding.modelClient.defaultModel
    if (!model) throw new Error('Billion-context requires the actual model ID.')
    const contextWindow = this.contextWindow ?? binding.modelClient.capabilities.maxInputTokens
    const headers: Record<string, string> = {
      'x-bili-plugin': this.agent,
      'x-bili-plugin-conversation': binding.conversationId,
      'x-bili-plugin-model': model,
    }
    if (contextWindow !== undefined) headers['x-bili-plugin-context-window'] = String(contextWindow)
    if (request.maxTokens !== undefined) headers['x-bili-plugin-max-output'] = String(request.maxTokens)
    await this.client.runtimeInfo({
      agent: this.agent,
      conversationId: binding.conversationId,
      model,
      contextWindow,
      maxOutput: request.maxTokens,
      source: 'ekko-agent',
    }, request.signal)
    return { ...request, transport: { proxyOrigin: this.client.proxyOrigin, headers } }
  }

  private loadManifest(signal?: AbortSignal): Promise<BillionContextManifest> {
    signal?.throwIfAborted()
    if (this.manifest) return Promise.resolve(this.manifest)
    const load = async () => {
      const manifest = await this.client.manifest(signal)
      this.manifest = manifest
      return manifest
    }
    // A caller's cancellation must not abort another run sharing this manager.
    if (signal) return load()
    this.manifestPromise ??= load().catch(error => {
      this.manifestPromise = undefined
      throw error
    })
    return this.manifestPromise
  }
}
