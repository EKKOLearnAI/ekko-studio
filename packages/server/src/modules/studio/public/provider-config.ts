import YAML from 'js-yaml'
import { assertUniqueProviderNames, uniqueProviderLabels } from '../contracts/provider-identity'
import { providerConfigKeys } from '../services/providers/account-pool'
import { supplementalConfigForDisplay } from '../services/providers/supplemental-routing'
import { chmod, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { safeFileStore } from './safe-file-store'
import { getDefaultProfileForUser } from './users'
import { readAppConfig as readGlobalAppConfig, type AppConfig } from './app-config'
import {
  importAccountProviders, providerAccountHome, providerAccountId,
  providerProfileDir, providerProfiles, providerRequestProfile, providerAccountDirectory, providerCredentialDir,
} from './provider-account'

export { PROVIDER_ENV_MAP, buildModelGroups } from './profile-config'
export { providerAccountDirectory as getProfileDir, providerProfiles as listProfileNamesFromDisk }
export type { AppConfig, ModelVisibilityRule } from './app-config'
export { providerDisplayLabel, invalidateAppConfigCache } from './app-config'

export async function safeReadFile(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8') }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw error }
}

export const getActiveProfileName = () => providerRequestProfile() || getDefaultProfileForUser(providerAccountId())
export const getActiveProfileDir = () => providerAccountDirectory(getActiveProfileName())
export const getActiveEnvPath = () => join(getActiveProfileDir(), '.env')
export const getActiveAuthPath = () => join(getActiveProfileDir(), 'auth.json')
export const getHermesBaseDir = () => providerAccountHome()
export const appConfigFilePath = () => join(providerAccountHome(), 'display.json')

export async function readConfigYamlForProfile(profile: string): Promise<Record<string, any>> {
  await importAccountProviders()
  const shared = await safeFileStore.readYaml(join(providerAccountHome(), 'config.yaml'))
  if (!providerProfiles().includes(profile)) return shared
  const settings = await safeFileStore.readYaml(join(providerProfileDir(profile), 'config.yaml'))
  return supplementalConfigForDisplay(profile, { ...shared, ...settings })
}
export const readConfigYaml = () => readConfigYamlForProfile(getActiveProfileName())

export async function updateConfigYamlForProfile<T = void>(profile: string, updater: Parameters<typeof safeFileStore.updateYaml<T>>[1]): Promise<T | undefined> {
  await importAccountProviders()
  const sharedPath = join(providerAccountHome(), 'config.yaml')
  const settingsPath = join(providerProfileDir(profile), 'config.yaml')
  const displayPath = appConfigFilePath()
  const result = await safeFileStore.updateTexts<T>([sharedPath, settingsPath, displayPath], async current => {
    const shared = (YAML.load(current[sharedPath] || '{}') || {}) as Record<string, any>
    const settings = (YAML.load(current[settingsPath] || '{}') || {}) as Record<string, any>
    const update = await updater({ ...shared, ...settings })
    const wrapped = update && typeof update === 'object' && Object.hasOwn(update, 'data')
    if (wrapped && update.write === false) return { files: {}, result: update.result as T }
    const next = wrapped ? update.data : update
    const display = JSON.parse(current[displayPath] || '{}')
    assertUniqueProviderNames(next, display.providerLabels?.account)
    for (const key of providerConfigKeys) {
      delete shared[key]
      if (next[key] !== undefined) shared[key] = next[key]
    }
    const local = Object.fromEntries(Object.entries(next).filter(([key]) => !providerConfigKeys.includes(key as any) && key !== 'studio_provider_pool'))
    return { files: { [sharedPath]: YAML.dump(shared, { noRefs: true, lineWidth: -1 }), [settingsPath]: YAML.dump(local, { noRefs: true, lineWidth: -1 }) }, result: (wrapped ? update.result : undefined) as T }
  }, { backup: true })
  await Promise.all([sharedPath, settingsPath].map(path => chmod(path, 0o600)))
  return result
}
export const updateConfigYaml = <T = void>(updater: Parameters<typeof safeFileStore.updateYaml<T>>[1]) => updateConfigYamlForProfile<T>(getActiveProfileName(), updater)

export async function saveEnvValueForProfile(profile: string, key: string, value: string): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\r\n]/.test(value)) throw new Error('Invalid provider environment value')
  await importAccountProviders()
  const path = join(providerAccountDirectory(profile), '.env')
  await safeFileStore.updateText(path, raw => {
    const lines = raw.split(/\r?\n/).filter(line => line.trim().split('=', 1)[0].trim() !== key)
    if (value) lines.push(`${key}=${value}`)
    return lines.filter(Boolean).join('\n') + '\n'
  }, { backup: true })
  await chmod(path, 0o600)
}
export const saveEnvValue = (key: string, value: string) => saveEnvValueForProfile(getActiveProfileName(), key, value)

