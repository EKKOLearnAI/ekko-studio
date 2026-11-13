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

export async function fetchEkkoSkills(query = ''): Promise<EkkoSkillSummary[]> {
  const suffix = query ? `?query=${encodeURIComponent(query)}` : ''
  const response = await request<{ ok: boolean; skills: EkkoSkillSummary[] }>(`/api/ekko/skills${suffix}`)
  return response.skills
}

export async function fetchEkkoSkill(name: string): Promise<EkkoSkillDetail> {
  const response = await request<{ ok: boolean; skill: EkkoSkillDetail }>(`/api/ekko/skills/${encodeURIComponent(name)}`)
  return response.skill
}

export async function createEkkoSkill(input: {
  name: string
  content: string
  category?: string
}): Promise<EkkoSkillDetail> {
  const response = await request<{ ok: boolean; skill: EkkoSkillDetail }>('/api/ekko/skills', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return response.skill
}

export async function updateEkkoSkill(name: string, content: string): Promise<EkkoSkillDetail> {
  const response = await request<{ ok: boolean; skill: EkkoSkillDetail }>(`/api/ekko/skills/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })
  return response.skill
}

export async function deleteEkkoSkill(name: string): Promise<void> {
  await request(`/api/ekko/skills/${encodeURIComponent(name)}`, { method: 'DELETE' })
}

export async function toggleEkkoSkill(name: string, enabled: boolean): Promise<void> {
  await request(`/api/ekko/skills/${encodeURIComponent(name)}/toggle`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })
}

export async function fetchEkkoSkillFiles(name: string): Promise<SkillFileEntry[]> {
  const response = await request<{ ok: boolean; files: SkillFileEntry[] }>(
    `/api/ekko/skills/${encodeURIComponent(name)}/files`,
  )
  return response.files
}

export async function fetchEkkoSkillFile(name: string, path: string): Promise<string> {
  const response = await request<{ ok: boolean; content: string }>(
    `/api/ekko/skills/${encodeURIComponent(name)}/file?path=${encodeURIComponent(path)}`,
  )
  return response.content
}

export async function fetchEkkoExternalDirectories(): Promise<ExternalDirEntry[]> {
  const response = await request<{ ok: boolean; directories: ExternalDirEntry[] }>(
    '/api/ekko/skills/external-directories',
  )
  return response.directories
}

export async function saveEkkoExternalDirectories(directories: string[]): Promise<void> {
  await request('/api/ekko/skills/external-directories', {
    method: 'PUT',
    body: JSON.stringify({ directories }),
  })
}

export async function importEkkoSkill(files: File[], category?: string): Promise<{ name: string }> {
  const headers: Record<string, string> = {}
  const token = getApiKey()
  if (token) headers.Authorization = `Bearer ${token}`
  const profile = getActiveProfileName()
  if (profile) headers['X-Hermes-Profile'] = profile
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
