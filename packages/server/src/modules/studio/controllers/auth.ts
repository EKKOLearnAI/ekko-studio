import type { Context } from 'koa'
import { checkPassword, recordPasswordFailure, recordPasswordSuccess, extractIp, getLockedIps, unlockIp, unlockAll } from '../services/auth/login-limiter'
import {
  DEFAULT_PASSWORD,
  DEFAULT_USERNAME,
  bootstrapDefaultSuperAdmin,
  countActiveSuperAdmins,
  countUsers,
  createUser,
  deleteUser,
  findUserById,
  findUserByPhoneNumber,
  normalizePhoneNumber,
  findUserByUsername,
  getUserAvatar,
  getUserActiveProfile,
  markWeChatPasswordReady,
  listUserProfiles,
  listUsers,
  setUserAvatar,
  updateUser,
  updateUsername,
  updateUserPassword,
  verifyPassword,
  type UserRole,
  type UserRecord,
  type UserStatus,
} from '../public/users'
import { getUserTheme, removeAllUserThemeAssets, toUserThemePayload } from '../services/theme/user-theme'
import { getUserJwtExpiresSeconds, issueAppJwt, issueUserJwt } from '../public/auth'
import { consumeAppAuthorizationCode, upsertAppConnection, type AppConnectionType } from '../services/app-relay/app-connections'
import { listProfileNamesFromDisk } from '../public/profile-config'
import { startOutboundRelayClient, stopOutboundRelayClient } from '../public/global-agent'
import { getLanEndpointKind } from '../services/network/lan-discovery'
import { getPublicSystemInfo } from '../public/system-info'
import { config } from '../public/config'
import { tokenPlatformBaseUrl, validateTokenPlatformBaseUrl } from '../services/auth/token-platform-client'

/**
 * GET /api/auth/status
 * Check if username/password login is configured (public).
 */
export async function authStatus(ctx: Context) {
  const base = tokenPlatformBaseUrl()
  let tokenPlatformBase: string | undefined
  try { tokenPlatformBase = validateTokenPlatformBaseUrl(base) } catch { /* Invalid operator configuration. */ }
  ctx.body = {
    hasPasswordLogin: true,
    hasUsers: countUsers() > 0,
    wechatLoginEnabled: !!tokenPlatformBase,
    tokenPlatformBaseUrl: tokenPlatformBase,
  }
}
/**
 * GET /api/auth/me
 * Return the authenticated account.
 */
export async function currentUser(ctx: Context) {
  const userId = ctx.state.user?.id
  const user = userId ? findUserById(userId) : null
  if (!user) {
    ctx.status = 404
    ctx.body = { error: 'User not found' }
    return
  }
  ctx.body = {
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      phone_number: user.phone_number || null,
      wechat_bound: Boolean(user.wechat_bound),
      requiresPasswordSetup: /^tp_[1-9][0-9]*$/.test(user.username) && !!user.wechat_bound && !user.wechat_password_ready,
      activeProfile: getUserActiveProfile(user.id),
      active_profile: getUserActiveProfile(user.id),
      created_at: user.created_at,
      updated_at: user.updated_at,
      last_login_at: user.last_login_at,
      avatar: user.avatar || '',
      modelGuideStatus: user.model_guide_status || 'pending',
      shouldShowModelGuide: process.env.HERMES_DESKTOP === 'true'
        ? false
        : user.username === DEFAULT_USERNAME && (user.model_guide_status || 'pending') === 'pending',
      requiresCredentialChange: process.env.HERMES_DESKTOP === 'true'
        ? false
        : user.username === DEFAULT_USERNAME && verifyPassword(DEFAULT_PASSWORD, user.password_hash),
    },
  }
}


const MAX_AVATAR_BYTES = 500 * 1024

