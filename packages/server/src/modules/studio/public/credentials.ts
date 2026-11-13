import { readFile, writeFile, mkdir, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { scryptSync, randomBytes } from 'node:crypto'
import { config } from './config'

const APP_HOME = config.appHome
const CREDENTIALS_FILE = join(APP_HOME, '.credentials')

export interface Credentials {
  username: string
  password_hash: string
  salt: string
  created_at: number
}

const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64, SCRYPT_OPTIONS).toString('hex')
}

export async function getCredentials(): Promise<Credentials | null> {
  try {
    const data = await readFile(CREDENTIALS_FILE, 'utf-8')
    return JSON.parse(data)
  } catch {
    return null
  }
}

export async function setCredentials(username: string, password: string): Promise<Credentials> {
  const salt = randomBytes(16).toString('hex')
  const password_hash = hashPassword(password, salt)
  const cred: Credentials = { username, password_hash, salt, created_at: Date.now() }
  await mkdir(APP_HOME, { recursive: true })
  await writeFile(CREDENTIALS_FILE, JSON.stringify(cred, null, 2), { mode: 0o600 })
  return cred
}

export async function deleteCredentials(): Promise<void> {
  try {
    await unlink(CREDENTIALS_FILE)
  } catch {
    // File may not exist
  }
}

export async function verifyCredentials(username: string, password: string): Promise<boolean> {
  const cred = await getCredentials()
  if (!cred) return false
  if (cred.username !== username) return false
  const computed = hashPassword(password, cred.salt)
  return computed === cred.password_hash
}

export function credentialsFileExists(): boolean {
  return existsSync(CREDENTIALS_FILE)
}
