import {
  buildModelGroups,
  PROVIDER_ENV_MAP,
  readConfigYaml,
  readConfigYamlForProfile,
  safeReadFile,
  saveEnvValue,
  saveEnvValueForProfile,
  updateConfigYaml,
  updateConfigYamlForProfile,
} from '../modules/hermes/services/profiles/config'
import * as hermesProfile from '../modules/hermes/services/profiles/profile'
import { configureProfileConfig } from '../modules/studio/public/profile-config'
import { resolveModelBaseUrlForProfile } from '../modules/hermes/services/models/endpoint'

const hasProfileExport = (name: string): boolean => (
  Object.prototype.hasOwnProperty.call(hermesProfile, name)
)
const getProfilesBaseDir = hasProfileExport('getHermesBaseDir')
  ? (hermesProfile as any).getHermesBaseDir as () => string
  : () => hermesProfile.getProfileDir('default')
const listProfileNames = hasProfileExport('listProfileNamesFromDisk')
  ? (hermesProfile as any).listProfileNamesFromDisk as () => string[]
  : () => ['default']

configureProfileConfig({
  resolveModelBaseUrl: resolveModelBaseUrlForProfile,
  buildModelGroups,
  getProfilesBaseDir,
  getActiveProfileName: hermesProfile.getActiveProfileName,
  getProfileDir: hermesProfile.getProfileDir,
  listProfileNames,
  providerEnvironmentMap: PROVIDER_ENV_MAP,
  readConfigYaml,
  readConfigYamlForProfile,
  safeReadFile,
  saveEnvValue,
  saveEnvValueForProfile,
  updateConfigYaml,
  updateConfigYamlForProfile,
})
