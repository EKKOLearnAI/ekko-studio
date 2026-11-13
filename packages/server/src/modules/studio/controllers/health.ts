import type { StudioHealthService } from '../services/health'

let service: StudioHealthService | null = null

export function configureHealthController(nextService: StudioHealthService): void {
  service = nextService
}

function requireService(): StudioHealthService {
  if (!service) throw new Error('Studio health controller is not configured')
  return service
}

export function livenessCheck(ctx: any) {
  ctx.body = { status: 'ok' }
}

export async function healthCheck(ctx: any) {
  ctx.body = await requireService().snapshot()
}

export async function checkLatestVersion(): Promise<void> {
  await requireService().checkLatestVersion()
}

export function startVersionCheck(): void {
  requireService().startVersionCheck()
}
