import { randomBytes } from 'crypto'
import { mkdir, readFile, rename, rm, unlink, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import { MAX_THEME_BACKGROUND_BYTES } from '../../../../../../shared/theme-archive'
import { config } from '../../public/config'
import {
  assertActiveTheme,
  getThemePreset,
  isThemeBackgroundReferenced,
  deleteThemePreset as deletePresetRecord,
  clearUserThemeBackground,
  getUserTheme,
  saveUserTheme,
  saveUserThemeBackground,
  toUserThemePayload,
  UserThemeValidationError,
  type UserThemeRecord,
} from '../../repositories/user-theme-store'

export {
  getUserTheme,
  saveUserTheme,
  toUserThemePayload,
  UserThemeValidationError,
}

const THEME_ASSET_ROOT = join(config.appHome, 'theme-backgrounds')

const IMAGE_TYPES = {
  jpeg: { mime: 'image/jpeg', extension: '.jpg' },
  png: { mime: 'image/png', extension: '.png' },
  webp: { mime: 'image/webp', extension: '.webp' },
  gif: { mime: 'image/gif', extension: '.gif' },
} as const

export class ThemeBackgroundValidationError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message)
  }
}

function normalizeUserId(value: unknown): number {
  const userId = Number(value)
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new ThemeBackgroundValidationError('Invalid user')
  }
  return userId
}

function detectImageType(data: Buffer): typeof IMAGE_TYPES[keyof typeof IMAGE_TYPES] | null {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return IMAGE_TYPES.png
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return IMAGE_TYPES.jpeg
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return IMAGE_TYPES.webp
  }
  if (
    data.length >= 6 &&
    ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))
  ) {
    return IMAGE_TYPES.gif
  }
  return null
}

function userThemeDirectory(userId: number): string {
  return join(THEME_ASSET_ROOT, String(userId))
}

function storedBackgroundPath(userId: number, filename: string): string {
  if (!/^[a-f0-9]{32}\.(?:jpg|png|webp|gif)$/.test(filename)) {
    throw new Error('Invalid stored theme background filename')
  }
  return join(userThemeDirectory(userId), filename)
}

export function sanitizeThemeBackgroundName(value: string): string {
  const name = basename(value.replaceAll('\\', '/')).trim()
  return (name || 'background').slice(0, 255)
}

export async function stageThemeBackground(
  userIdValue: unknown,
  originalName: string,
  data: Buffer,
) {
  const userId = normalizeUserId(userIdValue)
  if (!data.length) throw new ThemeBackgroundValidationError('Background image is empty')
  if (data.length > MAX_THEME_BACKGROUND_BYTES) {
    throw new ThemeBackgroundValidationError('Background image exceeds the 30 MB limit', 413)
  }
  const imageType = detectImageType(data)
  if (!imageType) {
    throw new ThemeBackgroundValidationError('Use a PNG, JPEG, WebP, or GIF image', 415)
  }

  const directory = userThemeDirectory(userId)
  const filename = `${randomBytes(16).toString('hex')}${imageType.extension}`
  const finalPath = storedBackgroundPath(userId, filename)
  const temporaryPath = join(directory, `.${filename}.tmp`)
  await mkdir(directory, { recursive: true })
  try {
    // Keep the original bytes so animated backgrounds retain frames and timing.
    await writeFile(temporaryPath, data, { mode: 0o600, flag: 'wx' })
    await rename(temporaryPath, finalPath)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
  return {
    background: { filename, originalName: sanitizeThemeBackgroundName(originalName), mime: imageType.mime },
    discard: () => unlink(finalPath).catch(() => undefined),
  }
}

export async function replaceThemeBackground(
  userIdValue: unknown,
  originalName: string,
  data: Buffer,
  expectedId?: unknown,
): Promise<UserThemeRecord> {
  const userId = normalizeUserId(userIdValue)
  assertActiveTheme(userId, expectedId)
  const current = getUserTheme(userId)
  const targetId = current.activePresetId
  const staged = await stageThemeBackground(userId, originalName, data)

  try {
    const saved = saveUserThemeBackground(userId, staged.background, targetId)
    if (current.backgroundFilename && current.backgroundFilename !== staged.background.filename) {
      await removeUnusedBackground(userId, current.backgroundFilename)
    }
    return saved
  } catch (error) {
    await staged.discard()
    throw error
  }
}

export async function readThemeBackground(userIdValue: unknown, presetId?: unknown): Promise<{
  data: Buffer
  mime: string
  updatedAt: number
} | null> {
  const userId = normalizeUserId(userIdValue)
  const theme = presetId === undefined ? getUserTheme(userId) : getThemePreset(userId, presetId)
  if (!theme.backgroundFilename || !theme.backgroundMime) return null
  try {
    return {
      data: await readFile(storedBackgroundPath(userId, theme.backgroundFilename)),
      mime: theme.backgroundMime,
      updatedAt: theme.backgroundUpdatedAt,
    }
  } catch {
    return null
  }
}

export async function removeThemeBackground(userIdValue: unknown, expectedId?: unknown): Promise<UserThemeRecord> {
  const userId = normalizeUserId(userIdValue)
  const current = getUserTheme(userId)
  const saved = clearUserThemeBackground(userId, expectedId)
  if (current.backgroundFilename) {
    await removeUnusedBackground(userId, current.backgroundFilename)
  }
  return saved
}

export async function removeAllUserThemeAssets(userIdValue: unknown): Promise<void> {
  const userId = normalizeUserId(userIdValue)
  await rm(userThemeDirectory(userId), { recursive: true, force: true })
}

async function removeUnusedBackground(userId: number, filename: string) {
  if (!isThemeBackgroundReferenced(userId, filename)) {
    await unlink(storedBackgroundPath(userId, filename)).catch(() => undefined)
  }
}

export async function deleteThemePreset(userId: number, id: unknown) {
  const { removed, ...result } = deletePresetRecord(userId, id)
  if (removed.backgroundFilename) await removeUnusedBackground(userId, removed.backgroundFilename)
  return result
}

export { listThemePresets, createThemePreset, renameThemePreset, activateThemePreset } from '../../repositories/user-theme-store'
