import { lstatSync } from 'fs'
import { join } from 'path'
import { HermesSkillInjector } from '../skills/injector'
import {
  setProfileAvatarGenerated,
  setProfileAvatarRemote,
  setProfileDisplayName,
} from './metadata'
import { detectHermesRootHome, isRealPathWithin } from '../runtime/path'
import { createProfileWithoutHermes } from './lifecycle'
import { updateConfigYamlForProfile } from './config'
import { logger } from '../../../studio/public/logging'

/**
 * Per-WeChat-user provisioning: every bound WeChat account owns a dedicated
 * Hermes agent profile (`u_<TokenPlatform user id>`) that isolates its agent,
 * sessions and Token Platform api_key from every other user. `default` stays
 * super-admin-only and is never shared with WeChat users.
 */

const TOKEN_PLATFORM_PROVIDER_NAME = 'token_platform'

export function personalProfileNameFor(platformProfileId: number): string {
  return `u_${platformProfileId}`
}

export function personalProfileDirExists(profileName: string): boolean {
  if (!/^u_[1-9][0-9]*$/.test(profileName)) return false
  try {
    return lstatSync(join(detectHermesRootHome(), 'profiles', profileName)).isDirectory()
  } catch {
    return false
  }
}

async function syncBundledSkills(profileName: string): Promise<void> {
  try {
    const targetDir = HermesSkillInjector.resolveTargetDirForProfile(profileName)
    await new HermesSkillInjector(undefined, targetDir).injectMissingSkills()
  } catch (err: any) {
    logger.warn(err, '[wechat-provision] failed to sync bundled skills for profile "%s"', profileName)
  }
}

function applyProfileIdentity(profileName: string, displayName: string, avatarUrl?: string | null): void {
  try {
    setProfileDisplayName(profileName, displayName)
    if (avatarUrl) {
      setProfileAvatarRemote(profileName, avatarUrl)
    } else {
      setProfileAvatarGenerated(profileName, displayName)
    }
  } catch (err: any) {
    logger.warn(err, '[wechat-provision] failed to write identity metadata for profile "%s"', profileName)
  }
}

/**
 * Write (or refresh) the user's own Token Platform custom provider entry into
 * their personal profile's config.yaml so each WeChat account calls the relay
 * with its own api_key. Provider config is profile-scoped, which keeps keys
 * isolated between users.
 */
export async function applyTokenPlatformProvider(
  profileName: string,
  apiBase: string,
  apiKey: string,
  models: string[],
): Promise<boolean> {
  const model = models[0] || ''
  if (!model) {
    logger.warn('[wechat-provision] no model available; skipping provider config for profile "%s"', profileName)
    return false
  }
  try {
    await updateConfigYamlForProfile(profileName, (config) => {
      if (typeof config.model !== 'object' || config.model === null) config.model = {}
      if (!Array.isArray(config.custom_providers)) config.custom_providers = []
      const existing = (config.custom_providers as any[]).find(
        (entry: any) => `custom:${entry?.name}` === `custom:${TOKEN_PLATFORM_PROVIDER_NAME}`,
      )
      if (existing) {
        existing.base_url = apiBase
        existing.api_key = apiKey
        existing.model = model
      } else {
        config.custom_providers.push({
          name: TOKEN_PLATFORM_PROVIDER_NAME,
          base_url: apiBase,
          api_key: apiKey,
          model,
        })
      }
      config.model.default = model
      config.model.provider = `custom:${TOKEN_PLATFORM_PROVIDER_NAME}`
      delete config.model.base_url
      delete config.model.api_key
      return config
    })
    return true
  } catch (err: any) {
    logger.warn(err, '[wechat-provision] failed to write token_platform provider for profile "%s"', profileName)
    return false
  }
}

export interface PersonalWorkspaceInput {
  platformProfileId: number
  displayName: string
  avatarUrl?: string | null
  apiBase?: string
  apiKey?: string
  models?: string[]
}

/**
 * Ensure the WeChat user has their personal agent profile: create it on disk
 * when missing, bind it to the user, sync the WeChat identity onto it, and
 * (when credentials are given) point its token_platform provider at the user's
 * own api_key. Returns the profile name, or null when provisioning failed —
 * callers must not fail the login itself in that case.
 */
export async function ensurePersonalWorkspace(input: PersonalWorkspaceInput): Promise<string | null> {
  const profileName = personalProfileNameFor(input.platformProfileId)
  try {
    if (!personalProfileDirExists(profileName)) {
      await createProfileWithoutHermes(profileName)
      await syncBundledSkills(profileName)
    }
    const root = detectHermesRootHome()
    const profiles = join(root, 'profiles')
    if (!await isRealPathWithin(profiles, root) || !await isRealPathWithin(join(profiles, profileName), profiles)) {
      return null
    }
  } catch (err: any) {
    logger.warn(err, '[wechat-provision] failed to create personal profile "%s"', profileName)
    return null
  }

  applyProfileIdentity(profileName, input.displayName, input.avatarUrl)

  if (input.apiBase && input.apiKey) {
    await applyTokenPlatformProvider(profileName, input.apiBase, input.apiKey, input.models || [])
  }

  return profileName
}
