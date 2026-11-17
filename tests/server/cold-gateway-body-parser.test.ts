import { expect, it } from 'vitest'
import Koa from 'koa'
import { once } from 'node:events'
import { createCodexProxyRequestBodyParser, createRequestBodyParser } from '../../packages/server/src/modules/studio/middleware/request-body-parser'

it('awaits cold credential authentication before choosing the larger Responses body limit', async () => {
  const app = new Koa()
  app.on('error', () => {})
  app.use(createCodexProxyRequestBodyParser(async ctx => {
    await Promise.resolve()
    return ctx.get('authorization') === 'Bearer fixture-valid'
  }))
  app.use(createRequestBodyParser())
  app.use(ctx => { ctx.body = { size: (ctx.request.body as any)?.image?.length } })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  const url = `http://127.0.0.1:${address.port}/api/ekko-studio/models/v1/responses`
  const payload = JSON.stringify({ image: 'a'.repeat(21 * 1024 * 1024) })
  try {
    const accepted = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer fixture-valid', 'content-type': 'application/json' }, body: payload })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({ size: 21 * 1024 * 1024 })
    const denied = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer fixture-invalid', 'content-type': 'application/json' }, body: payload })
    expect(denied.status).toBe(413)
    await denied.text()
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
