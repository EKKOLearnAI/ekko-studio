import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserProfileStore } from '../../packages/desktop/src/main/browser/browser-profile-store'
import type { BrowserProxyMode } from '../../packages/desktop/src/main/browser/browser-types'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ekko-browser-proxy-'))
  roots.push(root)
  const store = new BrowserProfileStore(join(root, 'state'))
  await store.initialize()
  return { root, store }
}

describe('desktop browser profile proxy defaults', () => {
  it('uses the system proxy for the first profile and new profiles without a proxy mode', async () => {
    const { root, store } = await setup()
    expect(store.active().proxyMode).toBe('system')
    const rootDirectory = join(root, 'work')
    await mkdir(rootDirectory)
    const profile = await store.create({ name: 'Work', rootDirectory })
    expect(profile.proxyMode).toBe('system')
    expect(profile.proxyRules).toBe('')

    const restarted = new BrowserProfileStore(store.root)
    await restarted.initialize()
    expect(restarted.list().every(profile => profile.proxyMode === 'system')).toBe(true)
  })

  it.each(['direct', 'system', 'fixed_servers'] as const)('preserves explicit %s on creation, unrelated updates and reload', async (proxyMode) => {
    const { root, store } = await setup()
    const rootDirectory = join(root, 'work')
    await mkdir(rootDirectory)
    const proxyRules = proxyMode === 'fixed_servers' ? 'http://127.0.0.1:7890' : ''
    const profile = await store.create({ name: 'Work', rootDirectory, proxyMode, proxyRules })
    expect(profile).toMatchObject({ proxyMode, proxyRules })
    await store.update(profile.id, { askBeforeDownload: false })

    const restarted = new BrowserProfileStore(store.root)
    await restarted.initialize()
    expect(restarted.get(profile.id)).toMatchObject({ proxyMode, proxyRules, askBeforeDownload: false })
  })

  it.each([undefined, null, '', 'invalid'])('falls back to system when persisted proxy mode is %s', async (proxyMode) => {
    const { store } = await setup()
    const document = JSON.parse(await readFile(store.profilesFile, 'utf8'))
    document.profiles[0].proxyMode = proxyMode
    await writeFile(store.profilesFile, JSON.stringify(document))

    const restarted = new BrowserProfileStore(store.root)
    await restarted.initialize()
    expect(restarted.active().proxyMode).toBe('system')
    expect(JSON.parse(await readFile(store.profilesFile, 'utf8')).profiles[0].proxyMode).toBe('system')
  })

  it('preserves explicit direct updates and falls back to system for invalid input', async () => {
    const { root, store } = await setup()
    const id = store.active().id
    expect((await store.update(id, { proxyMode: 'direct' })).proxyMode).toBe('direct')
    expect((await store.update(id, { askBeforeDownload: false })).proxyMode).toBe('direct')
    const restarted = new BrowserProfileStore(store.root)
    await restarted.initialize()
    expect(restarted.active().proxyMode).toBe('direct')
    expect((await restarted.update(id, { proxyMode: 'invalid' as BrowserProxyMode })).proxyMode).toBe('system')

    const rootDirectory = join(root, 'invalid')
    await mkdir(rootDirectory)
    expect((await store.create({ name: 'Invalid', rootDirectory, proxyMode: 'invalid' as BrowserProxyMode })).proxyMode).toBe('system')
  })
})
