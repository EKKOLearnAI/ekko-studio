export const SESSION_SHARE_LIFETIME_MS = 30 * 24 * 60 * 60_000
export const SESSION_SHARE_CACHE_MS = 10_000

export const SESSION_SHARE_PERMISSION_KEYS = [
  'input', 'voice', 'upload', 'download', 'workspaceRead', 'workspaceWrite', 'outsideWorkspace', 'terminal', 'switchModel', 'reasoningEffort', 'switchWorkspace',
] as const
export type SessionSharePermission = typeof SESSION_SHARE_PERMISSION_KEYS[number]
export type SessionSharePermissions = Record<SessionSharePermission, boolean>
export type SessionShareAction = 'read' | SessionSharePermission

export interface SessionShareAppUser { id: number; name: string }
export interface SessionShareExtraPath { path: string; realPath: string; writable: boolean }

export interface SessionShareRecord {
  id: string
  session_id: string
  profile: string
  created_by_user_id: number
  sharer_app_user_id: number
  sharer_name_snapshot: string
  recipient_app_user_id: number | null
  recipient_name_snapshot: string | null
  token_hash: string
  permissions: SessionSharePermissions
  workspace_root: string
  workspace_real_root: string
  extra_paths: SessionShareExtraPath[]
  policy_version: number
  created_at: number
  updated_at: number
  expires_at: number
  claimed_at: number | null
  revoked_at: number | null
}

export type PublicSessionShare = Omit<SessionShareRecord, 'token_hash' | 'created_by_user_id' | 'profile' | 'workspace_root' | 'workspace_real_root' | 'extra_paths'>

export class SessionShareError extends Error {
  constructor(readonly code: string, readonly status = 403) { super(code) }
}

export function sharePermissions(value: unknown, previous?: SessionSharePermissions): SessionSharePermissions {
  const result = { ...Object.fromEntries(SESSION_SHARE_PERMISSION_KEYS.map(key => [key, false])), ...previous } as SessionSharePermissions
  if (value === undefined) return result
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SessionShareError('share_invalid_permissions', 400)
  for (const [key, enabled] of Object.entries(value)) {
    if (!SESSION_SHARE_PERMISSION_KEYS.includes(key as SessionSharePermission) || typeof enabled !== 'boolean') {
      throw new SessionShareError('share_invalid_permissions', 400)
    }
    result[key as SessionSharePermission] = enabled
  }
  return result
}

export function publicSessionShare(record: SessionShareRecord): PublicSessionShare {
  const { token_hash, created_by_user_id, profile, workspace_root, workspace_real_root, extra_paths, ...visible } = record
  return structuredClone(visible)
}
