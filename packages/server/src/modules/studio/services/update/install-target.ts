import { posix, win32 } from 'path'

/**
 * Global npm prefix that reinstalls into the directory the running process was started from.
 *
 * The updater resolves npm from `process.execPath`, and that npm's global prefix is not
 * guaranteed to be the prefix the Studio package lives in. Example: node runs from
 * `/usr/bin/node`, so the bundled npm has prefix `/usr`, while the package itself was installed
 * by another npm into `/usr/local/lib/node_modules`. `npm install -g` then writes into the wrong
 * tree, the update reports success, and the launcher keeps booting the old version.
 * Pinning `--prefix` to the running installation keeps both in sync.
 *
 * Returns null when the package does not look like a global install (source checkout, local
 * dependency), so callers keep their previous behaviour.
 */
export function resolveGlobalInstallPrefix(
  packageRoot: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const path = platform === 'win32' ? win32 : posix
  const nodeModulesDir = path.dirname(packageRoot)
  if (path.basename(nodeModulesDir) !== 'node_modules') return null
  if (platform === 'win32') return path.dirname(nodeModulesDir)
  // POSIX globals live in `<prefix>/lib/node_modules`; only claim a prefix when the layout matches.
  if (path.basename(path.dirname(nodeModulesDir)) !== 'lib') return null
  return path.dirname(path.dirname(nodeModulesDir))
}
