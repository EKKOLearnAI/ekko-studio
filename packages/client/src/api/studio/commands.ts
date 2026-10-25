import { request } from '../client'

export interface PluginCommand {
  id: string; name: string; description: string; argsHint?: string; aliases?: string[]
  qualifiedName: string; revision: string; agentTypeIds?: string[]
  provider: { kind: 'plugin'; pluginId: string; version: string; generation: string }
}
export interface PluginCommandCall {
  inputMessageId?: number
  id: string; sessionId: string; commandId: string
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  results: Array<{ event: 'session.command'; session_id: string; commandCallId: string; commandSequence: number; messageId?: number; message: string; ok: boolean; [key: string]: unknown }>
  errorCode: string | null
}
const query = (profile: string) => new URLSearchParams({ profile }).toString()
export async function fetchPluginCommands(sessionId: string, profile: string): Promise<PluginCommand[]> {
  const response = await request<{ data: PluginCommand[] }>(`/api/studio/commands?${new URLSearchParams({ sessionId, profile })}`)
  return response.data
}
export async function startPluginCommand(sessionId: string, command: PluginCommand, text: string, profile: string, idempotencyKey: string): Promise<PluginCommandCall> {
  return (await request<{ data: PluginCommandCall }>(`/api/studio/command-calls?${query(profile)}`, { method: 'POST',
    body: JSON.stringify({ sessionId, commandId: command.id, revision: command.revision, text, idempotencyKey }) })).data
}
export async function getPluginCommand(id: string, profile: string, signal: AbortSignal): Promise<PluginCommandCall> {
  return (await request<{ data: PluginCommandCall }>(`/api/studio/command-calls/${encodeURIComponent(id)}?${query(profile)}`, { signal })).data
}
export async function cancelPluginCommand(id: string, profile: string): Promise<PluginCommandCall> {
  return (await request<{ data: PluginCommandCall }>(`/api/studio/command-calls/${encodeURIComponent(id)}/cancel?${query(profile)}`, { method: 'POST', body: '{}' })).data
}
