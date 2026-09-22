import { request, getBaseUrlValue, getApiKey } from '../client'

export interface HermesProfile {
  name: string
  active: boolean
  model: string
  gatewayStatus?: string
  alias: string
  avatar?: ProfileAvatar | null
}

export interface HermesProfileDetail {
  name: string
  path: string
  model: string
  provider: string
  skills: number
  hasEnv: boolean
  hasSoulMd: boolean
  avatar?: ProfileAvatar | null
}

export interface ProfileAvatar {
  type: 'generated' | 'image'
  seed?: string
  dataUrl?: string
  updatedAt?: number
}

export interface ProfileRuntimeStatus {
  profile: string
  bridge: {
    running: boolean
    profile: string
    mode?: string
    reachable?: boolean
    error?: string
  }
  gateway: {
    profile: string
    running: boolean
    targetProfile?: string
    unified?: boolean
    pid?: number
    port?: number
    host?: string
    url?: string
    error?: string
    diagnostics?: {
      health_url?: string
      reason?: string
      health_ok?: boolean
    }
  }
}

export interface ProfileRuntimeStatusesResponse {
  profiles: ProfileRuntimeStatus[]
  refreshing?: boolean
}

export async function fetchProfiles(): Promise<HermesProfile[]> {
  const res = await request<{ profiles: HermesProfile[] }>('/api/hermes/profiles')
  return res.profiles
}

export async function fetchProfileDetail(name: string): Promise<HermesProfileDetail> {
  const res = await request<{ profile: HermesProfileDetail }>(`/api/hermes/profiles/${encodeURIComponent(name)}`)
  return res.profile
}

export async function fetchProfileRuntimeStatus(name: string): Promise<ProfileRuntimeStatus> {
  return request<ProfileRuntimeStatus>(`/api/hermes/profiles/${encodeURIComponent(name)}/runtime-status`)
}

export async function fetchProfileRuntimeStatusesWithMeta(options: { refresh?: boolean } = {}): Promise<ProfileRuntimeStatusesResponse> {
  const query = options.refresh === false ? '?refresh=0' : ''
  return request<ProfileRuntimeStatusesResponse>(`/api/hermes/profiles/runtime-statuses${query}`)
}

export async function fetchProfileRuntimeStatuses(): Promise<ProfileRuntimeStatus[]> {
  const res = await fetchProfileRuntimeStatusesWithMeta()
  return res.profiles
}

export async function updateProfileAvatar(name: string, avatar: ProfileAvatar): Promise<ProfileAvatar> {
  const res = await request<{ avatar: ProfileAvatar }>(`/api/hermes/profiles/${encodeURIComponent(name)}/avatar`, {
    method: 'PUT',
    body: JSON.stringify(avatar),
  })
  return res.avatar
}

export async function deleteProfileAvatar(name: string): Promise<void> {
  await request(`/api/hermes/profiles/${encodeURIComponent(name)}/avatar`, { method: 'DELETE' })
}

export async function restartProfileGateway(name: string): Promise<ProfileRuntimeStatus['gateway']> {
  const res = await request<{ success: boolean; gateway: ProfileRuntimeStatus['gateway'] }>(
    `/api/hermes/profiles/${encodeURIComponent(name)}/gateway/restart`,
    { method: 'POST' },
  )
  return res.gateway
}

export async function restartProfileRuntime(name: string): Promise<ProfileRuntimeStatus> {
  const res = await request<{ success: boolean; status: ProfileRuntimeStatus }>(
    `/api/hermes/profiles/${encodeURIComponent(name)}/restart`,
    { method: 'POST' },
  )
  return res.status
}

export interface CreateProfileResult {
  success: boolean
  /** 实际克隆来源的 profile 名（未克隆时为空） */
  clonedFrom?: string
  /** 克隆时被清理的独占平台凭据 KEY 名 */
  strippedCredentials?: string[]
  /** 克隆时被禁用的独占平台名 */
  disabledPlatforms?: string[]
  /** 克隆时在 config.yaml 中被清理的内嵌凭据字段路径 */
  strippedConfigCredentials?: string[]
}

/**
 * @param cloneFrom 克隆来源 profile 名；留空表示不克隆
 */
export async function createProfile(name: string, cloneFrom?: string | null): Promise<CreateProfileResult & { error?: string }> {
  try {
    const res = await request<{
      success: boolean
      clonedFrom?: string
      strippedCredentials?: string[]
      disabledPlatforms?: string[]
      strippedConfigCredentials?: string[]
      error?: string
    }>('/api/hermes/profiles', {
      method: 'POST',
      body: JSON.stringify({ name, clone: !!cloneFrom, cloneFrom: cloneFrom || undefined }),
    })
    return {
      success: !!res.success,
      clonedFrom: res.clonedFrom,
      strippedCredentials: res.strippedCredentials,
      disabledPlatforms: res.disabledPlatforms,
      strippedConfigCredentials: res.strippedConfigCredentials,
      error: res.error,
    }
  } catch (err: any) {
    return { success: false, error: err.message || 'Unknown error' }
  }
}

export async function deleteProfile(name: string): Promise<boolean> {
  try {
    await request(`/api/hermes/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' })
    return true
  } catch {
    return false
  }
}

export async function renameProfile(name: string, newName: string): Promise<boolean> {
  try {
    await request(`/api/hermes/profiles/${encodeURIComponent(name)}/rename`, {
      method: 'POST',
      body: JSON.stringify({ new_name: newName }),
    })
    return true
  } catch {
    return false
  }
}

export async function switchProfile(name: string): Promise<boolean> {
  return !!name
}

export async function switchHermesProfile(name: string): Promise<boolean> {
  try {
    await request('/api/hermes/profiles/active', {
      method: 'PUT',
      body: JSON.stringify({ name }),
    })
    return true
  } catch {
    return false
  }
}

export interface ProfileArchiveResult {
  success: boolean
  /** 服务端给出的失败原因，没有时前端回落到通用文案 */
  error?: string
  /** 已知的失败类型，目前只有 'archive_timeout' */
  code?: string
}

export async function exportProfile(name: string): Promise<ProfileArchiveResult> {
  try {
    const baseUrl = getBaseUrlValue()
    const token = getApiKey()
    const headers: Record<string, string> = {}
    if (token) headers['Authorization'] = `Bearer ${token}`

    const res = await fetch(`${baseUrl}/api/hermes/profiles/${encodeURIComponent(name)}/export`, {
      method: 'POST',
      headers,
    })
    if (!res.ok) {
      // 导出失败时服务端返回 JSON；别把原因丢掉，否则用户只看到"导出失败"
      const detail = await res.json().catch(() => null)
      return { success: false, error: detail?.error, code: detail?.code }
    }

    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `hermes-profile-${name}.tar.gz`
    a.click()
    URL.revokeObjectURL(url)
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err?.message }
  }
}

export async function importProfile(file: File): Promise<ProfileArchiveResult> {
  try {
    const baseUrl = getBaseUrlValue()
    const token = getApiKey()
    const headers: Record<string, string> = {}
    if (token) headers['Authorization'] = `Bearer ${token}`

    const formData = new FormData()
    formData.append('file', file)

    const res = await fetch(`${baseUrl}/api/hermes/profiles/import`, {
      method: 'POST',
      headers,
      body: formData,
    })
    if (res.ok) return { success: true }
    const detail = await res.json().catch(() => null)
    return { success: false, error: detail?.error, code: detail?.code }
  } catch (err: any) {
    return { success: false, error: err?.message }
  }
}
