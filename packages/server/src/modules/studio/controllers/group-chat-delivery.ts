import type { Context } from 'koa'
import * as service from '../services/group-chat/delivery'

export async function deliveryUsage(ctx: Context): Promise<void> {
  await service.deliveryUsage(ctx)
}

export async function cleanupDelivery(ctx: Context): Promise<void> {
  await service.cleanupDelivery(ctx)
}