function isValidAvatarPayload(value: unknown): { ok: true; json: string } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: 'Invalid avatar payload' }
  const obj = value as Record<string, unknown>
  const type = obj.type
  if (type !== 'image' && type !== 'default') return { ok: false, error: 'Avatar type must be "image" or "default"' }
  if (type === 'image') {
    if (typeof obj.dataUrl !== 'string' || !obj.dataUrl.startsWith('data:image/')) {
      return { ok: false, error: 'Image avatar must include a dataUrl' }
    }
    if (obj.dataUrl.length > MAX_AVATAR_BYTES) {
      return { ok: false, error: `Avatar image is too large (max ${MAX_AVATAR_BYTES} bytes)` }
    }
  }
  if (obj.seed != null && typeof obj.seed !== 'string') {
    return { ok: false, error: 'Avatar seed must be a string' }
  }
  return { ok: true, json: JSON.stringify(value) }
}

/**
 * GET /api/auth/avatar
 * Return the authenticated user's avatar JSON string.
 */
export async function getMyAvatar(ctx: Context) {
  const userId = ctx.state.user?.id
  if (!userId) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }
  ctx.body = { avatar: getUserAvatar(userId) }
}

/**
 * PUT /api/auth/avatar
 * Update the authenticated user's avatar. Body: { avatar: <json string> } OR
 * body directly contains the avatar object { type, dataUrl?, seed? }.
 */
export async function updateMyAvatar(ctx: Context) {
  const userId = ctx.state.user?.id
  if (!userId) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }
  const body = ctx.request.body as { avatar?: unknown } & Record<string, unknown>
  // Accept both { avatar: "<json string>" } and a direct avatar object
  const candidate = body && Object.prototype.hasOwnProperty.call(body, 'avatar') ? body.avatar : body
  if (typeof candidate === 'string') {
    if (candidate.length > MAX_AVATAR_BYTES * 2) {
      ctx.status = 400
      ctx.body = { error: 'Avatar string is too large' }
      return
    }
    try {
      const parsed = JSON.parse(candidate)
      const validation = isValidAvatarPayload(parsed)
      if (!validation.ok) {
        ctx.status = 400
        ctx.body = { error: validation.error }
        return
      }
      const ok = setUserAvatar(userId, candidate)
      if (!ok) {
        ctx.status = 500
        ctx.body = { error: 'Failed to save avatar' }
        return
      }
      ctx.body = { success: true, avatar: candidate }
      return
    } catch {
      ctx.status = 400
      ctx.body = { error: 'Avatar string is not valid JSON' }
      return
    }
  }
  const validation = isValidAvatarPayload(candidate)
  if (!validation.ok) {
    ctx.status = 400
    ctx.body = { error: validation.error }
    return
  }
  const ok = setUserAvatar(userId, validation.json)
  if (!ok) {
    ctx.status = 500
    ctx.body = { error: 'Failed to save avatar' }
    return
  }
  ctx.body = { success: true, avatar: validation.json }
}

async function authenticatePasswordUser(
  ctx: Context,
  username: string,
  password: string,
): Promise<{ ok: true; ip: string; user: UserRecord } | { ok: false }> {
  const ip = extractIp(ctx)
  const result = checkPassword(ip)
  if (!result.allowed) {
    ctx.status = result.status
    ctx.body = { error: 'Too many login attempts, please try again later' }
    return { ok: false }
  }

  const existingUserCount = countUsers()
  const user = existingUserCount === 0
    ? bootstrapDefaultSuperAdmin(username, password)
    : findUserByUsername(username) || findUserByPhoneNumber(username)

  if (!user || user.status !== 'active' || (existingUserCount > 0 && !verifyPassword(password, user.password_hash))) {
    recordPasswordFailure(ip)
    ctx.status = 401
    ctx.body = { error: 'Invalid username or password' }
    return { ok: false }
  }

  if (!user.wechat_password_ready) markWeChatPasswordReady(user.id)
  return { ok: true, ip, user }
}

async function passwordLogin(
  ctx: Context,
  username: string,
  password: string,
): Promise<{ ok: true; token: string; user: UserRecord } | { ok: false }> {
  const authentication = await authenticatePasswordUser(ctx, username, password)
  if (!authentication.ok) return authentication
  try {
    const token = await issueUserJwt(authentication.user)
    recordPasswordSuccess(authentication.ip)
    return { ok: true, token, user: authentication.user }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err?.message || 'Failed to issue login token' }
    return { ok: false }
  }
}

