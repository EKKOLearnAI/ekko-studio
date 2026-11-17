import { expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserProfileStore } from '../../packages/desktop/src/main/browser/browser-profile-store'

it('keeps valid profiles and backs up the exact damaged index before recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-browser-'))
  try {
    const store = new BrowserProfileStore(root)
    await store.initialize()
    const valid = store.active()
    const raw = JSON.stringify({ schema: 1, activeProfileId: 'bad', profiles: [
      valid, { ...valid, id: 'bad', proxyMode: 'fixed_servers', proxyRules: '' },
    ] })
    await writeFile(store.profilesFile, raw)
    await store.initialize()
    expect(store.list().map(profile => profile.id)).toEqual([valid.id])
    expect(store.active().id).toBe(valid.id)
    const backup = (await readdir(root)).find(name => name.endsWith('.bak'))!
    expect(await readFile(join(root, backup), 'utf8')).toBe(raw)
    await writeFile(store.profilesFile, '{invalid')
    await expect(store.initialize()).rejects.toThrow()
    expect(await readFile(store.profilesFile, 'utf8')).toBe('{invalid')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
