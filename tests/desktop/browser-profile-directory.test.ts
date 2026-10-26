import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { BrowserProfileStore } from '../../packages/desktop/src/main/browser/browser-profile-store'

const electron = vi.hoisted(() => ({ root: '', releases: [] as Array<() => void> }))
vi.mock('electron', () => ({
  app: { getLocale: () => 'en', getPath: () => electron.root, once: (_: string, release: () => void) => electron.releases.push(release) },
}))
import { BrowserManager } from '../../packages/desktop/src/main/browser/browser-manager'

it('reserves an empty custom root without breaking create or root-change validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profile-manager-directory-'))
  electron.root = root
  try {
    const manager = new BrowserManager({} as BrowserWindow, join(root, 'browser'))
    const store = (manager as unknown as { profileStore: BrowserProfileStore }).profileStore
    await store.initialize()
    const first = join(root, 'first')
    const second = join(root, 'second')
    await mkdir(first)
    await mkdir(second)
    const profile = await manager.createProfile({ name: 'isolated', rootDirectory: first })
    expect((await readdir(first)).sort()).toEqual(['data', 'download'])
    const updated = await manager.updateProfile(profile.id, { rootDirectory: second })
    expect(updated.sessionPath).toBe(await realpath(join(second, 'data')))
    expect((await readdir(second)).sort()).toEqual(['data', 'download'])
    const persisted = JSON.parse(await readFile(store.profilesFile, 'utf8'))
    expect(persisted.profiles.find((item: { id: string }) => item.id === profile.id).sessionPath).toBe(updated.sessionPath)
    await expect(manager.createProfile({ name: 'overlap', rootDirectory: second })).rejects.toThrow('overlap')
  } finally {
    electron.releases.splice(0).forEach(release => release())
    await rm(root, { recursive: true, force: true })
  }
})
