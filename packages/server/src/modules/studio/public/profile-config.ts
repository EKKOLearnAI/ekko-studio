export type ProviderEnvironmentMap = Record<string, { api_key_env: string; base_url_env: string }>

export interface ModelGroupResult {
  default: string
  groups: Array<{
    provider: string
    models: Array<{ id: string; label: string }>
  }>
}

export interface ProfileConfigDependencies {
  resolveModelBaseUrl?: (profile: string, provider: string, model: string) => string | undefined
  buildModelGroups: (config: Record<string, any>) => ModelGroupResult
  getProfilesBaseDir: () => string
  getProfileDir: (profile: string) => string
  getActiveProfileName: () => string
  listProfileNames: () => string[]
  providerEnvironmentMap: ProviderEnvironmentMap
  readConfigYaml: () => Promise<Record<string, any>>
  readConfigYamlForProfile: (profile: string) => Promise<Record<string, any>>
  safeReadFile: (filePath: string) => Promise<string | null>
  saveEnvValue: (key: string, value: string) => Promise<void>
  saveEnvValueForProfile: (profile: string, key: string, value: string) => Promise<void>
  updateConfigYaml: <T = void>(
    updater: (config: Record<string, any>) => any,
  ) => Promise<T | undefined>
  updateConfigYamlForProfile: <T = void>(
    profile: string,
    updater: (config: Record<string, any>) => any,
  ) => Promise<T | undefined>
}

let profileConfigDependencies: ProfileConfigDependencies | null = null
export let PROVIDER_ENV_MAP: ProviderEnvironmentMap = {}

export function configureProfileConfig(dependencies: ProfileConfigDependencies): void {
  profileConfigDependencies = dependencies
  PROVIDER_ENV_MAP = dependencies.providerEnvironmentMap
}

function configured(): ProfileConfigDependencies {
  if (!profileConfigDependencies) throw new Error('Studio profile config has not been configured')
  return profileConfigDependencies
}

export function getProfileDir(profile: string): string {
  return configured().getProfileDir(profile)
}

export function getActiveProfileName(): string {
  return configured().getActiveProfileName()
}

export function getActiveProfileDir(): string {
  return getProfileDir(getActiveProfileName())
}

export function buildModelGroups(config: Record<string, any>): ModelGroupResult {
  return configured().buildModelGroups(config)
}

export function getProfilesBaseDir(): string {
  return configured().getProfilesBaseDir()
}

export function listProfileNames(): string[] {
  return configured().listProfileNames()
}

export const listProfileNamesFromDisk = listProfileNames

export function readConfigYamlForProfile(profile: string): Promise<Record<string, any>> {
  return configured().readConfigYamlForProfile(profile)
}

export function readConfigYaml(): Promise<Record<string, any>> {
  return configured().readConfigYaml()
}

export function safeReadFile(filePath: string): Promise<string | null> {
  return configured().safeReadFile(filePath)
}

export function saveEnvValueForProfile(profile: string, key: string, value: string): Promise<void> {
  return configured().saveEnvValueForProfile(profile, key, value)
}

export function saveEnvValue(key: string, value: string): Promise<void> {
  return configured().saveEnvValue(key, value)
}

export function updateConfigYaml<T = void>(
  updater: (config: Record<string, any>) => any,
): Promise<T | undefined> {
  return configured().updateConfigYaml<T>(updater)
}

export function updateConfigYamlForProfile<T = void>(
  profile: string,
  updater: (config: Record<string, any>) => any,
): Promise<T | undefined> {
  return configured().updateConfigYamlForProfile<T>(profile, updater)
}

export function resolveModelBaseUrl(profile: string, provider: string, model: string): string | undefined {
  return profileConfigDependencies?.resolveModelBaseUrl?.(profile, provider, model)
}
