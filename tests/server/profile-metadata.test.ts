import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'

const tempRoot = mkdtempSync(join(tmpdir(), 'profile-meta-test-'))

vi.mock('../../packages/server/src/modules/studio/public/config', () => ({
  getWebUiHome: () => tempRoot,
}))

import {
  readProfileMeta,
  setProfileDisplayName,
  clearProfileDisplayName,
  readProfileAvatarMeta,
  setProfileAvatarRemote,
  setProfileAvatarGenerated,
  profileMetadataDir,
} from '../../packages/server/src/modules/hermes/services/profiles/metadata'

describe('profile-metadata service', () => {
  beforeEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  it('stores and reads a displayName for a profile', () => {
    setProfileDisplayName('default', 'Existentialist')
    expect(readProfileMeta('default').displayName).toBe('Existentialist')
  })

  it('ignores empty display names', () => {
    setProfileDisplayName('default', '')
    expect(readProfileMeta('default').displayName).toBeUndefined()
    expect(existsSync(join(profileMetadataDir('default'), 'meta.json'))).toBe(false)
  })

  it('clears an existing display name while keeping avatar metadata', () => {
    setProfileDisplayName('default', 'Existentialist')
    setProfileAvatarRemote('default', 'https://thirdwx.qlogo.cn/avatar.png')
    clearProfileDisplayName('default')
    expect(readProfileMeta('default').displayName).toBeUndefined()
    expect(readProfileAvatarMeta('default')?.type).toBe('remote')
  })

  it('clearProfileDisplayName is a no-op when no display name is set', () => {
    clearProfileDisplayName('default')
    expect(existsSync(join(profileMetadataDir('default'), 'meta.json'))).toBe(false)
  })

  it('stores a remote avatar URL', () => {
    setProfileAvatarRemote('default', 'https://thirdwx.qlogo.cn/avatar.png')
    const meta = readProfileAvatarMeta('default')
    expect(meta?.type).toBe('remote')
    expect(meta && 'url' in meta ? meta.url : '').toBe('https://thirdwx.qlogo.cn/avatar.png')
  })

  it('stores a generated avatar seed', () => {
    setProfileAvatarGenerated('default', 'Existentialist')
    const meta = readProfileAvatarMeta('default')
    expect(meta?.type).toBe('generated')
    expect(meta && 'seed' in meta ? meta.seed : '').toBe('Existentialist')
  })

  it('writes JSON metadata files to the web-ui home', () => {
    setProfileDisplayName('default', 'User One')
    const metaPath = join(profileMetadataDir('default'), 'meta.json')
    expect(existsSync(metaPath)).toBe(true)
    const raw = JSON.parse(readFileSync(metaPath, 'utf-8'))
    expect(raw.displayName).toBe('User One')
  })
})