function accessibleProfileNames(user: UserRecord): string[] {
  if (user.role === 'super_admin') return listProfileNamesFromDisk()
  return listUserProfiles(user.id).map(profile => profile.profile_name)
}

/**
 * POST /api/auth/login
 * Authenticate with username/password (public).
 * Returns a user-scoped JWT on success.
 */
export async function login(ctx: Context) {
  const { username, password } = ctx.request.body as { username?: string; password?: string }
  if (!username || !password) {
    ctx.status = 400
    ctx.body = { error: 'Username and password are required' }
    return
  }

  const result = await passwordLogin(ctx, username, password)
  if (!result.ok) return
  ctx.body = {
    token: result.token,
    userId: result.user.id,
    profiles: accessibleProfileNames(result.user),
    activeProfile: getUserActiveProfile(result.user.id),
    theme: toUserThemePayload(getUserTheme(result.user.id)),
  }
}

function normalizeAppLoginField(value: unknown, maxLength: number): string {
  const normalized = String(value || '').trim()
  return normalized.length <= maxLength ? normalized : ''
}

function appConnectionType(ctx: Context): AppConnectionType {
  const requestAddresses = [ctx.ip, ctx.request.ip, ctx.req?.socket?.remoteAddress]
    .map(value => String(value || '').trim().replace(/^::ffff:/, ''))
    .filter(Boolean)
  const forwardedByLocalRelay = requestAddresses.some(value => (
    value === '::1' || value === 'localhost' || value.startsWith('127.')
  ))
  return forwardedByLocalRelay && ctx.get('x-hermes-app-connection').trim().toLowerCase() === 'cloud'
    ? 'cloud'
    : 'lan'
}

/**
 * POST /api/auth/app-login
 * Exchange either a one-time App authorization code or active user credentials
 * for a device-bound App token.
 */
export async function appLogin(ctx: Context) {
  const body = ctx.request.body as Record<string, unknown> | undefined
  const authorizationCode = normalizeAppLoginField(
    body?.authorization_code ?? body?.authorizationCode,
    255,
  )
  const deviceCode = normalizeAppLoginField(body?.device_code ?? body?.deviceCode, 255)
  const deviceName = normalizeAppLoginField(body?.device_name ?? body?.deviceName, 80)
  const deviceBrand = normalizeAppLoginField(body?.device_brand ?? body?.deviceBrand, 80)
  const deviceModel = normalizeAppLoginField(body?.device_model ?? body?.deviceModel, 120)
  const username = normalizeAppLoginField(body?.username ?? body?.account, 80)
  const rawPassword = typeof body?.password === 'string' ? body.password : ''
  const password = rawPassword.length <= 256 ? rawPassword : ''
  const requestedCloudUserId = Number(body?.cloud_user_id ?? body?.cloudUserId)
  const passwordCredentialsProvided = Boolean(username && password)
  if (!deviceCode || !deviceName || (!authorizationCode && !passwordCredentialsProvided)) {
    ctx.status = 400
    ctx.body = {
      error: 'device_code and device_name are required together with authorization_code or username and password',
    }
    return
  }

  let user: UserRecord | null = null
  let authenticatedPasswordIp = ''
  if (authorizationCode) {
    try {
      const authorization = consumeAppAuthorizationCode(authorizationCode, deviceCode)
      user = findUserById(authorization.created_by_user_id)
    } catch (error: any) {
      if (error?.message === 'app_authorization_code_expired') {
        ctx.status = 410
        ctx.body = { error: 'App authorization code has expired' }
        return
      }
      if (error?.message === 'app_authorization_code_used') {
        ctx.status = 409
        ctx.body = { error: 'App authorization code has already been used' }
        return
      }
      ctx.status = 401
      ctx.body = { error: 'Invalid App authorization code' }
      return
    }
  } else {
    const authentication = await authenticatePasswordUser(ctx, username, password)
    if (!authentication.ok) return
    user = authentication.user
    authenticatedPasswordIp = authentication.ip
  }

  if (!user || user.status !== 'active') {
    ctx.status = 403
    ctx.body = { error: 'The authorizing user is disabled or does not exist' }
    return
  }
  const connectionType = appConnectionType(ctx)
  const cloudUserId = connectionType === 'cloud' && Number.isSafeInteger(requestedCloudUserId) && requestedCloudUserId > 0
    ? requestedCloudUserId
    : 0
  if (connectionType === 'cloud' && !cloudUserId) {
    ctx.status = 400
    ctx.body = { error: 'cloud_user_id is required for cloud App connections' }
    return
  }
  const token = await issueAppJwt(user, deviceCode, connectionType)
  if (authenticatedPasswordIp) recordPasswordSuccess(authenticatedPasswordIp)
  const now = Math.floor(Date.now() / 1000)
  const tokenExpiresAt = now + getUserJwtExpiresSeconds()
  const connection = upsertAppConnection({
    deviceCode,
    deviceName,
    deviceBrand,
    deviceModel,
    connectionType,
    userId: user.id,
    cloudUserId,
    token,
    tokenExpiresAt,
    now,
  })
  ctx.body = {
    token,
    userId: user.id,
    profiles: accessibleProfileNames(user),
    theme: toUserThemePayload(getUserTheme(user.id)),
    appConnection: {
      id: connection.id,
      device_code: connection.device_code,
      device_name: connection.device_name,
      device_brand: connection.device_brand,
      device_model: connection.device_model,
      connection_type: connection.connection_type,
      cloud_user_id: connection.cloud_user_id,
      token_expires_at: connection.token_expires_at,
    },
  }
}

