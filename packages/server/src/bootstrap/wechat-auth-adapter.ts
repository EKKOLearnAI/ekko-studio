import { ensurePersonalWorkspace, personalProfileDirExists } from '../modules/hermes/services/profiles/wechat-user-provisioning'
import { configureWeChatWorkspace } from '../modules/studio/public/wechat-workspace'
import { migrateLegacyDeviceBinding, reconcileWeChatWorkspaces } from '../modules/studio/services/auth/wechat-binding-migration'
import { logger } from '../modules/studio/public/logging'

configureWeChatWorkspace({
  exists: personalProfileDirExists,
  ensure: ensurePersonalWorkspace,
})

export async function migrateLegacyWeChatAccounts(): Promise<void> {
  try {
    await migrateLegacyDeviceBinding()
    reconcileWeChatWorkspaces()
  } catch (error) {
    logger.warn({ err: error }, '[wechat-auth] could not migrate existing account bindings')
  }
}
