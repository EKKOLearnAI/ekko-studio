import { join } from 'path'

import {
  ORCAROUTER_OAUTH_LABEL,
  ORCAROUTER_PROVIDER,
  ORCAROUTER_OAUTH_PROVIDER,
  ORCAROUTER_API_KEY_PREFIX,
  normalizeOrcaRouterApiBase,
} from '../../../studio/public/orcarouter-catalog'
import { logger } from '../../../studio/public/logging'
import {
  readConfigYamlForProfile,
  saveEnvValueForProfile,
  safeReadFile,
} from '../../../studio/public/profile-config'
import { getProfileDir } from '../profiles/profile'
import { atomicWritePrivateJson } from './private-json-store'
import { resolveAuthorizedProviderRuntimeCredentials } from './authorized-provider-credentials'

/**
 * The credential seam.
 *
 * Both authentication entries converge on one result shape — a plain OrcaRouter
 * API key plus the inference base URL — so provider requests, model discovery,
 * and every AI entry point consume the same value and never learn where the key
 * came from. The two ways to obtain it are adapters on this seam:
 *
 * - `api-key`: the user pastes an `sk-orca-…` key; it is stored in the profile
 *   `.env` through the project's existing secret mechanism.
 * - `oauth-pkce`: a browser authorization mints a key that is persisted in the
 *   profile's `auth.json` credential store.
 */

export type OrcaRouterCredentialSource = 'api-key' | 'oauth-pkce'

export interface OrcaRouterCredential {
  source: OrcaRouterCredentialSource
  apiKey: string
  baseUrl: string
  scope?: string
  accountId?: string
}

export interface OrcaRouterCredentialAdapter {
  readonly source: OrcaRouterCredentialSource
  load(profile: string): Promise<OrcaRouterCredential | null>
  save(profile: string, credential: OrcaRouterCredential): Promise<void>
  clear(profile: string): Promise<void>
}

export class OrcaRouterCredentialError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly needsReauth = false,
  ) {
    super(message)
    this.name = 'OrcaRouterCredentialError'
  }
}

export function redactOrcaRouterKey(value: unknown): string {
  const key = String(value ?? '').trim()
  if (!key) return ''
  if (key.length <= 12) return 'sk-orca-…'
  return `${key.slice(0, 11)}…${key.slice(-4)}`
}

/**
 * Lightweight shape check only. An `sk-orca-` prefix is not proof the key is
 * valid; the first real request establishes that. We do not spend a billed
 * inference request just to make a settings form say "valid".
 */
export function isOrcaRouterKeyShape(value: unknown): boolean {
  const key = String(value ?? '').trim()
  return key.startsWith(ORCAROUTER_API_KEY_PREFIX) && key.length >= 20
}

const ENV_KEY = 'ORCAROUTER_API_KEY'
const ENV_BASE_URL = 'ORCAROUTER_BASE_URL'
const OAUTH_POOL_KEY = ORCAROUTER_OAUTH_PROVIDER

function envPathForProfile(profile: string): string {
  return join(getProfileDir(profile), '.env')
}

function parseEnvValue(content: string, key: string): string {
  const match = content.match(new RegExp(`^${key}\\s*=[ \\t]*(.+)`, 'm'))
  const value = match?.[1]?.trim() || ''
  return value.startsWith('#') ? '' : value
}

async function resolveBaseUrl(profile: string): Promise<string> {
  const envContent = await safeReadFile(envPathForProfile(profile)) || ''
  const override = parseEnvValue(envContent, ENV_BASE_URL) || process.env[ENV_BASE_URL] || ''
  return normalizeOrcaRouterApiBase(override)
}

/** Adapter 1 — a key the user pasted, stored in the project's `.env` secret store. */
export const orcaRouterApiKeyAdapter: OrcaRouterCredentialAdapter = {
  source: 'api-key',
  async load(profile) {
    const envContent = await safeReadFile(envPathForProfile(profile)) || ''
    const apiKey = parseEnvValue(envContent, ENV_KEY) || String(process.env[ENV_KEY] || '').trim()
    if (!apiKey) return null
    return { source: 'api-key', apiKey, baseUrl: await resolveBaseUrl(profile) }
  },
  async save(profile, credential) {
    if (!isOrcaRouterKeyShape(credential.apiKey)) {
      throw new OrcaRouterCredentialError(
        'An OrcaRouter API key starts with "sk-orca-"',
        'ORCAROUTER_API_KEY_SHAPE',
      )
    }
    await saveEnvValueForProfile(profile, ENV_KEY, credential.apiKey.trim())
  },
  async clear(profile) {
    await saveEnvValueForProfile(profile, ENV_KEY, '')
  },
}