function normalizeRelayUrl(input: string): string | null {
  try {
    const url = new URL(input)
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return null
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return null
  }
}

function requestBaseUrl(ctx: Context): string | undefined {
  const host = ctx.get('host').trim()
  if (!host) return undefined
  return `${ctx.protocol || 'http'}://${host}`
}

async function verifyRemoteRelayDeviceCode(deviceCode: string): Promise<boolean> {
  const url = `${config.remoteRelay.url.replace(/\/$/, '')}/global-agent/device/${encodeURIComponent(deviceCode)}`
  const response = await fetch(url, { method: 'GET' })
  return response.ok
}

async function localRelayMachineInfo(url: string) {
  const info = await getPublicSystemInfo()
  return {
    ...info,
    http_port: config.port,
    endpoint_kind: getLanEndpointKind(config.port),
    url,
    relay_url: config.remoteRelay.url,
  }
}

/**
 * POST /api/auth/mcu-login
 * Authenticate with the existing username/password login for an MCU/device.
 * When remote relay is requested or a legacy relay URL is provided, connect this Ekko Studio instance to it.
 * Body: { token, id, account, password, url? }.
 */
export async function microcontrollerLogin(ctx: Context) {
  const {
    token: relayToken,
    url,
    id,
    account,
    password,
    relayMode,
    remote,
    device_code: deviceCode,
  } = ctx.request.body as {
    token?: string
    url?: string
    id?: string
    account?: string
    password?: string
    relayMode?: string
    remote?: boolean
    device_code?: string
  }

  if (!relayToken || !id || !account || !password) {
    ctx.status = 400
    ctx.body = { error: 'token, id, account and password are required' }
    return
  }

  const wantsRemoteRelay = relayMode === 'remote' || remote === true
  const remoteRelayUrl = wantsRemoteRelay ? config.remoteRelay.url : ''
  const relayUrl = typeof url === 'string' && url.trim()
    ? normalizeRelayUrl(url)
    : remoteRelayUrl || null
  if (url && !relayUrl) {
    ctx.status = 400
    ctx.body = { error: 'url must be a valid http, https, ws, or wss URL' }
    return
  }

  const normalizedDeviceCode = typeof deviceCode === 'string' ? deviceCode.trim() : ''
  if (wantsRemoteRelay && !normalizedDeviceCode) {
    ctx.status = 400
    ctx.body = { error: '缺少设备码' }
    return
  }

  const result = await passwordLogin(ctx, account, password)
  if (!result.ok) return

  if (wantsRemoteRelay) {
    try {
      if (!await verifyRemoteRelayDeviceCode(normalizedDeviceCode)) {
        ctx.status = 403
        ctx.body = { error: '非官方设备码' }
        return
      }
    } catch (err: any) {
      ctx.status = 502
      ctx.body = { error: err?.message || '远程设备码校验失败' }
      return
    }
  }

  const connectionId = id.trim()
  const forwardedRemoteMcuLogin = wantsRemoteRelay && ctx.get('x-hermes-relay-forwarded') === 'mcu-socket.io'
  if (!forwardedRemoteMcuLogin) {
    stopOutboundRelayClient(connectionId)
  }
  if (relayUrl && !forwardedRemoteMcuLogin) {
    const relayStartUrl = wantsRemoteRelay && relayUrl === remoteRelayUrl
      ? config.remoteRelay.url
      : relayUrl
    const localBaseUrl = requestBaseUrl(ctx)
    const machineInfo = localBaseUrl ? await localRelayMachineInfo(localBaseUrl) : undefined
    const client = startOutboundRelayClient({
      connectionId,
      relayUrl: relayStartUrl,
      relayToken,
      userToken: result.token,
      instanceId: connectionId,
      ...(normalizedDeviceCode ? { deviceCode: normalizedDeviceCode } : {}),
      ...(localBaseUrl ? { localBaseUrl } : {}),
      ...(machineInfo ? { machineInfo } : {}),
      relayProtocol: wantsRemoteRelay ? 'mcu-socket.io' : 'socket.io',
    })
    if (!client) {
      ctx.status = 400
      ctx.body = { error: 'Failed to start relay client' }
      return
    }
  }

  ctx.body = {
    token: result.token,
    profiles: accessibleProfileNames(result.user),
    relay: {
      connected: Boolean(relayUrl),
      id: connectionId,
      ...(wantsRemoteRelay && relayUrl === remoteRelayUrl ? { remote: true } : {}),
      ...(relayUrl ? { url: relayUrl } : {}),
    },
  }
}

