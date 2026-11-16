import Koa from 'koa'
import { afterEach, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { legacyProviderCredentials } from '../../packages/server/src/modules/studio/middleware/legacy-provider-credentials'
import { legacyAppApiCompatibility } from '../../packages/server/src/modules/studio/middleware/legacy-app-api'
import { LEGACY_PROVIDER_CREDENTIAL, stripLegacyProviderCredential } from '../../packages/server/src/modules/studio/contracts/legacy-provider-credential'

const group = (ready: boolean) => ({ provider: 'deepseek', models: ['family/model'],
  api_key: '', credential_configured: ready, supports_gateway_auth: true })
const catalog = () => ({ groups: [group(true), { ...group(false), provider: 'custom:missing' }],
  profiles: [{ profile: 'work', groups: [group(true)] }, { profile: 'default', groups: [group(false)] }],
  allProviders: [{ provider: 'deepseek', api_key: '' }], default_provider: 'deepseek', default: 'family/model' })
const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))) })

async function start() {
  const app = new Koa()
  const original = catalog()
  app.use(async (ctx, next) => {
    if (ctx.method !== 'GET') {
      const chunks: Buffer[] = []
      for await (const chunk of ctx.req) chunks.push(chunk)
      ctx.request.body = JSON.parse(Buffer.concat(chunks).toString())
    }
    await next()
  })
  app.use(legacyAppApiCompatibility)
  app.use(legacyProviderCredentials)
  app.use(ctx => { ctx.body = ctx.method === 'GET' ? original : ctx.request.body })
  const server = app.listen(0, '127.0.0.1')
  servers.push(server)
  await new Promise<void>(resolve => server.once('listening', resolve))
  return { url: `http://127.0.0.1:${(server.address() as any).port}`, original }
}

it('serves readiness markers to old clients without mutating the internal catalog or pretending missing credentials exist', async () => {
  const { url, original } = await start()
  const response = await fetch(`${url}/api/hermes/available-models?profile=work`)
  const body = await response.json() as any
  expect(body.groups[0].api_key).toBe(LEGACY_PROVIDER_CREDENTIAL)
  expect(body.groups[1].api_key).toBe('')
  expect(body.profiles[0].groups[0].api_key).toBe(LEGACY_PROVIDER_CREDENTIAL)
  expect(body.profiles[1].groups[0].api_key).toBe('')
  expect(body.allProviders[0].api_key).toBe('')
  expect(body.default_provider).toBe('deepseek')
  expect(body.default).toBe('family/model')
  expect(original).toEqual(catalog())
})

it('preserves the redacted response for new clients and leaves unrelated endpoints unchanged', async () => {
  const { url, original } = await start()
  const modern = await fetch(`${url}/api/hermes/available-models?credential_format=metadata`)
  expect(await modern.json()).toEqual(original)
  const unrelated = await fetch(`${url}/api/studio/unrelated`)
  expect(await unrelated.json()).toEqual(original)
})

it.each(['/api/studio/sessions', '/api/hermes/sessions', '/api/studio/chat-run/run',
  '/api/hermes/config/providers/deepseek', '/api/hermes/config/providers/deepseek/editor', '/api/hermes/provider-models'])(
  'removes echoed markers before handling %s while preserving logical model identity and message content', async path => {
    const { url } = await start()
    const response = await fetch(url + path, { method: 'POST', body: JSON.stringify({
      provider: 'deepseek', model: 'family/model', apiMode: 'chat_completions',
      apiKey: LEGACY_PROVIDER_CREDENTIAL, api_key: ` ${LEGACY_PROVIDER_CREDENTIAL} `,
      credential_action: 'replace', input: { api_key: LEGACY_PROVIDER_CREDENTIAL },
    }) })
    expect(await response.json()).toEqual({ provider: 'deepseek', model: 'family/model', apiMode: 'chat_completions',
      credential_action: 'keep', input: { api_key: LEGACY_PROVIDER_CREDENTIAL } })
  },
)

it('retains real credential updates and explicit clears', () => {
  for (const key of ['new-secret', '', null]) {
    const body = { api_key: key, credential_action: key ? 'replace' : 'clear' }
    const original = { ...body }
    stripLegacyProviderCredential(body)
    expect(body).toEqual(original)
  }
  const mixed = { api_key: 'new-secret', apiKey: LEGACY_PROVIDER_CREDENTIAL, credential_action: 'replace' }
  stripLegacyProviderCredential(mixed)
  expect(mixed).toEqual({ api_key: 'new-secret', credential_action: 'replace' })
})

it('normalizes a cached old-App Socket run before it can enter the queue', () => {
  const run = { apiKey: LEGACY_PROVIDER_CREDENTIAL, api_key: LEGACY_PROVIDER_CREDENTIAL,
    provider: 'deepseek', model: 'family/model', mode: 'scoped', input: 'hello', session_id: 'old-session' }
  stripLegacyProviderCredential(run)
  expect(run).toEqual({ provider: 'deepseek', model: 'family/model', mode: 'scoped', input: 'hello', session_id: 'old-session' })
})
