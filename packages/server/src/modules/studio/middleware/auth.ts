import { handleSessionShareHttp } from '../services/session-shares/http-access'
import type { Context, Next } from 'koa'
import { createHmac, randomUUID, timingSafeEqual } from 'crypto'
import { getToken } from '../services/auth/token-auth'
import {
  findUserById,
  listUserProfiles,
  touchUserLogin,
  userCanAccessProfile,
  type UserRecord,
  type UserRole,
} from '../repositories/users-store'
import {
  getAppConnectionTokenStatus,
  isAppConnectionTokenActive,
  type AppConnectionTokenStatus,
  type AppConnectionType,
} from '../repositories/app-connections-store'

export interface AuthenticatedUser {
  id: number
  username: string
  role: UserRole
  profiles?: string[]
}

export interface RequestProfile {
  name: string
}

export interface AppUserTokenInspection {
  status: AppConnectionTokenStatus
  user: AuthenticatedUser | null
  deviceCode: string
  connectionType: AppConnectionType
}

interface JwtPayload {
  sub: string
  username: string
  role: UserRole
  type: 'access' | 'app_access'
  app_device_code?: string
  app_connection_type?: AppConnectionType
  app_token_id?: string
  aud: 'hermes-studio'
  iat: number
  exp: number
}

declare module 'koa' {
  interface DefaultState {
    user?: AuthenticatedUser
    profile?: RequestProfile
    serverTokenAuth?: boolean
  }
}

const JWT_AUDIENCE = 'hermes-studio'
const DEFAULT_EXPIRES_SECONDS = 60 * 60 * 24 * 30
const MIN_EXPIRES_SECONDS = 1
const MAX_EXPIRES_SECONDS = 60 * 60 * 24 * 365
export const MODEL_RUN_EXPIRES_SECONDS = 60 * 60

export function parseJwtExpirySeconds(value: string | undefined): number | null {
  const raw = value?.trim()
  if (!raw) return null

  const match = raw.match(/^(\d+)(?:\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days))?$/i)
  if (!match) return null

  const amount = Number(match[1])
  if (!Number.isSafeInteger(amount) || amount <= 0) return null

  const unit = (match[2] || 's').toLowerCase()
  const multiplier = unit.startsWith('d') ? 86400
    : unit.startsWith('h') ? 3600
      : unit.startsWith('m') ? 60
        : 1
  const seconds = amount * multiplier
  if (!Number.isSafeInteger(seconds)) return null
  if (seconds < MIN_EXPIRES_SECONDS || seconds > MAX_EXPIRES_SECONDS) return null
  return seconds
}

export function getUserJwtExpiresSeconds(env: Record<string, string | undefined> = process.env): number {
  return parseJwtExpirySeconds(env.HERMES_WEB_UI_AUTH_JWT_EXPIRES_IN) ?? DEFAULT_EXPIRES_SECONDS
}

