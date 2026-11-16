import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { importLegacyProviderContexts } from '../modules/studio/public/provider-context'
import { configureProviderProjection } from '../modules/studio/public/provider-projection'
import { getAvailableModelGroupsForProfile } from '../modules/hermes/controllers/models'
import { configureProviderSources } from '../modules/studio/public/provider-account'
import { getProfileDir, listProfileNamesFromDisk } from '../modules/hermes/services/profiles/profile'
import { PROVIDER_ENV_MAP } from '../modules/hermes/services/profiles/config'
import { findUserById, listUserProfiles } from '../modules/studio/public/users'

configureProviderSources({
  profileDir: getProfileDir,
  environmentMap: PROVIDER_ENV_MAP,
  qwenCredentials: async (_profile, configuration) => {
    if (!JSON.stringify(configuration).includes('qwen-oauth')) return ''
    try { return await readFile(join(homedir(), '.qwen', 'oauth_creds.json'), 'utf8') }
    catch (error: any) { if (error.code === 'ENOENT') return ''; throw error }
  },
  importMetadata: importLegacyProviderContexts,
  profiles: userId => {
    const user = findUserById(userId)
    if (!user || user.status !== 'active') return []
    const disk = listProfileNamesFromDisk()
    const allowed = new Set(listUserProfiles(userId).map(row => row.profile_name))
    return disk.filter(profile => user.role === 'super_admin' || allowed.has(profile))
  },
  environmentKeys: Object.values(PROVIDER_ENV_MAP).flatMap(mapping => [mapping.api_key_env, mapping.base_url_env]).filter(Boolean),
})

configureProviderProjection(getAvailableModelGroupsForProfile)
