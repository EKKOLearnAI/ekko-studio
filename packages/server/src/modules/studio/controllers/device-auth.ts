import type { Context } from 'koa'
import { authenticateUserToken, issueWeChatUserJwt } from '../public/auth'
import {
  findUserById, findUserByPhoneNumber, getUserAvatar, listUserProfiles, normalizePhoneNumber,
  updateUserModelGuideStatus, updateUserPassword, updateUserPhoneNumber, verifyPassword,
} from '../public/users'
import { checkPairing, checkPassword, extractIp, recordPairingFailure, recordPasswordFailure, recordPasswordSuccess } from '../services/auth/login-limiter'
import { publicWeChatBinding, resolveWeChatLogin, unbindWeChat, WeChatAuthError } from '../services/auth/wechat-auth'
import { logger } from '../public/logging'

function body(ctx: Context): Record<string, unknown> {
  const input = ctx.request.body
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
}

function fail(ctx: Context, status: number, error: string, code?: string) {
  ctx.status = status
  ctx.body = code ? { error, code } : { error }
}

async function approve(ctx: Context, choice: 'scan' | 'create' | 'credentials'): Promise<void> {
  const ip = extractIp(ctx)
  const limit = choice === 'credentials' ? checkPassword(ip) : checkPairing(ip)
  if (!limit.allowed) return fail(ctx, limit.status, 'Too many login attempts; try again later')
  const header = ctx.get('authorization')
  const authenticated = header.startsWith('Bearer ') ? await authenticateUserToken(header.slice(7).trim()) : null
  if (header && !authenticated) return fail(ctx, 401, 'Unauthorized')

  try {
    const result = await resolveWeChatLogin(body(ctx), choice, authenticated?.id)
    if (result.status === 'needs_choice') {
      ctx.body = result
      return
    }
    if (choice === 'credentials') recordPasswordSuccess(ip)
    const token = await issueWeChatUserJwt(result.identity)
    ctx.body = { ...result.result, token }
  } catch (error) {
    if (error instanceof WeChatAuthError) {
      if (error.code === 'INVALID_CREDENTIALS' && choice === 'credentials') recordPasswordFailure(ip)
      if (error.code === 'INVALID_APPROVAL' || error.code === 'PLATFORM_MISMATCH') recordPairingFailure(ip)
      return fail(ctx, error.status, error.message, error.code)
    }
    logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, '[wechat-auth] login failed')
    fail(ctx, 500, 'Could not complete WeChat login')
  }
}

export const deviceLogin = (ctx: Context) => approve(ctx, 'scan')
export const createWeChatUser = (ctx: Context) => approve(ctx, 'create')
export const bindByCredentialsDeviceLogin = (ctx: Context) => approve(ctx, 'credentials')

export function getDeviceBinding(ctx: Context): void {
  const user = ctx.state.user
  if (!user) return fail(ctx, 401, 'Unauthorized')
  const binding = publicWeChatBinding(user.id)
  ctx.body = { bound: !!binding, accounts: binding ? [binding] : [] }
}

export function clearDeviceBindingController(ctx: Context): void {
  const user = ctx.state.user
  if (!user) return fail(ctx, 401, 'Unauthorized')
  const account = findUserById(user.id)
  const password = body(ctx).currentPassword
  const ip = extractIp(ctx)
  const limit = checkPassword(ip)
  if (!limit.allowed) return fail(ctx, limit.status, 'Too many login attempts; try again later')
  if (!account || typeof password !== 'string' || password.length > 256 || !verifyPassword(password, account.password_hash)) {
    recordPasswordFailure(ip)
    return fail(ctx, 401, 'Current password is incorrect', 'INVALID_CREDENTIALS')
  }
  recordPasswordSuccess(ip)
  const hadBinding = unbindWeChat(user.id)
  ctx.body = { success: true, hadBinding, deletedUser: null, deletedProfiles: [] }
}

export function setPassword(ctx: Context): void {
  const user = ctx.state.user
  const account = user && findUserById(user.id)
  if (!account) return fail(ctx, 401, 'Unauthorized')
  if (!ctx.state.freshWeChatAuth || !/^tp_[1-9][0-9]*$/.test(account.username)
    || !account.wechat_bound || account.wechat_password_ready) {
    return fail(ctx, 403, 'Scan WeChat again to set your first password, or use change-password', 'WECHAT_PASSWORD_SETUP_REQUIRED')
  }
  const password = body(ctx).newPassword
  if (typeof password !== 'string' || password.length < 6 || password.length > 256) {
    return fail(ctx, 400, 'Password must be 6–256 characters')
  }
  if (!updateUserPassword(account.id, password)) return fail(ctx, 500, 'Failed to update password')
  ctx.body = { success: true }
}

export function updateMyModelGuideStatus(ctx: Context): void {
  if (!ctx.state.user) return fail(ctx, 401, 'Unauthorized')
  const status = body(ctx).status
  if (status !== 'skipped' && status !== 'completed') return fail(ctx, 400, 'status must be skipped or completed')
  if (!updateUserModelGuideStatus(ctx.state.user.id, status)) return fail(ctx, 500, 'Failed to update model guide status')
  ctx.body = { success: true, status }
}

export function exportManagedUser(ctx: Context): void {
  const user = findUserById(String(ctx.params.id || ''))
  if (!user) return fail(ctx, 404, 'User not found')
  const profiles = listUserProfiles(user.id)
  const avatarRaw = getUserAvatar(user.id)
  let avatar: unknown = avatarRaw || null
  try { if (avatarRaw) avatar = JSON.parse(avatarRaw) } catch { /* Legacy avatar string. */ }
  ctx.body = {
    exported_at: Date.now(),
    user: {
      id: user.id, username: user.username, role: user.role, status: user.status,
      profiles: profiles.map(item => item.profile_name), default_profile: profiles.find(item => item.is_default === 1)?.profile_name || null,
      created_at: user.created_at, last_login_at: user.last_login_at, avatar,
    },
  }
}

export function bindPhone(ctx: Context): void {
  const user = ctx.state.user
  if (!user) return fail(ctx, 401, 'Unauthorized')
  const raw = body(ctx).phone
  const phone = typeof raw === 'string' ? normalizePhoneNumber(raw) : null
  if (!phone) return fail(ctx, 400, 'A valid phone number is required')
  const existing = findUserByPhoneNumber(phone)
  if (existing && existing.id !== user.id) return fail(ctx, 409, 'This phone number is already bound to another account', 'PHONE_ALREADY_IN_USE')
  if (!updateUserPhoneNumber(user.id, phone)) return fail(ctx, 500, 'Failed to bind phone number')
  ctx.body = { success: true, phone_number: phone }
}

export function unbindPhone(ctx: Context): void {
  const user = ctx.state.user
  const account = user && findUserById(user.id)
  if (!account) return fail(ctx, 401, 'Unauthorized')
  if (account.wechat_bound) return fail(ctx, 400, 'Unbind WeChat before removing the phone number', 'WECHAT_BOUND')
  if (!updateUserPhoneNumber(account.id, null)) return fail(ctx, 500, 'Failed to unbind phone number')
  ctx.body = { success: true }
}
