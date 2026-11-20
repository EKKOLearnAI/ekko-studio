import { coalesceProviderPool, compareProviderProfiles, mergeProviderSnapshot, type ProviderSnapshot, type ProviderPoolState } from './account-pool'
import { uniqueProviderLabels } from '../../contracts/provider-identity'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import YAML from 'js-yaml'
import { config } from '../../public/config'
import { safeFileStore } from '../../public/safe-file-store'
import { findUserById, listUsers } from '../../repositories/users-store'

export interface ProviderSources {
  profileDir(profile: string): string
  profiles(userId: number): string[]
  environmentKeys: string[]
  importMetadata?(profile: string, aliases?: Record<string, string>): void
  environmentMap?: Record<string, { api_key_env: string; base_url_env: string }>
  qwenCredentials?(profile: string, configuration: Record<string, any>): Promise<string>
}

interface AccountScope { userId: number; profile?: string }
interface ImportRecord { version: 1; profile: string; importedAt: string }
export interface InternalModelCredential { userId: number; profile?: string; token: string; sessionId?: string }

const scopes = new AsyncLocalStorage<AccountScope>()
const importing = new Map<number, Promise<void>>()
let sources: ProviderSources | undefined
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const root = () => join(config.appHome, 'providers')

export function configureProviderSources(next: ProviderSources): void { sources = next }

export function providerAccountId(profile?: string): number {
  const bound = scopes.getStore()?.userId
  if (bound) return bound
  // Old background callers may identify a uniquely owned Profile. Shared
  // Profiles require an explicit account; never select an arbitrary owner.
  const owners = profile ? listUsers().filter(user => user.status === 'active' && user.profiles.includes(profile)) : []
  if (owners.length === 1) return owners[0].id
  throw Object.assign(new Error('Provider access requires a Studio user context'), { status: 403 })
}

export function providerAccountHome(userId = providerAccountId()): string {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('Invalid provider account')
  return join(root(), 'users', String(userId))
}

export function providerProfileDir(profile: string): string {
  const bound = scopes.getStore()
  if (bound && sources && !sources.profiles(bound.userId).includes(profile || 'default')) throw Object.assign(new Error('Profile is not accessible to this user'), { status: 403 })
  return join(providerAccountHome(providerAccountId(profile)), 'profiles', digest(profile || 'default'))
}

export const providerRequestAccountId = () => scopes.getStore()?.userId
export const providerRequestProfile = () => scopes.getStore()?.profile

export function providerSourceDir(profile: string): string {
  if (!sources || !providerProfiles().includes(profile)) throw new Error('Provider Profile source is unavailable')
  return sources.profileDir(profile)
}

export function providerScopeKey(profile: string): string {
  return `account:${providerAccountId(profile)}`
}

export function providerProfiles(): string[] {
  if (!sources) throw new Error('Provider sources are not configured')
  return [...new Set(sources.profiles(providerAccountId()))]
}

export function withProviderAccount<T>(userId: number | string, operation: () => T, profile?: string): T {
  const id = Number(userId)
  if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error('Studio user is required'), { status: 401 })
  return scopes.run({ userId: id, profile }, operation)
}

export function withoutProviderAccount<T>(operation: () => T): T {
  return scopes.exit(operation)
}

export function withSocketProviderAccount<T extends (...args: any[]) => Promise<any>>(operation: T): T {
  return ((...args: Parameters<T>) => withProviderAccount(args[1]?.data?.user?.id, async () => {
    await importAccountProviders()
    return operation(...args)
  }, args[3])) as T
}