/**
 * POST /api/auth/setup
 * Set up username/password (protected).
 */
export async function setupPassword(ctx: Context) {
  ctx.status = 400
  ctx.body = { error: 'Password login is managed by user accounts' }
}

/**
 * POST /api/auth/change-password
 * Change password (protected).
 */
export async function changePassword(ctx: Context) {
  const { currentPassword, newPassword } = ctx.request.body as { currentPassword?: string; newPassword?: string }
  if (!currentPassword || !newPassword) {
    ctx.status = 400
    ctx.body = { error: 'Current password and new password are required' }
    return
  }
  if (newPassword.length < 6) {
    ctx.status = 400
    ctx.body = { error: 'New password must be at least 6 characters' }
    return
  }

  const userId = ctx.state.user?.id
  const user = userId ? findUserById(userId) : null
  if (!user || !verifyPassword(currentPassword, user.password_hash)) {
    ctx.status = 400
    ctx.body = { error: 'Current password is incorrect' }
    return
  }

  updateUserPassword(user.id, newPassword)
  ctx.body = { success: true }
}
/**
 * POST /api/auth/change-username
 * Change username (protected).
 *
 * Legacy WeChat-only accounts can choose their first password after a fresh
 * QR scan before renaming the account.
 */
export async function changeUsername(ctx: Context) {
  const { currentPassword, newUsername } = ctx.request.body as { currentPassword?: string; newUsername?: string }
  if (!newUsername) {
    ctx.status = 400
    ctx.body = { error: 'New username is required' }
    return
  }
  if (newUsername.length < 2 || /^tp_/i.test(newUsername)) {
    ctx.status = 400
    ctx.body = { error: 'Username must have at least two characters and cannot use the reserved tp_ prefix' }
    return
  }

  const userId = ctx.state.user?.id
  const user = userId ? findUserById(userId) : null
  if (!user) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }

  if (!currentPassword) {
    ctx.status = 400
    ctx.body = { error: 'Current password is required' }
    return
  }
  if (!verifyPassword(currentPassword, user.password_hash)) {
    ctx.status = 400
    ctx.body = { error: 'Current password is incorrect' }
    return
  }
  if (!user.wechat_password_ready) markWeChatPasswordReady(user.id)

  const existing = findUserByUsername(newUsername)
  if (existing && existing.id !== user.id) {
    ctx.status = 409
    ctx.body = { error: 'Username already exists' }
    return
  }

  updateUsername(user.id, newUsername)
  ctx.body = { success: true }
}


