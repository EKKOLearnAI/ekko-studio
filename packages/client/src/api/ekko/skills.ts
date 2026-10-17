import { getActiveProfileName, getApiKey, getBaseUrlValue, request } from '@/api/client'
import type { ExternalDirEntry, SkillFileEntry, SkillSource } from '@/api/hermes/skills'

export interface EkkoSkillSummary {
  name: string
  description: string
  category: string
  source: Exclude<SkillSource, 'hub'>
  sourcePath?: string
  enabled: boolean
  managedByEkko: boolean
  builtIn: boolean
}

export interface EkkoSkillDetail extends EkkoSkillSummary {
  content: string
}

export async function fetchEkkoSkills(query = '', profile?: string): Promise<EkkoSkillSummary[]> {
  const params: string[] = []
  if (query) params.push(`query=${encodeURIComponent(query)}`)
  if (profile) params.push(`profile=${encodeURIComponent(profile)}`)
  const suffix = params.length ? `?${params.join('&')}` : ''
  const response = await request<{ ok: boolean; skills: EkkoSkillSummary[] }>(`/api/ekko/skills${suffix}`)
  return response.skills
}

export async function fetchEkkoSkill(name: string, profile?: string): Promise<EkkoSkillDetail> {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : ''
  const response = await request<{ ok: boolean; skill: EkkoSkillDetail }>(`/api/ekko/skills/${encodeURIComponent(name)}${query}`)
  return response.skill
}

export async function createEkkoSkill(input: {
  name: string
  content: string
  category?: string
}, profile?: string): Promise<EkkoSkillDetail> {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : ''
  const response = await request<{ ok: boolean; skill: EkkoSkillDetail }>(`/api/ekko/skills${query}`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return response.skill
}

export async function updateEkkoSkill(name: string, content: string, profile?: string): Promise<EkkoSkillDetail> {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : ''
  const response = await request<{ ok: boolean; skill: EkkoSkillDetail }>(`/api/ekko/skills/${encodeURIComponent(name)}${query}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })
  return response.skill
}

export async function deleteEkkoSkill(name: string, profile?: string): Promise<void> {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : ''
  await request(`/api/ekko/skills/${encodeURIComponent(name)}${query}`, { method: 'DELETE' })
}

export async function toggleEkkoSkill(name: string, enabled: boolean, profile?: string): Promise<void> {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : ''
  await request(`/api/ekko/skills/${encodeURIComponent(name)}/toggle${query}`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })
}

export async function fetchEkkoSkillFiles(name: string, profile?: string): Promise<SkillFileEntry[]> {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : ''
  const response = await request<{ ok: boolean; files: SkillFileEntry[] }>(
    `/api/ekko/skills/${encodeURIComponent(name)}/files${query}`,
  )
  return response.files
}

export async function fetchEkkoSkillFile(name: string, path: string, profile?: string): Promise<string> {
  const params: string[] = [`path=${encodeURIComponent(path)}`]
  if (profile) params.push(`profile=${encodeURIComponent(profile)}`)
  const response = await request<{ ok: boolean; content: string }>(
    `/api/ekko/skills/${encodeURIComponent(name)}/file?${params.join('&')}`,
  )
  return response.content
}

export async function fetchEkkoExternalDirectories(profile?: string): Promise<ExternalDirEntry[]> {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : ''
  const response = await request<{ ok: boolean; directories: ExternalDirEntry[] }>(
    `/api/ekko/skills/external-directories${query}`,
  )
  return response.directories
}

export async function saveEkkoExternalDirectories(directories: string[], profile?: string): Promise<void> {
  const query = profile ? `?profile=${encodeURIComponent(profile)}` : ''
  await request(`/api/ekko/skills/external-directories${query}`, {
    method: 'PUT',
    body: JSON.stringify({ directories }),
  })
}

export async function importEkkoSkill(files: File[], category?: string, profile?: string): Promise<{ name: string }> {
  const headers: Record<string, string> = {}
  const token = getApiKey()
  if (token) headers.Authorization = `Bearer ${token}`
  const activeProfile = profile || getActiveProfileName()
  if (activeProfile) headers['X-Hermes-Profile'] = activeProfile
  const formData = new FormData()
  for (const file of files) {
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    formData.append('file', file, path)
  }
  if (category) formData.append('category', category)
  const response = await fetch(`${getBaseUrlValue()}/api/ekko/skills/import`, {
    method: 'POST',
    headers,
    body: formData,
  })
  const text = await response.text()
  let payload: { name?: string; error?: string } | null = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    // Preserve raw text for useful server/proxy errors.
  }
  if (!response.ok) throw new Error(payload?.error || text || `Import failed (${response.status})`)
  return { name: payload?.name || '' }
}