const displayKeys = ['copilotEnabled', 'modelAliases', 'customModels', 'modelVisibility', 'providerLabels', 'providerPreferredModels'] as const

const sharedDisplayKeys = ['providerLabels', 'providerPreferredModels'] as const
function accountPreferenceMap(value: Record<string, any> | undefined, imports: Record<string, Record<string, string>>): Record<string, any> {
  if (value?.account) return { ...value.account }
  const result: Record<string, any> = {}
  for (const profile of Object.keys(value || {}).sort((a, b) => a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b))) {
    for (const [provider, preference] of Object.entries(value![profile] || {})) {
      const id = imports[profile]?.[provider] || provider
      if (!Object.hasOwn(result, id)) result[id] = preference
    }
  }
  return result
}

export async function readAppConfig(): Promise<AppConfig> {
  const global = await readGlobalAppConfig()
  const path = appConfigFilePath()
  const cfgPath = join(providerAccountHome(), 'config.yaml')
  const state = JSON.parse(await safeFileStore.readText(join(providerAccountHome(), 'pool.json')).catch(() => '{}'))
  const own = await safeFileStore.updateTexts<AppConfig>([path, cfgPath], current => {
    const initial = current[path] ? JSON.parse(current[path]!) as AppConfig
      : Object.fromEntries(displayKeys.filter(key => global[key] !== undefined).map(key => [key, global[key]])) as AppConfig
    for (const key of sharedDisplayKeys) {
      const source = current[path] ? initial[key] : Object.fromEntries(Object.entries(initial[key] || {}).filter(([profile]) => providerProfiles().includes(profile)))
      initial[key] = { account: accountPreferenceMap(source, state.imports || {}) }
    }
    initial.providerLabels = { account: uniqueProviderLabels((YAML.load(current[cfgPath] || '{}') || {}) as Record<string, any>, initial.providerLabels?.account || {}) }
    const serialized = JSON.stringify(initial)
    return { files: serialized === current[path] ? {} : { [path]: serialized }, result: initial }
  })
  await chmod(path, 0o600)
  for (const key of sharedDisplayKeys) {
    const shared = accountPreferenceMap(own?.[key], state.imports || {})
    own![key] = Object.fromEntries(['account', ...providerProfiles()].map(profile => [profile, { ...shared }]))
  }
  const unrelated = Object.fromEntries(Object.entries(global).filter(([key]) => !displayKeys.includes(key as any)))
  return { ...unrelated, ...own }
}

export async function writeAppConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const before = await readAppConfig()
  const path = appConfigFilePath()
  const cfgPath = join(providerAccountHome(), 'config.yaml')
  const state = JSON.parse(await safeFileStore.readText(join(providerAccountHome(), 'pool.json')).catch(() => '{}'))
  await safeFileStore.updateTexts([path, cfgPath], files => {
    const current = JSON.parse(files[path] || '{}')
    const next = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([key]) => displayKeys.includes(key as any))) }
    for (const key of sharedDisplayKeys) if (patch[key]) {
      const shared = accountPreferenceMap(current[key], state.imports || {})
      for (const [profile, incoming] of Object.entries(patch[key]!)) {
        const previous = before[key]?.[profile] || {}
        for (const provider of new Set([...Object.keys(previous), ...Object.keys(incoming)])) {
          if (JSON.stringify(previous[provider]) === JSON.stringify(incoming[provider])) continue
          if (incoming[provider] === undefined) delete shared[provider]
          else shared[provider] = incoming[provider]
        }
      }
      next[key] = { account: shared }
    }
    assertUniqueProviderNames((YAML.load(files[cfgPath] || '{}') || {}) as Record<string, any>, next.providerLabels?.account)
    return { files: { [path]: JSON.stringify(next, null, 2) }, result: undefined }
  }, { backup: true })
  return readAppConfig()
}

export async function providerEnv(profile: string, credentialScope?: string): Promise<string> {
  try { return await readFile(join(providerCredentialDir(credentialScope), '.env'), 'utf8') } catch (error: any) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}