export function getModelRunJwtExpiresSeconds(env: Record<string, string | undefined> = process.env): number {
  return parseJwtExpirySeconds(env.HERMES_WEB_UI_MODEL_RUN_JWT_EXPIRES_IN) ?? MODEL_RUN_EXPIRES_SECONDS
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function sign(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url')
}

function safeEqual(a: string, b: string): boolean {
  try {
    const left = Buffer.from(a)
    const right = Buffer.from(b)
    return left.length === right.length && timingSafeEqual(left, right)
  } catch {
    return false
  }
}

async function getJwtSecret(): Promise<string> {
  return process.env.AUTH_JWT_SECRET || await getToken()
}

function requestToken(ctx: Context): string {
  const auth = ctx.headers.authorization || ''
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim()
  return typeof ctx.query.token === 'string' ? ctx.query.token.trim() : ''
}

const SERVER_TOKEN_EXACT_PATHS = new Set([
  '/api/studio/media/apikey-image-generate',
  '/api/studio/media/grok-image-to-video',
  '/api/studio/media/minimax-image-to-video',
])

function allowsServerTokenPath(path: string): boolean {
  return SERVER_TOKEN_EXACT_PATHS.has(path) ||
    path.startsWith('/api/studio/voice/proxy/')
}

function isLoopbackRequest(ctx: Context): boolean {
  const ip = String(ctx.ip || ctx.request.ip || '').trim()
  const remote = String(ctx.req.socket.remoteAddress || '').trim()
  const values = [ip, remote].map(value => value.startsWith('::ffff:') ? value.slice(7) : value)
  return values.some(value => (
    value === '127.0.0.1' ||
    value === '::1' ||
    value === 'localhost' ||
    value.startsWith('127.')
  ))
}

async function allowServerTokenForAgentEndpoint(ctx: Context, token: string): Promise<boolean> {
  if (!token || !allowsServerTokenPath(ctx.path)) return false
  if (!isLoopbackRequest(ctx)) return false
  const serverToken = await getToken()
  if (token !== serverToken) return false
  ctx.state.serverTokenAuth = true
  return true
}

function isProtectedHttpPath(path: string): boolean {
  const lowerPath = path.toLowerCase()
  return lowerPath.startsWith('/api') ||
    lowerPath.startsWith('/v1')
}

export function signUserJwt(
  user: Pick<UserRecord, 'id' | 'username' | 'role'>,
  secret: string,
  now = Date.now(),
  expiresSeconds = DEFAULT_EXPIRES_SECONDS,
): string {
  const iat = Math.floor(now / 1000)
  const payload: JwtPayload = {
    sub: String(user.id),
    username: user.username,
    role: user.role,
    type: 'access',
    aud: JWT_AUDIENCE,
    iat,
    exp: iat + expiresSeconds,
  }
  const header = base64UrlJson({ alg: 'HS256', typ: 'JWT' })
  const body = base64UrlJson(payload)
  const unsigned = `${header}.${body}`
  return `${unsigned}.${sign(unsigned, secret)}`
}

export function signAppJwt(
  user: Pick<UserRecord, 'id' | 'username' | 'role'>,
  deviceCode: string,
  connectionType: AppConnectionType,
  secret: string,
  now = Date.now(),
  expiresSeconds = DEFAULT_EXPIRES_SECONDS,
): string {
  const iat = Math.floor(now / 1000)
  const payload: JwtPayload = {
    sub: String(user.id),
    username: user.username,
    role: user.role,
    type: 'app_access',
    app_device_code: deviceCode,
    app_connection_type: connectionType,
    app_token_id: randomUUID(),
    aud: JWT_AUDIENCE,
    iat,
    exp: iat + expiresSeconds,
  }
  const header = base64UrlJson({ alg: 'HS256', typ: 'JWT' })
  const body = base64UrlJson(payload)
  const unsigned = `${header}.${body}`
  return `${unsigned}.${sign(unsigned, secret)}`
}

function verifyUserJwtPayload(
  token: string,
  secret: string,
  now: number,
  allowExpired: boolean,
): JwtPayload | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  const [header, body, signature] = parts
  const expected = sign(`${header}.${body}`, secret)
  if (!safeEqual(signature, expected)) return null

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as Partial<JwtPayload>
    if ((payload.type !== 'access' && payload.type !== 'app_access') || payload.aud !== JWT_AUDIENCE) return null
    if (!payload.sub || !payload.username || !payload.role || !payload.exp) return null
    if (payload.type === 'app_access' && (
      !payload.app_device_code
      || (payload.app_connection_type !== 'lan' && payload.app_connection_type !== 'cloud')
      || !payload.app_token_id
    )) return null
    if (!allowExpired && Math.floor(now / 1000) >= payload.exp) return null
    return payload as JwtPayload
  } catch {
    return null
  }
}

export function verifyUserJwt(token: string, secret: string, now = Date.now()): JwtPayload | null {
  return verifyUserJwtPayload(token, secret, now, false)
}

export async function issueUserJwt(user: Pick<UserRecord, 'id' | 'username' | 'role'>): Promise<string> {
  const secret = await getJwtSecret()
  return signUserJwt(user, secret, Date.now(), getUserJwtExpiresSeconds())
}

export async function issueAppJwt(
  user: Pick<UserRecord, 'id' | 'username' | 'role'>,
  deviceCode: string,
  connectionType: AppConnectionType,
): Promise<string> {
  const secret = await getJwtSecret()
  return signAppJwt(user, deviceCode, connectionType, secret, Date.now(), getUserJwtExpiresSeconds())
}

export async function issueModelRunJwt(user: Pick<UserRecord, 'id' | 'username' | 'role'>): Promise<string> {
  const secret = await getJwtSecret()
  return signUserJwt(user, secret, Date.now(), getModelRunJwtExpiresSeconds())
}

export function toAuthenticatedUser(user: Pick<UserRecord, 'id' | 'username' | 'role'>): AuthenticatedUser {
  const authenticated: AuthenticatedUser = {
    id: user.id,
    username: user.username,
    role: user.role,
  }
  if (user.role !== 'super_admin') {
    authenticated.profiles = listUserProfiles(user.id).map(profile => profile.profile_name)
  }
  return authenticated
}

