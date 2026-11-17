import { getWebUiHome } from '../modules/studio/public/config'
import { requireSuperAdmin } from '../modules/studio/middleware/auth'
import * as updateController from '../modules/studio/controllers/update'
import { configureSuperAdminMiddleware } from '../modules/studio/middleware/super-admin'
import { updateRoutes } from '../modules/studio/routes/update'
import {
  configureUpdateRuntime,
  describePreviewPluginResource,
  stopPreviewRuntime,
} from '../modules/studio/services/update/version-preview-manager'
import { isDockerContainer } from '../modules/studio/public/runtime-environment'

import { pluginResources } from '../modules/studio/services/plugins/resources'

configureUpdateRuntime({ getWebUiHome, isDockerContainer })
configureSuperAdminMiddleware(requireSuperAdmin)
pluginResources.register('studio.version-preview', describePreviewPluginResource)

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
