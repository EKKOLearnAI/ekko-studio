import { getWebUiHome } from '../modules/studio/public/config'
import { requireSuperAdmin } from '../modules/studio/middleware/auth'
import * as updateController from '../modules/studio/controllers/update'
import { configureSuperAdminMiddleware } from '../modules/studio/middleware/super-admin'
import { updateRoutes } from '../modules/studio/routes/update'
import {
  configureUpdateRuntime,
  stopPreviewRuntime,
} from '../modules/studio/services/update/version-preview-manager'
import { isDockerContainer, isGitCloneDeployment, getGitCloneRoot } from '../modules/studio/public/runtime-environment'

configureUpdateRuntime({ getWebUiHome, isDockerContainer, isGitCloneDeployment, getGitCloneRoot })
configureSuperAdminMiddleware(requireSuperAdmin)

export const {
  handleUpdate,
  installPreview,
  preparePreview,
  previewStatus,
  previewTags,
  startPreview,
  stopPreview,
} = updateController

export { stopPreviewRuntime, updateRoutes }
