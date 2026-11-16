import { createHash } from 'node:crypto'
import { providerEnv } from '../../public/provider-config'
import { providerAccountId } from '../../public/provider-account'

export const copilotRequestHeaders = {
  'Editor-Version': 'vscode/1.104.1',
  'Editor-Plugin-Version': 'copilot-chat/0.20.0',
  'User-Agent': 'GithubCopilot/1.155.0',
  'Copilot-Integration-Id': 'vscode-chat',
  'OpenAI-Intent': 'conversation-panel',
}
const cache = new Map<string, { token: string; expires: number }>()
const pending = new Map<string, Promise<{ token: string; expires: number }>>()

/** GitHub OAuth credentials must be exchanged for an inference credential. */
export async function resolveCopilotCredentials(input: { profile: string; forceRefresh?: boolean; credentialScope?: string }) {
  const env = await providerEnv(input.profile, input.credentialScope)
  const raw = /^\s*COPILOT_GITHUB_TOKEN\s*=\s*(.+)$/m.exec(env)?.[1]?.trim() || ''
  const oauth = raw.replace(/^(["'])(.*)\1$/, '$2')
  if (!oauth) throw new Error('Copilot login is required')
  const key = `${providerAccountId()}:${createHash('sha256').update(oauth).digest('hex')}`
  let credential = cache.get(key)
  if (input.forceRefresh || !credential || credential.expires < Date.now() + 60_000) {
    let request = pending.get(key)
    if (!request) {
      request = (async () => {
        const response = await fetch('https://api.github.com/copilot_internal/v2/token', {
          headers: { ...copilotRequestHeaders, Authorization: `token ${oauth}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(20_000),
        })
        if (!response.ok) throw new Error(`Copilot credential exchange failed (${response.status})`)
        const data = await response.json() as { token?: string; expires_at?: number }
        if (!data.token) throw new Error('Copilot returned no inference credential')
        const result = { token: data.token, expires: data.expires_at ? data.expires_at * 1000 : Date.now() + 240_000 }
        cache.set(key, result)
        return result
      })().finally(() => pending.delete(key))
      pending.set(key, request)
    }
    credential = await request
  }
  return { provider: 'copilot', apiKey: credential.token, baseUrl: 'https://api.githubcopilot.com', apiMode: 'chat_completions', expiresAtMs: credential.expires }
}
