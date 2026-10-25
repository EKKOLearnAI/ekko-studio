import { StudioError, type JsonValue, type McpConnectInput, type McpConnectionHandle, type McpToolDefinition, type McpToolResult, type RuntimeMcp, type McpPage, type McpResource, type McpResourceTemplate, type McpResourceContents, type McpPrompt, type McpPromptResult } from '../../studio-plugin-sdk/src'
import type { RpcPeer } from '../../studio-plugin-sdk/src/rpc'

export function remoteMcp(peer: RpcPeer, runtimeHandle: string, signal: AbortSignal, origin: () => string | undefined, assertMutation: () => void): RuntimeMcp {
  const call = (method: string, input: Record<string, JsonValue>, timeoutMs: number): Promise<JsonValue> => {
    assertMutation()
    if (signal.aborted && method !== 'dispose') throw new StudioError('CANCELLED', 'Runtime ended')
    return peer.request('mcp.call', { runtimeHandle, originHandle: origin() || runtimeHandle, method, ...input }, timeoutMs + 10_000)
  }
  return Object.freeze({ connect: async (input: McpConnectInput) => {
    const snapshot = JSON.parse(JSON.stringify(input))
    const timeout = Number.isSafeInteger(input.timeoutMs) && input.timeoutMs! >= 100 && input.timeoutMs! <= 300_000 ? input.timeoutMs! : 30_000
    const result = await call('connect', { input: snapshot }, timeout) as { id: string }
    let disposed: Promise<void> | undefined
    const handle: McpConnectionHandle = {
      id: result.id,
      listTools: async () => await call('listTools', { id: result.id }, timeout) as unknown as McpToolDefinition[],
      callTool: async (name, args) => await call('callTool', { id: result.id, name, input: JSON.parse(JSON.stringify(args)) }, timeout) as unknown as McpToolResult,
      listResources: async cursor => await call('listResources', { id: result.id, ...(cursor === undefined ? {} : { input: { cursor } }) }, timeout) as unknown as McpPage<McpResource>,
      listResourceTemplates: async cursor => await call('listResourceTemplates', { id: result.id, ...(cursor === undefined ? {} : { input: { cursor } }) }, timeout) as unknown as McpPage<McpResourceTemplate>,
      readResource: async uri => await call('readResource', { id: result.id, input: { uri } }, timeout) as unknown as McpResourceContents[],
      listPrompts: async cursor => await call('listPrompts', { id: result.id, ...(cursor === undefined ? {} : { input: { cursor } }) }, timeout) as unknown as McpPage<McpPrompt>,
      getPrompt: async (name, args) => await call('getPrompt', { id: result.id, name, ...(args === undefined ? {} : { input: JSON.parse(JSON.stringify(args)) }) }, timeout) as unknown as McpPromptResult,
      dispose: () => {
        assertMutation()
        if (disposed) return disposed
        const pending = call('dispose', { id: result.id }, timeout).then(() => {})
        disposed = pending
        void pending.catch(() => { if (disposed === pending) disposed = undefined })
        return pending
      },
    }
    return Object.freeze(handle)
  } })
}
