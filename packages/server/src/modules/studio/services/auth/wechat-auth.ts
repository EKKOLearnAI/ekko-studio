import {
  claimWeChatWorkspace,
  countActiveSuperAdmins,
  createUser,
  findUserById,
  findUserByPhoneNumber,
  findUserByUsername,
  getUserActiveProfile,
  listUserProfiles,
  markWeChatPasswordReady,
  normalizePhoneNumber,
  setUserAvatar,
  setUserWeChatBound,
  touchUserLogin,
  updateUserPhoneNumber,
  verifyPassword,
  weChatWorkspaceHasOtherOwner,
  type UserRecord,
} from '../../repositories/users-store'
import { deleteBindingByUserId, findBindingByPlatformId, findBindingByUserId, upsertBindingByPlatformId } from '../../repositories/wechat-bindings-store'
import { ensureWeChatWorkspace, existingWeChatWorkspace, weChatWorkspaceName } from '../../public/wechat-workspace'
import { getUserTheme, toUserThemePayload } from '../theme/user-theme'
import { fetchDeviceSelf, validateTokenPlatformBaseUrl, verifyDeviceApiKey, type TokenPlatformUserProfile } from './token-platform-client'

export class WeChatAuthError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

type LoginChoice = 'scan' | 'create' | 'credentials'
type ScanInput = Record<string, unknown>

function clean(value: unknown, max: number): string {
  return typeof value === 'string' && value.length <= max ? value.trim() : ''
}

interface VerifiedApproval {
  apiBase: string
  key: string
  deviceId: string
  models: string[]
  profile: TokenPlatformUserProfile
}

async function verifyApproval(body: ScanInput): Promise<VerifiedApproval> {
  const requestedBase = clean(body.api_base, 512)
  const key = clean(body.api_key, 1024)
  if (!requestedBase || !key) throw new WeChatAuthError(400, 'APPROVAL_REQUIRED', 'api_base and api_key are required')
  let apiBase: string
  try {
    apiBase = validateTokenPlatformBaseUrl(requestedBase)
  } catch {
    throw new WeChatAuthError(400, 'PLATFORM_MISMATCH', 'Device approval does not match the configured Token Platform')
  }

  let profile: TokenPlatformUserProfile
  let verifiedModels: string[]
  try {
    profile = await fetchDeviceSelf(apiBase, key)
    if (!Number.isSafeInteger(profile?.id) || profile.id <= 0) {
      throw new WeChatAuthError(401, 'INVALID_APPROVAL', 'Invalid Token Platform device key')
    }
    verifiedModels = await verifyDeviceApiKey(apiBase, key)
  } catch (error) {
    if (error instanceof WeChatAuthError) throw error
    throw new WeChatAuthError(502, 'PLATFORM_UNAVAILABLE', 'Token Platform could not verify the device approval')
  }

  return {
    apiBase,
    key,
    deviceId: clean(typeof body.device_id === 'number' ? String(body.device_id) : body.device_id, 128),
    models: [...new Set(verifiedModels)].slice(0, 100),
    profile,
  }
}

