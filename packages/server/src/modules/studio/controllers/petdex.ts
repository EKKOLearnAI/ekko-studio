import type { Context } from 'koa'
import { fetchPetdexAsset, fetchPetdexManifest } from '../services/pets/petdex'

export async function manifest(ctx: Context) {
  const force = ctx.query.force === '1' || ctx.query.force === 'true'
  ctx.body = await fetchPetdexManifest({ force })
}

export async function asset(ctx: Context) {
  const url = typeof ctx.query.url === 'string' ? ctx.query.url.trim() : ''
  if (!url) {
    ctx.status = 400
    ctx.body = { error: 'Petdex asset URL is required' }
    return
  }

  try {
    const asset = await fetchPetdexAsset(url)
    ctx.type = asset.mime
    ctx.set('Cache-Control', `public, max-age=${asset.maxAgeSeconds}`)
    ctx.body = asset.buffer
  } catch (err) {
    ctx.status = 400
    ctx.body = { error: err instanceof Error ? err.message : 'Petdex asset request failed' }
  }
}
