import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../../public/config'
import type { AgentReasoning } from '../../../../../../ekko-agent/src/model/types'
import { ModelApiError } from './errors'

const PREFIX = 'ekko_r1.'
let secret: Promise<Buffer> | undefined

async function loadSecret(): Promise<Buffer> {
  const path = join(config.appHome, 'model-api-reasoning.key')
  await mkdir(config.appHome, { recursive: true })
  try { await writeFile(path, randomBytes(32), { flag: 'wx', mode: 0o600 }) }
  catch (error: any) { if (error.code !== 'EEXIST') throw error }
  const key = await readFile(path)
  if (key.length !== 32) throw new Error('Invalid model API reasoning key')
  return key
}

/** Stateless replay preserves vendor signatures without exposing or trusting caller-supplied native data. */
export async function reasoningCodec(scope: string) {
  secret ||= loadSecret().catch(error => { secret = undefined; throw error })
  const key = await secret
  return {
    encode(reasoning: AgentReasoning): string {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const data = Buffer.concat([cipher.update(JSON.stringify({ scope, reasoning })), cipher.final()])
      return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url')
    },
    decode(value: unknown): AgentReasoning | undefined {
      if (typeof value !== 'string' || !value.startsWith(PREFIX)) return undefined
      try {
        const bytes = Buffer.from(value.slice(PREFIX.length), 'base64url')
        const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
        cipher.setAuthTag(bytes.subarray(12, 28))
        const data = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString())
        return data.scope === scope ? data.reasoning : undefined
      } catch { throw new ModelApiError('Invalid reasoning encrypted_content.', 400, 'input') }
    },
  }
}

export type ReasoningCodec = Awaited<ReturnType<typeof reasoningCodec>>