function remoteAvatar(value: unknown): string | null {
  try {
    const url = new URL(clean(value, 2048))
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}

function accountForApproval(approval: VerifiedApproval): UserRecord | null {
  const binding = findBindingByPlatformId(approval.profile.id)
  if (!binding) return null
  const user = binding.user_id ? findUserById(binding.user_id) : findUserByUsername(`tp_${approval.profile.id}`)
  if (user && user.status !== 'active') throw new WeChatAuthError(403, 'ACCOUNT_DISABLED', 'This account is disabled')
  return user
}

function ensureWorkspaceAvailable(platformId: number, userId: number | null, isBound: boolean): void {
  const name = weChatWorkspaceName(platformId)
  const assigned = userId !== null && listUserProfiles(userId).some(item => item.profile_name === name)
  if (weChatWorkspaceHasOtherOwner(userId, name) || (!isBound && !assigned && existingWeChatWorkspace(name))) {
    throw new WeChatAuthError(409, 'WORKSPACE_IN_USE', 'The WeChat workspace already belongs to a local account')
  }
}

function bindApproval(user: UserRecord, approval: VerifiedApproval, isBound: boolean, phone: string | null): void {
  const existing = findBindingByUserId(user.id)
  if (existing && existing.platform_profile_id !== approval.profile.id) {
    throw new WeChatAuthError(409, 'USER_ALREADY_BOUND', 'User is already bound to another WeChat account')
  }
  const phoneOwner = phone ? findUserByPhoneNumber(phone) : null
  if (phoneOwner && phoneOwner.id !== user.id) {
    throw new WeChatAuthError(409, 'PHONE_ALREADY_BOUND', 'Phone number already in use')
  }
  ensureWorkspaceAvailable(approval.profile.id, user.id, isBound)
  const saved = upsertBindingByPlatformId({
    userId: user.id,
    platformProfileId: approval.profile.id,
    platformUsername: clean(approval.profile.username, 128),
    apiBase: approval.apiBase,
    apiKey: approval.key,
    deviceId: approval.deviceId || existing?.device_id || '',
    models: approval.models,
    displayName: clean(approval.profile.display_name, 128) || user.username,
  })
  if (saved?.user_id !== user.id) {
    throw new WeChatAuthError(409, 'WECHAT_ALREADY_BOUND', 'This WeChat account is already bound to another user')
  }
  setUserWeChatBound(user.id, true)
  if (!user.phone_number && phone) updateUserPhoneNumber(user.id, phone)
}

const provisioning = new Map<number, Promise<string | null>>()

async function provision(approval: VerifiedApproval, user: UserRecord): Promise<void> {
  const platformId = approval.profile.id
  let pending = provisioning.get(platformId)
  if (!pending) {
    pending = ensureWeChatWorkspace({
      platformProfileId: platformId,
      displayName: clean(approval.profile.display_name, 128) || user.username,
      avatarUrl: remoteAvatar(approval.profile.avatar_url),
      apiBase: approval.apiBase,
      apiKey: approval.key,
      models: approval.models,
    })
    provisioning.set(platformId, pending)
  }
  let workspace: string | null
  try {
    workspace = await pending
  } finally {
    if (provisioning.get(platformId) === pending) provisioning.delete(platformId)
  }
  // A concurrent unbind must not revive the binding or issue its session.
  if (findBindingByPlatformId(platformId)?.user_id !== user.id) {
    throw new WeChatAuthError(409, 'BINDING_CHANGED', 'WeChat binding changed; scan again')
  }
  if (workspace === weChatWorkspaceName(platformId)) claimWeChatWorkspace(user.id, workspace)
}

export async function resolveWeChatLogin(body: ScanInput, choice: LoginChoice, authenticatedId?: number) {
  const approval = await verifyApproval(body)
  const platformPhone = normalizePhoneNumber(approval.profile.phone)
  const existing = accountForApproval(approval)
  const displayName = clean(approval.profile.display_name, 128) || clean(approval.profile.username, 128)
  const avatarUrl = remoteAvatar(approval.profile.avatar_url)

  let user: UserRecord | null = null
  if (choice === 'scan') {
    if (!existing) {
      return { status: 'needs_choice' as const, profile: { id: approval.profile.id, display_name: displayName, phone: platformPhone, avatar_url: avatarUrl },
        options: ['create_local_user', 'bind_by_credentials'], candidates: [] }
    }
    if (authenticatedId !== undefined && existing.id !== authenticatedId) {
      throw new WeChatAuthError(409, 'WECHAT_ALREADY_BOUND', 'This WeChat account is already bound to another user')
    }
    user = existing
  } else if (choice === 'create') {
    if (authenticatedId !== undefined) throw new WeChatAuthError(400, 'USE_BIND', 'Bind WeChat to your signed-in account instead')
    if (existing) throw new WeChatAuthError(409, 'WECHAT_ALREADY_BOUND', 'This WeChat account is already bound')
    const username = clean(body.username, 64)
    const password = typeof body.password === 'string' ? body.password : ''
    if (username.length < 2 || /^tp_/i.test(username) || password.length < 6 || password.length > 256) {
      throw new WeChatAuthError(400, 'INVALID_CREDENTIALS', 'Enter a valid username and password (6–256 characters)')
    }
    if (countActiveSuperAdmins() === 0) {
      throw new WeChatAuthError(409, 'ADMIN_SETUP_REQUIRED', 'Sign in as the administrator once before creating a WeChat account')
    }
    if (findUserByUsername(username)) throw new WeChatAuthError(409, 'USERNAME_TAKEN', 'Username already exists')
    if (platformPhone && findUserByPhoneNumber(platformPhone)) {
      throw new WeChatAuthError(409, 'PHONE_ALREADY_BOUND', 'Phone number already in use; bind with your local password')
    }
    ensureWorkspaceAvailable(approval.profile.id, null, false)
    user = createUser({ username, password, role: 'admin', status: 'active', phone: platformPhone })
    if (!user) throw new WeChatAuthError(500, 'USER_CREATE_FAILED', 'Failed to create user')
    markWeChatPasswordReady(user.id)
  } else {
    const identifier = clean(body.identifier ?? body.username, 128)
    const password = typeof body.password === 'string' && body.password.length <= 256 ? body.password : ''
    user = identifier ? findUserByUsername(identifier) || findUserByPhoneNumber(identifier) : null
    if (!user || user.status !== 'active' || !password || !verifyPassword(password, user.password_hash)
      || (authenticatedId !== undefined && user.id !== authenticatedId)) {
      throw new WeChatAuthError(401, 'INVALID_CREDENTIALS', 'Invalid username or password')
    }
    if (existing && existing.id !== user.id) {
      throw new WeChatAuthError(409, 'WECHAT_ALREADY_BOUND', 'This WeChat account is already bound to another user')
    }
    if (platformPhone && user.phone_number && platformPhone !== normalizePhoneNumber(user.phone_number)) {
      throw new WeChatAuthError(400, 'PHONE_MISMATCH', 'WeChat phone number does not match the account')
    }
    markWeChatPasswordReady(user.id)
  }

  bindApproval(user, approval, !!existing, choice === 'scan' ? null : platformPhone)
  await provision(approval, user)
  const activeUser = findUserById(user.id)
  if (!activeUser || activeUser.status !== 'active') {
    throw new WeChatAuthError(403, 'ACCOUNT_DISABLED', 'This account is disabled')
  }
  if (!activeUser.avatar && (displayName || avatarUrl)) {
    setUserAvatar(user.id, JSON.stringify(avatarUrl ? { type: 'image', dataUrl: avatarUrl, seed: displayName } : { type: 'default', seed: displayName }))
  }
  touchUserLogin(user.id)
  const profiles = listUserProfiles(user.id).map(item => item.profile_name)
  const savedProfile = getUserActiveProfile(user.id)
  const activeProfile = savedProfile && profiles.includes(savedProfile) ? savedProfile : profiles[0] || null
  const binding = findBindingByPlatformId(approval.profile.id)
  return {
    status: 'bound' as const,
    identity: activeUser,
    result: {
      userId: user.id,
      profiles,
      activeProfile,
      theme: toUserThemePayload(getUserTheme(user.id)),
      user: {
        id: user.id, username: activeUser.username, role: activeUser.role, display_name: displayName || activeUser.username,
        phone_number: activeUser.phone_number, wechat_bound: true, bound_models: approval.models, active_profile: activeProfile,
      },
      binding: { device_id: binding?.device_id || '', display_name: displayName || activeUser.username, platform_profile_id: approval.profile.id },
    },
  }
}

export function publicWeChatBinding(userId: number) {
  const binding = findBindingByUserId(userId)
  return binding ? {
    platform_profile_id: binding.platform_profile_id,
    display_name: binding.display_name,
    username: binding.platform_username,
    bound_at: binding.bound_at,
  } : null
}

export function unbindWeChat(userId: number): boolean {
  const hadBinding = deleteBindingByUserId(userId)
  setUserWeChatBound(userId, false)
  return hadBinding
}
