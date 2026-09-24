import { createDecipheriv } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../../public/config'

export function decryptPushSecret(value: string): string {
  const [version, iv, tag, data] = value.split('.')
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('push_secret_invalid')
  const key = readFileSync(join(config.appHome, '.push-token-key'))
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8')
}