export async function inspectAppUserToken(token: string): Promise<AppUserTokenInspection | null> {
  const secret = await getJwtSecret()
  const payload = token ? verifyUserJwtPayload(token, secret, Date.now(), true) : null
  if (!payload || payload.type !== 'app_access') return null

  const deviceCode = payload.app_device_code || ''
  const connectionType = payload.app_connection_type || 'lan'
  const status = getAppConnectionTokenStatus(
    deviceCode,
    connectionType,
    token,
    Number(payload.sub),
  )
  const user = findUserById(payload.sub)
  return {
    status: !user || user.status !== 'active' ? 'invalid' : status,
    user: user?.status === 'active' ? toAuthenticatedUser(user) : null,
    deviceCode,
    connectionType,
  }
}

export async function authenticateUserToken(token: string): Promise<AuthenticatedUser | null> {
  const secret = await getJwtSecret()

  const payload = token ? verifyUserJwt(token, secret) : null
  if (!payload) return null

  if (payload.type === 'app_access' && !isAppConnectionTokenActive(
    payload.app_device_code || '',
    payload.app_connection_type || 'lan',
    token,
    Number(payload.sub),
  )) return null

  const user = findUserById(payload.sub)
  if (!user || user.status !== 'active') return null
  return toAuthenticatedUser(user)
}

export async function isAuthEnabled(): Promise<boolean> {
  await getJwtSecret()
  return true
}

export async function requireUserJwt(ctx: Context, next: Next): Promise<void> {
  if (!isProtectedHttpPath(ctx.path)) {
    await next()
    return
  }

  if (await handleSessionShareHttp(ctx, next)) return

  const secret = await getJwtSecret()
  const token = requestToken(ctx)
  const payload = token ? verifyUserJwt(token, secret) : null
  if (!payload) {
    if (await allowServerTokenForAgentEndpoint(ctx, token)) {
      await next()
      return
    }
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }

  if (payload.type === 'app_access' && !isAppConnectionTokenActive(
    payload.app_device_code || '',
    payload.app_connection_type || 'lan',
    token,
    Number(payload.sub),
  )) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }

  const user = findUserById(payload.sub)
  if (!user || user.status !== 'active') {
    ctx.status = 403
    ctx.body = { error: 'User is disabled or does not exist' }
    return
  }

  ctx.state.user = toAuthenticatedUser(user)
  touchUserLogin(user.id)
  await next()
}

export async function requireSuperAdmin(ctx: Context, next: Next): Promise<void> {
  if (ctx.state.user?.role !== 'super_admin') {
    ctx.status = 403
    ctx.body = { error: 'Super administrator privileges are required' }
    return
  }
  await next()
}

export async function requireAdmin(ctx: Context, next: Next): Promise<void> {
  const role = ctx.state.user?.role
  if (role !== 'super_admin' && role !== 'admin') {
    ctx.status = 403
    ctx.body = { error: 'Administrator privileges are required' }
    return
  }
  await next()
}

export function resolveRequestedProfile(ctx: Context): string {
  if (ctx.path === '/api/hermes/available-models' && typeof ctx.query.profile !== 'string') {
    return ''
  }
  const headerProfile = ctx.get('x-hermes-profile')
  const queryProfile = typeof ctx.query.profile === 'string' ? ctx.query.profile : ''
  const body = ctx.request.body as { profile?: unknown } | undefined
  const bodyProfile = typeof body?.profile === 'string' ? body.profile : ''
  return (headerProfile || queryProfile || bodyProfile || '').trim()
}

export async function resolveUserProfile(ctx: Context, next: Next): Promise<void> {
  if (ctx.state.sessionShare) { await next(); return }
  const user = ctx.state.user
  if (!user) {
    await next()
    return
  }

  const profileName = resolveRequestedProfile(ctx)
  if (!profileName) {
    await next()
    return
  }

  if (user.role !== 'super_admin' && !userCanAccessProfile(user.id, profileName)) {
    ctx.status = 403
    ctx.body = { error: `Profile "${profileName}" is not available for this user` }
    return
  }

  ctx.state.profile = { name: profileName }
  await next()
}

export async function requireUserProfile(ctx: Context, next: Next): Promise<void> {
  if (!ctx.state.profile?.name) {
    ctx.status = 400
    ctx.body = { error: 'Profile is required' }
    return
  }
  await next()
}

export const userAuthMiddleware = [requireUserJwt, resolveUserProfile]
