import { request } from '../client'

export interface AgentResourceInstance { id: string; agentTypeId: string; revision: number; mode: 'scoped' | 'global' }
export interface AgentResourceLocation {
  id: string; name: string; path: string; scope: 'global' | 'scoped' | 'workspace' | 'shared' | 'builtin'; readOnly: boolean
  kind?: 'file' | 'directory'; format?: string
}
export interface AgentResourceRef { kind: 'skills' | 'configs'; locationId: string; path: string }
export interface AgentResourceFile extends AgentResourceRef { absolutePath: string; exists: boolean; readOnly: boolean }
export interface AgentResourceContent extends AgentResourceFile { content: string; etag: string }
export interface AgentResourceCatalog {
  instanceId: string; configRevision: number; snapshot: string
  skills?: AgentResourceLocation[]; configs?: AgentResourceLocation[]; files: AgentResourceFile[]
}
export async function fetchResourceInstances(profile: string): Promise<AgentResourceInstance[]> {
  return (await request<{ data: AgentResourceInstance[] }>(`/api/studio/agent-instances?${new URLSearchParams({ profile })}`)).data
}
const pending = new Map<string, Promise<unknown>>()
async function resourceQueue<T>(instance: AgentResourceInstance, profile: string, action: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([profile, instance.id])
  const task = (pending.get(key) || Promise.resolve()).catch(() => {}).then(action)
  pending.set(key, task)
  try { return await task } finally { if (pending.get(key) === task) pending.delete(key) }
}
function resourceRequest<T>(instance: AgentResourceInstance, profile: string, body: Record<string, unknown>): Promise<T> {
  const path = `/api/studio/agent-instances/${encodeURIComponent(instance.id)}/resources?${new URLSearchParams({ profile })}`
  const encoded = JSON.stringify({ revision: instance.revision, ...body })
  return resourceQueue(instance, profile, async () => (await request<{ data: T }>(path, { method: 'POST', body: encoded })).data)
}
export function fetchResourceCatalog(instance: AgentResourceInstance, profile: string): Promise<AgentResourceCatalog> {
  return resourceRequest(instance, profile, { action: 'list' })
}
const refFields = (ref: AgentResourceRef) => ({ kind: ref.kind, locationId: ref.locationId, path: ref.path })
export async function readAgentResource(instance: AgentResourceInstance, profile: string, snapshot: string, ref: AgentResourceRef): Promise<AgentResourceContent> {
  return (await resourceRequest<{ file: AgentResourceContent }>(instance, profile, { action: 'read', snapshot, ...refFields(ref) })).file
}
export async function writeAgentResource(instance: AgentResourceInstance, profile: string, snapshot: string, file: AgentResourceContent, content: string): Promise<AgentResourceContent> {
  return (await resourceRequest<{ file: AgentResourceContent }>(instance, profile, { action: 'write', snapshot, ...refFields(file), etag: file.etag, content })).file
}
export interface AgentResourceSkillReview { locationId: string; path: string; name: string; etag: string; files: number; bytes: number }
export async function reviewAgentResourceSkill(instance: AgentResourceInstance, profile: string, snapshot: string, locationId: string, path: string) {
  return (await resourceRequest<{ skill: AgentResourceSkillReview }>(instance, profile, { action: 'review-skill', kind: 'skills', snapshot, locationId, path })).skill
}
export function removeAgentResourceSkill(instance: AgentResourceInstance, profile: string, snapshot: string, review: AgentResourceSkillReview) {
  return resourceRequest(instance, profile, { action: 'remove-skill', kind: 'skills', snapshot, locationId: review.locationId, path: review.path, etag: review.etag })
}
export function importAgentResourceSkill(instance: AgentResourceInstance, profile: string, snapshot: string, locationId: string, files: File[]): Promise<{ name: string }> {
  const body = new FormData()
  body.append('revision', String(instance.revision)); body.append('snapshot', snapshot); body.append('locationId', locationId)
  for (const file of files) body.append('file', file, file.webkitRelativePath || file.name)
  const path = `/api/studio/agent-instances/${encodeURIComponent(instance.id)}/skills/import?${new URLSearchParams({ profile })}`
  return resourceQueue(instance, profile, async () => (await request<{ data: { name: string } }>(path, { method: 'POST', body })).data)
}
