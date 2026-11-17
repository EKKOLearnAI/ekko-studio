import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginRuntime } from '../../packages/server/src/modules/studio/services/plugins/runtime'
import { PluginStore } from '../../packages/server/src/modules/studio/services/plugins/store'
import { PluginResources, pluginResources } from '../../packages/server/src/modules/studio/services/plugins/resources'
import { configureUpdateRuntime, describePreviewPluginResource, installPreview, preparePreview, startPreview, stopPreview, stopPreviewRuntime } from '../../packages/server/src/modules/studio/services/update/version-preview-manager'
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function runtime(resources: PluginResources) {
  const directory = mkdtempSync(join(tmpdir(), 'studio-preview-resource-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const environment = { webUiHome: directory, studio: { name: 'ekko-studio', version: '0.8.25', repositoryUrl: 'https://github.com/example/studio' }, isPreview: false }
  const record: any = { manifest: { id: 'version-preview', name: 'Preview', version: '0.1.0', apiVersion: 1, permissions: ['api.write'], server: 'server.mjs' }, config: {} }
  return { environment, instance: new PluginRuntime(record, { userId: 42, profile: 'default' }, new PluginStore(join(directory, 'plugins')), { environment: () => environment, claimResource: (name, owner) => resources.claim(name, owner), authorize() {}, api: async () => null, emit() {}, log() {} }) }
}
it('claims immutable metadata for ordinary authenticated identity and releases after lifetime cleanup', async () => {
  const resources = new PluginResources(); resources.register('studio.version-preview', () => ({ sourceDir: '/preview', homeDir: '/preview-home' }))
  const { instance, environment } = runtime(resources); cleanup.push(() => instance.close())
  let lifetime!: AbortSignal, call!: AbortSignal, cleaned = false
  await instance.load({ async apply(ctx) {
    expect(ctx.environment).toEqual(environment); expect(ctx.environment).not.toBe(environment)
    const lease = await ctx.resources!.claim('studio.version-preview'); expect(lease.data).toEqual({ sourceDir: '/preview', homeDir: '/preview-home' })
    lifetime = ctx.signal; ctx.lifecycle.add(() => { expect(resources.claimed('studio.version-preview')).toBe(true); cleaned = true })
    ctx.extensions.rpc.register('check', (_input, run) => { call = run.signal; return { home: ctx.environment!.webUiHome } })
  } })
  await instance.invoke('rpc', 'check', null, { userId: 42, profile: 'default' })
  expect(call.aborted).toBe(true); expect(lifetime.aborted).toBe(false)
  await instance.close(); expect(cleaned).toBe(true); expect(lifetime.aborted).toBe(true); expect(resources.claimed('studio.version-preview')).toBe(false)
})
it('refuses unknown, busy and competing resources without replacing an owner', () => {
  const resources = new PluginResources()
  expect(() => resources.claim('unknown', 'a')).toThrow('unavailable')
  resources.register('busy', () => { throw new Error('Built-in task busy') })
  expect(() => resources.claim('busy', 'a')).toThrow('busy'); expect(resources.claimed('busy')).toBe(false)
  resources.register('free', () => null)
  const lease = resources.claim('free', 'a'); expect(() => resources.claim('free', 'b')).toThrow('already owned')
  lease.release(); lease.release(); expect(resources.claim('free', 'b')).toBeDefined()
})
it('retains exclusive ownership when plugin process cleanup fails', async () => {
  const resources = new PluginResources(); resources.register('preview', () => null)
  const { instance } = runtime(resources)
  await instance.load({ async apply(ctx) { await ctx.resources!.claim('preview'); ctx.lifecycle.add(() => { throw new Error('process still running') }) } })
  await expect(instance.close()).rejects.toThrow('cleanup failed'); expect(resources.claimed('preview')).toBe(true)
})
it('releases a claim after failed activation when cleanup succeeds', async () => {
  const resources = new PluginResources(); resources.register('preview', () => null)
  const { instance } = runtime(resources)
  await expect(instance.load({ async apply(ctx) { await ctx.resources!.claim('preview'); throw new Error('bad config') } })).rejects.toThrow('bad config')
  expect(resources.claimed('preview')).toBe(false)
})
it('keeps built-in preview implemented and blocks its mutations/shutdown while leased', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-built-in-preview-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  configureUpdateRuntime({ getWebUiHome: () => directory, isDockerContainer: () => false })
  const unregister = pluginResources.register('studio.version-preview', describePreviewPluginResource); cleanup.push(unregister)
  const lease = pluginResources.claim('studio.version-preview', 'plugin'); cleanup.push(lease.release)
  expect(lease.data).toEqual({ sourceDir: join(directory, 'hermes-web-ui-pereview'), homeDir: join(directory, 'hermes-web-ui-pereview-home') })
  for (const handler of [preparePreview, installPreview, startPreview, stopPreview]) {
    const ctx: any = { request: { body: { tag: 'main' } } }; await handler(ctx)
    expect(ctx.status).toBe(409); expect(ctx.body.message).toContain('active plugin')
  }
  await expect(stopPreviewRuntime()).resolves.toBeUndefined()
})