/** Adapter 2 — a key minted by the OAuth 2.0 + PKCE connect flow. It is a durable
 * API key, not a refresh token: it is reused until OrcaRouter revokes it, and
 * there is no refresh grant to call.
 */
export const orcaRouterPkceAdapter: OrcaRouterCredentialAdapter = {
  source: 'oauth-pkce',
  async load(profile) {
    try {
      const credentials = await resolveAuthorizedProviderRuntimeCredentials({
        profile,
        provider: OAUTH_POOL_KEY,
      })
      if (!credentials.apiKey) return null
      if (!isOrcaRouterKeyShape(credentials.apiKey)) {
        // A value in this slot that is not an OrcaRouter key can never be made
        // valid by a refresh. Fail closed rather than sending it as a bearer.
        logger.warn('[orcarouter] stored OAuth credential is not an OrcaRouter key profile=%s', profile)
        return null
      }
      const authPath = join(getProfileDir(profile), 'auth.json')
      const auth = await readAuthJson(authPath)
      const scope = String(auth.providers?.[OAUTH_POOL_KEY]?.scope || '').trim()
      return {
        source: 'oauth-pkce',
        apiKey: credentials.apiKey,
        baseUrl: normalizeOrcaRouterApiBase(credentials.baseUrl || await resolveBaseUrl(profile)),
        ...(scope ? { scope } : {}),
      }
    } catch (err) {
      const needsReauth = (err as { reloginRequired?: boolean })?.reloginRequired === true
      logger.warn(
        '[orcarouter] stored OAuth key unusable profile=%s needsReauth=%s',
        profile,
        needsReauth,
      )
      return null
    }
  },
  async save(profile, credential) {
    if (!isOrcaRouterKeyShape(credential.apiKey)) {
      throw new OrcaRouterCredentialError(
        'OrcaRouter returned a credential that is not an API key',
        'ORCAROUTER_KEY_SHAPE',
      )
    }
    const authPath = join(getProfileDir(profile), 'auth.json')
    const auth = await readAuthJson(authPath)
    const providers = asRecord(auth.providers)
    const pool = asRecord(auth.credential_pool)
    const obtainedAt = new Date().toISOString()
    providers[OAUTH_POOL_KEY] = {
      api_key: credential.apiKey.trim(),
      auth_mode: 'oauth_pkce',
      scope: credential.scope || '',
      ...(credential.accountId ? { account_id: credential.accountId } : {}),
      obtained_at: obtainedAt,
      last_refresh: obtainedAt,
      base_url: credential.baseUrl,
    }
    pool[OAUTH_POOL_KEY] = [{
      id: `${OAUTH_POOL_KEY}-${Date.now()}`,
      label: ORCAROUTER_OAUTH_LABEL,
      auth_type: 'oauth',
      source: 'loopback_pkce',
      priority: 0,
      api_key: credential.apiKey.trim(),
      base_url: credential.baseUrl,
      obtained_at: obtainedAt,
      ...(credential.accountId ? { account_id: credential.accountId } : {}),
    }]
    auth.providers = providers
    auth.credential_pool = pool
    auth.updated_at = obtainedAt
    await atomicWritePrivateJson(authPath, auth)
  },
  async clear(profile) {
    const authPath = join(getProfileDir(profile), 'auth.json')
    const auth = await readAuthJson(authPath)
    const providers = asRecord(auth.providers)
    const pool = asRecord(auth.credential_pool)
    delete providers[OAUTH_POOL_KEY]
    delete pool[OAUTH_POOL_KEY]
    auth.providers = providers
    auth.credential_pool = pool
    auth.updated_at = new Date().toISOString()
    await atomicWritePrivateJson(authPath, auth)
  },
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, any>) }
    : {}
}

async function readAuthJson(authPath: string): Promise<Record<string, any>> {
  const raw = await safeReadFile(authPath)
  if (!raw) return { version: 1 }
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { version: 1 }
  } catch {
    return { version: 1 }
  }
}

