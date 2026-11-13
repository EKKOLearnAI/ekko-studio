export const MAX_DOWNLOAD_SIZE = parseInt(process.env.MAX_DOWNLOAD_SIZE || '', 10) || 200 * 1024 * 1024
export const MAX_EDIT_SIZE = parseInt(process.env.MAX_EDIT_SIZE || '', 10) || 10 * 1024 * 1024

const SENSITIVE_FILES = new Set(['.env', 'auth.json'])

export function isSensitivePath(relativePath: string): boolean {
  const parts = relativePath.replace(/\\/g, '/').split('/')
  const fileName = parts[parts.length - 1]
  return SENSITIVE_FILES.has(fileName)
}
