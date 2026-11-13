import type { Context } from 'koa'
import { getActiveProfileName } from '../services/profiles/profile'
import {
  createSkillBundle,
  deleteSkillBundle,
  listSkillBundles,
  SkillBundleConflictError,
  SkillBundleProfileNotFoundError,
  SkillBundleNotFoundError,
  SkillBundleValidationError,
} from '../services/skill-bundles/skill-bundles'

function requestedProfile(ctx: Context): string {
  const queryProfile = typeof ctx.query?.profile === 'string' ? ctx.query.profile.trim() : ''
  return ctx.state?.profile?.name || queryProfile || getActiveProfileName() || 'default'
}

/** DELETE /api/hermes/bundles/:commandName — delete a bundle from the request-scoped profile. */
export async function remove(ctx: Context) {
  try {
    await deleteSkillBundle(requestedProfile(ctx), ctx.params.commandName || '')
    ctx.body = { success: true }
  } catch (err) {
    if (err instanceof SkillBundleValidationError) {
      ctx.status = 400
      ctx.body = { error: err.message }
      return
    }
    if (err instanceof SkillBundleNotFoundError || err instanceof SkillBundleProfileNotFoundError) {
      ctx.status = 404
      ctx.body = { error: err.message }
      return
    }
    throw err
  }
}

/** GET /api/hermes/bundles — list the request-scoped profile's skill bundles. */
export async function list(ctx: Context) {
  try {
    ctx.body = { bundles: await listSkillBundles(requestedProfile(ctx)) }
  } catch (err) {
    if (err instanceof SkillBundleProfileNotFoundError) {
      ctx.status = 404
      ctx.body = { error: err.message }
      return
    }
    throw err
  }
}

/** POST /api/hermes/bundles — create a skill bundle in the request-scoped profile. */
export async function create(ctx: Context) {
  const body = ctx.request.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    ctx.status = 400
    ctx.body = { error: 'Request body must be an object' }
    return
  }

  const record = body as Record<string, unknown>
  try {
    const bundle = await createSkillBundle(requestedProfile(ctx), {
      name: typeof record.name === 'string' ? record.name : '',
      description: typeof record.description === 'string' ? record.description : '',
      skills: Array.isArray(record.skills) ? record.skills.filter((skill): skill is string => typeof skill === 'string') : [],
    })
    ctx.status = 201
    ctx.body = { bundle }
  } catch (err) {
    if (err instanceof SkillBundleValidationError) {
      ctx.status = 400
      ctx.body = { error: err.message }
      return
    }
    if (err instanceof SkillBundleConflictError) {
      ctx.status = 409
      ctx.body = { error: err.message }
      return
    }
    if (err instanceof SkillBundleProfileNotFoundError) {
      ctx.status = 404
      ctx.body = { error: err.message }
      return
    }
    throw err
  }
}
