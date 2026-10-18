import { lstat, mkdir, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export async function linkAntigravityNativeKeychain(
  home: string,
  rootDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== 'darwin') return
  // go-keyring invokes /usr/bin/security, which resolves both its preferences
  // and login keychain relative to HOME. Keep those native while MCP/settings
  // use the per-run HOME; credentials stay in the OS keychain rather than copies.
  const entries = [
    { path: join('Library', 'Keychains'), type: 'dir' as const },
    { path: join('Library', 'Preferences', 'com.apple.security.plist'), type: 'file' as const },
  ]
  for (const entry of entries) {
    const source = join(home, entry.path)
    const exists = await lstat(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!exists) continue
    const target = join(rootDir, entry.path)
    await mkdir(dirname(target), { recursive: true })
    await symlink(source, target, entry.type).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
  }
}
