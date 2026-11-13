import type { Context } from 'koa'
import { fetchStudioAnnouncements } from '../services/notifications/announcements'

export async function getAnnouncements(ctx: Context): Promise<void> {
  ctx.set('Cache-Control', 'no-store')
  try {
    ctx.body = await fetchStudioAnnouncements(ctx.query.locale)
  } catch {
    ctx.status = 502
    ctx.body = { ok: false, error: 'announcement_fetch_failed' }
  }
}