/**
 * DELETE /api/auth/password
 * Remove username/password login (protected).
 */
export async function removePassword(ctx: Context) {
  ctx.status = 400
  ctx.body = { error: 'Password login cannot be removed for user accounts' }
}

function normalizeRole(value: unknown): UserRole | null {
  return value === 'super_admin' || value === 'admin' ? value : null
}

function normalizeStatus(value: unknown): UserStatus | null {
  return value === 'active' || value === 'disabled' ? value : null
}

function normalizeProfiles(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))]
}

function validateProfiles(profiles: string[]): string | null {
  const available = new Set(listProfileNamesFromDisk())
  const missing = profiles.find(profile => !available.has(profile))
  return missing || null
}

/**
 * GET /api/auth/users
 * Super admin user management list.
 */
export async function listManagedUsers(ctx: Context) {
  ctx.body = {
    users: listUsers(),
    profiles: listProfileNamesFromDisk(),
  }
}
/**
 * POST /api/auth/users
 * Create a user account. Super admin only.
 */
export async function createManagedUser(ctx: Context) {
  const body = ctx.request.body as {
    username?: string
    password?: string
    role?: unknown
    status?: unknown
    phone?: unknown
    profiles?: unknown
    defaultProfile?: string | null
  }
  const username = String(body.username || '').trim()
  const password = String(body.password || '')
  const role = normalizeRole(body.role || 'admin')
  const status = normalizeStatus(body.status || 'active')
  const phone = typeof body.phone === 'string' ? body.phone : null
  const profiles = normalizeProfiles(body.profiles)

  if (username.length < 2) {
    ctx.status = 400
    ctx.body = { error: 'Username must be at least 2 characters' }
    return
  }
  if (password.length < 6) {
    ctx.status = 400
    ctx.body = { error: 'Password must be at least 6 characters' }
    return
  }
  if (!role || !status) {
    ctx.status = 400
    ctx.body = { error: 'Invalid role or status' }
    return
  }
  if (findUserByUsername(username)) {
    ctx.status = 409
    ctx.body = { error: 'Username already exists' }
    return
  }
  // Check phone uniqueness
  const normalizedPhone = normalizePhoneNumber(phone)
  if (normalizedPhone && findUserByPhoneNumber(normalizedPhone)) {
    ctx.status = 409
    ctx.body = { error: 'Phone number already in use' }
    return
  }

  const missingProfile = validateProfiles(profiles)
  if (missingProfile) {
    ctx.status = 400
    ctx.body = { error: `Profile "${missingProfile}" does not exist` }
    return
  }

  const user = createUser({
    username,
    password,
    role,
    status,
    phone: normalizedPhone,
    profiles: role === 'super_admin' ? [] : profiles,
    defaultProfile: body.defaultProfile,
  })
  ctx.status = 201
  ctx.body = { user, users: listUsers() }
}
/**
 * PUT /api/auth/users/:id
 * Update user account metadata, password, and profile bindings.
 */
