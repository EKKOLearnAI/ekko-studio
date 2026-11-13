/**
 * Knowledge plugin — directory browser (task-12, v0.8.9).
 *
 * Backs the "添加知识库" visual directory picker so users never have to
 * type a filesystem path by hand (the UX defect that motivated this
 * task). It reuses the USB explorer's listing shape but enforces a
 * closed allowlist of browsable roots: browsing the whole filesystem
 * from a web-served endpoint would be a directory-traversal disclosure,
 * so anything outside the allowlist is refused with a typed 403.
 *
 * Allowlist (spec § "Directory picker backend", binding):
 *   - $HERMES_WEB_UI_HOME (via getWebUiHome — never process.env directly)
 *   - $HERMES_WEB_UI_HOME/mnt/usb/<uuid> for every mounted USB
 *   - /tmp, /data, /sdcard, /mnt — each probed with existsSync, silently
 *     skipped when absent
 * Expanding this list is a spec change, not a code change (AGENTS.md).
 */

import { readdirSync, statSync, existsSync, realpathSync } from 'node:fs'
import { join, resolve, dirname, sep } from 'node:path'
import { getWebUiHome } from '../../public/config'

export class ForbiddenPathError extends Error {
  readonly code = 'forbidden_path'
  constructor(message: string) {
    super(message)
    this.name = 'ForbiddenPathError'
  }
}

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
  sizeBytes: number | null
  modifiedAt: number | null
  inAllowlist: boolean
}

export interface DirListing {
  path: string
  parent: string | null
  entries: DirEntry[]
}

export interface HomeRoot {
  name: string
  path: string
  exists: boolean
}

export interface UsbDrive {
  uuid: string
  label: string
  mountPath: string
  sizeBytes: number | null
  freeBytes: number | null
}

interface DirBrowserFs {
  exists: (p: string) => boolean
  realpath: (p: string) => string
  readdir: (p: string) => string[]
  stat: (p: string) => { isDirectory(): boolean; size: number; mtimeMs: number }
}

export interface ListDirsOptions {
  homeRoot?: string
  usbRoots?: UsbDrive[]
  includeHidden?: boolean
  /** Injectable for tests; defaults to the real fs probes. */
  fs?: DirBrowserFs
}

const EXTRA_ROOTS = ['/tmp', '/data', '/sdcard', '/mnt']

function defaultFs(): DirBrowserFs {
  return {
    exists: (p: string) => existsSync(p),
    realpath: (p: string) => {
      try { return realpathSync(p) } catch { return resolve(p) }
    },
    readdir: (p: string) => readdirSync(p) as unknown as string[],
    stat: (p: string) => statSync(p),
  }
}

/**
 * The set of allowed roots (realpath-resolved). The USB mounts and the
 * home root are provided by the caller (they are device-state dependent)
 * so the pure resolver stays testable.
 */
export function allowedRoots(
  env: NodeJS.ProcessEnv = process.env,
  opts: Pick<ListDirsOptions, 'homeRoot' | 'usbRoots' | 'fs'> = {},
): string[] {
  const fsx = opts.fs ?? defaultFs()
  // No native `resolve()` here: it would re-root POSIX device paths onto
  // a Windows drive letter when the suite runs on a dev workstation. The
  // home root is already canonical (getWebUiHome resolves on-device) and
  // fsx.realpath is the single normalization point.
  const home = opts.homeRoot ?? getWebUiHome(env)
  const roots = new Set<string>([fsx.realpath(home)])
  for (const drive of opts.usbRoots ?? []) {
    if (fsx.exists(drive.mountPath)) roots.add(fsx.realpath(drive.mountPath))
  }
  for (const extra of EXTRA_ROOTS) {
    if (fsx.exists(extra)) roots.add(fsx.realpath(extra))
  }
  return [...roots]
}

function isWithin(path: string, root: string): boolean {
  const norm = (p: string) => (p === sep ? p : p.endsWith(sep) ? p.slice(0, -1) : p)
  const npath = norm(path)
  const nroot = norm(root)
  return npath === nroot || npath.startsWith(nroot + sep)
}

/**
 * Resolve a requested absolute path to a safe browsable path. Throws
 * ForbiddenPathError (→ 403) on traversal (`..`), symlink escape, or a
 * path outside the allowlist.
 */
export function assertAllowed(
  requested: string,
  roots: string[],
  fsx = defaultFs(),
): string {
  if (!requested || !requested.startsWith('/')) {
    // relative or empty → resolve against nothing; treat as forbidden.
    throw new ForbiddenPathError('path must be absolute')
  }
  if (requested.split('/').includes('..')) {
    throw new ForbiddenPathError('path traversal is not allowed')
  }
  // Already validated as absolute with no '..' segments; normalize only
  // through the (injectable) realpath, never native resolve().
  const resolved = requested
  if (!fsx.exists(resolved)) {
    throw new ForbiddenPathError(`path does not exist: ${resolved}`)
  }
  const real = fsx.realpath(resolved)
  const ok = roots.some(root => isWithin(real, root))
  if (!ok) {
    throw new ForbiddenPathError(`path outside allowlist: ${real}`)
  }
  const st = fsx.stat(real)
  if (!st.isDirectory()) {
    throw new ForbiddenPathError(`not a directory: ${real}`)
  }
  return real
}

export function listDirs(
  requested: string,
  opts: ListDirsOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): DirListing {
  const fsx = opts.fs ?? defaultFs()
  const roots = allowedRoots(env, opts)
  const dir = assertAllowed(requested, roots, fsx)
  const names = fsx.readdir(dir)
  const entries: DirEntry[] = []
  for (const name of names) {
    if (!opts.includeHidden && name.startsWith('.')) continue
    const childPath = join(dir, name)
    let st
    try { st = fsx.stat(childPath) } catch { continue }
    entries.push({
      name,
      path: childPath,
      isDir: st.isDirectory(),
      sizeBytes: st.isDirectory() ? null : st.size,
      modifiedAt: st.mtimeMs ? Math.round(st.mtimeMs) : null,
      inAllowlist: true,
    })
  }
  // Folders first, then by name — matches the USB explorer ordering.
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
  const parent = dirname(dir)
  const parentAllowed = roots.some(root => isWithin(fsx.realpath(parent), root))
  return { path: dir, parent: parentAllowed ? parent : null, entries }
}
