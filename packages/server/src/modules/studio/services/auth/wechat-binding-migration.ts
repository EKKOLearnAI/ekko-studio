import { existsSync } from 'fs'
import { rename } from 'fs/promises'
import { deviceBindingFilePath, loadDeviceBinding } from './device-binding'
import { claimWeChatWorkspace, demoteLegacyWeChatSuperAdmins, findUserById, findUserByUsername, setUserWeChatBound } from '../../repositories/users-store'
import { findBindingByPlatformId, listWeChatBindings, upsertBindingByPlatformId } from '../../repositories/wechat-bindings-store'
import { logger } from '../../public/logging'
import { existingWeChatWorkspace, weChatWorkspaceName } from '../../public/wechat-workspace'
import { reverseDoubleUtf8 } from './double-utf8'

const MIGRATED_SUFFIX = '.migrated'

/**
 * One-time migration from the legacy single-owner device binding
 * (device-binding.json) to the per-WeChat-account `wechat_bindings` table.
 *
 * - Imports the legacy binding as a row keyed by the Token Platform user id.
 * - Demotes any legacy `tp_`-prefixed WeChat user that still holds the
 *   single-owner `super_admin` role: the multi-user model reserves super admin
 *   for the built-in `quanthermes` account.
 * - Renames the legacy file so the import never runs twice.
 *
 * Idempotent and safe to run on every boot.
 */
export async function migrateLegacyDeviceBinding(): Promise<void> {
  const legacyFile = deviceBindingFilePath()
  if (existsSync(legacyFile)) {
    try {
      const binding = await loadDeviceBinding()
      if (!binding?.api_key || !binding.api_base || !binding.profile_id || !Number.isSafeInteger(binding.profile_id) || binding.profile_id <= 0) return
      {
        const existing = findBindingByPlatformId(binding.profile_id)
        if (!existing) {
          const localUsername = `tp_${binding.profile_id}`
          const user = findUserByUsername(localUsername)
          upsertBindingByPlatformId({
            userId: user?.id ?? null,
            platformProfileId: binding.profile_id,
            platformUsername: binding.username || '',
            apiBase: binding.api_base,
            apiKey: binding.api_key,
            deviceId: binding.device_id,
            models: binding.models || [],
            displayName: reverseDoubleUtf8(binding.display_name) ?? '',
          })
          logger.info({ platformProfileId: binding.profile_id }, '[wechat-binding] legacy device binding imported')
        }
      }
    } catch (err) {
      logger.warn(err, '[wechat-binding] failed to import legacy device binding')
      return
    }
    try {
      await rename(legacyFile, `${legacyFile}${MIGRATED_SUFFIX}`)
    } catch (err) {
      logger.warn(err, '[wechat-binding] failed to rename legacy device binding file')
    }
  }

  try {
    const demoted = demoteLegacyWeChatSuperAdmins()
    if (demoted > 0) {
      logger.info({ demoted }, '[wechat-binding] demoted legacy WeChat super admins')
    }
  } catch (err) {
    logger.warn(err, '[wechat-binding] failed to demote legacy WeChat super admins')
  }
}

export function reconcileWeChatWorkspaces(): void {
  for (const binding of listWeChatBindings()) {
    if (!Number.isSafeInteger(binding.platform_profile_id) || binding.platform_profile_id <= 0) continue
    const user = binding.user_id ? findUserById(binding.user_id) : null
    if (!user || user.status !== 'active') continue
    const profile = weChatWorkspaceName(binding.platform_profile_id)
    if (existingWeChatWorkspace(profile)) claimWeChatWorkspace(user.id, profile)
    if (!user.wechat_bound) setUserWeChatBound(user.id, true)
  }
}
