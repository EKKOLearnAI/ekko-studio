import type { Context } from 'koa'
import {
  decideLegacyWindowsDataMigration,
  getLegacyWindowsDataMigrationStatus,
} from '../services/profiles/legacy-windows-data-migration'

export async function status(ctx: Context) {
  ctx.body = await getLegacyWindowsDataMigrationStatus()
}

export async function decide(ctx: Context) {
  const body = ctx.request.body as { action?: string }
  const action = body?.action
  if (action !== 'migrate' && action !== 'decline') {
    ctx.status = 400
    ctx.body = { error: 'action is required and must be either "migrate" or "decline"' }
    return
  }

  try {
    ctx.body = await decideLegacyWindowsDataMigration(action)
  } catch (error) {
    ctx.status = 400
    ctx.body = { error: error instanceof Error ? error.message : String(error) }
  }
}