export async function updateManagedUser(ctx: Context) {
  const id = Number(ctx.params.id)
  const user = Number.isInteger(id) ? findUserById(id) : null
  if (!user) {
    ctx.status = 404
    ctx.body = { error: 'User not found' }
    return
  }

  const body = ctx.request.body as {
    username?: string
    password?: string
    role?: unknown
    status?: unknown
    phone?: string | null
    profiles?: unknown
    defaultProfile?: string | null
  }
  const username = body.username == null ? undefined : String(body.username).trim()
  const password = body.password == null ? undefined : String(body.password)
  const role = body.role == null ? undefined : normalizeRole(body.role)
  const status = body.status == null ? undefined : normalizeStatus(body.status)
  const phone = body.phone == null ? undefined : (body.phone === '' ? null : body.phone)
  const profiles = body.profiles == null ? undefined : normalizeProfiles(body.profiles)

  if (username !== undefined && username.length < 2) {
    ctx.status = 400
    ctx.body = { error: 'Username must be at least 2 characters' }
    return
  }
  if (password !== undefined && password.length > 0 && password.length < 6) {
    ctx.status = 400
    ctx.body = { error: 'Password must be at least 6 characters' }
    return
  }
  if (body.role != null && !role || body.status != null && !status) {
    ctx.status = 400
    ctx.body = { error: 'Invalid role or status' }
    return
  }
  if (username && username !== user.username) {
    const existing = findUserByUsername(username)
    if (existing && existing.id !== user.id) {
      ctx.status = 409
      ctx.body = { error: 'Username already exists' }
      return
    }
  }
  // Check phone uniqueness
  if (phone !== undefined) {
    const normalizedPhone = normalizePhoneNumber(phone)
    if (normalizedPhone) {
      const phoneOwner = findUserByPhoneNumber(normalizedPhone)
      if (phoneOwner && phoneOwner.id !== user.id) {
        ctx.status = 409
        ctx.body = { error: 'Phone number already in use' }
        return
      }
    }
  }

  const nextRole = role || user.role
  const nextStatus = status || user.status
  const currentUserId = ctx.state.user?.id
  if (user.id === currentUserId && nextStatus !== 'active') {
    ctx.status = 400
    ctx.body = { error: 'You cannot disable your own account' }
    return
  }
  if (user.role === 'super_admin' && user.status === 'active' && (nextRole !== 'super_admin' || nextStatus !== 'active') && countActiveSuperAdmins(user.id) === 0) {
    ctx.status = 400
    ctx.body = { error: 'At least one active super administrator is required' }
    return
  }

  if (profiles) {
    const missingProfile = validateProfiles(profiles)
    if (missingProfile) {
      ctx.status = 400
      ctx.body = { error: `Profile "${missingProfile}" does not exist` }
      return
    }
  }

  updateUser({
    userId: user.id,
    username,
    password: password || undefined,
    role: role || undefined,
    status: status || undefined,
    phone: phone !== undefined ? phone : undefined,
    profiles: nextRole === 'super_admin' ? [] : profiles,
    defaultProfile: body.defaultProfile,
  })
  ctx.body = { user: findUserById(user.id), users: listUsers() }
}


/**
 * DELETE /api/auth/users/:id
 * Delete a user account. Super admin only.
 */
export async function deleteManagedUser(ctx: Context) {
  const id = Number(ctx.params.id)
  const user = Number.isInteger(id) ? findUserById(id) : null
  if (!user) {
    ctx.status = 404
    ctx.body = { error: 'User not found' }
    return
  }

  if (ctx.state.user?.id === user.id) {
    ctx.status = 400
    ctx.body = { error: 'You cannot delete your own account' }
    return
  }
  if (user.role === 'super_admin' && user.status === 'active' && countActiveSuperAdmins(user.id) === 0) {
    ctx.status = 400
    ctx.body = { error: 'At least one active super administrator is required' }
    return
  }

  await removeAllUserThemeAssets(user.id)
  deleteUser(user.id)
  ctx.body = { success: true, users: listUsers() }
}

/**
 * GET /api/auth/locked-ips
 * List all currently locked IPs (protected).
 */
export async function listLockedIps(ctx: Context) {
  const locks = getLockedIps()
  ctx.body = { locks }
}

/**
 * DELETE /api/auth/locked-ips?ip=xxx
 * Unlock a specific IP. No ip param = unlock all.
 */
export async function unlockIpHandler(ctx: Context) {
  const ip = ctx.query.ip as string
  if (ip) {
    const found = unlockIp(ip)
    if (!found) {
      ctx.status = 404
      ctx.body = { error: 'IP not locked' }
      return
    }
    ctx.body = { success: true }
    return
  }
  // No IP specified — unlock all
  const count = unlockAll()
  ctx.body = { success: true, count }
}
