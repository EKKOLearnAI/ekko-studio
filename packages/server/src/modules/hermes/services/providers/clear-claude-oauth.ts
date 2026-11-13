import { readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { getProfileDir } from '../profiles/profile'
import { saveEnvValueForProfile } from '../../../studio/public/profile-config'

function isOAuthEntry(value: any): boolean {
  if (!value || typeof value !== 'object') return false
  if (value.auth_type === 'api_key' || value.auth_mode === 'api_key') return false
  return value.auth_type === 'oauth' || value.auth_mode === 'oauth_pkce'
    || !!(value.access_token || value.refresh_token || value.tokens?.access_token || value.tokens?.refresh_token)
}

/** Undo only the selected profile's Studio-managed Claude OAuth login artifacts. */
export async function clearClaudeOAuthCredentials(profile: string): Promise<void> {
  const directory = getProfileDir(profile)
  const authPath = join(directory, 'auth.json')
  let raw: string | undefined
  try { raw = await readFile(authPath, 'utf8') }
  catch (error: any) { if (error.code !== 'ENOENT') throw error }
  if (raw !== undefined) {
    let auth: any
    try {
      auth = JSON.parse(raw)
      if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw new Error()
    } catch {
      // JSON parser diagnostics may include the credential text.
      throw new Error('Could not parse the Claude OAuth credential store')
    }
    let changed = false
    for (const section of ['providers', 'credential_pool']) {
      const entries = auth[section]
      if (entries && Object.prototype.hasOwnProperty.call(entries, 'claude-oauth')) {
        delete entries['claude-oauth']
        changed = true
      }
    }
    // The login writer also writes the runtime alias. Ordinary Anthropic
    // API-key entries are a separate provider and must survive OAuth clearing.
    if (isOAuthEntry(auth.providers?.anthropic)) {
      delete auth.providers.anthropic
      changed = true
    }
    const pool = auth.credential_pool?.anthropic
    if (Array.isArray(pool)) {
      const retained = pool.filter(entry => !isOAuthEntry(entry))
      if (retained.length !== pool.length) {
        if (retained.length) auth.credential_pool.anthropic = retained
        else delete auth.credential_pool.anthropic
        changed = true
      }
    }
    if (changed) await writeFile(authPath, JSON.stringify(auth, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  }
  await rm(join(directory, '.anthropic_oauth.json'), { force: true })
  await saveEnvValueForProfile(profile, 'ANTHROPIC_TOKEN', '')
}
