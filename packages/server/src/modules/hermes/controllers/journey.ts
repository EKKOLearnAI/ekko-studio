import { getActiveProfileName } from '../services/profiles/profile'
import { getJourneyGraph } from '../services/journey/journey'

function requestedProfile(ctx: any): string {
  return ctx.state?.profile?.name || getActiveProfileName() || 'default'
}

export async function graph(ctx: any) {
  try {
    ctx.body = await getJourneyGraph(requestedProfile(ctx))
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: { message: err?.message || String(err) } }
  }
}
