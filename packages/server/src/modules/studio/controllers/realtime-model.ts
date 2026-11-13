import type { Context } from 'koa'
import {
  deleteRealtimeModelSetting,
  getRealtimeModelSetting,
  RealtimeModelSettingsValidationError,
  saveRealtimeModelSetting,
} from '../services/realtime-model'
import { getDefaultProfileForUser } from '../public/users'

/**
 * Realtime (Qwen / DashScope) model settings controller.
 *
 * Persists the "设置 → 模型 → Realtime 模型" panel configuration (shared
 * DashScope API key + realtime model + default voice) server-side per Hermes
 * profile — the same profile-scoped pattern STT/TTS settings use — instead of
 * browser-only localStorage. Auth/profile semantics mirror the STT settings
 * controller.
 */

function authUserId(ctx: Context): number | null {
  const rawUserId = ctx.state.user?.id
  const userId = typeof rawUserId === 'number' ? rawUserId : Number.NaN
  if (!Number.isInteger(userId) || userId <= 0) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return null
  }
  return userId
}

function requestedProfile(ctx: Context): string {
  const queryProfile = typeof ctx.query?.profile === 'string' ? ctx.query.profile : ''
  const headerProfile = ctx.get?.('x-hermes-profile') || ''
  const explicit = (ctx.state?.profile?.name || queryProfile || headerProfile || '').trim()
  if (explicit) return explicit
  // Implicit fallback: resolve to a profile the user actually owns instead of
  // blindly landing on the shared active/default profile. Users without any
  // profile binding keep the legacy `default` fallback.
  const user = ctx.state?.user
  if (user && user.role !== 'super_admin' && !ctx.state?.serverTokenAuth) {
    const bound: string[] = user.profiles || []
    if (bound.length === 1) return bound[0]
    if (bound.length > 1) {
      const fallback = getDefaultProfileForUser(user.id)
      if (bound.includes(fallback)) return fallback
      const err: any = new Error('Profile is required')
      err.status = 400
      err.code = 'profile_required'
      throw err
    }
  }
  return 'default'
}

function handleSettingsError(ctx: Context, error: unknown): boolean {
  if (error instanceof RealtimeModelSettingsValidationError) {
    ctx.status = 400
    ctx.body = { error: error.message }
    return true
  }
  return false
}

/** GET /api/studio/realtime-model/settings */
export async function getSettings(ctx: Context): Promise<void> {
  const userId = authUserId(ctx)
  if (!userId) return

  try {
    const profile = requestedProfile(ctx)
    // includeSecrets: the settings panel echoes the key back (it is needed to
    // bootstrap realtime sessions / meeting ASR from any browser), so the
    // authenticated owner of the profile receives the raw stored value.
    ctx.body = { setting: getRealtimeModelSetting(profile, { includeSecrets: true }) }
  } catch (error) {
    if (handleSettingsError(ctx, error)) return
    throw error
  }
}

/** PUT /api/studio/realtime-model/settings */
export async function saveSettings(ctx: Context): Promise<void> {
  const userId = authUserId(ctx)
  if (!userId) return

  const body = ctx.request.body as { settings?: unknown; secrets?: unknown } | undefined

  try {
    const profile = requestedProfile(ctx)
    const setting = saveRealtimeModelSetting(profile, {
      settings: body?.settings,
      secrets: body?.secrets,
    })
    ctx.body = { setting }
  } catch (error) {
    if (handleSettingsError(ctx, error)) return
    throw error
  }
}

/** DELETE /api/studio/realtime-model/settings */
export async function removeSettings(ctx: Context): Promise<void> {
  const userId = authUserId(ctx)
  if (!userId) return

  try {
    const profile = requestedProfile(ctx)
    const deleted = deleteRealtimeModelSetting(profile)
    ctx.body = { success: true, deleted }
  } catch (error) {
    if (handleSettingsError(ctx, error)) return
    throw error
  }
}
