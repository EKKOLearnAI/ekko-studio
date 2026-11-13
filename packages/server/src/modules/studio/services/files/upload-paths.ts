import { join, resolve } from 'path'
import { config } from '../../public/config'
import { isPathWithin } from './path'

function safeProfileSegment(profile: string): string {
  const name = (profile || 'default').trim() || 'default'
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw Object.assign(new Error('Invalid profile name'), { code: 'invalid_profile' })
  }
  return name
}

export function getProfileUploadDir(profile: string): string {
  return resolve(join(config.uploadDir, safeProfileSegment(profile)))
}

export function isInProfileUploadDir(filePath: string, profile: string): boolean {
  return isPathWithin(filePath, getProfileUploadDir(profile))
}
