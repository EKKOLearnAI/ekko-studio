/**
 * Knowledge plugin — USB on-demand scanner (task-12, v0.8.9).
 *
 * Turns a mounted USB volume into a `kind='usb'` vault scanned FTS5-only
 * (the ingest kind branch in knowledge.service.ts routes usb → ftsOnlyIngest,
 * so vec0 is never populated for removable drives). Reference-based: the
 * source files stay on the stick; only extracted text rows live in the DB,
 * so unmounting just flips document status to 'unmounted' (search-invisible)
 * and re-mounting flips it back to 'fts_only' without re-extraction.
 *
 * Mounts are discovered under $HERMES_WEB_UI_HOME/mnt/usb/<uuid> (the same
 * tree the USB module manages), enumerated via dir-browser's helpers so the
 * two features agree on what "mounted" means.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { getWebUiHome } from '../../public/config'
import {
  KnowledgeService,
  VaultPathInUseError,
  type KnowledgeVaultKind,
} from './knowledge.service'

export interface UsbVolume {
  uuid: string
  label: string
  mountPath: string
}

/** Cap a single scan so one stick can't flood the bounded ingest queue. */
const MAX_FILES_PER_SCAN = 2000

/** Enumerate currently-mounted USB volumes. */
export function listUsbVolumes(
  env: NodeJS.ProcessEnv = process.env,
  homeRoot: string = getWebUiHome(env),
): UsbVolume[] {
  const usbRoot = join(homeRoot, 'mnt', 'usb')
  if (!existsSync(usbRoot)) return []
  let names: string[]
  try { names = readdirSync(usbRoot) } catch { return [] }
  const volumes: UsbVolume[] = []
  for (const uuid of names) {
    const mountPath = join(usbRoot, uuid)
    try {
      if (statSync(mountPath).isDirectory()) volumes.push({ uuid, label: uuid, mountPath })
    } catch { /* race; skip */ }
  }
  return volumes
}

/** Walk a mounted volume for files matching the supported extensions. */
function collectIngestableFiles(dir: string, supported: string[]): string[] {
  const out: string[] = []
  const stack = [dir]
  while (stack.length && out.length < MAX_FILES_PER_SCAN) {
    const current = stack.pop()!
    let entries: string[]
    try { entries = readdirSync(current) } catch { continue }
    for (const name of entries) {
      if (name.startsWith('.')) continue
      const full = join(current, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) { stack.push(full); continue }
      const ext = extname(name).toLowerCase()
      if (ext && supported.includes(ext)) out.push(full)
    }
  }
  return out
}

export interface ScanResult {
  vaultId: number
  status: 'scanning'
  documentsQueued: number
  reused: boolean
}

/**
 * Create (or reuse) a `kind='usb'` vault for a mounted volume and enqueue
 * every in-place supported file for FTS-only ingest. Returns synchronously
 * after queueing; the single-writer worker does the extraction.
 */
export function scanUsbVolume(
  service: KnowledgeService,
  volume: UsbVolume,
  supportedExtensions: string[],
): ScanResult {
  if (!existsSync(volume.mountPath)) {
    throw new Error('usb_not_mounted')
  }

  let vault = service.findVaultByPath(volume.mountPath)
  let reused = true
  if (!vault) {
    try {
      vault = service.addVault(volume.mountPath, volume.label || volume.uuid, 'usb')
      reused = false
    } catch (err) {
      if (err instanceof VaultPathInUseError) {
        vault = service.findVaultByPath(volume.mountPath)!
        reused = true
      } else {
        throw err
      }
    }
  }

  const files = collectIngestableFiles(volume.mountPath, supportedExtensions)
  let queued = 0
  for (const file of files) {
    // Queue; if the bounded queue is full we stop early rather than throw
    // (partial scan is fine — the watcher covers later changes).
    try {
      void service.ingest(file, vault.id)
      queued += 1
    } catch {
      break
    }
  }

  return { vaultId: vault.id, status: 'scanning', documentsQueued: queued, reused }
}

/**
 * Reconcile USB vaults against the live mount set (run at startup and on
 * each listUsbVolumes poll). Gone → 'unmounted'; back → 'fts_only'. Chunk
 * content persists across both, so re-mount needs no re-extraction.
 */
export function reconcileUsbMounts(
  service: KnowledgeService,
  env: NodeJS.ProcessEnv = process.env,
  homeRoot: string = getWebUiHome(env),
): { demoted: number; restored: number } {
  const usbVaults = service.listVaults().filter(v => v.kind === 'usb')
  let demoted = 0
  let restored = 0
  for (const vault of usbVaults) {
    const mounted = existsSync(vault.root_path)
    if (!mounted) {
      demoted += service.markUsbVaultUnmounted(vault.id, 'unmounted')
    } else {
      restored += service.markUsbVaultUnmounted(vault.id, 'fts_only')
    }
  }
  return { demoted, restored }
}

export type { KnowledgeVaultKind }
