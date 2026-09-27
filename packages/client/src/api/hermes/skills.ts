import { request, getBaseUrlValue, getApiKey, getActiveProfileName } from '../client'

export type SkillSource = 'builtin' | 'hub' | 'local' | 'external'
export type SkillTarget = 'hermes' | 'claude' | 'codex' | 'pi' | 'grok' | 'opencode' | 'dsh' | 'cursor'

export interface SkillInfo {
  name: string
  description: string
  enabled?: boolean
  source?: SkillSource
  readonly?: boolean
  modified?: boolean
  patchCount?: number
  useCount?: number
  viewCount?: number
  pinned?: boolean
  /** External skills only — raw form of the configured external dir (e.g. `~/my_skills/...`),
   *  used by the UI to group external skills by their source path. */
  sourcePath?: string
}

export interface SkillCategory {
  name: string
  description: string
  skills: SkillInfo[]
}

export interface ExternalDirEntry {
  raw: string
  expanded: string
  exists: boolean
  isDir: boolean
}

export interface SkillPaths {
  local: string
  external: string[]
  /** Raw entries as written in `config.skills.external_dirs`, with existence
   *  flags so the UI can grey-out paths that don't currently resolve.
   *  Optional — older servers may not include it. */
  externalRaw?: ExternalDirEntry[]
}

export interface SkillListResponse {
  categories: SkillCategory[]
  archived: SkillInfo[]
  paths?: SkillPaths
}

export interface SkillFileEntry {
  path: string
  name: string
  isDir: boolean
}

export interface MemoryData {
  memory: string
  user: string
  soul: string
  memory_mtime: number | null
  user_mtime: number | null
  soul_mtime: number | null
}

export interface SkillsData {
  categories: SkillCategory[]
  archived: SkillInfo[]
  paths?: SkillPaths
}

export interface SkillUsageRow {
  skill: string
  view_count: number
  manage_count: number
  total_count: number
  percentage: number
  last_used_at: number | null
}

export interface SkillUsageDailySkillRow {
  skill: string
  view_count: number
  manage_count: number
  total_count: number
}

export interface SkillUsageDailyRow {
  date: string
  view_count: number
  manage_count: number
  total_count: number
  skills: SkillUsageDailySkillRow[]
}

export interface SkillUsageStats {
  period_days: number
  summary: {
    total_skill_loads: number
    total_skill_edits: number
    total_skill_actions: number
    distinct_skills_used: number
  }
  by_day: SkillUsageDailyRow[]
  top_skills: SkillUsageRow[]
}

export async function fetchSkills(profile?: string, target: SkillTarget = 'hermes'): Promise<SkillsData> {
  const params = new URLSearchParams()
  if (profile) params.set('profile', profile)
  if (target !== 'hermes') params.set('target', target)
  const query = params.toString() ? `?${params.toString()}` : ''
  const res = await request<SkillListResponse>(`/api/hermes/skills${query}`)
  return { categories: res.categories, archived: res.archived ?? [], paths: res.paths }
}

export async function fetchSkillUsageStats(days = 7): Promise<SkillUsageStats> {
  const params = new URLSearchParams({ days: String(days) })
  return request<SkillUsageStats>(`/api/hermes/skills/usage/stats?${params}`)
}

function targetQuery(target: SkillTarget = 'hermes'): string {
  if (target === 'hermes') return ''
  return `?target=${encodeURIComponent(target)}`
}

function encodeSkillPath(path: string): string {
  return path.split('/').map(segment => encodeURIComponent(segment)).join('/')
}

export async function fetchSkillContent(skillPath: string, target: SkillTarget = 'hermes'): Promise<string> {
  const res = await request<{ content: string }>(`/api/hermes/skills/${encodeSkillPath(skillPath)}${targetQuery(target)}`)
  return res.content
}

export async function saveSkillContent(
  category: string,
  skill: string,
  content: string,
  target: SkillTarget = 'hermes',
): Promise<void> {
  const c = encodeURIComponent(category)
  const s = encodeURIComponent(skill)
  await request(`/api/hermes/skills/${c}/${s}${targetQuery(target)}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })
}

export async function fetchSkillFiles(category: string, skill: string, target: SkillTarget = 'hermes'): Promise<SkillFileEntry[]> {
  const path = encodeSkillPath(`${category}/${skill}`)
  const res = await request<{ files: SkillFileEntry[] }>(`/api/hermes/skills/${path}/files${targetQuery(target)}`)
  return res.files
}

export async function fetchMemory(): Promise<MemoryData> {
  return request<MemoryData>('/api/hermes/memory')
}

export async function saveMemory(section: 'memory' | 'user' | 'soul', content: string): Promise<void> {
  await request('/api/hermes/memory', {
    method: 'POST',
    body: JSON.stringify({ section, content }),
  })
}

export async function toggleSkill(name: string, enabled: boolean): Promise<void> {
  await request('/api/hermes/skills/toggle', {
    method: 'PUT',
    body: JSON.stringify({ name, enabled }),
  })
}

export async function pinSkillApi(name: string, pinned: boolean): Promise<void> {
  await request('/api/hermes/skills/pin', {
    method: 'PUT',
    body: JSON.stringify({ name, pinned }),
  })
}

export async function fetchExternalDirs(): Promise<ExternalDirEntry[]> {
  const res = await request<{ dirs: ExternalDirEntry[] }>('/api/hermes/skills/external-dirs')
  return res.dirs ?? []
}

export async function saveExternalDirs(dirs: string[]): Promise<void> {
  await request('/api/hermes/skills/external-dirs', {
    method: 'PUT',
    body: JSON.stringify({ dirs }),
  })
}

export async function deleteSkillApi(category: string, name: string, target: SkillTarget = 'hermes'): Promise<void> {
  const c = encodeURIComponent(category)
  const n = encodeURIComponent(name)
  await request(`/api/hermes/skills/${c}/${n}${targetQuery(target)}`, { method: 'DELETE' })
}

/**
 * Import one or more files (a single .zip OR a folder of files with relative paths).
 * For folder uploads, the caller should pass File objects whose `webkitRelativePath`
 * starts with the skill folder name; we forward those paths verbatim as the
 * `filename` parameter so the server can reconstruct the directory tree.
 */
export async function importSkill(files: File[], category?: string, target: SkillTarget = 'hermes'): Promise<{ name: string }> {
  const baseUrl = getBaseUrlValue()
  const token = getApiKey()
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  const profile = getActiveProfileName()
  if (profile) headers['X-Hermes-Profile'] = profile

  const formData = new FormData()
  for (const f of files) {
    const relPath = (f as any).webkitRelativePath || f.name
    formData.append('file', f, relPath)
  }
  if (category) formData.append('category', category)

  const res = await fetch(`${baseUrl}/api/hermes/skills/import${targetQuery(target)}`, {
    method: 'POST',
    headers,
    body: formData,
  })
  const text = await res.text()
  let payload: any = null
  try { payload = text ? JSON.parse(text) : null } catch { /* keep raw text */ }
  if (!res.ok) {
    throw new Error(payload?.error || text || `Import failed (${res.status})`)
  }
  return payload || { name: '' }
}
