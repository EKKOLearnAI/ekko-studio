import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { getWebUiHome } from '../../../studio/public/config'
import { logger } from '../../../studio/public/logging'
import { createAppImagePreview } from '../../../studio/public/workspace-files'

const APP_PROFILE_AVATAR_MAX_EDGE = 128
const APP_PROFILE_AVATAR_WEBP_QUALITY = 65

interface ProfileAvatarMeta {
  type: 'generated' | 'image'
  seed?: string
  file?: string
  mime?: string
  updatedAt?: number
}

export interface AppProfileAvatar {
  type: 'generated' | 'image'
  seed?: string
  dataUrl?: string
  updatedAt?: number
}

interface CachedAppProfileAvatar {
  signature: string
  avatar: AppProfileAvatar
}

const avatarCache = new Map<string, CachedAppProfileAvatar>()
const pendingAvatars = new Map<string, Promise<AppProfileAvatar | null>>()

function profileMetadataDir(name: string): string {
  const segment = Buffer.from(name || 'default', 'utf-8').toString('base64url')
  return join(getWebUiHome(), 'profile-metadata', segment)
}

function profileAvatarMetaPath(name: string): string {
  return join(profileMetadataDir(name), 'avatar.json')
}

export async function readAppProfileAvatar(name: string): Promise<AppProfileAvatar | null> {
  const metaPath = profileAvatarMetaPath(name)
  if (!existsSync(metaPath)) return null

  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as ProfileAvatarMeta
    if (meta.type === 'generated') {
      return {
        type: 'generated',
        seed: typeof meta.seed === 'string' ? meta.seed : name,
        updatedAt: meta.updatedAt,
      }
    }
    if (meta.type !== 'image' || !meta.file || !meta.mime || !meta.mime.startsWith('image/')) return null

    const imagePath = join(profileMetadataDir(name), meta.file)
    if (!existsSync(imagePath)) return null
    const imageStat = statSync(imagePath)
    const signature = [imagePath, meta.mime, meta.updatedAt || 0, imageStat.size, imageStat.mtimeMs].join(':')
    const cached = avatarCache.get(name)
    if (cached?.signature === signature) return cached.avatar

    const pendingKey = `${name}:${signature}`
    const existing = pendingAvatars.get(pendingKey)
    if (existing) return existing

    const pending = (async () => {
      const original = readFileSync(imagePath)
      const preview = await createAppImagePreview(original, meta.mime!, {
        maxEdge: APP_PROFILE_AVATAR_MAX_EDGE,
        quality: APP_PROFILE_AVATAR_WEBP_QUALITY,
        preserveAnimation: false,
      })
      const avatar: AppProfileAvatar = {
        type: 'image',
        dataUrl: `data:${preview.mime};base64,${preview.data.toString('base64')}`,
        updatedAt: meta.updatedAt,
      }
      avatarCache.set(name, { signature, avatar })
      return avatar
    })()
    pendingAvatars.set(pendingKey, pending)
    try {
      return await pending
    } finally {
      pendingAvatars.delete(pendingKey)
    }
  } catch (err) {
    logger.warn(err, '[app-profiles] failed to build App avatar for profile "%s"', name)
    return null
  }
}
