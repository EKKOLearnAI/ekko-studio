import { getWebUiHome } from '../modules/studio/public/config'
import * as updateController from '../modules/studio/controllers/update'
import { updateRoutes } from '../modules/studio/routes/update'
import { configureUpdateRuntime } from '../modules/studio/services/update/update-runtime'
import { isDockerContainer } from '../modules/studio/public/runtime-environment'

configureUpdateRuntime({ getWebUiHome, isDockerContainer })
export const { handleUpdate } = updateController
export { updateRoutes }