export const ORCAROUTER_CREDENTIAL_ADAPTERS: OrcaRouterCredentialAdapter[] = [
  orcaRouterApiKeyAdapter,
  orcaRouterPkceAdapter,
]

/**
 * Resolve the key for a provider id. The API-key provider prefers the pasted
 * key; the Auth provider prefers the PKCE key. Either entry point works on its
 * own — a user with no browser can still paste a key, and a user with no key can
 * still authorize.
 */
export async function resolveOrcaRouterCredential(
  profile: string,
  provider: string,
): Promise<OrcaRouterCredential | null> {
  const normalized = String(provider || '').trim().toLowerCase()
  const order = normalized === OAUTH_POOL_KEY
    ? [orcaRouterPkceAdapter, orcaRouterApiKeyAdapter]
    : [orcaRouterApiKeyAdapter, orcaRouterPkceAdapter]
  for (const adapter of order) {
    const credential = await adapter.load(profile)
    if (credential?.apiKey) return credential
  }
  return null
}

export async function clearOrcaRouterCredential(profile: string, source: OrcaRouterCredentialSource): Promise<void> {
  const adapter = ORCAROUTER_CREDENTIAL_ADAPTERS.find(candidate => candidate.source === source)
  if (!adapter) return
  await adapter.clear(profile)
}

export interface OrcaRouterCredentialInspection {
  credential: OrcaRouterCredential | null
  /**
   * True when the stored key itself was rejected, as opposed to never having
   * been issued. A rejected key is terminal for that account: there is no
   * refresh grant, so the only recovery is running the connect flow again.
   */
  needsReauth: boolean
  errorCode?: string
}

/**
 * Same resolution as `resolveOrcaRouterCredential`, but it also reports *why*
 * no credential came back so the status endpoint can ask for a fresh
 * authorization instead of silently pretending nothing was ever stored.
 */
export async function inspectOrcaRouterCredential(
  profile: string,
  provider: string,
): Promise<OrcaRouterCredentialInspection> {
  const normalized = String(provider || '').trim().toLowerCase()
  const order = normalized === OAUTH_POOL_KEY
    ? [orcaRouterPkceAdapter, orcaRouterApiKeyAdapter]
    : [orcaRouterApiKeyAdapter, orcaRouterPkceAdapter]
  let needsReauth = false
  let errorCode: string | undefined
  for (const adapter of order) {
    if (adapter === orcaRouterPkceAdapter) {
      try {
        const credentials = await resolveAuthorizedProviderRuntimeCredentials({
          profile,
          provider: OAUTH_POOL_KEY,
        })
        if (credentials.apiKey) {
          if (!isOrcaRouterKeyShape(credentials.apiKey)) {
            needsReauth = true
            errorCode = 'ORCAROUTER_KEY_MALFORMED'
            continue
          }
          const authPath = join(getProfileDir(profile), 'auth.json')
          const auth = await readAuthJson(authPath)
          const scope = String(auth.providers?.[OAUTH_POOL_KEY]?.scope || '').trim()
          return {
            credential: {
              source: 'oauth-pkce',
              apiKey: credentials.apiKey,
              baseUrl: normalizeOrcaRouterApiBase(credentials.baseUrl || await resolveBaseUrl(profile)),
              ...(scope ? { scope } : {}),
            },
            needsReauth: false,
          }
        }
      } catch (err) {
        const typed = err as { reloginRequired?: boolean; code?: string }
        if (typed?.reloginRequired === true) {
          needsReauth = true
          errorCode = String(typed.code || 'ORCAROUTER_KEY_REJECTED')
        }
      }
      continue
    }
    const credential = await adapter.load(profile)
    if (credential?.apiKey) return { credential, needsReauth: false }
  }
  return { credential: null, needsReauth, ...(errorCode ? { errorCode } : {}) }
}

export function orcaRouterProviderIds(): string[] {
  return [ORCAROUTER_PROVIDER, ORCAROUTER_OAUTH_PROVIDER]
}

export async function orcaRouterConfiguredModel(profile: string): Promise<string> {
  try {
    const config = await readConfigYamlForProfile(profile)
    const model = typeof config.model === 'object' && config.model !== null
      ? String((config.model as Record<string, unknown>).default || '').trim()
      : ''
    return model
  } catch {
    return ''
  }
}
