import { mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getWebUiHome } from '../../public/config'
import { issueModelRunJwt, type AuthenticatedUser } from '../../public/auth'

const MODEL_RUN_TOKEN_FILE = '.model-run-token'

function normalizeProfileSegment(profile: string): string {
  const sanitized = String(profile || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'default'
  if (sanitized === '.' || sanitized === '..' || sanitized.length > 128) {
    const err = new Error('Invalid profile')
    ;(err as any).status = 400
    throw err
  }
  return sanitized
}

export function modelRunProfileTokenPath(profile: string): string {
  return join(getWebUiHome(), 'profiles', normalizeProfileSegment(profile), MODEL_RUN_TOKEN_FILE)
}

export async function writeModelRunProfileToken(user: AuthenticatedUser | undefined, profile: string): Promise<void> {
  if (!user) return
  const token = await issueModelRunJwt(user)
  const tokenPath = modelRunProfileTokenPath(profile)
  const mkdirOptions: any = { recursive: true }
  const writeOptions: any = {}
  if (process.platform !== 'win32') {
    mkdirOptions.mode = 0o700
    writeOptions.mode = 0o600
  }
  await mkdir(dirname(tokenPath), mkdirOptions)
  await writeFile(tokenPath, `${token}\n`, writeOptions)
}