async function text(path: string): Promise<string> {
  try { return await readFile(path, 'utf8') } catch (error: any) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

function providerOnlyConfig(raw: string): Record<string, any> {
  let value: Record<string, any>
  try { value = raw.trim() ? YAML.load(raw, { json: true }) as Record<string, any> : {} }
  catch { throw new Error('Invalid Profile configuration') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Profile configuration')
  return Object.fromEntries(['model', 'providers', 'custom_providers', 'fallback_providers', 'auxiliary', 'moa', 'delegation']
    .filter(key => value[key] !== undefined).map(key => [key, value[key]]))
}

function providerEnvironment(raw: string, cfg: Record<string, any>): string {
  const keys = new Set([...(sources?.environmentKeys || []), 'ANTHROPIC_TOKEN'])
  for (const entry of [...Object.values(cfg.providers || {}), ...(cfg.custom_providers || [])] as any[]) {
    for (const key of [entry?.key_env, entry?.api_key_env, entry?.keyEnv, entry?.apiKeyEnv]) if (typeof key === 'string') keys.add(key)
  }
  return raw.split(/\r?\n/).filter(line => keys.has(line.trim().split('=', 1)[0].trim())).join('\n') + '\n'
}

export async function importAccountProviders(): Promise<void> {
  const userId = providerAccountId()
  const running = importing.get(userId)
  if (running) return running
  if (!sources) throw new Error('Provider sources are not configured')
  const pending = (async () => {
    for (const profile of providerProfiles().sort((a, b) => a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b))) {
      const dir = providerProfileDir(profile)
      const marker = join(dir, 'import.json')
      if (await text(marker)) continue
      const source = sources!.profileDir(profile)
      let [rawConfig, rawEnv, rawAuth, anthropic] = await Promise.all([
        text(join(source, 'config.yaml')), text(join(source, '.env')),
        text(join(source, 'auth.json')), text(join(source, '.anthropic_oauth.json')),
      ])
      // Never persist an invalid first snapshot: fixing the source must allow
      // a failed import to be retried without editing Studio's private files.
      const initialConfiguration = providerOnlyConfig(rawConfig)
      for (const raw of [rawAuth, anthropic]) {
        try { if (raw.trim()) JSON.parse(raw) } catch { throw new Error('Invalid Profile credentials') }
      }
      let qwen = await sources!.qwenCredentials?.(profile, initialConfiguration) || ''
      // A Profile can be shared by several Studio users. Preserve its original
      // import snapshot before replacing Hermes' live configuration so a later
      // user's first import never imports the gateway back into itself.
      const seedPath = join(root(), 'import-sources', digest(source) + '.json')
      await mkdir(join(root(), 'import-sources'), { recursive: true, mode: 0o700 })
      const seed = await safeFileStore.updateTexts<string[]>([seedPath], current => {
        const snapshot = current[seedPath] ? JSON.parse(current[seedPath]!) as string[] : [rawConfig, rawEnv, rawAuth, anthropic, qwen]
        return { files: current[seedPath] ? {} : { [seedPath]: JSON.stringify(snapshot) }, result: snapshot }
      }, { backup: false })
      if (!seed) throw new Error('Unable to preserve Profile import source')
      await chmod(seedPath, 0o600)
      ;[rawConfig, rawEnv, rawAuth, anthropic, qwen = ''] = seed
      const cfg = providerOnlyConfig(rawConfig)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await safeFileStore.updateTexts([marker, join(dir, 'config.yaml'), join(dir, '.env'), join(dir, 'auth.json'), join(dir, '.anthropic_oauth.json'), join(dir, 'qwen-oauth.json'), join(dir, 'source-backup.json')], current => {
        if (current[marker]) return { files: {}, result: undefined }
        const record: ImportRecord = { version: 1, profile, importedAt: new Date().toISOString() }
        return { files: {
          [join(dir, 'config.yaml')]: YAML.dump(cfg, { lineWidth: -1, noRefs: true }),
          [join(dir, '.env')]: providerEnvironment(rawEnv, cfg),
          [join(dir, 'auth.json')]: rawAuth || '{}\n',
          [join(dir, '.anthropic_oauth.json')]: anthropic || '{}\n',
          [join(dir, 'qwen-oauth.json')]: qwen || '{}\n',
          [join(dir, 'source-backup.json')]: JSON.stringify({ config: rawConfig, env: rawEnv, auth: rawAuth, anthropic, qwen }),
          [marker]: JSON.stringify(record),
        }, result: undefined }
      })
      for (const name of ['config.yaml', '.env', 'auth.json', '.anthropic_oauth.json', 'source-backup.json', 'import.json', 'qwen-oauth.json']) await chmod(join(dir, name), 0o600)
    }
    await upgradeAccountProviderPool()
    await enforceUniqueProviderPool()
  })()
  importing.set(userId, pending)
  try { await pending } finally { if (importing.get(userId) === pending) importing.delete(userId) }
}

/** Socket.IO invokes listeners in its own async resource; bind the account at entry. */
export function bindProviderSocket(socket: any): void {
  const on = socket.on.bind(socket)
  socket.on = (event: string, listener: (...args: any[]) => unknown) => on(event, (...args: any[]) => {
    const user = socket.data?.user || socket.data?.authUser
    if (!user?.id) return listener(...args)
    const selected = socket.data?.profile || socket.data?.profileName
    return withProviderAccount(user.id, () => listener(...args), typeof selected === 'string' ? selected : selected?.name)
  })
}

export async function internalModelCredential(profile: string): Promise<InternalModelCredential> {
  const userId = providerAccountId(profile)
  const path = join(providerAccountHome(userId), 'gateway-credential.json')
  const result = await safeFileStore.updateTexts([path], current => {
    const existing = current[path] ? JSON.parse(current[path]) as InternalModelCredential : undefined
    const credential = existing || { userId, token: `studio_model_${randomBytes(32).toString('base64url')}` }
    return { files: existing ? {} : { [path]: JSON.stringify(credential) }, result: credential }
  })
  if (!result) throw new Error('Unable to issue internal model credential')
  await chmod(path, 0o600)
  return result
}

function signModelSession(token: string, value: string): string {
  return createHmac('sha256', token).update('studio-model-session\0').update(value).digest('base64url')
}

/** Carry the bridge's session through the HTTP SDK without exposing its ID or account credential. */
export function bindInternalModelSession(credential: InternalModelCredential, profile: string, sessionId: string): string {
  const scope = signModelSession(credential.token, JSON.stringify([profile, sessionId]))
  const binding = `${credential.userId}.${Buffer.from(profile).toString('base64url')}.${scope}`
  return `studio_model_session_${binding}.${signModelSession(credential.token, binding)}`
}

export async function authenticateInternalModelCredential(token: string): Promise<InternalModelCredential | null> {
  const match = /^studio_model_session_([1-9]\d{0,15})\.([A-Za-z0-9_-]{1,512})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(token)
  if (match) {
    const [, account, encodedProfile, sessionId, signature] = match
    const userId = Number(account)
    if (!Number.isSafeInteger(userId) || findUserById(userId)?.status !== 'active') return null
    const current = await text(join(providerAccountHome(userId), 'gateway-credential.json'))
    if (!current) return null
    const credential = JSON.parse(current) as InternalModelCredential
    if (credential.userId !== userId) return null
    const expected = signModelSession(credential.token, `${account}.${encodedProfile}.${sessionId}`)
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null
    return { userId, profile: Buffer.from(encodedProfile, 'base64url').toString('utf8'), token, sessionId }
  }
  if (!/^studio_model_[A-Za-z0-9_-]{43}$/.test(token)) return null
  let accounts: string[]
  try { accounts = await readdir(join(root(), 'users')) } catch { return null }
  const hash = digest(token)
  for (const account of accounts) {
    if (!/^[1-9]\d*$/.test(account) || findUserById(account)?.status !== 'active') continue
    const home = join(root(), 'users', account)
    const current = await text(join(home, 'gateway-credential.json'))
    if (current) {
      const credential = JSON.parse(current) as InternalModelCredential
      if (credential.userId === Number(account) && digest(credential.token) === hash) return credential
    }
    const aliases = JSON.parse(await text(join(home, 'legacy-credentials.json')) || '[]') as Array<{ hash: string; profile?: string }>
    const legacy = aliases.find(entry => entry.hash === hash)
    if (legacy) return { userId: Number(account), token, ...(legacy.profile ? { profile: legacy.profile } : {}) }
  }
  return null
}


export function providerCredentialDir(scope?: string): string {
  if (!scope) return providerAccountHome()
  if (!/^[a-f0-9]{64}$/.test(scope)) throw new Error('Invalid Provider credential scope')
  return join(providerAccountHome(), 'credentials', scope)
}

export function providerAccountDirectory(profile?: string): string {
  return providerAccountHome(providerAccountId(profile))
}

async function enforceUniqueProviderPool(): Promise<void> {
  const home = providerAccountHome()
  const statePath = join(home, 'pool.json')
  const initial = JSON.parse(await text(statePath) || '{}')
  if (initial.version === 3) return
  const cfgPath = join(home, 'config.yaml')
  const routesPath = join(home, 'routes.json')
  const catalogPath = join(home, 'catalog.json')
  const displayPath = join(home, 'display.json')
  const archivePath = join(home, 'pool-v2-backup.json')
  const settingsPaths = providerProfiles().map(profile => join(providerProfileDir(profile), 'config.yaml'))
  const written = await safeFileStore.updateTexts<string[]>([statePath, cfgPath, routesPath, catalogPath, displayPath, archivePath, ...settingsPaths], current => {
    const state = JSON.parse(current[statePath] || '{"version":2,"imports":{},"fingerprints":{}}') as ProviderPoolState
    if (state.version === 3) return { files: {}, result: [] }
    const cfg = (YAML.load(current[cfgPath] || '{}') || {}) as Record<string, any>
    const aliases = coalesceProviderPool(cfg, state)
    const canonical = (id: string) => aliases[id] || id
    const files: Record<string, string> = {}
    if (!current[archivePath]) files[archivePath] = JSON.stringify(Object.fromEntries(Object.entries(current).filter(([path]) => path !== archivePath)))
    for (const path of [cfgPath, ...settingsPaths]) {
      const value = path === cfgPath ? cfg : (YAML.load(current[path] || '{}') || {}) as Record<string, any>
      if (value.model && typeof value.model === 'object') value.model.provider = canonical(value.model.provider)
      files[path] = YAML.dump(value, { noRefs: true, lineWidth: -1 })
    }
    const routes = JSON.parse(current[routesPath] || '{}')
    for (const route of Object.values(routes) as any[]) route.provider = canonical(route.provider)
    files[routesPath] = JSON.stringify(routes)
    if (current[catalogPath]) {
      const catalog = JSON.parse(current[catalogPath])
      // A discarded endpoint's model discovery must not leak into the winner.
      catalog.providers = Object.fromEntries(Object.entries(catalog.providers || {}).filter(([, entry]: [string, any]) => canonical(entry.provider) === entry.provider))
      files[catalogPath] = JSON.stringify(catalog)
    }
    if (current[displayPath]) {
      const display = JSON.parse(current[displayPath])
      for (const key of ['providerLabels', 'providerPreferredModels']) for (const values of Object.values(display[key] || {}) as any[]) {
        for (const old of Object.keys(values)) if (canonical(old) !== old) delete values[old]
      }
      if (display.providerLabels) for (const scope of Object.keys(display.providerLabels)) display.providerLabels[scope] = uniqueProviderLabels(cfg, display.providerLabels[scope])
      files[displayPath] = JSON.stringify(display)
    }
    files[statePath] = JSON.stringify(state)
    return { files, result: Object.keys(files) }
  }, { backup: true })
  for (const path of written || []) await chmod(path, 0o600)
}

async function upgradeAccountProviderPool(): Promise<void> {
  const home = providerAccountHome()
  const statePath = join(home, 'pool.json')
  const initialState = JSON.parse(await text(statePath) || '{"version":2,"imports":{},"fingerprints":{}}') as ProviderPoolState
  const names = providerProfiles().filter(profile => !Object.hasOwn(initialState.imports, profile)).sort(compareProviderProfiles)
  if (!names.length) return
  const snapshots: ProviderSnapshot[] = []
  const existingRoutes = JSON.parse(await text(join(home, 'routes.json')) || '{}')
  for (const profile of names) {
    const dir = providerProfileDir(profile)
    snapshots.push({ profile, config: providerOnlyConfig(await text(join(dir, 'config.yaml'))), env: await text(join(dir, '.env')),
      auth: JSON.parse(await text(join(dir, 'auth.json')) || '{}'), anthropic: await text(join(dir, '.anthropic_oauth.json')), qwen: await text(join(dir, 'qwen-oauth.json')) })
    const selection = snapshots.at(-1)!.config.model
    if (selection && typeof selection === 'object' && ['ekkostudio', 'custom:ekkostudio'].includes(selection.provider) && typeof selection.default === 'string') {
      const slash = selection.default.indexOf('/')
      const route = existingRoutes[decodeURIComponent(selection.default.slice(0, slash))]
      if (route) snapshots.at(-1)!.config.model = { ...selection, provider: route.provider, default: selection.default.slice(slash + 1) }
    }
    // Recover the shared original seed for users imported by the earlier layout.
    const backup = JSON.parse(await text(join(dir, 'source-backup.json')) || '{}')
    const seedPath = join(root(), 'import-sources', digest(sources!.profileDir(profile)) + '.json')
    await safeFileStore.updateTexts([seedPath], current => ({ files: current[seedPath] ? {} : { [seedPath]: JSON.stringify([backup.config || '', backup.env || '', backup.auth || '{}', backup.anthropic || '', backup.qwen || '']) }, result: undefined }), { backup: false })
    await chmod(seedPath, 0o600)
  }
  const cfgPath = join(home, 'config.yaml')
  const envPath = join(home, '.env')
  const authPath = join(home, 'auth.json')
  const archivePath = join(home, 'profile-import-backups.json')
  const catalogPath = join(home, 'catalog.json')
  const routePath = join(home, 'routes.json')
  const oldCredentialPath = join(home, 'legacy-credentials.json')
  const anthropicPath = join(home, '.anthropic_oauth.json')
  const qwenPath = join(home, 'qwen-oauth.json')
  const initialConfig = await safeFileStore.readYaml(cfgPath)
  // Reserve all possible credential paths before the atomic multi-file update.
  const planned = structuredClone(initialState)
  let previewConfig = initialConfig, previewEnv = await text(envPath), previewAuth = JSON.parse(await text(authPath) || '{}')
  for (const snapshot of snapshots) {
    const result = mergeProviderSnapshot({ snapshot, config: previewConfig, env: previewEnv, auth: previewAuth, state: planned, environmentMap: sources!.environmentMap || {} })
    previewConfig = result.config; previewEnv = result.env; previewAuth = result.auth
  }
  const credentialPaths = Object.values(planned.fingerprints).flatMap(scope => ['auth.json', '.env', '.anthropic_oauth.json', 'qwen-oauth.json'].map(name => join(home, 'credentials', scope, name)))
  const oldPaths = snapshots.flatMap(snapshot => ['config.yaml', '.env', 'auth.json', '.anthropic_oauth.json', 'qwen-oauth.json', 'gateway-credential.json'].map(name => join(providerProfileDir(snapshot.profile), name)))
  const written = await safeFileStore.updateTexts<string[]>([cfgPath, envPath, authPath, statePath, archivePath, catalogPath, routePath, oldCredentialPath, anthropicPath, qwenPath, ...credentialPaths, ...oldPaths], current => {
    const state = JSON.parse(current[statePath] || '{"version":2,"imports":{},"fingerprints":{}}') as ProviderPoolState
    let cfg = current[cfgPath] ? YAML.load(current[cfgPath]!) as Record<string, any> : {}
    let env = current[envPath] || ''
    let auth = JSON.parse(current[authPath] || '{}')
    const archive = JSON.parse(current[archivePath] || '{}')
    const legacy = JSON.parse(current[oldCredentialPath] || '[]') as Array<{ hash: string; profile?: string }>
    const files: Record<string, string | undefined> = {}
    for (const snapshot of snapshots) {
      if (Object.hasOwn(state.imports, snapshot.profile)) continue
      const dir = providerProfileDir(snapshot.profile)
      const result = mergeProviderSnapshot({ snapshot, config: cfg, env, auth, state, environmentMap: sources!.environmentMap || {} })
      cfg = result.config; env = result.env; auth = result.auth
      archive[snapshot.profile] ||= snapshot
      files[join(dir, 'config.yaml')] = YAML.dump(result.settings, { noRefs: true, lineWidth: -1 })
      for (const name of ['.env', 'auth.json', '.anthropic_oauth.json', 'qwen-oauth.json']) files[join(dir, name)] = undefined
      const previousCredential = current[join(dir, 'gateway-credential.json')]
      if (previousCredential) {
        const credential = JSON.parse(previousCredential) as InternalModelCredential
        if (!legacy.some(entry => entry.hash === digest(credential.token))) legacy.push({ hash: digest(credential.token), profile: snapshot.profile })
        files[join(dir, 'gateway-credential.json')] = undefined
      }
      for (const [relative, value] of Object.entries(result.credentialFiles)) files[join(home, 'credentials', relative)] = value
      if (!current[anthropicPath] && snapshot.anthropic) files[anthropicPath] ||= snapshot.anthropic
      if (!current[qwenPath] && snapshot.qwen) files[qwenPath] ||= snapshot.qwen
      sources!.importMetadata?.(snapshot.profile, result.aliases)
    }
    const routes = JSON.parse(current[routePath] || '{}')
    for (const [namespace, entry] of Object.entries(routes) as Array<[string, any]>) {
      routes[namespace] = { provider: state.imports[entry.profile]?.[entry.provider] || entry.provider }
    }
    if (current[catalogPath]) {
      const catalog = JSON.parse(current[catalogPath])
      const merged: Record<string, any> = {}
      for (const [key, entry] of Object.entries(catalog.providers || {}) as Array<[string, any]>) {
        const sourceProfile = entry.profile || entry.profiles?.[0] || /^profile:account:[^:]+:([^|]+)\|/.exec(key)?.[1]
        const provider = state.imports[sourceProfile]?.[entry.provider] || entry.provider
        const identity = `${provider}|${String(entry.base_url || '').replace(/\/+$/, '')}|${entry.free_only ? 'free' : 'all'}`
        if (!merged[identity] || String(entry.updated_at) > String(merged[identity].updated_at)) merged[identity] = { ...entry, provider }
      }
      files[catalogPath] = JSON.stringify({ ...catalog, providers: merged })
    }
    Object.assign(files, { [cfgPath]: YAML.dump(cfg, { noRefs: true, lineWidth: -1 }), [envPath]: env, [authPath]: JSON.stringify(auth),
      [statePath]: JSON.stringify(state), [archivePath]: JSON.stringify(archive), [routePath]: JSON.stringify(routes), [oldCredentialPath]: JSON.stringify(legacy) })
    return { files, result: Object.entries(files).filter(([, value]) => value !== undefined).map(([path]) => path) }
  }, { backup: true })
  for (const path of written || []) await chmod(path, 0o600)
}
