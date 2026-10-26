import { t } from '../desktop-i18n'
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { deviceWindowEndpoint, ownDeviceWindow } from '../device-window-owner'

/** Chromium keeps a Session alive after views close. Hold until process exit. */
export class BrowserProfileLeases {
  private static readonly leases = new Map<string, Promise<void>>()
  constructor(private readonly onExit: (release: () => void) => void) {}
  async acquire(path: string): Promise<void> {
    // Reserve a not-yet-created data directory without making an empty profile
    // root nonempty before BrowserProfileStore validates it. Resolve existing
    // ancestors so symlink aliases contend for the same cross-process owner.
    let parent = resolve(path)
    const suffix: string[] = []
    while (!existsSync(parent)) {
      suffix.unshift(basename(parent))
      parent = dirname(parent)
    }
    const canonical = resolve(realpathSync(parent), ...suffix)
    let pending = BrowserProfileLeases.leases.get(canonical)
    if (!pending) {
      pending = (async () => {
        const release = await ownDeviceWindow(deviceWindowEndpoint('browser-profile-storage-v1', canonical), () => {})
        if (!release) throw new Error(t('browser.profileInUse'))
        this.onExit(release)
      })()
      BrowserProfileLeases.leases.set(canonical, pending)
      pending.catch(() => { if (BrowserProfileLeases.leases.get(canonical) === pending) BrowserProfileLeases.leases.delete(canonical) })
    }
    await pending
  }
}
