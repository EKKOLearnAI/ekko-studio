/**
 * Broker descriptor file (spec-05 acceptance 23 + Decisions 1).
 *
 * The MCP layer only ever reads `<webUiHome>/desktop-browser/broker.json`
 * (`bin/hermes-studio-mcp.mjs`), and validates `(mode & 0o077) === 0` on both
 * the file and the directory, so this module owns the permissions as well as
 * the "never overwrite a live foreign host" rule.
 *
 * Desktop mode (`HERMES_DESKTOP=true`) means Electron owns the file: the server
 * never writes, never deletes and never overwrites it.
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { chmodSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { getWebUiHome } from '../../public/config'
import { isDesktopSurfaceHost } from '../../public/browser-surface'
import { isProcessAlive } from './broker-lease'

export const BROKER_DESCRIPTOR_DIR = 'desktop-browser'
export const BROKER_DESCRIPTOR_FILE = 'broker.json'
export const BROKER_DESCRIPTOR_SCHEMA = 1

export interface BrowserBrokerDescriptorFile {
  schema: 1
  protocol: 'http:'
  endpoint: string
  token: string
  desktopPid: number
  instanceId: string
  createdAt: string
}

export type BrokerDescriptorWriteResult =
  | 'written'
  | 'desktop-mode'
  | 'foreign-owner'

export interface BrokerDescriptorOptions {
  /** Overridable for tests; defaults to `getWebUiHome()`. */
  webUiHome?: string
  /** `HERMES_DESKTOP === 'true'`. */
  desktopMode?: boolean
  warn?: (message: string) => void
}

export function brokerDescriptorDir(options: BrokerDescriptorOptions = {}): string {
  const home = options.webUiHome ?? getWebUiHome()
  return join(home, BROKER_DESCRIPTOR_DIR)
}

export function brokerDescriptorPath(options: BrokerDescriptorOptions = {}): string {
  return join(brokerDescriptorDir(options), BROKER_DESCRIPTOR_FILE)
}

export function readBrokerDescriptorSync(path: string): BrowserBrokerDescriptorFile | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as BrowserBrokerDescriptorFile
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

/** Synchronously reserve the owner-only directory (MCP checks its mode). */
export function ensureBrokerDescriptorDirSync(dir: string, platform: NodeJS.Platform = process.platform): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (platform === 'win32') return
  try {
    chmodSync(dir, 0o700)
  } catch {
    // A filesystem without POSIX modes (exFAT/NTFS mounts) is reported by the MCP side.
  }
}

/**
 * Write the descriptor, honouring the takeover rules. Returns why it did not
 * write instead of throwing, so startup can continue without a browser surface.
 */
export async function writeBrokerDescriptor(
  descriptor: BrowserBrokerDescriptorFile,
  options: BrokerDescriptorOptions = {},
): Promise<BrokerDescriptorWriteResult> {
  if (options.desktopMode ?? isDesktopSurfaceHost()) return 'desktop-mode'

  const path = brokerDescriptorPath(options)
  const dir = dirname(path)
  ensureBrokerDescriptorDirSync(dir)

  const existing = readBrokerDescriptorSync(path)
  if (
    existing
    && existing.desktopPid !== process.pid
    && isProcessAlive(existing.desktopPid)
  ) {
    const warn = options.warn ?? ((message: string) => console.warn(message))
    warn(
      '[browser-broker] another host owns the browser broker descriptor '
      + `(pid ${existing.desktopPid}); not overwriting it`,
    )
    return 'foreign-owner'
  }

  const tempPath = `${path}.${process.pid}.tmp`
  await writeFile(tempPath, JSON.stringify(descriptor, null, 2), { mode: 0o600 })
  if (process.platform !== 'win32') await chmod(tempPath, 0o600).catch(() => undefined)
  await rename(tempPath, path)

  return 'written'
}

/** Delete the descriptor only when this process wrote that exact instance. */
export async function removeOwnedBrokerDescriptor(
  instanceId: string,
  options: BrokerDescriptorOptions = {},
): Promise<boolean> {
  if (options.desktopMode ?? isDesktopSurfaceHost()) return false
  const path = brokerDescriptorPath(options)
  const existing = readBrokerDescriptorSync(path)
  if (!existing || existing.instanceId !== instanceId) return false
  await rm(path, { force: true }).catch(() => undefined)
  return true
}

/** Directory + file modes, for tests and diagnostics. */
export async function readBrokerDescriptorModes(
  options: BrokerDescriptorOptions = {},
): Promise<{ dir: number, file: number } | null> {
  const { statSync } = await import('fs')
  try {
    const dir = statSync(brokerDescriptorDir(options)).mode & 0o777
    const file = statSync(brokerDescriptorPath(options)).mode & 0o777
    return { dir, file }
  } catch {
    return null
  }
}

/** Used by tests to create the directory with the production helper. */
export async function ensureBrokerDescriptorDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(dirname(path), 0o700).catch(() => undefined)
}

export async function readBrokerDescriptorFile(path: string): Promise<BrowserBrokerDescriptorFile | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as BrowserBrokerDescriptorFile
  } catch {
    return null
  }
}
