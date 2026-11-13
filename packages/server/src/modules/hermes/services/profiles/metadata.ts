import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getWebUiHome } from '../../../studio/public/config'

export interface ProfileMeta {
  displayName?: string
}

export type ProfileAvatarMeta =
  | { type: 'generated'; seed?: string; updatedAt?: number }
  | { type: 'image'; file: string; mime: string; updatedAt?: number }
  | { type: 'remote'; url: string; updatedAt?: number }

function profileMetadataRoot(): string {
  return join(getWebUiHome(), 'profile-metadata')
}

export function profileMetadataDir(name: string): string {
  const segment = Buffer.from(name || 'default', 'utf-8').toString('base64url')
  return join(profileMetadataRoot(), segment)
}

function profileMetaPath(name: string): string {
  return join(profileMetadataDir(name), 'meta.json')
}

function profileAvatarMetaPath(name: string): string {
  return join(profileMetadataDir(name), 'avatar.json')
}

export function readProfileMeta(name: string): ProfileMeta {
  const metaPath = profileMetaPath(name)
  if (!existsSync(metaPath)) return {}
  try {
    return JSON.parse(readFileSync(metaPath, 'utf-8'))
  } catch {
    return {}
  }
}

function writeProfileMeta(name: string, meta: ProfileMeta): void {
  const dir = profileMetadataDir(name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(profileMetaPath(name), JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 })
}

/**
 * Set the user-visible display name for a profile (Web UI metadata only,
 * does not touch the underlying Hermes profile directory).
 */
export function setProfileDisplayName(name: string, displayName: string): void {
  const value = String(displayName || '').trim()
  if (!value) return
  const existing = readProfileMeta(name)
  if (existing.displayName === value) return
  writeProfileMeta(name, { ...existing, displayName: value })
}

/**
 * Clear the display name for a profile, restoring the system name as the
 * visible label. Keeps avatar metadata intact.
 */
export function clearProfileDisplayName(name: string): void {
  const existing = readProfileMeta(name)
  if (!existing.displayName) return
  const { displayName: _removed, ...rest } = existing
  writeProfileMeta(name, rest)
}

export function readProfileAvatarMeta(name: string): ProfileAvatarMeta | null {
  const metaPath = profileAvatarMetaPath(name)
  if (!existsSync(metaPath)) return null
  try {
    return JSON.parse(readFileSync(metaPath, 'utf-8'))
  } catch {
    return null
  }
}

function writeProfileAvatar(name: string, meta: ProfileAvatarMeta): void {
  const dir = profileMetadataDir(name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(profileAvatarMetaPath(name), JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 })
}

/**
 * Store a remote avatar URL (e.g. a WeChat avatar) for a profile. Rendered as
 * a plain <img>, so no local download is needed.
 */
export function setProfileAvatarRemote(name: string, url: string): void {
  const value = String(url || '').trim()
  if (!value) return
  writeProfileAvatar(name, { type: 'remote', url: value, updatedAt: Date.now() })
}

/**
 * Store a generated (multiavatar) avatar seeded from the display name.
 */
export function setProfileAvatarGenerated(name: string, seed: string): void {
  writeProfileAvatar(name, { type: 'generated', seed: seed || name || 'default', updatedAt: Date.now() })
}

/**
 * Clear the Web-UI display name and avatar for a profile, restoring the
 * underlying profile's original identity. Used when a WeChat account unbinds
 * from the super administrator.
 */
export function clearProfileIdentity(name: string): void {
  const dir = profileMetadataDir(name)
  const metaPath = profileMetaPath(name)
  const avatarPath = profileAvatarMetaPath(name)
  if (existsSync(metaPath)) rmSync(metaPath, { force: true })
  if (existsSync(avatarPath)) rmSync(avatarPath, { force: true })
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  } catch { }
}
