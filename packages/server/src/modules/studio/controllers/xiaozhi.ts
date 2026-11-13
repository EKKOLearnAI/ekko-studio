import type { Context } from 'koa'
import { getXiaozhiProvisioning, getXiaozhiStatus } from '../services/xiaozhi-provisioning'
export async function provision(ctx: Context) {
  ctx.set('Cache-Control', 'no-store')
  const result = await getXiaozhiProvisioning(ctx.get('device-id'), String(ctx.params.code || ''), ctx.req.socket.localAddress, ctx.get('host'))
  if (!result) { ctx.status = 404; return }
  ctx.body = result
}
export async function status(ctx: Context) {
  ctx.set('Cache-Control', 'no-store')
  ctx.body = await getXiaozhiStatus(ctx.req.socket.localAddress, ctx.get('host'))
}
