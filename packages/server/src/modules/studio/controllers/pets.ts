import type { Context } from 'koa'
import { getActiveProfileName } from '../public/profile-config'
import { adoptPetFromPetdex, getActivePet, updateActivePetPreferences } from '../services/pets/pets'

function requestedProfile(ctx: Context): string {
  return ctx.state.profile?.name || getActiveProfileName() || 'default'
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Pet request failed'
}

export async function active(ctx: Context) {
  ctx.body = { pet: await getActivePet(requestedProfile(ctx)) }
}

export async function adopt(ctx: Context) {
  const body = ctx.request.body as { slug?: unknown } | undefined
  const slug = typeof body?.slug === 'string' ? body.slug.trim() : ''
  if (!slug) {
    ctx.status = 400
    ctx.body = { error: 'Pet slug is required' }
    return
  }

  try {
    ctx.body = { pet: await adoptPetFromPetdex(requestedProfile(ctx), slug) }
  } catch (err) {
    const message = errorMessage(err)
    ctx.status = message.includes('was not found') ? 404 : 400
    ctx.body = { error: message }
  }
}

export async function updateActive(ctx: Context) {
  const body = ctx.request.body as {
    scale?: unknown
    position?: { x?: unknown; y?: unknown }
    enabled?: unknown
  } | undefined

  const pet = await updateActivePetPreferences(requestedProfile(ctx), {
    scale: typeof body?.scale === 'number' ? body.scale : undefined,
    enabled: typeof body?.enabled === 'boolean' ? body.enabled : undefined,
    position: body?.position && typeof body.position.x === 'number' && typeof body.position.y === 'number'
      ? { x: body.position.x, y: body.position.y }
      : undefined,
  })
  ctx.body = { pet }
}
