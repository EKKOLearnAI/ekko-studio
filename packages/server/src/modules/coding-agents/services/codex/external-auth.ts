import { chmod, mkdir, open, rename, rm } from 'fs/promises'
import { randomUUID } from 'crypto'
import { dirname, join } from 'path'

type JsonRecord = Record<string, unknown>

function objectValue(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function decodeJwtClaims(token: string): JsonRecord {
  const parts = token.split('.')
  if (parts.length !== 3) return {}
  try {
    return objectValue(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')))
  } catch {
    return {}
  }
}

function chatgptAccountId(accessToken: string): string {
  const claims = decodeJwtClaims(accessToken)
  const auth = objectValue(claims['https://api.openai.com/auth'])
  const accountId = String(auth.chatgpt_account_id || '').trim()
  if (!accountId) throw new Error('Studio Codex OAuth token has no ChatGPT account id')
  return accountId
}

export function codexExternalAuthDocument(accessToken: string, now = Date.now()): JsonRecord {
  const token = accessToken.trim()
  if (!token) throw new Error('Studio Codex OAuth token is empty')
  const accountId = chatgptAccountId(token)
  return {
    // Codex must not refresh these tokens itself. Studio resolves and replaces
    // the externally managed access token immediately before every turn.
    auth_mode: 'chatgptAuthTokens',
    OPENAI_API_KEY: null,
    tokens: {
      // Codex parses ChatGPT identity claims from this field. Its own external
      // token integration also uses the access JWT as the identity JWT.
      id_token: token,
      access_token: token,
      refresh_token: '',
      account_id: accountId,
    },
    last_refresh: new Date(now).toISOString(),
  }
}

export async function writeCodexExternalAuth(
  codexHome: string,
  accessToken: string,
  now = Date.now(),
): Promise<string> {
  const authPath = join(codexHome, 'auth.json')
  await mkdir(dirname(authPath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${authPath}.tmp.${process.pid}.${randomUUID()}`
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(codexExternalAuthDocument(accessToken, now), null, 2)}\n`, 'utf-8')
    await handle.sync()
    await handle.close()
    await rename(temporaryPath, authPath)
    await chmod(authPath, 0o600)
    return authPath
  } catch (err) {
    await handle.close().catch(() => undefined)
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw err
  }
}
